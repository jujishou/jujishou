/**
 * 星海抽卡 · Cloudflare Workers 后端
 *
 * 从 server/server.c 移植，接口逐条对齐，前端 app.js 一行都不用改。
 * 静态文件（index.html / app.js / style.css / art/）由 Cloudflare 的资源服务器直接出，
 * 只有匹配不到文件的路径才会进到这里，也就是 /api/*。
 *
 * 存储用 D1（SQLite）。会话仍是 HMAC 签名的 Cookie，和原来一样两套：
 *   gsid = 管理员，7 天，SameSite=Strict
 *   guid = 玩家，365 天，SameSite=Lax   ← 「输入过一次就再也不用输入」
 *
 * 密码：pbkdf2$<iters>$<salt>$<hash>，格式与原来一致，但轮数按 Workers 免费版
 * 10ms CPU 上限调低（原 C 端 120000 轮在本机实测 28.6ms，会被 Worker 掐掉）。
 * 轮数写在记录里，以后要加可以逐条升级。
 */

const PBKDF2_ITERS = 10000;
const SESS_TTL = 7 * 24 * 3600;
const USER_TTL = 365 * 24 * 3600;
const MAX_SAVE = 128 * 1024;
const LOGIN_MAXFAIL = 5;
const LOGIN_WINDOW = 600;
const LOG_KEEP = 400;
// Crockford Base32：去掉了容易看错的 I L O U
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const TE = new TextEncoder();

/* ---------- 基础工具 ---------- */

function hex(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

function unhex(s) {
  const out = new Uint8Array((s || '').length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16) || 0;
  return out;
}

/** 定长比较，别用 === 比摘要 */
function ctEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

async function hmacHex(keyBytes, msg) {
  const k = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, TE.encode(msg)));
}

async function pbkdf2Hex(pass, saltBytes, iters) {
  const k = await crypto.subtle.importKey('raw', TE.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: iters, hash: 'SHA-256' }, k, 256);
  return hex(bits);
}

let _secret = null;
function secretBytes(env) {
  if (!_secret) _secret = unhex(env.SESSION_SECRET || '');
  return _secret;
}

const nowSec = () => Math.floor(Date.now() / 1000);

/* ---------- 会话 token（沿用 <id>.<exp>.<hmac> 格式） ---------- */

async function makeToken(env, scope, id, exp) {
  const mac = await hmacHex(secretBytes(env), scope + '|' + id + '|' + exp);
  return id + '.' + exp + '.' + mac;
}

async function checkToken(env, scope, tok) {
  if (!tok) return null;
  const parts = String(tok).split('.');
  if (parts.length !== 3) return null;
  const id = parts[0], exp = parseInt(parts[1], 10), mac = parts[2];
  const now = nowSec();
  if (!exp || exp <= 0 || exp > now + USER_TTL + 300) return null;
  if (mac.length !== 64) return null;
  const want = await hmacHex(secretBytes(env), scope + '|' + id + '|' + exp);
  if (!ctEq(want, mac)) return null;
  if (exp < now) return null;
  return id;
}

/* ---------- Cookie ---------- */

function parseCookies(request) {
  const out = {};
  const raw = request.headers.get('Cookie') || '';
  raw.split(';').forEach(function (part) {
    const i = part.indexOf('=');
    if (i < 0) return;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

function cookieStr(name, value, maxAge, sameSite, secure) {
  return name + '=' + value + '; Path=/; Max-Age=' + maxAge +
    '; HttpOnly; SameSite=' + sameSite + (secure ? '; Secure' : '');
}

const isSecure = (url) => url.protocol === 'https:';

/* ---------- 用户名 / 密码 ---------- */

/** ASCII 大写转小写，其余字节原样（中文不被拆坏） */
function normName(s) {
  let out = '';
  for (const ch of String(s)) {
    out += (ch >= 'A' && ch <= 'Z') ? ch.toLowerCase() : ch;
  }
  return out;
}

function validName(n) {
  const len = TE.encode(n).length;
  if (len < 2 || len > 32) return false;
  for (const ch of String(n)) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c === 0x7f) return false;
    if (c < 0x80) {
      const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) ||
                 (c >= 97 && c <= 122) || c === 95 || c === 45;
      if (!ok) return false;
    }
  }
  return true;
}

function validPass(p) {
  const n = TE.encode(String(p)).length;
  return n >= 6 && n <= 128;
}

async function uidOf(name) {
  const d = await sha256(TE.encode(normName(name)));
  return hex(d.slice(0, 16));
}

async function pwMake(pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const h = await pbkdf2Hex(pass, salt, PBKDF2_ITERS);
  return 'pbkdf2$' + PBKDF2_ITERS + '$' + hex(salt) + '$' + h;
}

async function pwCheck(pass, line) {
  const p = String(line || '').split('$');
  if (p.length !== 4 || p[0] !== 'pbkdf2') return false;
  const iters = parseInt(p[1], 10);
  if (!iters || iters < 1 || iters > 120000) return false;
  const h = await pbkdf2Hex(pass, unhex(p[2]), iters);
  return ctEq(h, p[3]);
}

/* ---------- 一次性密钥 ---------- */

/* 好念的新密码：小写字母 + 数字，避开 l/1/o/0 这些容易看错的分不清的字符 */
function genPassword() {
  const A = 'abcdefghjkmnpqrstuvwxyz23456789';
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  let out = '';
  for (let i = 0; i < 8; i++) out += A[b[i] % A.length];
  return out;
}

function genCode() {
  const raw = crypto.getRandomValues(new Uint8Array(12));
  let s = '';
  for (let i = 0; i < 12; i++) {
    if (i === 4 || i === 8) s += '-';
    s += CODE_ALPHABET[raw[i] % 32];   // 256 % 32 === 0，无取模偏置
  }
  return s;
}

const validCode = (c) => /^[A-Za-z0-9-]{8,32}$/.test(String(c || ''));

/* ---------- 限速（管理员登录，按 IP） ---------- */

async function failLocked(env, ip) {
  const r = await env.DB.prepare('SELECT count, first, locked FROM fails WHERE ip=?').bind(ip).first();
  if (!r) return 0;
  const now = nowSec();
  if (r.locked && r.locked > now) return r.locked;
  if (now - r.first > LOGIN_WINDOW) {
    await env.DB.prepare('DELETE FROM fails WHERE ip=?').bind(ip).run();
    return 0;
  }
  return 0;
}

async function failBump(env, ip) {
  const now = nowSec();
  const r = await env.DB.prepare('SELECT count, first FROM fails WHERE ip=?').bind(ip).first();
  if (!r || now - r.first > LOGIN_WINDOW) {
    await env.DB.prepare(
      'INSERT INTO fails(ip,count,first,locked) VALUES(?,1,?,0) ' +
      'ON CONFLICT(ip) DO UPDATE SET count=1, first=excluded.first, locked=0'
    ).bind(ip, now).run();
    return;
  }
  const count = r.count + 1;
  const locked = count >= LOGIN_MAXFAIL ? now + LOGIN_WINDOW : 0;
  await env.DB.prepare('UPDATE fails SET count=?, locked=? WHERE ip=?').bind(count, locked, ip).run();
}

async function failClear(env, ip) {
  await env.DB.prepare('DELETE FROM fails WHERE ip=?').bind(ip).run();
}

/* ---------- 审计日志 ---------- */

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') ||
         (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() ||
         '0.0.0.0';
}

function stamp(t) {
  const d = new Date(t * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' +
         p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}

async function addLog(env, ip, method, path, status) {
  try {
    await env.DB.prepare('INSERT INTO logs(t,line) VALUES(?,?)')
      .bind(nowSec(), stamp(nowSec()) + ' ' + ip + ' ' + method + ' ' + path + ' ' + status).run();
    // 只留最近 LOG_KEEP 条，别让表无限涨
    await env.DB.prepare(
      'DELETE FROM logs WHERE id <= (SELECT MAX(id) FROM logs) - ?').bind(LOG_KEEP).run();
  } catch (e) { /* 日志失败不能影响业务 */ }
}

/* ---------- meta ---------- */

async function metaGet(env, k, dflt) {
  const r = await env.DB.prepare('SELECT v FROM meta WHERE k=?').bind(k).first();
  return r ? r.v : dflt;
}

async function metaSet(env, k, v) {
  await env.DB.prepare(
    'INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v'
  ).bind(k, String(v)).run();
}

/* ---------- 响应工具 ---------- */

function json(obj, status, extra) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  };
  if (extra) for (const k in extra) headers[k] = extra[k];
  return new Response(JSON.stringify(obj), { status: status || 200, headers });
}

function parseForm(text) {
  const o = {};
  for (const [k, v] of new URLSearchParams(text || '')) o[k] = v;
  return o;
}

async function currentUser(request, env) {
  return checkToken(env, 'user', parseCookies(request).guid);
}

/* 记录「这个账号最后一次在网站上活动」是什么时候。
   后台靠它显示在线状态。写库有成本，所以 60 秒内的重复访问就跳过。 */
async function touchUser(env, ctx, uid) {
  if (!uid) return;
  const now = nowSec();
  const p = env.DB.prepare(
    'UPDATE users SET last_seen=? WHERE uid=? AND last_seen<?'
  ).bind(now, uid, now - 60).run().catch(function () {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
}

async function isAdmin(request, env) {
  return (await checkToken(env, 'admin', parseCookies(request).gsid)) !== null;
}

/* ==================================================================
   API 路由
   ================================================================== */

async function handleApi(request, env, url, ctx) {
  const path = url.pathname;
  const method = request.method;
  const secure = isSecure(url);
  const ip = clientIp(request);

  /* ---- 存活探测 ---- */
  if (path === '/api/health') {
    const boot = await metaGet(env, 'boot', '0');
    return json({ ok: true, t: Date.now(), boot: Number(boot) || (await bootOnce(env)) });
  }

  /* ---- 管理员 ---- */
  if (path === '/api/login' && method === 'POST') {
    if (await failLocked(env, ip)) {
      return json({ ok: false, err: 'rate', msg: '尝试过于频繁，请稍后再试' }, 429);
    }
    const form = parseForm(await request.text());
    const key = String(form.key || '').trim();
    if (!ctEq(key, String(env.ADMIN_HASH || ''))) {
      await failBump(env, ip);
      return json({ ok: false, err: 'bad-key', msg: '密钥不正确' }, 401);
    }
    await failClear(env, ip);
    const tok = await makeToken(env, 'admin', env.ADMIN_NAME || 'root', nowSec() + SESS_TTL);
    return json({ ok: true }, 200,
      { 'Set-Cookie': cookieStr('gsid', tok, SESS_TTL, 'Strict', secure) });
  }

  if (path === '/api/logout' && method === 'POST') {
    return json({ ok: true }, 200,
      { 'Set-Cookie': cookieStr('gsid', '', 0, 'Strict', secure) });
  }

  if (path === '/api/session') {
    return json({ ok: true, admin: await isAdmin(request, env) });
  }

  /* ---- 注册 / 登录 ---- */
  if (path === '/api/register' && method === 'POST') {
    const form = parseForm(await request.text());
    const name = String(form.name || '').trim();
    const pass = String(form.pass || '');
    const code = String(form.code || '').trim().toUpperCase();

    if (!validName(name)) {
      return json({ ok: false, err: 'bad-name', msg: '用户名要 2~32 个字符，只能用字母、数字、下划线、连字符或中文' }, 400);
    }
    if (!validPass(pass)) {
      return json({ ok: false, err: 'bad-pass', msg: '密码至少 6 位' }, 400);
    }
    if (!validCode(code)) {
      return json({ ok: false, err: 'bad-code', msg: '密钥格式不对' }, 400);
    }
    const inv = await env.DB.prepare('SELECT code, used FROM invites WHERE code=?').bind(code).first();
    if (!inv || inv.used) {
      return json({ ok: false, err: 'bad-code', msg: '密钥无效或已经被用过了' }, 403);
    }
    const nn = normName(name);
    const dup = await env.DB.prepare('SELECT uid FROM users WHERE name_norm=?').bind(nn).first();
    if (dup) {
      // 注意：重名失败不消耗密钥
      return json({ ok: false, err: 'taken', msg: '这个名字已经被注册了' }, 409);
    }

    const uid = await uidOf(name);
    const now = nowSec();
    const line = await pwMake(pass);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users(uid,name,name_norm,pass,created) VALUES(?,?,?,?,?)')
        .bind(uid, name, nn, line, now),
      env.DB.prepare('UPDATE invites SET used=1, uid=?, used_at=? WHERE code=?')
        .bind(uid, now, code)
    ]);
    // 老玩家在别的设备上留下的匿名存档，不再有 gpid 概念，跳过领养

    const tok = await makeToken(env, 'user', uid, now + USER_TTL);
    return json({ ok: true, name: name }, 200,
      { 'Set-Cookie': cookieStr('guid', tok, USER_TTL, 'Lax', secure) });
  }

  if (path === '/api/player/login' && method === 'POST') {
    const form = parseForm(await request.text());
    const name = String(form.name || '').trim();
    const pass = String(form.pass || '');
    const row = name
      ? await env.DB.prepare('SELECT uid, pass FROM users WHERE name_norm=?').bind(normName(name)).first()
      : null;
    if (!row || !(await pwCheck(pass, row.pass))) {
      return json({ ok: false, err: 'bad-login', msg: '用户名或密码不对' }, 401);
    }
    const tok = await makeToken(env, 'user', row.uid, nowSec() + USER_TTL);
    await touchUser(env, ctx, row.uid);
    return json({ ok: true }, 200,
      { 'Set-Cookie': cookieStr('guid', tok, USER_TTL, 'Lax', secure) });
  }

  if (path === '/api/player/logout' && method === 'POST') {
    return json({ ok: true }, 200,
      { 'Set-Cookie': cookieStr('guid', '', 0, 'Lax', secure) });
  }

  if (path === '/api/me') {
    const uid = await currentUser(request, env);
    if (!uid) return json({ ok: true, signedIn: false });
    const row = await env.DB.prepare('SELECT name FROM users WHERE uid=?').bind(uid).first();
    if (!row) return json({ ok: true, signedIn: false });
    await touchUser(env, ctx, uid);
    return json({ ok: true, signedIn: true, name: row.name, uid: uid });
  }

  /* ---- 存档 ---- */
  if (path === '/api/save') {
    const uid = await currentUser(request, env);
    if (!uid) return json({ ok: false, err: 'no-account', msg: '请先注册或登录' }, 401);
    await touchUser(env, ctx, uid);

    if (method === 'GET') {
      const row = await env.DB.prepare('SELECT data FROM saves WHERE uid=?').bind(uid).first();
      if (!row) return json({ ok: true, save: null });
      let obj = null;
      try { obj = JSON.parse(row.data); } catch (e) { obj = null; }
      return json({ ok: true, save: obj });
    }

    if (method === 'POST') {
      const body = await request.text();
      if (body.length > MAX_SAVE) return json({ ok: false, err: 'too-big', msg: '存档太大了' }, 413);
      let total = 0;
      try { total = Number(JSON.parse(body).total) || 0; }
      catch (e) { return json({ ok: false, err: 'bad-json' }, 400); }
      const now = nowSec();
      await env.DB.prepare(
        'INSERT INTO saves(uid,data,bytes,total,mtime) VALUES(?,?,?,?,?) ' +
        'ON CONFLICT(uid) DO UPDATE SET data=excluded.data, bytes=excluded.bytes, ' +
        'total=excluded.total, mtime=excluded.mtime'
      ).bind(uid, body, body.length, total, now).run();
      return json({ ok: true });
    }
  }

  /* ---- 后台：以下全部要管理员 Cookie ---- */
  if (path.startsWith('/api/admin/')) {
    if (!(await isAdmin(request, env))) {
      return json({ ok: false, err: 'no-auth', msg: '后台会话已失效，请重新输入密钥' }, 401);
    }

    if (path === '/api/admin/overview') {
      const st = await env.DB.prepare(
        'SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b, COALESCE(SUM(total),0) AS t FROM saves'
      ).first();
      const top = await env.DB.prepare(
        'SELECT s.uid AS uid, s.total AS total, u.name AS name FROM saves s ' +
        'LEFT JOIN users u ON u.uid = s.uid ORDER BY s.total DESC LIMIT 1'
      ).first();
      const bootAt = Number(await metaGet(env, 'bootAt', '0')) || nowSec();
      return json({
        ok: true,
        players: st.n,
        pulls: st.t,
        bytes: st.b,
        uptimeSec: nowSec() - bootAt,
        topPid: top ? (top.name || top.uid) : null,
        topPulls: top ? top.total : 0,
        port: '443 (Cloudflare)',
        www: 'Workers 静态资源 (public/)',
        data: 'Cloudflare D1 · gacha',
        serverTime: Date.now()
      });
    }

    if (path === '/api/admin/saves') {
      const rs = await env.DB.prepare(
        'SELECT s.uid AS uid, s.data AS data, s.bytes AS bytes, s.mtime AS mtime, u.name AS name ' +
        'FROM saves s LEFT JOIN users u ON u.uid = s.uid ORDER BY s.mtime DESC LIMIT 500'
      ).all();
      const players = (rs.results || []).map(function (r) {
        return {
          pid: r.uid, uid: r.uid, name: r.name || null,
          raw: r.data, bytes: r.bytes, mtime: r.mtime
        };
      });
      return json({ ok: true, players: players });
    }

    if (path === '/api/admin/users') {
      const rs = await env.DB.prepare(
        'SELECT u.uid AS uid, u.name AS name, u.created AS created, ' +
        'COALESCE(u.last_seen,0) AS last_seen, ' +
        'COALESCE(s.bytes,0) AS bytes, COALESCE(s.total,0) AS pulls, COALESCE(s.mtime,0) AS mtime ' +
        'FROM users u LEFT JOIN saves s ON s.uid = u.uid ORDER BY u.created DESC LIMIT 500'
      ).all();
      const users = rs.results || [];
      return json({ ok: true, users: users, count: users.length });
    }

    /* 重置某个玩家的密码。密码是 PBKDF2 哈希存的，原文没法反推出来，
       所以「查看密码」这件事在技术上不存在；能给的是「换一个新密码」。 */
    if (path === '/api/admin/user/pass' && method === 'POST') {
      const form = parseForm(await request.text());
      const uid = String(form.uid || '');
      if (!uid) return json({ ok: false, err: 'no-uid' }, 400);
      const row = await env.DB.prepare('SELECT name FROM users WHERE uid=?').bind(uid).first();
      if (!row) return json({ ok: false, err: 'no-user', msg: '没有这个账号' }, 404);
      const pw = genPassword();
      await env.DB.prepare('UPDATE users SET pass=? WHERE uid=?').bind(await pwMake(pw), uid).run();
      return json({ ok: true, name: row.name, pass: pw });
    }

    if (path === '/api/admin/user/delete' && method === 'POST') {
      const form = parseForm(await request.text());
      const uid = String(form.uid || '');
      if (!uid) return json({ ok: false, err: 'no-uid' }, 400);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM saves WHERE uid=?').bind(uid),
        env.DB.prepare('DELETE FROM users WHERE uid=?').bind(uid)
      ]);
      return json({ ok: true });
    }

    if (path === '/api/admin/invites') {
      const rs = await env.DB.prepare(
        'SELECT code, used, uid, created, used_at FROM invites ORDER BY created DESC LIMIT 500'
      ).all();
      const rows = rs.results || [];
      const invites = rows.map(function (r) {
        return { code: r.code, used: r.used, uid: r.uid, created: r.created, usedAt: r.used_at };
      });
      const fresh = invites.filter(function (i) { return !i.used; }).length;
      return json({ ok: true, invites: invites, count: invites.length, fresh: fresh });
    }

    if (path === '/api/admin/invite/new' && method === 'POST') {
      let code = genCode();
      for (let i = 0; i < 5; i++) {
        const dup = await env.DB.prepare('SELECT code FROM invites WHERE code=?').bind(code).first();
        if (!dup) break;
        code = genCode();
      }
      await env.DB.prepare('INSERT INTO invites(code,used,created) VALUES(?,0,?)')
        .bind(code, nowSec()).run();
      return json({ ok: true, code: code });
    }

    if (path === '/api/admin/invite/delete' && method === 'POST') {
      const form = parseForm(await request.text());
      const code = String(form.code || '').toUpperCase();
      if (!code) return json({ ok: false, err: 'no-code' }, 400);
      await env.DB.prepare('DELETE FROM invites WHERE code=?').bind(code).run();
      return json({ ok: true });
    }

    if (path === '/api/admin/logs') {
      const rs = await env.DB.prepare(
        'SELECT line FROM logs ORDER BY id DESC LIMIT 300'
      ).all();
      const logs = (rs.results || []).map(function (r) { return r.line; }).reverse();
      return json({ ok: true, logs: logs });
    }

    if (path === '/api/admin/delete' && method === 'POST') {
      const form = parseForm(await request.text());
      const pid = String(form.pid || '');
      if (!pid) return json({ ok: false, err: 'no-pid' }, 400);
      await env.DB.prepare('DELETE FROM saves WHERE uid=?').bind(pid).run();
      return json({ ok: true });
    }

    if (path === '/api/admin/restart' && method === 'POST') {
      // Workers 上没有进程可重启。改一个 boot 号，前端每 5 秒轮询 /api/health
      // 发现变了就会自己刷新，效果等价于「让所有人重新加载」。
      await metaSet(env, 'boot', String(Date.now()));
      return json({ ok: true, msg: 'Cloudflare 上不需要重启进程，已通知所有客户端刷新' });
    }
  }

  return json({ ok: false, err: 'no-route', msg: '没有这个接口' }, 404);
}

async function bootOnce(env) {
  const v = String(Date.now());
  await metaSet(env, 'boot', v);
  await metaSet(env, 'bootAt', String(nowSec()));
  return Number(v);
}

/* ================================================================== */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      const res = await env.ASSETS.fetch(request);
      if (res.status === 304 || res.status === 204) return res;
      const h = new Headers(res.headers);
      const ct = h.get('content-type') || '';
      if (ct.indexOf('text/html') >= 0) {
        // HTML 绝对不能缓存：它里面带着 style.css?v=<内容摘要> / app.js?v=<内容摘要>，
        // 一旦被 Cloudflare 边缘缓存住，新的版本号就永远传不出去，
        // 用户会一直加载旧 CSS/JS —— 本站已经被这个坑过一次。
        h.set('Cache-Control', 'no-store, must-revalidate');
        h.set('CDN-Cache-Control', 'no-store');
      } else if (url.searchParams.has('v')) {
        // 带内容摘要的 CSS/JS：内容一变 URL 就变，可以放心长缓存
        h.set('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        h.set('Cache-Control', 'public, max-age=300');
      }
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    }

    let status = 500;
    try {
      const res = await handleApi(request, env, url, ctx);
      status = res.status;
      if (request.method !== 'GET') {
        ctx.waitUntil(addLog(env, clientIp(request), request.method, url.pathname, status));
      }
      return res;
    } catch (e) {
      status = 500;
      try {
        ctx.waitUntil(addLog(env, clientIp(request), request.method, url.pathname, status));
      } catch (e2) { /* 忽略 */ }
      return json({ ok: false, err: 'server', msg: '服务器出错了：' + (e && e.message ? e.message : String(e)) }, 500);
    }
  }
};
