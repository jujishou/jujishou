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
const ADMIN_SESSION = 'starfall-admin-session';

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

function parseSave(d) {
  const s = blank();
  if (!d || typeof d !== 'object') return s;
  try {
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

function load() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return blank();
    return parseSave(JSON.parse(raw));
  } catch (e) { return blank(); }
}

/* ---------- 服务端存档同步 ---------- */
let pushTimer = null;

function pushSave() {
  pushTimer = null;
  try {
    fetch('api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify(state)
    }).catch(function () { /* 离线就只留本地 */ });
  } catch (e) { /* 忽略 */ }
}

function save() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch (e) { /* 隐私模式忽略 */ }
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(pushSave, 1500);
}

/* 探测服务端。静态托管（比如 GitHub Pages）上没有后端，
   这时把后台入口藏掉，免得点进去只看到一堆请求失败。 */
function probeServer() {
  try {
    return fetch('api/health', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        serverOnline = !!(d && d.ok);
        const btn = $('adminBtn');
        if (btn && !serverOnline) {
          btn.hidden = true;
          btn.style.display = 'none';
        }
        return serverOnline;
      })
      .catch(function () {
        serverOnline = false;
        const btn = $('adminBtn');
        if (btn) { btn.hidden = true; btn.style.display = 'none'; }
        return false;
      });
  } catch (e) { return Promise.resolve(false); }
}

/* 启动时若本地无进度，则认领服务端那份（换设备也能接着抽）。
   本地已有进度时以本地为准，避免旧存档把新进度盖掉。 */
function syncFromServer() {
  try {
    fetch('api/save', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.ok || !d.save) return;
        if (state.total > 0) return;
        const s = parseSave(d.save);
        if (s.total <= 0) return;
        state.total = s.total;
        state.muted = s.muted;
        state.counts = s.counts;
        state.history = s.history;
        state.current = s.current;
        state.pools = s.pools;
        try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch (e) {}
        renderAll();
      })
      .catch(function () {});
  } catch (e) { /* 忽略 */ }
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

/* 纯 JS SHA-256。
   本站跑在 http 上（不是安全上下文），浏览器不提供 crypto.subtle，
   所以自带一份实现：用户输入的密钥只在本机算成摘要后才离开浏览器。 */
function sha256hex(text) {
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
  var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
           0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
           0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
           0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
           0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
           0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
           0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
           0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  var bytes = [], i, c;

  for (i = 0; i < text.length; i++) {
    c = text.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) { bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
    else { bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
  }

  var bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  var hi = Math.floor(bitLen / 4294967296), lo = bitLen >>> 0;
  bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255);
  bytes.push((lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);

  var w = new Array(64);
  for (var off = 0; off < bytes.length; off += 64) {
    for (i = 0; i < 16; i++)
      w[i] = (bytes[off+i*4] << 24) | (bytes[off+i*4+1] << 16) | (bytes[off+i*4+2] << 8) | bytes[off+i*4+3];
    for (i = 16; i < 64; i++) {
      var s0 = rotr(w[i-15], 7) ^ rotr(w[i-15], 18) ^ (w[i-15] >>> 3);
      var s1 = rotr(w[i-2], 17) ^ rotr(w[i-2], 19) ^ (w[i-2] >>> 10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
    }
    var a=H[0],b=H[1],cc=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
    for (i = 0; i < 64; i++) {
      var S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
      var ch = (e & f) ^ (~e & g);
      var t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      var S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
      var maj = (a & b) ^ (a & cc) ^ (b & cc);
      var t2 = (S0 + maj) | 0;
      h=g; g=f; f=e; e=(d+t1)|0; d=cc; cc=b; b=a; a=(t1+t2)|0;
    }
    H[0]=(H[0]+a)|0;  H[1]=(H[1]+b)|0;  H[2]=(H[2]+cc)|0; H[3]=(H[3]+d)|0;
    H[4]=(H[4]+e)|0;  H[5]=(H[5]+f)|0;  H[6]=(H[6]+g)|0;  H[7]=(H[7]+h)|0;
  }
  return H.map(function (x) { return ('00000000' + (x >>> 0).toString(16)).slice(-8); }).join('');
}

/* --- 与服务端通信 --- */
function api(path, opts) {
  opts = opts || {};
  return fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
    body: opts.body || null,
    credentials: 'same-origin',
    cache: 'no-store'
  }).then(function (res) {
    return res.text().then(function (txt) {
      var data = null;
      try { data = JSON.parse(txt); } catch (e) { data = null; }
      return { status: res.status, ok: res.ok, data: data, text: txt };
    });
  });
}

/* 前端只记「我登录过」，真正的门在服务端：
   没有服务端签发的 HttpOnly Cookie，所有 /api/admin/* 一律 401。 */
function isUnlocked() {
  try { return sessionStorage.getItem(ADMIN_SESSION) === '1'; } catch (e) { return false; }
}
function unlock() { try { sessionStorage.setItem(ADMIN_SESSION, '1'); } catch (e) {} }
function lockAdmin() { try { sessionStorage.removeItem(ADMIN_SESSION); } catch (e) {} }

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
  if (!isUnlocked()) { renderGate(); return; }

  adminTitleEl.textContent = '后台控制台';
  adminBodyEl.innerHTML =
    '<div class="sect">' +
      '<h3>服务器状态<span id="aDot" class="dot">检测中…</span></h3>' +
      '<div class="kv" id="adminLive"></div>' +
    '</div>' +
    '<div class="sect">' +
      '<h3>玩家存档</h3>' +
      '<div id="adminPlayers" class="plist"></div>' +
    '</div>' +
    '<div class="sect">' +
      '<h3>审计日志</h3>' +
      '<pre class="code code-block" id="adminLogs">读取中…</pre>' +
    '</div>' +
    '<div class="sect">' +
      '<h3>本机存档</h3>' +
      '<div class="arow">' +
        '<button class="btn-sm" id="aExport">导出存档 JSON</button>' +
        '<button class="btn-sm" id="aImport">导入存档</button>' +
        '<button class="btn-sm" id="aResetPity">重置本池保底</button>' +
        '<button class="btn-sm danger" id="aClear">清空本机数据</button>' +
      '</div>' +
      '<input type="file" id="aFile" accept=".json,application/json" hidden>' +
      '<p class="msg" id="aMsg"></p>' +
    '</div>' +
    '<div class="sect">' +
      '<h3>本机原始存档</h3>' +
      '<code class="code code-block" id="adminRaw"></code>' +
    '</div>' +
    '<div class="sect">' +
      '<div class="arow"><button class="btn-sm danger" id="aLock">退出后台</button></div>' +
      '<p class="note">本后台由服务器校验：密钥经 PBKDF2-SHA256（12 万轮）加盐存储，服务端只比对摘要，' +
      '会话是 HMAC 签名的 HttpOnly Cookie。密钥明文不会存进任何文件，也不随请求上传——' +
      '浏览器先在本机把它算成 SHA-256 摘要再发送。</p>' +
    '</div>';

  $('aExport').addEventListener('click', exportSave);
  $('aImport').addEventListener('click', function () { $('aFile').click(); });
  $('aFile').addEventListener('change', importSave);
  $('aResetPity').addEventListener('click', function () {
    var ps = poolState(currentPool());
    ps.pityUR = 0; ps.pitySR = 0;
    save(); renderAll();
    adminMsg('已重置「' + currentPool().name + '」的保底进度', 'good');
  });
  $('aClear').addEventListener('click', function () {
    if (!confirm('确定要清空本机数据吗？此操作不可撤销。')) return;
    Object.assign(state, blank());
    save(); renderAll();
    adminMsg('已清空本机数据', 'good');
  });
  $('aLock').addEventListener('click', function () {
    api('/api/logout', { method: 'POST', body: '' }).then(function () {
      lockAdmin(); closeAdmin(); renderAll();
    });
  });

  refreshAdminLive();
  startAdminTimer();
}

function renderGate() {
  adminTitleEl.textContent = '后台入口';
  adminBodyEl.innerHTML =
    '<p class="note">请输入专属密钥。校验在服务器上进行，错误尝试会被限速。</p>' +
    '<div class="field" style="margin-top:12px">' +
      '<input type="password" id="aKeyInput" placeholder="DSH-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false">' +
      '<button class="btn-sm" id="aKeyGo">进入后台</button>' +
    '</div>' +
    '<p class="msg" id="aMsg"></p>' +
    '<p class="note">输入后按回车也可以直接进入。密钥明文只在本机算成摘要，不会原样发出。</p>';
  $('aKeyGo').addEventListener('click', tryUnlock);
  $('aKeyInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') tryUnlock();
  });
}

function adminMsg(text, cls) {
  var el = $('aMsg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'msg ' + (cls || '');
}

function tryUnlock() {
  var input = $('aKeyInput');
  var raw = (input && input.value || '').trim().toUpperCase();
  if (!raw) { adminMsg('请输入密钥', 'bad'); return; }
  adminMsg('校验中…', '');
  var cred = sha256hex(raw);
  api('/api/login', { method: 'POST', body: 'key=' + encodeURIComponent(cred) })
    .then(function (r) {
      if (r.ok && r.data && r.data.ok) {
        unlock();
        adminMsg('密钥正确，正在进入…', 'good');
        setTimeout(function () { renderAdmin(); }, 320);
      } else if (r.status === 429) {
        adminMsg('尝试次数过多，请等几分钟再试', 'bad');
      } else {
        adminMsg('密钥不正确', 'bad');
      }
    })
    .catch(function () { adminMsg('无法连接服务器', 'bad'); });
}

function fmtTime(sec) {
  var d = new Date(sec * 1000);
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + ' ' +
         p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function refreshAdminLive() {
  if (!modalEl || modalEl.hidden || !isUnlocked()) return;

  api('/api/admin/overview').then(function (r) {
    var dot = $('aDot'), live = $('adminLive');
    if (!dot || !live) return;
    if (r.status === 401) {
      dot.className = 'dot bad'; dot.textContent = '会话已失效';
      lockAdmin(); renderGate();
      adminMsg('登录已过期，请重新输入密钥', 'bad');
      return;
    }
    if (!r.ok || !r.data || !r.data.ok) { dot.className = 'dot bad'; dot.textContent = '异常'; return; }
    dot.className = 'dot good'; dot.textContent = '在线';
    live.innerHTML =
      '<div><b>' + r.data.players + '</b><span>玩家存档</span></div>' +
      '<div><b>' + r.data.pulls + '</b><span>记录总抽数</span></div>' +
      '<div><b>' + (r.data.bytes / 1024).toFixed(1) + ' KB</b><span>占用空间</span></div>' +
      '<div><b>' + r.data.port + '</b><span>服务端口</span></div>' +
      '<div><b>' + fmtTime(r.data.serverTime) + '</b><span>服务器时间</span></div>';
  }).catch(function () {
    var dot = $('aDot');
    if (dot) { dot.className = 'dot bad'; dot.textContent = '离线'; }
  });

  api('/api/admin/saves').then(function (r) {
    var box = $('adminPlayers');
    if (!box || !r.data || !r.data.ok) return;
    if (!r.data.players.length) { box.innerHTML = '<p class="note">还没有任何玩家存档。</p>'; return; }
    box.innerHTML = r.data.players.map(function (p) {
      var pulls = '—', ur = '—';
      try {
        var sv = JSON.parse(p.raw);
        pulls = sv.total || 0;
        var n = 0;
        if (sv.pools) Object.keys(sv.pools).forEach(function (k) { n += (sv.pools[k].got && sv.pools[k].got.UR) || 0; });
        ur = n;
      } catch (e) {}
      return '<details class="pitem"><summary><b>' + p.id.slice(0, 12) + '…</b>' +
             '<span>' + pulls + ' 抽 · 大隐藏 ×' + ur + ' · ' + p.bytes + 'B</span></summary>' +
             '<pre class="code code-block">' + p.raw.replace(/[<>&]/g, function (c) {
               return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c];
             }) + '</pre></details>';
    }).join('');
  }).catch(function () {});

  api('/api/admin/logs').then(function (r) {
    var box = $('adminLogs');
    if (!box || !r.data || !r.data.ok) return;
    box.textContent = r.data.logs.length ? r.data.logs.join('\n') : '（暂无日志）';
  }).catch(function () {});

  var raw = $('adminRaw');
  if (raw) raw.textContent = JSON.stringify(state, null, 2);
}

var adminTimer = null;
function startAdminTimer() {
  stopAdminTimer();
  adminTimer = setInterval(refreshAdminLive, 5000);
}
function stopAdminTimer() {
  if (adminTimer) { clearInterval(adminTimer); adminTimer = null; }
}

function exportSave() {
  var text = JSON.stringify(state, null, 2);
  var blob = new Blob([text], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'Jujishou测试-存档-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  adminMsg('已导出存档文件', 'good');
}

function importSave(e) {
  var file = e.target.files && e.target.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function () {
    try {
      var d = JSON.parse(String(reader.result));
      if (!d || typeof d !== 'object' || !d.pools) throw new Error('文件格式不对');
      Object.assign(state, d);
      save(); renderAll();
      adminMsg('导入成功，数据已刷新', 'good');
    } catch (err) {
      adminMsg('导入失败：' + (err.message || '解析错误'), 'bad');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
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
let serverOnline = false;
renderAll();
probeServer();
syncFromServer();
