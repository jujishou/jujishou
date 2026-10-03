/* ===================== 星海抽卡 · 逻辑 ===================== */
'use strict';

/* ---------- 稀有度档位 ---------- */
const TIER_ORDER = ['UR', 'SSR', 'SR', 'R'];
const RARITY = {
  UR:  { stars: 6, label: 'UR',  alias: '大隐藏' },
  SSR: { stars: 5, label: 'SSR' },
  SR:  { stars: 4, label: 'SR' },
  R:   { stars: 3, label: 'R' },
};

/* ---------- 卡面：只使用用户提供的图片 ---------- */
const CARDS = {
  shadow: {
    id: 'shadow', name: '夜瞳', art: 'art/shadow.jpg',
    fit: 'cover', pos: '50% 44%', note: '黑发红瞳，在训练场等了很久',
  },
  blueset: {
    id: 'blueset', name: '蓝耳机', art: 'art/blueset.jpg',
    fit: 'cover', pos: '50% 46%', note: '永远睡不醒的方块脸',
  },
  memorial: {
    id: 'memorial', name: '永远怀念', art: 'art/memorial.jpg',
    fit: 'contain', pos: '50% 50%', note: '奠 —— 已经退游的老朋友',
  },
  block: {
    id: 'block', name: '方块白', art: 'art/block.webp',
    fit: 'cover', pos: '50% 50%', note: '一身石灰色，站得很稳',
  },
  cat: {
    id: 'cat', name: '橘座', art: 'art/cat.jpg',
    fit: 'cover', pos: '50% 44%', note: '盯————',
  },
};

/* ---------- 两个卡池 ---------- */
const PITY_SR = 10;   // 十连保底
const PITY_UR = 120;  // 大隐藏硬保底

const POOLS = [
  {
    id: 'p1',
    tab: '卡池一',
    name: '夜瞳 · 限定',
    desc: '黑发红瞳的限定池',
    rates: { UR: 3, SR: 51, R: 946 },   // 千分比：0.3% / 5.1% / 94.6%
    pityUR: PITY_UR,
    note: '大隐藏：夜瞳',
    entries: [
      { id: 'shadow',   rarity: 'UR' },
      { id: 'blueset',  rarity: 'SR' },
      { id: 'memorial', rarity: 'R'  },
    ],
  },
  {
    id: 'p2',
    tab: '卡池二',
    name: '方块 · 限定',
    desc: '本池没有 SR，SR 概率并入 R',
    rates: { UR: 3, R: 997 },          // 千分比：0.3% / 99.7%
    pityUR: PITY_UR,
    note: '大隐藏：方块白',
    entries: [
      { id: 'block', rarity: 'UR' },
      { id: 'cat',   rarity: 'R'  },
    ],
  },
];

const POOL_BY_ID = {};
POOLS.forEach(function (p) { POOL_BY_ID[p.id] = p; });

function entriesOf(pool, rarity) {
  return pool.entries.filter(function (e) { return e.rarity === rarity; });
}
function hasTier(pool, rarity) {
  return entriesOf(pool, rarity).length > 0;
}
function presentTiers(pool) {
  return TIER_ORDER.filter(function (t) { return hasTier(pool, t); });
}
function rateList(pool) {
  return presentTiers(pool).map(function (t) {
    return { tier: t, text: t + ' ' + (pool.rates[t] / 10).toFixed(1) + '%' };
  });
}

/* ---------- 存档 ---------- */
const SAVE_KEY = 'starfall-gacha-v2';
const ADMIN_HASH = '2b46f9829d5fa6054d5ff43a2c150ddf8f2f1ff55348f61fd16db878c03fa3aa';
const ADMIN_SESSION = 'starfall-admin-session';
const ADMIN_REMEMBER = 'starfall-admin-remember';

function blankPool() {
  return { pulls: 0, pityUR: 0, pitySR: 0, got: {} };
}

function blank() {
  const pools = {};
  POOLS.forEach(function (p) { pools[p.id] = blankPool(); });
  return {
    v: 2,
    total: 0,
    current: POOLS[0].id,
    pools: pools,
    counts: {},
    history: [],
    muted: false,
  };
}

function load() {
  const s = blank();
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return s;
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object') return s;
    s.total = Number(d.total) || 0;
    s.muted = !!d.muted;
    s.counts = (d.counts && typeof d.counts === 'object') ? d.counts : {};
    s.history = Array.isArray(d.history) ? d.history.slice(0, 300) : [];
    if (POOL_BY_ID[d.current]) s.current = d.current;
    POOLS.forEach(function (p) {
      const src = (d.pools && d.pools[p.id]) || {};
      const dst = s.pools[p.id];
      dst.pulls = Number(src.pulls) || 0;
      dst.pityUR = Number(src.pityUR) || 0;
      dst.pitySR = Number(src.pitySR) || 0;
      dst.got = (src.got && typeof src.got === 'object') ? src.got : {};
    });
  } catch (e) { /* 存档损坏则用空白档 */ }
  return s;
}

function save() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch (e) { /* 隐私模式忽略 */ }
}

const state = load();

function currentPool() {
  return POOL_BY_ID[state.current] || POOLS[0];
}
function poolState(pool) {
  return state.pools[pool.id];
}

/* ---------- 抽卡核心 ---------- */
function rollTier(pool) {
  const tiers = presentTiers(pool);
  let sum = 0;
  tiers.forEach(function (t) { sum += (pool.rates[t] || 0); });
  if (sum <= 0) return tiers[tiers.length - 1];
  let roll = Math.random() * sum;
  for (let i = 0; i < tiers.length; i++) {
    roll -= (pool.rates[tiers[i]] || 0);
    if (roll < 0) return tiers[i];
  }
  return tiers[tiers.length - 1];
}

function pickRarity(pool, ps) {
  const srOn = hasTier(pool, 'SR');
  ps.pityUR++;
  if (srOn) ps.pitySR++;

  let rarity;
  if (ps.pityUR >= pool.pityUR) rarity = 'UR';
  else if (srOn && ps.pitySR >= PITY_SR) rarity = 'SR';
  else rarity = rollTier(pool);

  if (rarity === 'UR') { ps.pityUR = 0; ps.pitySR = 0; }
  else if (rarity !== 'R') { ps.pitySR = 0; }
  return rarity;
}

function drawOne(poolId) {
  const pool = POOL_BY_ID[poolId] || currentPool();
  const ps = poolState(pool);
  const rarity = pickRarity(pool, ps);
  const list = entriesOf(pool, rarity);
  const entry = list[Math.floor(Math.random() * list.length)];
  const card = CARDS[entry.id];

  ps.pulls++;
  ps.got[rarity] = (ps.got[rarity] || 0) + 1;
  state.total++;
  state.counts[card.id] = (state.counts[card.id] || 0) + 1;

  const rec = {
    no: state.total,
    pool: pool.id,
    poolName: pool.name,
    id: card.id,
    name: card.name,
    rarity: rarity,
  };
  state.history.unshift(rec);
  if (state.history.length > 300) state.history.length = 300;

  return Object.assign({}, rec, { card: card });
}

/* 大隐藏未获得前显示 ??? */
function displayName(card, rarity) {
  if (rarity === 'UR' && !state.counts[card.id]) return '???';
  return card.name;
}
function isLocked(card, rarity) {
  return rarity === 'UR' && !state.counts[card.id];
}

/* ---------- 音效 ---------- */
let audioCtx = null;
function beep(rarity) {
  if (state.muted) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const notes =
      rarity === 'UR'  ? [523, 659, 784, 1047, 1319] :
      rarity === 'SSR' ? [523, 659, 784, 1047] :
      rarity === 'SR'  ? [440, 587] : [330];
    const vol = rarity === 'R' ? 0.05 : (rarity === 'UR' ? 0.14 : 0.12);
    notes.forEach(function (freq, i) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      const t0 = audioCtx.currentTime + i * 0.07;
      osc.type = rarity === 'R' ? 'triangle' : 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.34);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.36);
    });
  } catch (e) { /* 无音频环境则静默 */ }
}

/* ---------- DOM ---------- */
const $ = function (id) { return document.getElementById(id); };
const stage = $('stage');
const logEl = $('log');
const statsEl = $('stats');
const tabsEl = $('tabs');
const ratesEl = $('rates');
const galleryEl = $('gallery');
const galleryNoteEl = $('galleryNote');
const pull1Btn = $('pull1');
const pull10Btn = $('pull10');
const flashEl = $('flash');
const flashUREl = $('flashUR');
const skyEl = $('sky');
const muteBtn = $('muteBtn');
const modalEl = $('adminModal');
const adminBodyEl = $('adminBody');
const adminTitleEl = $('adminTitle');

/* 背景星点 */
(function makeSky() {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 70; i++) {
    const s = document.createElement('i');
    const size = (1 + Math.random() * 2).toFixed(1);
    s.style.left = Math.random() * 100 + '%';
    s.style.top = Math.random() * 100 + '%';
    s.style.width = size + 'px';
    s.style.height = size + 'px';
    s.style.animationDelay = (Math.random() * 3).toFixed(2) + 's';
    frag.appendChild(s);
  }
  skyEl.appendChild(frag);
})();

/* ---------- 渲染 ---------- */
function artStyle(card) {
  return 'object-fit:' + card.fit + ';object-position:' + card.pos + ';';
}

function cardEl(item) {
  const card = item.card || CARDS[item.id];
  const r = RARITY[item.rarity];
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.rarity = item.rarity;
  el.innerHTML =
    '<div class="card-inner">' +
      '<div class="card-face card-back">✦<span>星海</span></div>' +
      '<div class="card-face card-front">' +
        '<img class="art" src="' + card.art + '" alt="' + displayName(card, item.rarity) + '" style="' + artStyle(card) + '">' +
        '<span class="tag">' + r.label + '</span>' +
        '<div class="scrim">' +
          '<div class="cname">' + displayName(card, item.rarity) + '</div>' +
          '<div class="stars">' + '★'.repeat(r.stars) + '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  const img = el.querySelector('.art');
  img.src = card.art;
  el.addEventListener('click', function () { el.classList.toggle('flipped'); });
  return el;
}

let busy = false;

function renderResults(items) {
  stage.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'results' + (items.length === 1 ? ' single' : '');

  items.forEach(function (it, i) {
    const card = cardEl(it);
    wrap.appendChild(card);
    setTimeout(function () {
      card.classList.add('pop', 'flipped');
      beep(it.rarity);
      if (it.rarity === 'UR' || it.rarity === 'SSR') {
        const fx = it.rarity === 'UR' ? flashUREl : flashEl;
        fx.classList.remove('on');
        void fx.offsetWidth;   // 重启动画
        fx.classList.add('on');
      }
    }, 120 + i * (items.length === 1 ? 0 : 110));
  });

  stage.appendChild(wrap);
}

function renderTabs() {
  if (!tabsEl) return;
  tabsEl.innerHTML = '';
  POOLS.forEach(function (p) {
    const b = document.createElement('button');
    const on = p.id === state.current;
    b.className = 'tab' + (on ? ' on' : '');
    b.innerHTML = '<b>' + p.tab + '</b><small>' + p.name + '</small>';
    b.addEventListener('click', function () {
      if (busy || state.current === p.id) return;
      state.current = p.id;
      save();
      stage.innerHTML = '<p class="hint">已切换到「' + p.name + '」，点击下方按钮开始抽卡 ✦</p>';
      renderAll();
    });
    tabsEl.appendChild(b);
  });
}

function renderBanner() {
  const pool = currentPool();
  ratesEl.innerHTML = rateList(pool).map(function (r) {
    return '<span class="rate ' + r.tier.toLowerCase() + '">' + r.text + '</span>';
  }).join('') + '<span class="rate-note">' + pool.desc + '</span>';

  const ps = poolState(pool);
  $('pityLabel').textContent = ps.pityUR + ' / ' + pool.pityUR;
  $('pityFill').style.width = Math.min(100, (ps.pityUR / pool.pityUR) * 100) + '%';

  const row = $('pity4Row');
  if (hasTier(pool, 'SR')) {
    row.hidden = false;
    $('pity4Label').textContent = ps.pitySR + ' / ' + PITY_SR;
  } else {
    row.hidden = true;
  }
}

function renderStats() {
  const pool = currentPool();
  const ps = poolState(pool);
  const ur = ps.got.UR || 0;
  const sr = ps.got.SR || 0;
  const rate = ps.pulls ? ((ur / ps.pulls) * 100).toFixed(2) + '%' : '—';
  const cards = [
    { k: '本池抽数', v: ps.pulls, cls: '' },
    { k: '大隐藏', v: ur, cls: 'ur' },
    { k: 'SR 出货', v: sr, cls: 'sr' },
    { k: '本池出金率', v: rate, cls: 'ur' },
    { k: '距大保底', v: Math.max(0, pool.pityUR - ps.pityUR) + ' 抽', cls: '' },
    { k: '全站总抽数', v: state.total, cls: '' },
  ];
  statsEl.innerHTML = cards.map(function (c) {
    return '<div class="stat ' + c.cls + '"><b>' + c.v + '</b><span>' + c.k + '</span></div>';
  }).join('');
}

function renderGallery() {
  const pool = currentPool();
  galleryEl.innerHTML = pool.entries.map(function (e) {
    const card = CARDS[e.id];
    const locked = isLocked(card, e.rarity);
    const n = state.counts[card.id] || 0;
    return '<div class="gitem' + (locked ? ' locked' : '') + '" data-rarity="' + e.rarity + '">' +
      '<img alt="' + card.name + '" style="' + artStyle(card) + '" src="' + card.art + '" loading="lazy">' +
      '<span class="gtag">' + RARITY[e.rarity].label + '</span>' +
      '<div class="gscrim">' +
        '<span class="gname">' + displayName(card, e.rarity) + '</span>' +
        '<span class="gcount">×' + n + '</span>' +
      '</div>' +
    '</div>';
  }).join('');
  const hasLocked = pool.entries.some(function (e) { return isLocked(CARDS[e.id], e.rarity); });
  galleryNoteEl.textContent = hasLocked ? '大隐藏未获得前显示 ???' : '本池卡面已全部解锁';
}

function renderLog() {
  if (!state.history.length) {
    logEl.innerHTML = '<li class="empty">还没有抽卡记录，去试试手气吧</li>';
    return;
  }
  logEl.innerHTML = state.history.slice(0, 50).map(function (h) {
    return '<li>' +
      '<span class="pill ' + h.rarity + '">' + h.rarity + '</span>' +
      '<span class="li-name">' + h.name + '</span>' +
      '<span class="li-pool">' + (h.poolName || '') + '</span>' +
      '<span class="li-no">#' + h.no + '</span>' +
    '</li>';
  }).join('');
}

function renderAll() {
  renderTabs();
  renderBanner();
  renderStats();
  renderGallery();
  renderLog();
  muteBtn.textContent = state.muted ? '🔇' : '🔊';
  refreshAdminLive();
}

/* ---------- 抽卡交互 ---------- */
function pull(n) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('.btn').forEach(function (b) { b.disabled = true; });

  const poolId = state.current;
  const items = [];
  for (let i = 0; i < n; i++) items.push(drawOne(poolId));

  save();
  renderResults(items);
  renderStats();
  renderBanner();
  renderGallery();
  setTimeout(renderLog, 200);
  setTimeout(refreshAdminLive, 60);

  setTimeout(function () {
    busy = false;
    document.querySelectorAll('.btn').forEach(function (b) { b.disabled = false; });
  }, 120 + items.length * 110 + 700);
}

pull1Btn.addEventListener('click', function () { pull(1); });
pull10Btn.addEventListener('click', function () { pull(10); });

muteBtn.addEventListener('click', function () {
  state.muted = !state.muted;
  save();
  renderAll();
});

$('resetBtn').addEventListener('click', function () {
  if (!confirm('确定要清空全部卡池的抽卡记录、图鉴与保底进度吗？')) return;
  Object.assign(state, blank());
  save();
  stage.innerHTML = '<p class="hint">选择卡池，点击下方按钮开始抽卡 ✦</p>';
  renderAll();
});

document.addEventListener('keydown', function (e) {
  if (e.code === 'Space' && !e.repeat && (!modalEl || modalEl.hidden)) {
    e.preventDefault();
    pull(1);
  }
});

/* ===================== 后台 ===================== */
function sha256hex(text) {
  if (!(window.crypto && window.crypto.subtle)) {
    return Promise.reject(new Error('当前环境不支持 Web Crypto（需要 HTTPS 或 localhost）'));
  }
  const data = new TextEncoder().encode(text);
  return window.crypto.subtle.digest('SHA-256', data).then(function (buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) {
      return b.toString(16).padStart(2, '0');
    }).join('');
  });
}

function isUnlocked() {
  try {
    return sessionStorage.getItem(ADMIN_SESSION) === '1'
        || localStorage.getItem(ADMIN_REMEMBER) === ADMIN_HASH;
  } catch (e) { return false; }
}

function unlock(remember) {
  try {
    sessionStorage.setItem(ADMIN_SESSION, '1');
    if (remember) localStorage.setItem(ADMIN_REMEMBER, ADMIN_HASH);
  } catch (e) { /* 忽略 */ }
}

function lockAdmin() {
  try {
    sessionStorage.removeItem(ADMIN_SESSION);
    localStorage.removeItem(ADMIN_REMEMBER);
  } catch (e) { /* 忽略 */ }
}

function openAdmin() {
  modalEl.hidden = false;
  renderAdmin();
}

function closeAdmin() {
  modalEl.hidden = true;
  stopAdminTimer();
}

/* --- 后台界面 --- */
function renderAdmin() {
  if (!isUnlocked()) {
    renderGate();
    return;
  }
  adminTitleEl.textContent = '后台控制台';
  adminBodyEl.innerHTML =
    '<div class="sect">' +
      '<h3>数据总览（自动刷新）</h3>' +
      '<div class="kv" id="adminLive"></div>' +
    '</div>' +
    '<div class="sect">' +
      '<h3>卡池明细</h3>' +
      '<div class="kv" id="adminPools"></div>' +
    '</div>' +
    '<div class="sect">' +
      '<h3>存档管理</h3>' +
      '<div class="arow">' +
        '<button class="btn-sm" id="aExport">导出存档 JSON</button>' +
        '<button class="btn-sm" id="aImport">导入存档</button>' +
        '<button class="btn-sm" id="aResetPity">重置本池保底</button>' +
        '<button class="btn-sm danger" id="aClear">清空全部数据</button>' +
      '</div>' +
      '<input type="file" id="aFile" accept=".json,application/json" hidden>' +
      '<p class="msg" id="aMsg"></p>' +
    '</div>' +
    '<div class="sect">' +
      '<h3>密钥工具</h3>' +
      '<div class="arow"><button class="btn-sm" id="aKey">生成一枚新密钥</button></div>' +
      '<div id="aKeyOut"></div>' +
      '<p class="note">新密钥生成后，把它的 SHA-256 写进 <code>app.js</code> 的 <code>ADMIN_HASH</code> 即可启用；本页不修改代码，只给出哈希。</p>' +
    '</div>' +
    '<div class="sect">' +
      '<h3>原始存档</h3>' +
      '<code class="code" id="adminRaw"></code>' +
    '</div>' +
    '<div class="sect">' +
      '<div class="arow"><button class="btn-sm danger" id="aLock">退出后台</button></div>' +
      '<p class="warn">这是纯前端后台：站点是静态页，没有服务器，所以它只能读写「当前这台设备浏览器里」的存档，无法汇总其他访客的数据。密钥校验也在本地，懂技术的人翻源码可以绕过——它挡的是随手点进来的人，不是攻击者。</p>' +
    '</div>';

  $('aExport').addEventListener('click', exportSave);
  $('aImport').addEventListener('click', function () { $('aFile').click(); });
  $('aFile').addEventListener('change', importSave);
  $('aResetPity').addEventListener('click', function () {
    const ps = poolState(currentPool());
    ps.pityUR = 0; ps.pitySR = 0;
    save(); renderAll();
    adminMsg('已重置「' + currentPool().name + '」的保底进度', 'good');
  });
  $('aClear').addEventListener('click', function () {
    if (!confirm('确定要清空全部数据吗？此操作不可撤销。')) return;
    Object.assign(state, blank());
    save(); renderAll();
    adminMsg('已清空全部数据', 'good');
  });
  $('aKey').addEventListener('click', generateKey);
  $('aLock').addEventListener('click', function () {
    lockAdmin(); closeAdmin(); renderAll();
  });

  refreshAdminLive();
  startAdminTimer();
}

function renderGate() {
  adminTitleEl.textContent = '后台入口';
  adminBodyEl.innerHTML =
    '<p class="note">请输入专属密钥。密钥由管理员生成，只在获取后可见。</p>' +
    '<div class="field" style="margin-top:12px">' +
      '<input type="password" id="aKeyInput" placeholder="DSH-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false">' +
      '<button class="btn-sm" id="aKeyGo">进入后台</button>' +
    '</div>' +
    '<p class="msg" id="aMsg"></p>' +
    '<p class="note">输入后按回车也可以直接进入。</p>';
  $('aKeyGo').addEventListener('click', tryUnlock);
  $('aKeyInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') tryUnlock();
  });
}

function adminMsg(text, cls) {
  const el = $('aMsg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'msg ' + (cls || '');
}

function tryUnlock() {
  const input = $('aKeyInput');
  const raw = (input && input.value || '').trim().toUpperCase();
  if (!raw) { adminMsg('请输入密钥', 'bad'); return; }
  adminMsg('校验中…', '');
  sha256hex(raw).then(function (hex) {
    if (hex === ADMIN_HASH) {
      unlock(true);
      adminMsg('密钥正确，正在进入…', 'good');
      setTimeout(function () {
        renderAdmin();
        startAdminTimer();
      }, 320);
    } else {
      adminMsg('密钥不正确', 'bad');
    }
  }).catch(function (err) {
    adminMsg(err.message || '校验失败', 'bad');
  });
}

function refreshAdminLive() {
  if (!modalEl || modalEl.hidden || !isUnlocked()) return;
  const live = $('adminLive');
  const pools = $('adminPools');
  const raw = $('adminRaw');
  if (!live) return;

  const all = {};
  TIER_ORDER.forEach(function (t) { all[t] = 0; });
  let pulls = 0;
  POOLS.forEach(function (p) {
    const ps = poolState(p);
    pulls += ps.pulls;
    TIER_ORDER.forEach(function (t) { all[t] += (ps.got[t] || 0); });
  });
  const rate = pulls ? ((all.UR / pulls) * 100).toFixed(2) + '%' : '—';

  live.innerHTML =
    '<div><b>' + pulls + '</b><span>总抽数</span></div>' +
    '<div class="ur"><b>' + all.UR + '</b><span>大隐藏</span></div>' +
    '<div class="sr"><b>' + all.SR + '</b><span>SR 出货</span></div>' +
    '<div><b>' + all.R + '</b><span>R 出货</span></div>' +
    '<div class="ur"><b>' + rate + '</b><span>综合出金率</span></div>' +
    '<div><b>' + state.history.length + '</b><span>记录条数</span></div>';

  if (pools) {
    pools.innerHTML = POOLS.map(function (p) {
      const ps = poolState(p);
      const cur = p.id === state.current ? '（当前）' : '';
      return '<div><b>' + ps.pulls + '</b><span>' + p.name + cur + '<br>保底 ' + ps.pityUR + '/' + p.pityUR +
        ' · 大隐藏 ×' + (ps.got.UR || 0) + '</span></div>';
    }).join('');
  }
  if (raw) raw.textContent = JSON.stringify(state, null, 2);
}

let adminTimer = null;
function startAdminTimer() {
  stopAdminTimer();
  adminTimer = setInterval(refreshAdminLive, 1000);
}
function stopAdminTimer() {
  if (adminTimer) { clearInterval(adminTimer); adminTimer = null; }
}

function exportSave() {
  const text = JSON.stringify(state, null, 2);
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '星海抽卡-存档-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  adminMsg('已导出存档文件', 'good');
}

function importSave(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function () {
    try {
      const d = JSON.parse(String(reader.result));
      if (!d || typeof d !== 'object' || !d.pools) throw new Error('文件格式不对');
      try { localStorage.setItem(SAVE_KEY, JSON.stringify(d)); } catch (err) { /* 忽略 */ }
      Object.assign(state, load());
      save(); renderAll();
      adminMsg('导入成功，数据已刷新', 'good');
    } catch (err) {
      adminMsg('导入失败：' + (err.message || '解析错误'), 'bad');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

function generateKey() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const g = function () {
    let s = '';
    const arr = new Uint32Array(4);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(arr);
    for (let i = 0; i < 4; i++) {
      const v = arr[i] || Math.floor(Math.random() * 4294967296);
      s += A[v % A.length];
    }
    return s;
  };
  const key = 'DSH-' + g() + '-' + g() + '-' + g();
  const out = $('aKeyOut');
  sha256hex(key).then(function (hex) {
    out.innerHTML =
      '<div class="keybox">' + key + '</div>' +
      '<p class="note">这一串只显示这一次，请立刻复制保存。</p>' +
      '<p class="note">它的 SHA-256（写进 app.js 的 ADMIN_HASH）：</p>' +
      '<code class="code">' + hex + '</code>';
  }).catch(function (err) {
    out.innerHTML = '<p class="msg bad">' + (err.message || '生成失败') + '</p>';
  });
}

/* ---------- 后台入口绑定 ---------- */
$('adminBtn').addEventListener('click', openAdmin);
$('adminClose').addEventListener('click', closeAdmin);
modalEl.addEventListener('click', function (e) {
  if (e.target === modalEl) closeAdmin();
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && !modalEl.hidden) closeAdmin();
});

/* ---------- 启动 ---------- */
renderAll();
