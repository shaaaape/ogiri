// ホストの状態管理（ホストが唯一の正）

const MAX_STROKES = 3000;
const MAX_PTS = 4000;
const MAX_TEXT = 200;
const MAX_HISTORY = 100;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function emptyFlip(mode = 'draw') {
  return { mode, strokes: [], text: '' };
}

export function flipHasContent(f) {
  return !!f && ((f.strokes && f.strokes.length > 0) || (typeof f.text === 'string' && f.text.trim() !== ''));
}

// 表示用ステータス（MC画面・ステージ画面で共用）
export const STATUS_LABEL = {
  off: '切断',
  onstage: '発表中',
  submitted: '提出済み',
  writing: '記入中',
  idle: '待機中',
};

export function playerStatus(p, stage) {
  if (!p) return 'idle';
  if (!p.connected) return 'off';
  if (stage && stage.playerId === p.id) return 'onstage';
  if (p.submitted) return 'submitted';
  if (flipHasContent(p.flip)) return 'writing';
  return 'idle';
}

export function sanitizeName(s) {
  const n = String(s == null ? '' : s).replace(/[\r\n\t]/g, ' ').trim().slice(0, 16);
  return n || 'ななし';
}

// 受け取ったフリップを安全な形に整える
export function sanitizeFlip(f) {
  const mode = f && f.mode === 'text' ? 'text' : 'draw';
  const strokes = [];
  const src = f && Array.isArray(f.strokes) ? f.strokes.slice(0, MAX_STROKES) : [];
  for (const s of src) {
    if (!s || !Array.isArray(s.pts)) continue;
    const pts = [];
    for (const p of s.pts.slice(0, MAX_PTS)) {
      if (!Array.isArray(p)) continue;
      const x = Math.round(Number(p[0]));
      const y = Math.round(Number(p[1]));
      if (Number.isFinite(x) && Number.isFinite(y)) pts.push([clamp(x, -100, 900), clamp(y, -100, 700)]);
    }
    if (!pts.length) continue;
    const color = typeof s.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(s.color) ? s.color : '#111111';
    const width = clamp(Number(s.width) || 6, 1, 120);
    strokes.push({ color, width, erase: !!s.erase, pts });
  }
  const text = f && typeof f.text === 'string' ? f.text.slice(0, MAX_TEXT) : '';
  return { mode, strokes, text };
}

function sanitizeStage(o) {
  if (!o || typeof o !== 'object' || !o.playerId) return null;
  return { playerId: String(o.playerId), opened: !!o.opened, since: Number(o.since) || Date.now() };
}

export class HostState {
  constructor(room, onChange) {
    this.room = room;
    this.onChange = onChange;
    this.topic = '';
    this.players = [];
    this.stage = null;   // { playerId, opened, since } 中央に出ている人
    this.history = [];   // [{ id, name, flip, at }] このお題で発表済みの回答（クライアントへは送らない）
    this.timer = { endsAt: null, total: 60 };
    this.round = 0;
    this.seq = 0;
    this._handClock = 0;
    this._histSeq = 0;
    this._t = null;
  }

  // 送信用スナップショット
  snapshot() {
    return {
      room: this.room,
      topic: this.topic,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        submitted: p.submitted,
        hand: p.hand.raised ? { raised: true, order: p.hand.order } : { raised: false },
        flip: p.flip,
        rev: p.rev,
      })),
      stage: this.stage ? { ...this.stage } : null,
      timer: { endsAt: this.timer.endsAt, total: this.timer.total },
      round: this.round,
      now: Date.now(),
      seq: this.seq,
    };
  }

  // 変更通知（50msデバウンス）
  changed() {
    this.seq++;
    if (this._t) return;
    this._t = setTimeout(() => {
      this._t = null;
      this.onChange(this.snapshot());
    }, 50);
  }

  // sessionStorage 保存用（容量オーバー時は withFlips=false で中身を省く）
  toSave(withFlips = true) {
    return {
      room: this.room,
      topic: this.topic,
      round: this.round,
      stage: this.stage,
      history: this.history.map((h) => ({ ...h, flip: withFlips ? h.flip : emptyFlip(h.flip.mode) })),
      timer: this.timer,
      handClock: this._handClock,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, submitted: p.submitted,
        hand: p.hand, rev: p.rev, flip: withFlips ? p.flip : emptyFlip(p.flip.mode),
      })),
    };
  }

  // リロード時の復元（全員を切断扱いで戻す）
  load(o) {
    if (!o || typeof o !== 'object') return;
    this.topic = typeof o.topic === 'string' ? o.topic : '';
    this.round = Number(o.round) || 0;
    if (o.timer && typeof o.timer === 'object') {
      this.timer = { endsAt: Number(o.timer.endsAt) || null, total: Number(o.timer.total) || 60 };
    }
    this._handClock = Number(o.handClock) || 0;
    this.players = (Array.isArray(o.players) ? o.players : []).filter((p) => p && p.id).map((p) => ({
      id: String(p.id),
      name: sanitizeName(p.name),
      connected: false,
      submitted: !!p.submitted,
      hand: p.hand && p.hand.raised ? { raised: true, at: Number(p.hand.at) || 0, order: 0 } : { raised: false },
      flip: sanitizeFlip(p.flip),
      rev: (Number(p.rev) || 0) + 1,
    }));
    this._renumber();
    this.stage = sanitizeStage(o.stage);
    if (this.stage && !this.get(this.stage.playerId)) this.stage = null;
    this.history = (Array.isArray(o.history) ? o.history : [])
      .filter((h) => h && typeof h === 'object')
      .slice(-MAX_HISTORY)
      .map((h, i) => ({
        id: String(h.id || 'h' + i),
        name: sanitizeName(h.name),
        flip: sanitizeFlip(h.flip),
        at: Number(h.at) || Date.now(),
      }));
  }

  get(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  connectedCount() {
    return this.players.filter((p) => p.connected).length;
  }

  isOnStage(id) {
    return !!(this.stage && this.stage.playerId === id);
  }

  // 入室（同じ clientId なら復帰）
  join(id, name) {
    let p = this.get(id);
    if (p) {
      p.connected = true;
      if (name) p.name = sanitizeName(name);
    } else {
      p = {
        id, name: sanitizeName(name), connected: true, submitted: false,
        hand: { raised: false }, flip: emptyFlip(), rev: 0,
      };
      this.players.push(p);
    }
    this.changed();
    return p;
  }

  setConnected(id, on) {
    const p = this.get(id);
    if (!p || p.connected === on) return;
    p.connected = on;
    this.changed();
  }

  setFlip(id, flip) {
    const p = this.get(id);
    if (!p || this.isOnStage(id)) return; // 発表中は内容を固定
    p.flip = sanitizeFlip(flip);
    p.rev++;
    this.changed();
  }

  setSubmitted(id, on) {
    const p = this.get(id);
    if (!p || this.isOnStage(id)) return;
    p.submitted = !!on;
    this.changed();
  }

  setHand(id, raised) {
    const p = this.get(id);
    if (!p) return;
    if (raised && this.isOnStage(id)) return; // 発表中は挙手できない
    if (raised && !p.hand.raised) p.hand = { raised: true, at: ++this._handClock, order: 0 };
    else if (!raised) p.hand = { raised: false };
    this._renumber();
    this.changed();
  }

  _renumber() {
    this.players.filter((p) => p.hand.raised)
      .sort((a, b) => a.hand.at - b.hand.at)
      .forEach((p, i) => { p.hand.order = i + 1; });
  }

  rename(id, name) {
    const p = this.get(id);
    if (!p) return;
    p.name = sanitizeName(name);
    this.changed();
  }

  // 全員のフリップ・提出・挙手を空にしてステージも下げる（round を進める）
  _clearFlips() {
    this.round++;
    for (const p of this.players) {
      p.flip = emptyFlip(p.flip.mode);
      p.rev++;
      p.submitted = false;
      p.hand = { raised: false };
    }
    this.stage = null;
  }

  // お題の変更。reset なら全員のフリップ・挙手・ステージ・履歴をリセット
  setTopic(topic, reset) {
    this.topic = String(topic || '').slice(0, 200);
    if (reset) {
      this._clearFlips();
      this.history = [];
    }
    this.changed();
  }

  // 全部クリア（次の回へ）。履歴は残す
  clearAll() {
    this._clearFlips();
    this.changed();
  }

  resetHands() {
    for (const p of this.players) p.hand = { raised: false };
    this.changed();
  }

  // ステージへ呼ぶ（既に誰かいれば入れ替え。前の人は履歴に入れずそのまま戻す）
  callToStage(id) {
    const p = this.get(id);
    if (!p) return;
    if (p.hand.raised) {
      p.hand = { raised: false };
      this._renumber();
    }
    this.stage = { playerId: id, opened: false, since: Date.now() };
    this.changed();
  }

  // フリップをオープン。byId 指定時は発表中の本人のときだけ受理。オープンしたら true
  openStage(byId = null) {
    if (!this.stage || this.stage.opened) return false;
    if (byId != null && this.stage.playerId !== byId) return false;
    this.stage = { ...this.stage, opened: true };
    this.changed();
    return true;
  }

  // 下げる：回答を履歴に移し、その人のフリップを白紙に戻す
  dismissStage() {
    if (!this.stage) return;
    const p = this.get(this.stage.playerId);
    this.stage = null;
    if (p) {
      const now = Date.now();
      this.history.push({
        id: 'h' + now.toString(36) + '-' + (++this._histSeq),
        name: p.name,
        flip: JSON.parse(JSON.stringify(p.flip)),
        at: now,
      });
      if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
      p.flip = emptyFlip(p.flip.mode);
      p.submitted = false;
      p.rev++;
    }
    this.changed();
  }

  clearHistory() {
    this.history = [];
    this.changed();
  }

  remove(id) {
    this.players = this.players.filter((p) => p.id !== id);
    if (this.isOnStage(id)) this.stage = null;
    this._renumber();
    this.changed();
  }

  startTimer(sec) {
    const s = clamp(Math.round(Number(sec) || 60), 1, 999);
    this.timer = { endsAt: Date.now() + s * 1000, total: s };
    this.changed();
  }

  stopTimer() {
    this.timer = { endsAt: null, total: this.timer.total };
    this.changed();
  }
}
