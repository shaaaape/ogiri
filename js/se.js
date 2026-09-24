// 効果音：内蔵SE（Web Audioで合成）＋カスタムSE（IndexedDB保存）

export const BUILTIN_SE = [
  { id: 'drumroll', name: 'ドラムロール' },
  { id: 'jan', name: 'ジャン' },
  { id: 'pinpon', name: 'ピンポン' },
  { id: 'buzzer', name: 'ブザー' },
  { id: 'clap', name: '拍手' },
  { id: 'chin', name: 'チーン' },
];

const LS_VOL = 'ogiri.seVolume';
const LS_META = 'ogiri.seCustom';
const DB_NAME = 'ogiri-se';
const STORE = 'sounds';

let ctx = null;
let master = null;
let noiseBuf = null;
let volume = loadVolume();
let muted = false;

const rawCustom = new Map(); // id -> ArrayBuffer
const decoded = new Map();   // id -> AudioBuffer
const decoding = new Map();  // id -> Promise

function loadVolume() {
  try {
    const v = parseFloat(localStorage.getItem(LS_VOL));
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8;
  } catch (e) {
    return 0.8;
  }
}

// ---- AudioContext ----
export function ensureAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch (e) {
      return null;
    }
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// ユーザー操作の中で呼ぶ（モバイル対策に無音を1回鳴らす）
export function unlockAudio() {
  const c = ensureAudio();
  if (!c) return;
  try {
    const b = c.createBuffer(1, 1, 22050);
    const s = c.createBufferSource();
    s.buffer = b;
    s.connect(c.destination);
    s.start(0);
  } catch (e) { /* 無視 */ }
  // 待機中のカスタムSEを先にデコードしておく
  for (const id of rawCustom.keys()) getDecoded(id);
}

export function audioState() {
  return ctx ? ctx.state : 'none';
}

export function getVolume() { return volume; }
export function setVolume(v) {
  volume = Math.min(1, Math.max(0, Number(v) || 0));
  try { localStorage.setItem(LS_VOL, String(volume)); } catch (e) { /* 無視 */ }
  if (master && ctx) master.gain.setValueAtTime(volume, ctx.currentTime);
}
export function isMuted() { return muted; }
export function setMuted(m) { muted = !!m; }

// ---- 再生 ----
export function playSE(id) {
  if (muted) return;
  const c = ensureAudio();
  if (!c) return;
  const t = c.currentTime + 0.03;
  try {
    switch (id) {
      case 'drumroll': drumroll(t); break;
      case 'jan': jan(t); break;
      case 'pinpon': pinpon(t); break;
      case 'buzzer': buzzer(t); break;
      case 'clap': clap(t); break;
      case 'chin': chin(t); break;
      default: playCustom(id);
    }
  } catch (e) {
    console.warn('SE再生に失敗', e);
  }
}

// ---- 合成の部品 ----
function getNoise() {
  if (!noiseBuf) {
    const len = Math.floor(ctx.sampleRate * 2);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

// 立ち上がり→指数減衰のエンベロープ
function env(g, t, attack, peak, decay) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function tone(type, freq, t, decay, peak = 0.3, attack = 0.005, dest = master) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  const g = ctx.createGain();
  env(g, t, attack, peak, decay);
  o.connect(g);
  g.connect(dest);
  o.start(t);
  o.stop(t + attack + decay + 0.05);
  return o;
}

function noise(t, decay, peak, filterType, freq, q = 1, dest = master) {
  const s = ctx.createBufferSource();
  s.buffer = getNoise();
  const f = ctx.createBiquadFilter();
  f.type = filterType;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  env(g, t, 0.002, peak, decay);
  s.connect(f);
  f.connect(g);
  g.connect(dest);
  s.start(t, Math.random() * 1.0);
  s.stop(t + decay + 0.05);
}

// ドラムロール：ノイズ＋低音の連打を約2秒、最後にジャン
function drumroll(t) {
  const dur = 1.9;
  let i = 0;
  for (let x = 0; x < dur; x += 0.042, i++) {
    const amp = 0.06 + 0.22 * (x / dur);
    noise(t + x, 0.07, amp, 'bandpass', 1700 + Math.random() * 300, 0.9);
    if (i % 2 === 0) tone('sine', 95, t + x, 0.09, amp * 0.9, 0.003);
  }
  jan(t + 2.0);
}

// ジャン：和音を短く（ファンファーレ風）
function jan(t) {
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 3200;
  lp.connect(master);
  const chord = [261.63, 523.25, 659.25, 783.99, 1046.5];
  // 前打ち「ジャ」
  for (const f of chord) tone('sawtooth', f, t, 0.07, 0.05, 0.004, lp);
  // 本体「ジャーン」
  const t2 = t + 0.13;
  for (const f of chord) {
    tone('sawtooth', f, t2, 0.95, 0.07, 0.01, lp);
    tone('triangle', f, t2, 1.1, 0.06, 0.01, master);
  }
  noise(t2, 0.7, 0.12, 'highpass', 6000, 0.7);
  tone('sine', 65.4, t2, 0.8, 0.3, 0.01);
}

// ピンポン：2音の上昇
function pinpon(t) {
  tone('sine', 783.99, t, 0.45, 0.35, 0.004);
  tone('sine', 1567.98, t, 0.25, 0.06, 0.004);
  tone('sine', 1046.5, t + 0.22, 0.9, 0.35, 0.004);
  tone('sine', 2093.0, t + 0.22, 0.4, 0.06, 0.004);
}

// ブザー：低い矩形波 0.6秒
function buzzer(t) {
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1400;
  lp.connect(master);
  for (const f of [110, 113.5]) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(f, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.01);
    g.gain.setValueAtTime(0.16, t + 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.62);
    o.connect(g);
    g.connect(lp);
    o.start(t);
    o.stop(t + 0.7);
  }
}

// 拍手：ノイズバーストを不規則に1.5秒
function clap(t) {
  const dur = 1.5;
  for (let i = 0; i < 150; i++) {
    const x = Math.random() * dur;
    const shape = Math.sin(Math.PI * Math.min(1, x / dur + 0.1)); // 立ち上がって消えていく
    const amp = (0.04 + Math.random() * 0.1) * Math.max(0.15, shape);
    noise(t + x, 0.02 + Math.random() * 0.04, amp, 'bandpass', 900 + Math.random() * 2400, 1.1);
  }
}

// チーン：高い正弦波を長めに減衰
function chin(t) {
  tone('sine', 2637.0, t, 2.6, 0.28, 0.002);
  tone('sine', 1318.5, t, 2.0, 0.08, 0.002);
  tone('sine', 7278.1, t, 0.9, 0.04, 0.002);
}

// ---- カスタムSE ----
export function addCustomData(id, buf) {
  if (!id || !(buf instanceof ArrayBuffer)) return;
  rawCustom.set(id, buf);
  decoded.delete(id);
  if (ctx) getDecoded(id);
}

export function hasCustom(id) {
  return rawCustom.has(id) || decoded.has(id);
}

export function getCustomRaw(id) {
  return rawCustom.get(id) || null;
}

function getDecoded(id) {
  if (decoded.has(id)) return Promise.resolve(decoded.get(id));
  if (decoding.has(id)) return decoding.get(id);
  const raw = rawCustom.get(id);
  const c = ensureAudio();
  if (!raw || !c) return Promise.resolve(null);
  const p = new Promise((resolve) => {
    const ok = (b) => { decoded.set(id, b); decoding.delete(id); resolve(b); };
    const ng = () => { decoding.delete(id); resolve(null); };
    try {
      const r = c.decodeAudioData(raw.slice(0), ok, ng);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (e) {
      ng();
    }
  });
  decoding.set(id, p);
  return p;
}

function playCustom(id) {
  if (!hasCustom(id)) return;
  getDecoded(id).then((b) => {
    if (!b || muted || !ctx) return;
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.connect(master);
    s.start();
  });
}

// ---- IndexedDB ----
function openDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('IndexedDB非対応')); return; }
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idb(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

export function listCustomMeta() {
  try {
    const a = JSON.parse(localStorage.getItem(LS_META) || '[]');
    return Array.isArray(a) ? a.filter((m) => m && m.id) : [];
  } catch (e) {
    return [];
  }
}

function saveMeta(list) {
  try { localStorage.setItem(LS_META, JSON.stringify(list)); } catch (e) { /* 無視 */ }
}

// ファイルを追加（デコードできるか確認してから保存）
export async function addCustomFile(file) {
  const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const buf = await file.arrayBuffer();
  rawCustom.set(id, buf);
  const b = await getDecoded(id);
  if (!b) {
    rawCustom.delete(id);
    throw new Error('デコードできません');
  }
  await idb('readwrite', (st) => st.put(new Blob([buf], { type: file.type || 'audio/mpeg' }), id));
  const meta = {
    id,
    name: (file.name || 'SE').replace(/\.[^.]+$/, '').slice(0, 20) || 'SE',
    size: buf.byteLength,
    mime: file.type || 'audio/mpeg',
  };
  const list = listCustomMeta();
  list.push(meta);
  saveMeta(list);
  return { meta, buf };
}

// 保存済みのカスタムSEをすべて読み込む
export async function loadAllCustom() {
  const list = listCustomMeta();
  const kept = [];
  for (const m of list) {
    try {
      const blob = await idb('readonly', (st) => st.get(m.id));
      if (!blob) continue;
      const buf = await blob.arrayBuffer();
      rawCustom.set(m.id, buf);
      m.size = buf.byteLength;
      kept.push(m);
    } catch (e) {
      console.warn('カスタムSEの読み込みに失敗', e);
    }
  }
  if (kept.length !== list.length) saveMeta(kept);
  return kept;
}

export function renameCustom(id, name) {
  const list = listCustomMeta();
  const m = list.find((x) => x.id === id);
  if (!m) return;
  m.name = String(name || '').trim().slice(0, 20) || m.name;
  saveMeta(list);
}

export async function deleteCustom(id) {
  saveMeta(listCustomMeta().filter((m) => m.id !== id));
  rawCustom.delete(id);
  decoded.delete(id);
  try {
    await idb('readwrite', (st) => st.delete(id));
  } catch (e) { /* 無視 */ }
}
