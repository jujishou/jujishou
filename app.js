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
  suit: {
    id: 'suit', name: '西装客', art: 'art/suit.webp',
    fit: 'cover', pos: '50% 44%', note: '一身黑西装，怀里抱着不该出现在这儿的东西',
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
    desc: '方块世界里走出来的三位，两个是大隐藏',
    rates: { UR: 3, R: 997 },   // 千分比：0.3% / 99.7%（无 SR 卡，十连保底自动关闭）
    pityUR: PITY_UR,
    note: '大隐藏：方块白 / 西装客',
    entries: [
      { id: 'block', rarity: 'UR' },
      { id: 'suit',  rarity: 'UR' },
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
let serverBoot = null;
function probeServer() {
  try {
    return fetch('api/health', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        serverOnline = !!(d && d.ok);
        if (d && d.boot && serverBoot === null) serverBoot = d.boot;
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

/* 服务端每重启一次就换一个 boot 时间戳。盯着它：一旦变了，说明站长
   在后台点了「重启网站」（多半是刚更新了页面），于是自己刷新一次，
   在线的人不用手动刷新也能拿到新版本。 */
function watchRestart() {
  setInterval(function () {
    if (!serverOnline) return;
    try {
      fetch('api/health', { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d || !d.ok || !d.boot) return;
          if (serverBoot === null) { serverBoot = d.boot; return; }
          if (d.boot !== serverBoot) location.reload();
        })
        .catch(function () { /* 服务端正在重启，下一轮再看 */ });
    } catch (e) { /* 忽略 */ }
  }, 15000);
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
  const ac = ensureAudio();
  if (!ac) return;
  try {
    const notes =
      rarity === 'UR'  ? [523, 659, 784, 1047, 1319] :
      rarity === 'SSR' ? [523, 659, 784, 1047] :
      rarity === 'SR'  ? [440, 587] : [330];
    const vol = rarity === 'R' ? 0.05 : (rarity === 'UR' ? 0.14 : 0.12);
    notes.forEach(function (freq, i) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      const t0 = ac.currentTime + i * 0.07;
      osc.type = rarity === 'R' ? 'triangle' : 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.34);
      osc.connect(gain).connect(ac.destination);
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
  /* 44 颗而不是 70 颗：每颗都是一个独立的合成层，手机上数量比密度更影响帧率，
     少掉的这部分肉眼几乎看不出来。 */
  for (let i = 0; i < 44; i++) {
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
        '<img class="art" decoding="async" src="' + card.art + '" alt="' + displayName(card, item.rarity) + '" style="' + artStyle(card) + '">' +
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
      sfxSwitch();
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

/* ---------- 界面音效 ---------- */
/* 移动端 AudioContext 一开始是 suspended，必须借用户的一次点击把它唤醒。
   抽卡、切卡池都是点击触发的，所以放在这里 resume 最自然。 */
function ensureAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) { return null; }
  return audioCtx;
}

/* 通用「点一下」音：很短，频率往下滑一点，听着像 UI 反馈 */
function sfxTap(freq) {
  if (state.muted) return;
  const ac = ensureAudio();
  if (!ac) return;
  try {
    const f0 = freq || 1180;
    const t0 = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(f0 * 0.62, t0 + 0.055);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.05, t0 + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.075);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + 0.09);
  } catch (e) { /* 无音频环境则静默 */ }
}

/* 切换卡池：两个音往上走，像「翻过去了」 */
function sfxSwitch() {
  if (state.muted) return;
  const ac = ensureAudio();
  if (!ac) return;
  try {
    [660, 988].forEach(function (f, i) {
      const t0 = ac.currentTime + i * 0.062;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'triangle';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.062, t0 + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13);
      osc.connect(gain).connect(ac.destination);
      osc.start(t0);
      osc.stop(t0 + 0.15);
    });
  } catch (e) { /* 静默 */ }
}

/* 开面板、展开展开这类动作：一声轻轻的「嗒」 */
function sfxOpen() {
  if (state.muted) return;
  const ac = ensureAudio();
  if (!ac) return;
  try {
    const t0 = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(420, t0);
    osc.frequency.exponentialRampToValueAtTime(880, t0 + 0.09);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.045, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + 0.14);
  } catch (e) { /* 静默 */ }
}

/* 大隐藏卡片冲出来的那一刻：低频冲击 + 噪声「唰」+ 金属闪光。
   视频原声是留着的，所以这段只在「卡片阶段」响，跟视频声音不打架。 */
function sfxUltraCard() {
  if (state.muted) return;
  const ac = ensureAudio();
  if (!ac) return;
  try {
    const t0 = ac.currentTime;

    /* ① 低频冲击：180Hz 一屁股坐到底，就是那声「轰」 */
    const o1 = ac.createOscillator(), g1 = ac.createGain();
    o1.type = 'sine';
    o1.frequency.setValueAtTime(180, t0);
    o1.frequency.exponentialRampToValueAtTime(38, t0 + 0.5);
    g1.gain.setValueAtTime(0.0001, t0);
    g1.gain.exponentialRampToValueAtTime(0.17, t0 + 0.012);
    g1.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.62);
    o1.connect(g1).connect(ac.destination);
    o1.start(t0); o1.stop(t0 + 0.66);

    /* ② 噪声「唰」：白噪声过带通，从低沉一下扫到明亮 */
    const len = Math.floor(ac.sampleRate * 0.32);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ac.createBufferSource(); src.buffer = buf;
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.setValueAtTime(700, t0);
    bp.frequency.exponentialRampToValueAtTime(5200, t0 + 0.26);
    bp.Q.value = 1.1;
    const g2 = ac.createGain();
    g2.gain.setValueAtTime(0.0001, t0);
    g2.gain.exponentialRampToValueAtTime(0.09, t0 + 0.015);
    g2.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
    src.connect(bp).connect(g2).connect(ac.destination);
    src.start(t0); src.stop(t0 + 0.34);

    /* ③ 金属闪光：G6 / C7 / E7 三个音错开 45ms 依次亮起来 */
    [1568, 2093, 2637].forEach(function (f, i) {
      const t = t0 + 0.06 + i * 0.045;
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.052, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
      o.connect(g).connect(ac.destination);
      o.start(t); o.stop(t + 0.9);
    });
  } catch (e) { /* 没有音频环境就静默 */ }
}

/* ---------- 大隐藏（UR）出场演出 ---------- */
/* 抽到 UR 时：先全屏放一段视频，视频结束再把卡片从爆光里冲出来。
   视频按需加载（第一次抽到才去取），加载失败或不允许自动播放就直接进动画。
   全程点一下可以跳过：视频阶段点了进卡片，卡片阶段点了收尾。 */

var ULTRA_VIDEO_SRC = 'art/ur-intro.mp4';
var ULTRA_VIDEO_TIMEOUT = 7000;    /* 视频这么久还没开始播就当它不行（要给慢网络留时间） */
var ULTRA_VIDEO_MAXWAIT = 16000;   /* 视频最长放这么久，防止卡死 */
var ULTRA_CARD_HOLD = 2600;        /* 卡片冲出来之后停留多久 */
var ultraRefs = null;
var ultraPreloaded = false;

/* 用户已经动手抽过了，说明他要玩，这时候在后台把视频取回来放进浏览器缓存。
   只做一次，不挡任何东西；真抽到 UR 时就不用等下载了。 */
function preloadUltra() {
  if (ultraPreloaded) return;
  ultraPreloaded = true;
  try {
    if (typeof fetch === 'function') {
      fetch(ULTRA_VIDEO_SRC, { cache: 'force-cache' }).then(function (r) {
        if (r && r.body && typeof r.body.cancel === 'function') { try { r.body.cancel(); } catch (e) {} }
      }).catch(function () {});
    }
  } catch (e) { /* 取不到就算了，到时候现下 */ }
}

function ultraDom() {
  if (ultraRefs) return true;
  const el = document.getElementById('ultra');
  if (!el) return false;
  ultraRefs = {
    root:   el,
    video:  document.getElementById('ultraVideo'),
    vig:    document.getElementById('ultraVig'),
    stage:  document.getElementById('ultraStage'),
    white:  document.getElementById('ultraWhite'),
    card:   document.getElementById('ultraCard'),
    sparks: document.getElementById('ultraSparks'),
    tip:    document.getElementById('ultraTip'),
  };
  return true;
}

function ultraSparks(n) {
  const host = ultraRefs.sparks;
  if (!host) return;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const s = document.createElement('i');
    const ang = Math.random() * Math.PI * 2;
    const dist = 80 + Math.random() * 320;
    s.style.setProperty('--sx', (Math.cos(ang) * dist).toFixed(0) + 'px');
    s.style.setProperty('--sy', (Math.sin(ang) * dist).toFixed(0) + 'px');
    s.style.animationDelay = (Math.random() * 0.24).toFixed(2) + 's';
    if (Math.random() < 0.45) {
      s.style.background = '#ffd9ff';
      s.style.boxShadow = '0 0 10px 2px rgba(255,120,255,.95)';
    }
    frag.appendChild(s);
  }
  host.appendChild(frag);
}

function playUltra(item, done) {
  if (!ultraDom()) { done(); return; }

  const r = ultraRefs;
  let closed = false;
  let phase = 'video';        /* 'video' | 'card' */
  let movedOn = false;
  let cardTimer = null, guardTimer = null, maxTimer = null;

  function onEnded() { toCard(); }
  function onError() { toCard(); }
  function onPlaying() {
    clearTimeout(guardTimer);
    if (!closed && phase === 'video') r.tip.textContent = '点击任意处跳过 »';
    r.video.removeEventListener('playing', onPlaying);
  }
  function detachVideo() {
    clearTimeout(guardTimer);
    clearTimeout(maxTimer);
    r.video.removeEventListener('ended', onEnded);
    r.video.removeEventListener('error', onError);
    r.video.removeEventListener('playing', onPlaying);
  }

  function finish() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    r.root.classList.add('out');
    setTimeout(function () {
      r.root.hidden = true;
      r.root.classList.remove('on', 'out', 'ultra-quake');
      try { r.video.pause(); } catch (e) {}
      r.video.removeAttribute('src');
      try { r.video.load(); } catch (e) {}
      r.video.hidden = false;
      r.video.classList.remove('gone');
      r.vig.classList.remove('gone');
      r.stage.hidden = true;
      r.stage.classList.remove('on');
      r.white.classList.remove('go');
      r.sparks.innerHTML = '';
      done();
    }, 330);
  }

  /* 白闪 + 震屏 + 卡片冲出来 */
  function showCard() {
    if (closed) return;
    phase = 'card';

    r.video.classList.add('gone');
    r.vig.classList.add('gone');
    r.tip.textContent = '点击任意处继续 »';

    setTimeout(function () {
      if (closed) return;

      r.video.hidden = true;
      r.stage.hidden = false;
      r.stage.classList.add('on');

      r.white.classList.remove('go');
      void r.white.offsetWidth;
      r.white.classList.add('go');

      /* 白闪和震屏一起发生，声音也卡在这一帧 */
      sfxUltraCard();

      r.root.classList.remove('ultra-quake');
      void r.root.offsetWidth;
      r.root.classList.add('ultra-quake');

      const card = item.card || CARDS[item.id];
      const color = RARITY[item.rarity] || RARITY.UR;
      r.card.innerHTML =
        '<img src="' + card.art + '" alt="' + card.name + '" style="' + artStyle(card) + '">' +
        '<span class="uc-tag">' + color.label + '</span>' +
        '<div class="uc-name">' + card.name + '</div>';

      ultraSparks(70);

      cardTimer = setTimeout(finish, ULTRA_CARD_HOLD);
    }, 380);
  }

  function toCard() {
    if (movedOn || closed) return;
    movedOn = true;
    detachVideo();
    showCard();
  }

  function skip() {
    if (closed) return;
    if (phase === 'card') {
      clearTimeout(cardTimer);
      finish();
      return;
    }
    toCard();
  }

  function onKey(e) {
    if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      skip();
    }
  }

  /* ---- 开场 ---- */
  r.root.hidden = false;
  r.root.classList.remove('out');
  r.video.hidden = false;
  r.video.classList.remove('gone');
  r.vig.classList.remove('gone');
  r.stage.hidden = true;
  r.stage.classList.remove('on');
  r.white.classList.remove('go');
  r.sparks.innerHTML = '';
  r.tip.textContent = '召唤中…';
  void r.root.offsetWidth;
  r.root.classList.add('on');

  r.root.onclick = function () { skip(); };
  document.addEventListener('keydown', onKey, true);

  /* ---- 视频 ---- */
  let videoOk = false;
  guardTimer = setTimeout(function () { if (!videoOk) toCard(); }, ULTRA_VIDEO_TIMEOUT);
  maxTimer = setTimeout(function () { toCard(); }, ULTRA_VIDEO_MAXWAIT);

  r.video.addEventListener('ended', onEnded);
  r.video.addEventListener('error', onError);
  r.video.addEventListener('playing', onPlaying);

  /* 原声保留；站点静音开关关掉时视频也不出声 */
  r.video.muted = !!state.muted;
  r.video.volume = 1;

  if (!r.video.getAttribute('src')) r.video.setAttribute('src', ULTRA_VIDEO_SRC);

  let playPromise = null;
  try { playPromise = r.video.play(); } catch (e) { playPromise = null; }
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch(function () {
      /* 自动播放被拦：先试静音再放一次，仍不行就直接进卡片 */
      if (closed || movedOn) return;
      try {
        r.video.muted = true;
        const p2 = r.video.play();
        if (p2 && typeof p2.catch === 'function') p2.catch(function () { toCard(); });
      } catch (e) { toCard(); }
    });
  }
}

/* ---------- 抽卡交互 ---------- */
function pull(n) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('.btn').forEach(function (b) { b.disabled = true; });
  sfxTap();

  /* 演出期间把星空关掉（它全屏被特效盖着，画了也白画） */
  document.body.classList.add('pulling');

  const poolId = state.current;
  const items = [];
  for (let i = 0; i < n; i++) items.push(drawOne(poolId));

  save();
  setTimeout(preloadUltra, 1500);

  let urItem = null;
  for (let i = 0; i < items.length; i++) {
    if (items[i].rarity === 'UR') { urItem = items[i]; break; }
  }

  /* 摆结果 + 放开按钮 */
  function settle() {
    renderResults(items);
    renderStats();
    renderBanner();
    renderGallery();
    setTimeout(renderLog, 200);
    setTimeout(refreshAdminLive, 60);
    setTimeout(function () {
      busy = false;
      document.body.classList.remove('pulling');
      document.querySelectorAll('.btn').forEach(function (b) { b.disabled = false; });
    }, 120 + items.length * 110 + 700);
  }

  if (urItem) {
    /* 抽到大隐藏：先放演出，演完再摆卡。演出期间 busy 一直压着，防连点 */
    renderStats();
    renderBanner();
    renderGallery();
    stage.innerHTML = '';
    playUltra(urItem, settle);
  } else {
    settle();
  }
}

pull1Btn.addEventListener('click', function () { pull(1); });
pull10Btn.addEventListener('click', function () { pull(10); });

muteBtn.addEventListener('click', function () {
  state.muted = !state.muted;
  save();
  if (!state.muted) sfxTap();
  renderAll();
});

$('resetBtn').addEventListener('click', function () {
  if (!confirm('确定要清空全部卡池的抽卡记录、图鉴与保底进度吗？')) return;
  sfxOpen();
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
/* --- 后台小工具 --- */
function adminEsc(s) {
  return String(s).replace(/[<>&"]/g, function (c) {
    return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c];
  });
}

function fmtDur(sec) {
  sec = Math.max(0, Number(sec) || 0);
  var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600),
      m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60);
  if (d) return d + ' 天 ' + h + ' 时';
  if (h) return h + ' 时 ' + m + ' 分';
  if (m) return m + ' 分 ' + s + ' 秒';
  return s + ' 秒';
}

function fmtSize(b) {
  b = Number(b) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(2) + ' MB';
}

function fmtTime(sec) {
  var d = new Date((Number(sec) || 0) * 1000);
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
         p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/* 后台界面状态（跨自动刷新保留） */
var adminState = { q: '', sort: 'pulls', logFilter: 'all', players: [], logs: [],
                   users: [], invites: [] };

function renderAdmin() {
  if (!isUnlocked()) { renderGate(); return; }

  adminTitleEl.textContent = '后台控制台';
  adminBodyEl.innerHTML =
    '<div class="sect">' +
      '<h3>仪表盘<span id="aDot" class="dot">检测中…</span></h3>' +
      '<div class="dash" id="aDash"></div>' +
    '</div>' +
    '<div class="sect">' +
      '<h3>服务器</h3>' +
      '<div class="srv" id="aInfo"></div>' +
      '<div class="arow" style="margin-top:12px">' +
        '<button class="btn-sm" id="aUltraBtn">预览出场演出</button>' +
        '<button class="btn-sm danger" id="aRestart">重启网站</button>' +
      '</div>' +
      '<p class="note">大隐藏大约三百多抽才见一次，想看演出不用真去赌概率：' +
      '点「预览出场演出」就会按抽到 UR 的完整流程走一遍（视频 + 卡片冲出）。' +
      '这个按钮只影响你自己的浏览器，不会写进存档、也不会算进抽数。</p>' +
      '<p class="note">重启是「硬」的：服务器会立刻掐断所有人（包括你自己）正在用的连接，' +
      '然后整个网站重新启动，大约 1～3 秒后自动恢复。已经登录的后台不会掉线。' +
      '别人正在玩的页面会在 15 秒内自动刷新，换到你刚更新上去的版本。' +
      '（页面文件本来就是每次访问现读的，所以更新内容不重启也会生效；' +
      '重启的真正意义是让「已经打开页面的人」自动换到新版本。）</p>' +
    '</div>' +
    '<div class="sect">' +
      '<h3>测试密钥<span id="aICount" class="dot"></span></h3>' +
      '<div class="arow">' +
        '<button class="btn-sm gold" id="aInvNew">生成一次性密钥</button>' +
        '<button class="btn-sm" id="aInvCopyAll">复制全部未用的</button>' +
      '</div>' +
      '<div class="invnew" id="aInvNewBox" hidden></div>' +
      '<div class="plist" id="adminInvites"></div>' +
      '<p class="note">站内测期间，来的人要先拿一枚密钥才能注册。一枚只能注册一个账号，' +
      '用完就作废。已经注册过的人换设备登录不用密钥。' +
      '把上面生成的那串发给对方就行，注意别发错人。</p>' +
    '</div>' +
    '<div class="sect">' +
      '<h3>账号<span id="aPCount" class="dot"></span></h3>' +
      '<div class="toolbar">' +
        '<input type="search" id="aSearch" placeholder="搜索用户名…" autocomplete="off">' +
        '<button class="chip on" id="aSortBtn">按抽数排序</button>' +
      '</div>' +
      '<div class="plist" id="adminPlayers"></div>' +
    '</div>' +
    '<div class="sect">' +
      '<h3>审计日志<span id="aLCount" class="dot"></span></h3>' +
      '<div class="toolbar" id="aFilters">' +
        '<button class="chip on" data-f="all">全部</button>' +
        '<button class="chip" data-f="2">成功 2xx</button>' +
        '<button class="chip" data-f="4">拒绝 4xx</button>' +
        '<button class="chip" data-f="5">错误 5xx</button>' +
      '</div>' +
      '<div class="loglist" id="adminLogs"></div>' +
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
      '<details class="fold">' +
        '<summary>本机原始存档</summary>' +
        '<code class="code code-block" id="adminRaw"></code>' +
      '</details>' +
    '</div>' +
    '<div class="sect">' +
      '<div class="arow">' +
        '<button class="btn-sm" id="aAuto">自动刷新：开</button>' +
        '<button class="btn-sm danger" id="aLock">退出后台</button>' +
      '</div>' +
      '<p class="note">这个后台由服务器校验，不是前端藏了个开关：密钥经 PBKDF2-SHA256（12 万轮）加盐后才落盘，' +
      '会话是 HMAC 签名的 HttpOnly Cookie，改一个字节就失效。密钥明文不会存进任何文件，也不随请求上传——' +
      '浏览器先在本机把它算成 SHA-256 摘要再发送。删除玩家存档会在服务器上真的删掉，无法恢复。</p>' +
    '</div>';

  /* --- 工具条事件 --- */
  var searchEl = $('aSearch');
  if (searchEl) {
    searchEl.value = adminState.q;
    searchEl.addEventListener('input', function () {
      adminState.q = this.value.trim().toLowerCase();
      paintPlayers();
    });
  }
  var sortBtn = $('aSortBtn');
  if (sortBtn) {
    var labels = { pulls: '按抽数排序', bytes: '按体积排序', id: '按 ID 排序' };
    var order = ['pulls', 'bytes', 'id'];
    sortBtn.textContent = labels[adminState.sort];
    sortBtn.addEventListener('click', function () {
      adminState.sort = order[(order.indexOf(adminState.sort) + 1) % order.length];
      sortBtn.textContent = labels[adminState.sort];
      paintPlayers();
    });
  }
  var filters = $('aFilters');
  if (filters) {
    filters.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-f]');
      if (!b) return;
      adminState.logFilter = b.getAttribute('data-f');
      Array.prototype.forEach.call(filters.querySelectorAll('.chip'), function (c) {
        c.classList.toggle('on', c === b);
      });
      paintLogs();
    });
  }

  /* --- 本机存档 --- */
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

  /* --- 测试密钥 --- */
  var invNew = $('aInvNew');
  if (invNew) {
    invNew.addEventListener('click', function () {
      invNew.disabled = true;
      api('/api/admin/invite/new', { method: 'POST' }).then(function (r) {
        invNew.disabled = false;
        var box = $('aInvNewBox');
        if (!r.ok || !r.data || !r.data.ok) {
          if (box) { box.hidden = false; box.innerHTML = '<span class="bad">生成失败</span>'; }
          return;
        }
        var c = r.data.code;
        if (box) {
          box.hidden = false;
          box.innerHTML = '新密钥：<code class="icode">' + adminEsc(c) + '</code>' +
            '<button class="mini" id="aInvCopyOne">复制</button>';
          var one = $('aInvCopyOne');
          if (one) one.addEventListener('click', function () { copyText(c, one); });
        }
        api('/api/admin/invites').then(function (r2) {
          if (r2.data && r2.data.ok) { adminState.invites = r2.data.invites || []; paintInvites(); }
        }).catch(function () {});
      }).catch(function () {
        invNew.disabled = false;
        adminMsg('生成密钥失败，服务端没响应', 'bad');
      });
    });
  }

  var invCopyAll = $('aInvCopyAll');
  if (invCopyAll) {
    invCopyAll.addEventListener('click', function () {
      var fresh = adminState.invites.filter(function (x) { return !x.used; })
                                   .map(function (x) { return x.code; });
      if (!fresh.length) { adminMsg('现在没有未使用的密钥', 'bad'); return; }
      copyText(fresh.join('\n'), invCopyAll);
    });
  }

  /* --- 自动刷新开关 / 退出 --- */
  var autoBtn = $('aAuto');
  adminState.auto = true;
  autoBtn.addEventListener('click', function () {
    adminState.auto = !adminState.auto;
    autoBtn.textContent = '自动刷新：' + (adminState.auto ? '开' : '关');
    if (adminState.auto) startAdminTimer(); else stopAdminTimer();
  });
  $('aLock').addEventListener('click', function () {
    api('/api/logout', { method: 'POST', body: '' }).then(function () {
      lockAdmin(); closeAdmin(); renderAll();
    });
  });

  /* --- 预览出场演出：随便挑一张本池的 UR，走一遍和真抽到一模一样的流程 --- */
  var ultraBtn = $('aUltraBtn');
  if (ultraBtn) ultraBtn.addEventListener('click', function () {
    var pool = currentPool();
    var entry = (pool.entries || []).filter(function (e) { return e.rarity === 'UR'; })[0];
    if (!entry) { adminMsg('这个卡池里没有大隐藏。', 'bad'); return; }
    closeAdmin();
    /* 演出时用真实卡面，不走「未获得显示 ???」那一套，否则预览看到的是一张问号 */
    playUltra({ id: entry.id, rarity: 'UR', card: CARDS[entry.id] }, function () {
      openAdmin();
    });
  });

  /* --- 重启网站（硬重启：服务端会把所有连接一起掐掉再重来） --- */
  $('aRestart').addEventListener('click', function () {
    if (!confirm('确定重启网站吗？\n\n所有正在访问的人（包括你自己）都会被立刻断开，' +
                 '网站会在 1～3 秒后重新启动。')) return;
    var btn = this;
    btn.disabled = true;
    adminMsg('正在重启网站…', '');

    function waitUp() {
      adminMsg('连接已被断开，等待网站重新启动…', '');
      var tries = 0;
      var timer = setInterval(function () {
        tries++;
        api('/api/health').then(function (h) {
          if (h.ok) {
            clearInterval(timer);
            adminMsg('网站已重新启动（约 ' + (tries * 0.8).toFixed(1) + ' 秒）', 'good');
            btn.disabled = false;
            refreshAdminLive();
          }
        }).catch(function () {
          if (tries >= 30) {
            clearInterval(timer);
            adminMsg('等了 24 秒还没起来，请手动刷新页面，或去服务器看一眼 server.log', 'bad');
            btn.disabled = false;
          }
        });
      }, 800);
    }

    /* 服务端回完 200 就自杀了，所以请求本身断掉也是正常的，两种情况都去等它回来 */
    api('/api/admin/restart', { method: 'POST', body: 'go=1' })
      .then(waitUp, waitUp);
  });

  refreshAdminLive();
  startAdminTimer();
}

function renderGate() {
  adminTitleEl.textContent = '后台入口';
  adminBodyEl.innerHTML =
    '<p class="note">请输入专属密钥。校验在服务器上进行，错误尝试会被限速（10 分钟内 5 次）。</p>' +
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

/* --- 玩家列表渲染 --- */

/* 最后一次活跃时间 → 人话 + 颜色类。3 分钟内有请求就算「在线」。 */
function seenInfo(ts) {
  var now = Math.floor(Date.now() / 1000);
  if (!ts) return { text: '未登录过', cls: 'off' };
  var d = now - ts;
  if (d < 0) d = 0;
  if (d < 180) return { text: '在线', cls: 'on' };
  if (d < 3600) return { text: Math.floor(d / 60) + ' 分钟前', cls: 'off' };
  if (d < 86400) return { text: Math.floor(d / 3600) + ' 小时前', cls: 'off' };
  return { text: Math.floor(d / 86400) + ' 天前', cls: 'off' };
}

function pdItem(k, v, mono) {
  return '<div class="pd-i"><span>' + adminEsc(k) + '</span><code' +
    (mono ? ' class="mono"' : '') + '>' + adminEsc(String(v)) + '</code></div>';
}

/* 详情面板：把存档里那些给玩家看的东西翻译成人话，
   原始 JSON 收进最后那个折叠里，默认不展开。 */
function playerDetailHTML(p) {
  var sv = null;
  try { sv = JSON.parse(p.raw); } catch (e) { sv = null; }
  var h = '<div class="pd">';

  h += '<div class="pd-sec"><h4>账号</h4><div class="pd-grid">' +
    pdItem('名字', p.hasAccount ? p.name : '（没有账号，只有存档）') +
    pdItem('UID', p.uid, true) +
    pdItem('注册时间', p.created ? fmtTime(p.created) : '—') +
    pdItem('最后活跃', p.lastSeen ? fmtTime(p.lastSeen) + '（' + seenInfo(p.lastSeen).text + '）' : '从未') +
    pdItem('存档大小', fmtSize(p.bytes)) +
    pdItem('存档更新', p.mtime ? fmtTime(p.mtime) : '—') +
    '</div></div>';

  if (sv && sv.pools) {
    var rows = '';
    POOLS.forEach(function (pool) {
      var d = sv.pools[pool.id] || {};
      var got = d.got || {};
      rows += '<tr><td>' + adminEsc(pool.name) + '</td>' +
        '<td>' + (Number(d.pulls) || 0) + ' 抽</td>' +
        '<td class="ur">' + (Number(got.UR) || 0) + '</td>' +
        '<td>' + (Number(got.SR) || 0) + '</td>' +
        '<td>' + (Number(got.R) || 0) + '</td>' +
        '<td>' + (Number(d.pityUR) || 0) + '</td></tr>';
    });
    h += '<div class="pd-sec"><h4>各卡池</h4><table class="pd-t"><thead><tr>' +
      '<th>卡池</th><th>抽数</th><th>大隐藏</th><th>SR</th><th>R</th><th>UR 保底计数</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  if (sv && sv.counts) {
    var owned = Object.keys(sv.counts).filter(function (id) { return CARDS[id]; });
    var order = { UR: 0, SSR: 1, SR: 2, R: 3 };
    var withRarity = owned.map(function (id) {
      var r = 'R';
      POOLS.forEach(function (pool) {
        pool.entries.forEach(function (e) { if (e.id === id) r = e.rarity; });
      });
      return { id: id, n: sv.counts[id], rarity: r };
    }).sort(function (a, b) { return order[a.rarity] - order[b.rarity] || b.n - a.n; });

    h += '<div class="pd-sec"><h4>图鉴（抽到过的卡）</h4><div class="pd-cards">' +
      withRarity.map(function (c) {
        return '<span class="pd-card" data-r="' + c.rarity + '">' +
          adminEsc(CARDS[c.id].name) + '<em>×' + c.n + '</em></span>';
      }).join('') + '</div></div>';
  }

  if (sv && sv.history && sv.history.length) {
    var recent = sv.history.slice(0, 10);
    h += '<div class="pd-sec"><h4>最近 10 抽</h4><div class="pd-hist">' +
      recent.map(function (e) {
        return '<div class="pd-h" data-r="' + adminEsc(e.rarity || 'R') + '">' +
          '<span>#' + (e.no || '?') + '</span>' +
          '<em>' + adminEsc(e.rarity || '?') + '</em>' +
          '<span>' + adminEsc(e.name || e.id || '?') + '</span>' +
          '<span class="dim">' + adminEsc(e.poolName || e.pool || '') + '</span>' +
          '</div>';
      }).join('') + '</div></div>';
  }

  if (p.raw) {
    h += '<details class="fold pd-raw"><summary>原始存档 JSON</summary>' +
      '<pre class="code code-block">' + adminEsc(p.raw) + '</pre></details>';
  }

  h += '</div>';
  return h;
}

function paintPlayers() {
  var box = $('adminPlayers'), cnt = $('aPCount');
  if (!box) return;

  /* 账号表（有名字、注册时间）跟存档表（有原始存档）按 uid 合并 */
  var byUid = {};
  adminState.players.forEach(function (p) { byUid[p.uid] = p; });

  var list = adminState.users.map(function (u) {
    var sv = byUid[u.uid] || {};
    return {
      uid: u.uid,
      name: u.name || u.uid,
      hasAccount: true,
      created: u.created || 0,
      pulls: u.pulls || sv.pulls || 0,
      ur: sv.ur || 0,
      bytes: u.bytes || sv.bytes || 0,
      mtime: u.mtime || 0,
      lastSeen: u.last_seen || 0,
      raw: sv.raw || ''
    };
  });

  /* 还有存档但没账号的（账号系统之前留下的匿名存档），也列出来别弄丢 */
  adminState.players.forEach(function (p) {
    var hit = false;
    for (var i = 0; i < list.length; i++) if (list[i].uid === p.uid) { hit = true; break; }
    if (!hit) list.push({
      uid: p.uid, name: p.name || '(匿名存档)', hasAccount: false,
      created: 0, pulls: p.pulls || 0, ur: p.ur || 0,
      bytes: p.bytes || 0, mtime: p.mtime || 0, lastSeen: 0, raw: p.raw || ''
    });
  });

  var q = adminState.q;
  if (q) {
    list = list.filter(function (p) {
      return p.name.toLowerCase().indexOf(q) >= 0 || p.uid.toLowerCase().indexOf(q) >= 0;
    });
  }

  list.sort(function (a, b) {
    if (adminState.sort === 'id') return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    if (adminState.sort === 'bytes') return b.bytes - a.bytes;
    return b.pulls - a.pulls;
  });

  if (cnt) cnt.textContent = list.length + ' / ' + adminState.users.length;

  if (!list.length) {
    box.innerHTML = '<p class="empty">' +
      (adminState.users.length || adminState.players.length ? '没有匹配的账号。' : '还没有人注册。') +
      '</p>';
    return;
  }

  box.innerHTML = list.map(function (p) {
    var seen = seenInfo(p.lastSeen);
    return '<div class="prow" data-uid="' + adminEsc(p.uid) + '">' +
      '<span class="pname" title="' + adminEsc(p.uid) + '">' + adminEsc(p.name) +
        (p.hasAccount ? '' : ' <em class="tag">无账号</em>') + '</span>' +
      '<span class="seen ' + seen.cls + '" title="最后活跃：' +
        (p.lastSeen ? fmtTime(p.lastSeen) : '从未') + '">' +
        '<i></i>' + adminEsc(seen.text) + '</span>' +
      '<span class="pm">' + p.pulls + ' 抽 · <em>UR ' + p.ur + '</em> · ' + fmtSize(p.bytes) +
        (p.created ? ' · ' + fmtTime(p.created) + ' 注册' : '') + '</span>' +
      (p.hasAccount ? '<button class="mini" data-act="pass">改密码</button>' : '') +
      (p.raw ? '<button class="mini" data-act="raw">详情</button>' : '') +
      '<button class="mini del" data-act="del">删除</button>' +
      (p.raw ? '<div class="pdetail" hidden></div>' : '') +
    '</div>';
  }).join('');
}

function paintInvites() {
  var box = $('adminInvites'), cnt = $('aICount');
  if (!box) return;

  var list = adminState.invites.slice();
  list.sort(function (a, b) {
    if (a.used !== b.used) return a.used - b.used;   /* 没用的排前面 */
    return (b.created || 0) - (a.created || 0);
  });

  var fresh = list.filter(function (x) { return !x.used; }).length;
  if (cnt) cnt.textContent = fresh + ' 枚可用 / 共 ' + list.length;

  if (!list.length) {
    box.innerHTML = '<p class="empty">还没生成过密钥。点上面那个按钮生成一枚。</p>';
    return;
  }

  box.innerHTML = list.map(function (v) {
    return '<div class="irow' + (v.used ? ' used' : '') + '" data-code="' + adminEsc(v.code) + '">' +
      '<code class="icode">' + adminEsc(v.code) + '</code>' +
      '<span class="im">' + (v.used ? '已用于 ' + adminEsc(v.uid || '?') : '可用') +
        (v.created ? ' · ' + fmtTime(v.created) : '') + '</span>' +
      (v.used ? '' : '<button class="mini" data-act="copy">复制</button>') +
      '<button class="mini del" data-act="ivdel">删除</button>' +
    '</div>';
  }).join('');
}

/* --- 审计日志渲染 --- */
function paintLogs() {
  var box = $('adminLogs'), cnt = $('aLCount');
  if (!box) return;

  var all = adminState.logs, f = adminState.logFilter;
  var list = all.filter(function (line) {
    if (f === 'all') return true;
    var m = line.match(/\s(\d{3})\s*$/);
    return m && m[1].charAt(0) === f;
  });

  if (cnt) cnt.textContent = list.length + ' / ' + all.length;

  if (!list.length) {
    box.innerHTML = '<div class="empty">' + (all.length ? '没有符合条件的记录。' : '（暂无日志）') + '</div>';
    return;
  }

  box.innerHTML = list.map(function (line) {
    var m = line.match(/\s(\d{3})\s*$/);
    var cls = m ? 's' + m[1].charAt(0) : '';
    var body = adminEsc(line);
    if (m) {
      var code = m[1];
      var i = body.lastIndexOf(code);
      body = body.slice(0, i) + '<i>' + code + '</i>';
    }
    return '<div class="' + cls + '">' + body + '</div>';
  }).join('');
}

/* --- 拉取服务端数据 --- */
function refreshAdminLive() {
  if (!modalEl || modalEl.hidden || !isUnlocked()) return;

  api('/api/admin/overview').then(function (r) {
    var dot = $('aDot'), dash = $('aDash'), info = $('aInfo');
    if (!dot || !dash) return;
    if (r.status === 401) {
      dot.className = 'dot bad'; dot.textContent = '会话已失效';
      lockAdmin(); renderGate();
      adminMsg('登录已过期，请重新输入密钥', 'bad');
      return;
    }
    if (!r.ok || !r.data || !r.data.ok) { dot.className = 'dot bad'; dot.textContent = '异常'; return; }
    var d = r.data;
    dot.className = 'dot good'; dot.textContent = '在线';

    dash.innerHTML =
      '<div class="dstat"><b>' + d.players + '</b><span>玩家存档</span></div>' +
      '<div class="dstat"><b>' + d.pulls + '</b><span>记录总抽数</span></div>' +
      '<div class="dstat"><b>' + fmtSize(d.bytes) + '</b><span>占用空间</span></div>' +
      '<div class="dstat"><b>' + fmtDur(d.uptimeSec) + '</b><span>服务已运行</span></div>' +
      (d.topPid ? '<div class="dstat ur"><b>' + d.topPulls + '</b><span>最肝玩家抽数</span></div>' : '');

    if (info) {
      info.innerHTML =
        '<div><span>端口</span><code>' + d.port + '</code></div>' +
        '<div><span>站点目录</span><code>' + adminEsc(d.www || '—') + '</code></div>' +
        '<div><span>数据目录</span><code>' + adminEsc(d.data || '—') + '</code></div>' +
        '<div><span>服务器时间</span><code>' + fmtTime(d.serverTime) + '</code></div>' +
        '<div><span>最肝玩家</span><code>' + adminEsc(d.topPid || '—') + '</code></div>';
    }
  }).catch(function () {
    var dot = $('aDot');
    if (dot) { dot.className = 'dot bad'; dot.textContent = '离线'; }
  });

  api('/api/admin/saves').then(function (r) {
    if (!r.data || !r.data.ok) return;
    adminState.players = (r.data.players || []).map(function (p) {
      var pulls = 0, ur = 0;
      try {
        var sv = JSON.parse(p.raw);
        pulls = sv.total || 0;
        if (sv.pools) Object.keys(sv.pools).forEach(function (k) {
          ur += (sv.pools[k].got && sv.pools[k].got.UR) || 0;
        });
      } catch (e) { /* 存档坏了也不影响列表 */ }
      /* 两个后端的字段名不一样：C 版 /api/admin/saves 给的是 id，
         Cloudflare Workers 版给的是 uid。这里统一成 uid（id 也留着兼容老代码），
         否则下面按 uid 合并时全都对不上，存档会被当成「匿名存档」重复列出来，
         而且删除时拿到的是 undefined，永远删不掉。 */
      var pid = p.uid || p.id || '';
      return { id: pid, uid: pid, name: p.name || '', bytes: p.bytes, raw: p.raw, pulls: pulls, ur: ur };
    });
    paintPlayers();
  }).catch(function () {});

  api('/api/admin/users').then(function (r) {
    if (!r.data || !r.data.ok) return;
    adminState.users = r.data.users || [];
    paintPlayers();
  }).catch(function () {});

  api('/api/admin/invites').then(function (r) {
    if (!r.data || !r.data.ok) return;
    adminState.invites = r.data.invites || [];
    paintInvites();
  }).catch(function () {});

  api('/api/admin/logs').then(function (r) {
    if (!r.data || !r.data.ok) return;
    adminState.logs = (r.data.logs || []).slice().reverse();
    paintLogs();
  }).catch(function () {});

  var raw = $('adminRaw');
  if (raw) raw.textContent = JSON.stringify(state, null, 2);
}


/* 复制到剪贴板。http 下 navigator.clipboard 用不了（不是安全上下文），
   所以留一条 execCommand 的老路。 */
function copyText(text, btn) {
  function done() {
    if (!btn) return;
    var old = btn.textContent;
    btn.textContent = '已复制';
    setTimeout(function () { btn.textContent = old; }, 1400);
  }
  function fallback() {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (e) { adminMsg('复制失败，手动选一下吧', 'bad'); }
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(fallback);
  } else fallback();
}

/* --- 后台列表里的按钮（事件委托，避免每次刷新重绑） --- */
document.addEventListener('click', function (e) {
  if (!e.target.closest) return;

  /* 密钥行：复制 / 删除 */
  var ib = e.target.closest('.irow [data-act]');
  if (ib) {
    var irow = ib.closest('.irow');
    var code = irow && irow.getAttribute('data-code');
    var iact = ib.getAttribute('data-act');
    if (!code) return;

    if (iact === 'copy') { copyText(code, ib); return; }

    if (iact === 'ivdel') {
      if (!confirm('删除密钥 ' + code + ' 吗？')) return;
      ib.disabled = true;
      api('/api/admin/invite/delete', { method: 'POST', body: 'code=' + encodeURIComponent(code) })
        .then(function (r) {
          if (r.ok && r.data && r.data.ok) {
            adminState.invites = adminState.invites.filter(function (v) { return v.code !== code; });
            paintInvites();
          } else {
            alert('删除失败：' + ((r.data && r.data.msg) || '未知错误'));
            ib.disabled = false;
          }
        })
        .catch(function () { alert('无法连接服务器'); ib.disabled = false; });
      return;
    }
  }

  /* 账号行：看详情 / 删号 */
  var btn = e.target.closest('.prow [data-act]');
  if (!btn) return;
  var row = btn.closest('.prow');
  var uid = row && row.getAttribute('data-uid');
  if (!uid) return;
  var act = btn.getAttribute('data-act');

  if (act === 'raw') {
    var box = row.querySelector('.pdetail');
    if (!box) return;
    if (!box.innerHTML) {
      var item = null;
      for (var i = 0; i < adminState.players.length; i++) {
        if (adminState.players[i].uid === uid) { item = adminState.players[i]; break; }
      }
      if (item) box.innerHTML = playerDetailHTML(item);
      else return;
    }
    box.hidden = !box.hidden;
    btn.textContent = box.hidden ? '详情' : '收起';
    return;
  }

  if (act === 'pass') {
    if (!confirm('给「' + uid + '」换一个新密码？\n旧密码会立刻失效，新密码只显示这一次，' +
                 '记得复制下来发给对方。')) return;
    btn.disabled = true;
    api('/api/admin/user/pass', { method: 'POST', body: 'uid=' + encodeURIComponent(uid) })
      .then(function (r) {
        btn.disabled = false;
        if (r.ok && r.data && r.data.ok) {
          adminMsg('「' + (r.data.name || uid) + '」的新密码：' + r.data.pass +
                   '（复制下来发给对方，关掉就看不到了）', 'good');
          try { copyText(r.data.pass, null); } catch (e) {}
        } else {
          alert('重置失败：' + ((r.data && r.data.msg) || '未知错误'));
        }
      })
      .catch(function () { btn.disabled = false; alert('无法连接服务器'); });
    return;
  }

  if (act === 'del') {
    if (!confirm('确定删除账号「' + uid + '」吗？\n账号和它的存档都会在服务器上真的删掉，无法恢复。')) return;
    btn.disabled = true;
    api('/api/admin/user/delete', { method: 'POST', body: 'uid=' + encodeURIComponent(uid) })
      .then(function (r) {
        if (r.ok && r.data && r.data.ok) {
          adminState.users = adminState.users.filter(function (u) { return u.uid !== uid; });
          adminState.players = adminState.players.filter(function (p) { return p.uid !== uid; });
          paintPlayers();
        } else {
          alert('删除失败：' + ((r.data && r.data.msg) || '未知错误'));
          btn.disabled = false;
        }
      })
      .catch(function () { alert('无法连接服务器'); btn.disabled = false; });
  }
});

var adminTimer = null;
function startAdminTimer() {
  stopAdminTimer();
  adminTimer = setInterval(function () {
    if (adminState.auto) refreshAdminLive();
  }, 5000);
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


/* ---------- 内测门禁：一次性密钥 + 注册 / 登录 ---------- */
/* 后端在线时，没账号就不让进；静态托管（GitHub Pages 那种）探测不到
   /api/me，就直接放行，保持原来的纯本地玩法。 */
var account = { name: '', online: false, checked: false };

function gateMsg(text, good) {
  var el = $('gMsg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'gate-msg' + (good ? ' good' : '');
}

function showGate() {
  var g = $('gate');
  if (!g) return;
  g.hidden = false;
  document.body.classList.add('gated');
}

function hideGate() {
  var g = $('gate');
  if (!g) return;
  g.hidden = true;
  document.body.classList.remove('gated');
}

/* footer 上显示当前是谁 */
function setWho(name) {
  var el = $('who');
  if (!el) return;
  if (!name) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = '';
  var b = document.createElement('b');
  b.textContent = name;
  el.appendChild(document.createTextNode('当前账号 '));
  el.appendChild(b);
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '退出';
  btn.addEventListener('click', function () {
    fetch('api/player/logout', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store'
    }).catch(function () {}).then(function () {
      account.name = '';
      setWho('');
      gateMsg('');
      showGate();
    });
  });
  el.appendChild(btn);
}

function gatePost(url, data) {
  var parts = [];
  Object.keys(data).forEach(function (k) {
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(data[k]));
  });
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    credentials: 'same-origin',
    cache: 'no-store',
    body: parts.join('&')
  }).then(function (r) {
    return r.json().catch(function () { return { ok: false, msg: '服务器返回异常' }; });
  });
}

/* 问服务端「我是谁」。静态托管上这个请求会失败，那就当没有后端。 */
function checkAccount() {
  return fetch('api/me', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !d.ok) { account.online = false; account.checked = true; return false; }
      account.online = true;
      account.checked = true;
      if (d.signedIn) {
        account.name = d.name || '';
        setWho(account.name);
        hideGate();
        return true;
      }
      showGate();
      return false;
    })
    .catch(function () {
      account.online = false;
      account.checked = true;
      return false;
    });
}

function gateSwitch(which) {
  var reg = which === 'reg';
  $('gTabReg').classList.toggle('on', reg);
  $('gTabLogin').classList.toggle('on', !reg);
  $('gRegForm').hidden = !reg;
  $('gLoginForm').hidden = reg;
  gateMsg('');
}

function gateDoRegister() {
  var code = $('gRegCode').value.trim().toUpperCase();
  var name = $('gRegName').value.trim();
  var pass = $('gRegPass').value;

  if (!code) { gateMsg('请先填一次性密钥'); return; }
  if (!name) { gateMsg('请填一个用户名'); return; }
  if ((pass || '').length < 6) { gateMsg('密码至少 6 位'); return; }

  $('gRegGo').disabled = true;
  gateMsg('正在注册…');
  gatePost('api/register', { name: name, pass: pass, code: code })
    .then(function (d) {
      $('gRegGo').disabled = false;
      if (!d || !d.ok) { gateMsg((d && d.msg) || '注册失败'); return; }
      account.online = true;
      account.name = d.name || name;
      setWho(account.name);
      hideGate();
      syncFromServer();
    })
    .catch(function () {
      $('gRegGo').disabled = false;
      gateMsg('网络不通，注册没成功');
    });
}

function gateDoLogin() {
  var name = $('gLogName').value.trim();
  var pass = $('gLogPass').value;

  if (!name || !pass) { gateMsg('用户名和密码都要填'); return; }

  $('gLogGo').disabled = true;
  gateMsg('正在登录…');
  gatePost('api/player/login', { name: name, pass: pass })
    .then(function (d) {
      $('gLogGo').disabled = false;
      if (!d || !d.ok) { gateMsg((d && d.msg) || '登录失败'); return; }
      account.online = true;
      account.name = d.name || name;
      setWho(account.name);
      hideGate();
      syncFromServer();
    })
    .catch(function () {
      $('gLogGo').disabled = false;
      gateMsg('网络不通，登录没成功');
    });
}

$('gTabReg').addEventListener('click', function () { gateSwitch('reg'); });
$('gTabLogin').addEventListener('click', function () { gateSwitch('login'); });
$('gRegGo').addEventListener('click', gateDoRegister);
$('gLogGo').addEventListener('click', gateDoLogin);
$('gRegPass').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') gateDoRegister();
});
$('gLogPass').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') gateDoLogin();
});

/* ---------- 后台入口绑定 ---------- */
$('adminBtn').addEventListener('click', openAdmin);
$('adminClose').addEventListener('click', closeAdmin);
modalEl.addEventListener('click', function (e) {
  if (e.target === modalEl) closeAdmin();
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && !modalEl.hidden) closeAdmin();
});

/* ---------- 手机输入法卡顿治理 ----------
   输入框一获得焦点就给 body 挂 .typing，CSS 会把背景星空、卡片动画、
   h1 的 drop-shadow 和各处 backdrop-filter 全停掉；失焦再恢复。
   手机上弹出输入法时帧率掉成个位数，主要就是这些东西每帧重算模糊。 */
document.addEventListener('focusin', function (e) {
  var t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
    document.body.classList.add('typing');
  }
});
document.addEventListener('focusout', function (e) {
  var t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
    document.body.classList.remove('typing');
  }
});

/* ---------- 手机键盘：用 visualViewport 精确跟随 ----------
   两种浏览器行为都要照顾：
   · 安卓 Chrome 认 interactive-widget=resizes-content：键盘弹起时布局视口
     直接变矮，fixed 层自己就缩了，我们什么都别做；
   · iOS / 老安卓只缩 visual viewport：布局视口纹丝不动，fixed 层会被键盘压住，
     这时才需要把键盘高度写进 --kb，让 CSS 在门禁底部留出这段空白。
   另外做了抖动过滤：键盘弹出/收回那几百毫秒里高度每帧都在变，
   不加过滤就会每帧改一次 CSS 变量、每帧触发一次重排，越修越卡。 */
(function keyboardGuard() {
  var vv = window.visualViewport;
  if (!vv) return;
  var baseH = 0, lastKb = -1, lastShrunk = -1;

  function sync() {
    baseH = Math.max(baseH, window.innerHeight, vv.height);
    var shrunk = Math.round(baseH - window.innerHeight);   // 布局视口缩了多少
    var kb = 0;
    if (document.body.classList.contains('typing')) {
      if (shrunk > 120) {
        kb = 0;                       // 布局视口已缩，fixed 层跟着矮了，不用再留边
      } else {
        kb = Math.round(baseH - vv.height - vv.offsetTop);
        if (kb < 120) kb = 0;         // 小几十像素是地址栏，不算键盘
      }
    }
    if (shrunk < 0) shrunk = 0;
    // 抖动过滤：变化不到 4px 就不碰样式
    if (kb === lastKb && Math.abs(shrunk - lastShrunk) < 4) return;
    lastKb = kb; lastShrunk = shrunk;
    document.documentElement.style.setProperty('--kb', kb + 'px');
    document.body.classList.toggle('kb', kb > 0 || shrunk > 120);
  }

  vv.addEventListener('resize', sync, { passive: true });
  vv.addEventListener('scroll', sync, { passive: true });
  window.addEventListener('orientationchange', function () { baseH = 0; lastKb = -1; setTimeout(sync, 120); });
  sync();
})();

/* ---------- 启动 ---------- */
let serverOnline = false;
renderAll();
probeServer();
checkAccount();
watchRestart();
