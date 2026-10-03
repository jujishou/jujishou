/* ===================== 星海抽卡 · 逻辑 ===================== */

/* ---------- 卡池 ---------- */
const POOL = {
  SSR: [
    { id: 'ssr1', name: '星海龙王', emoji: '🐉' },
    { id: 'ssr2', name: '永夜之瞳', emoji: '👁️' },
    { id: 'ssr3', name: '炽阳圣女', emoji: '🌟' },
    { id: 'ssr4', name: '虚空织者', emoji: '🕸️' },
  ],
  SR: [
    { id: 'sr1', name: '银月弓手', emoji: '🏹' },
    { id: 'sr2', name: '雷纹剑士', emoji: '⚔️' },
    { id: 'sr3', name: '潮汐巫女', emoji: '🌊' },
    { id: 'sr4', name: '赤炎术士', emoji: '🔥' },
    { id: 'sr5', name: '霜羽游侠', emoji: '🪶' },
    { id: 'sr6', name: '秘境守卫', emoji: '🛡️' },
  ],
  R: [
    { id: 'r1', name: '见习剑童', emoji: '🗡️' },
    { id: 'r2', name: '药草学徒', emoji: '🌿' },
    { id: 'r3', name: '矿脉工匠', emoji: '⛏️' },
    { id: 'r4', name: '流浪斥候', emoji: '🧭' },
    { id: 'r5', name: '村口铁匠', emoji: '🔨' },
    { id: 'r6', name: '矮脚信使', emoji: '📜' },
    { id: 'r7', name: '守夜人', emoji: '🏮' },
    { id: 'r8', name: '掘金老鼠', emoji: '🐭' },
  ],
};

const RARITY = {
  SSR: { stars: 5, label: 'SSR' },
  SR:  { stars: 4, label: 'SR' },
  R:   { stars: 3, label: 'R' },
};

const RATE_SSR = 6;    // 千分比 0.6%
const RATE_SR = 51;    // 千分比 5.1%
const PITY_SSR = 90;   // 90 抽必出 SSR
const PITY_SR = 10;    // 10 抽必出 SR

/* ---------- 存档 ---------- */
const SAVE_KEY = 'starfall-gacha-v1';
const state = load();

function blank() {
  return { total: 0, pity5: 0, pity4: 0, got: {}, counts: {}, history: [], muted: false };
}

function load() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return blank();
    return Object.assign(blank(), JSON.parse(raw));
  } catch (e) {
    return blank();
  }
}

function save() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch (e) { /* 隐私模式忽略 */ }
}

/* ---------- 抽卡核心 ---------- */
function pickRarity() {
  state.pity5++;
  state.pity4++;

  let rarity;
  if (state.pity5 >= PITY_SSR) {
    rarity = 'SSR';
  } else if (state.pity4 >= PITY_SR) {
    rarity = 'SR';
  } else {
    const roll = Math.random() * 1000;
    rarity = roll < RATE_SSR ? 'SSR' : roll < RATE_SSR + RATE_SR ? 'SR' : 'R';
  }

  if (rarity === 'SSR') state.pity5 = 0;
  if (rarity !== 'R') state.pity4 = 0;
  return rarity;
}

function drawOne() {
  const rarity = pickRarity();
  const list = POOL[rarity];
  const char = list[Math.floor(Math.random() * list.length)];
  state.total++;
  state.got[rarity] = (state.got[rarity] || 0) + 1;
  state.counts[char.id] = (state.counts[char.id] || 0) + 1;
  state.history.unshift({ no: state.total, ...char, rarity });
  if (state.history.length > 200) state.history.length = 200;
  return { ...char, rarity };
}

/* ---------- 音效 ---------- */
let audioCtx = null;
function beep(rarity) {
  if (state.muted) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const notes = rarity === 'SSR' ? [523, 659, 784, 1047]
                : rarity === 'SR'  ? [440, 587]
                : [330];
    notes.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      const t0 = audioCtx.currentTime + i * 0.07;
      osc.type = rarity === 'R' ? 'triangle' : 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(rarity === 'R' ? 0.05 : 0.12, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.34);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.36);
    });
  } catch (e) { /* 无音频环境则静默 */ }
}

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const stage = $('stage');
const logEl = $('log');
const statsEl = $('stats');
const pull1Btn = $('pull1');
const pull10Btn = $('pull10');
const flashEl = $('flash');
const starsEl = $('sky');
const muteBtn = $('muteBtn');

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
  starsEl.appendChild(frag);
})();

/* ---------- 渲染 ---------- */
function cardEl(item) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.rarity = item.rarity;
  card.innerHTML = `
    <div class="card-inner">
      <div class="card-face card-back">✦<span>STARFALL</span></div>
      <div class="card-face card-front">
        <span class="tag">${RARITY[item.rarity].label}</span>
        <div class="avatar">${item.emoji}</div>
        <div class="cname">${item.name}</div>
        <div class="stars">${'★'.repeat(RARITY[item.rarity].stars)}</div>
      </div>
    </div>`;
  card.addEventListener('click', () => card.classList.toggle('flipped'));
  return card;
}

let busy = false;

function renderResults(items) {
  stage.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'results' + (items.length === 1 ? ' single' : '');

  items.forEach((it, i) => {
    const card = cardEl(it);
    wrap.appendChild(card);
    setTimeout(() => {
      card.classList.add('pop', 'flipped');
      beep(it.rarity);
      if (it.rarity === 'SSR') {
        flashEl.classList.remove('on');
        void flashEl.offsetWidth;   // 重启动画
        flashEl.classList.add('on');
      }
    }, 120 + i * (items.length === 1 ? 0 : 110));
  });

  stage.appendChild(wrap);
}

function renderStats() {
  const ssr = state.got.SSR || 0;
  const sr = state.got.SR || 0;
  const rate = state.total ? ((ssr / state.total) * 100).toFixed(2) + '%' : '—';
  const cards = [
    { k: '总抽数', v: state.total, cls: '' },
    { k: 'SSR 出货', v: ssr, cls: 'ssr' },
    { k: 'SR 出货', v: sr, cls: 'sr' },
    { k: '出金率', v: rate, cls: 'ssr' },
    { k: '距大保底', v: Math.max(0, PITY_SSR - state.pity5) + ' 抽', cls: '' },
  ];
  statsEl.innerHTML = cards
    .map((c) => `<div class="stat ${c.cls}"><b>${c.v}</b><span>${c.k}</span></div>`)
    .join('');
}

function renderPity() {
  $('pityLabel').textContent = `${state.pity5} / ${PITY_SSR}`;
  $('pity4Label').textContent = `${state.pity4} / ${PITY_SR}`;
  $('pityFill').style.width = Math.min(100, (state.pity5 / PITY_SSR) * 100) + '%';
}

function renderLog() {
  if (!state.history.length) {
    logEl.innerHTML = '<li class="empty">还没有抽卡记录，去试试手气吧</li>';
    return;
  }
  logEl.innerHTML = state.history
    .slice(0, 40)
    .map((h) => `<li>
        <span class="pill ${h.rarity}">${h.rarity}</span>
        <span class="li-name">${h.emoji} ${h.name}</span>
        <span class="li-no">#${h.no}</span>
      </li>`)
    .join('');
}

function renderAll() {
  renderStats();
  renderPity();
  renderLog();
  muteBtn.textContent = state.muted ? '🔇' : '🔊';
}

/* ---------- 交互 ---------- */
function pull(n) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('.btn').forEach((b) => (b.disabled = true));

  const items = [];
  for (let i = 0; i < n; i++) items.push(drawOne());

  save();
  renderResults(items);
  renderStats();
  renderPity();
  setTimeout(renderLog, 200);

  // 等翻牌动画放完再解锁
  setTimeout(() => {
    busy = false;
    document.querySelectorAll('.btn').forEach((b) => (b.disabled = false));
  }, 120 + items.length * 110 + 700);
}

pull1Btn.addEventListener('click', () => pull(1));
pull10Btn.addEventListener('click', () => pull(10));

muteBtn.addEventListener('click', () => {
  state.muted = !state.muted;
  save();
  renderAll();
});

$('resetBtn').addEventListener('click', () => {
  if (!confirm('确定要清空所有抽卡记录和保底进度吗？')) return;
  Object.assign(state, blank());
  save();
  stage.innerHTML = '<p class="hint">点击下方按钮，召唤属于你的星灵 ✦</p>';
  renderAll();
});

/* 空格键 = 单抽 */
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat) {
    e.preventDefault();
    pull(1);
  }
});

renderAll();
