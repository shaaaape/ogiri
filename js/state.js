// ホストの状態管理（ホストが唯一の正）

const MAX_STROKES = 3000;
const MAX_PTS = 4000;
const MAX_TEXT = 200;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function emptyFlip(mode = 'draw') {
  return { mode, strokes: [], text: '' };
}

export function flipHasContent(f) {
  return !!f && ((f.strokes && f.strokes.length > 0) || (typeof f.text === 'string' && f.text.trim() !== ''));
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

export class HostState {
  constructor(room, onChange) {
    this.room = room;
    this.onChange = onChange;
    this.topic = '';
    this.players = [];
    this.spotlightId = null;
    this.timer = { endsAt: null, total: 60 };
    this.round = 0;
    this.seq = 0;
    this._handClock = 0;
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
        revealed: p.revealed,
        hand: p.hand.raised ? { raised: true, order: p.hand.order } : { raised: false },
        flip: p.flip,
        rev: p.rev,
      })),
      spotlightId: this.spotlightId,
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

  // sessionStorage 保存用
  toSave(withFlips = true) {
    return {
      room: this.room,
      topic: this.topic,
      round: this.round,
      spotlightId: this.spotlightId,
      timer: this.timer,
      handClock: this._handClock,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, submitted: p.submitted, revealed: p.revealed,
        hand: p.hand, rev: p.rev, flip: withFlips ? p.flip : emptyFlip(p.flip.mode),
      })),
    };
  }

  // リロード時の復元（全員を切断扱いで戻す）
  load(o) {
    if (!o || typeof o !== 'object') return;
    this.topic = typeof o.topic === 'string' ? o.topic : '';
    this.round = Number(o.round) || 0;
    this.spotlightId = o.spotlightId || null;
    if (o.timer && typeof o.timer === 'object') {
      this.timer = { endsAt: Number(o.timer.endsAt) || null, total: Number(o.timer.total) || 60 };
    }
    this._handClock = Number(o.handClock) || 0;
    this.players = (Array.isArray(o.players) ? o.players : []).filter((p) => p && p.id).map((p) => ({
      id: String(p.id),
      name: sanitizeName(p.name),
      connected: false,
      submitted: !!p.submitted,
      revealed: !!p.revealed,
      hand: p.hand && p.hand.raised ? { raised: true, at: Number(p.hand.at) || 0, order: 0 } : { raised: false },
      flip: sanitizeFlip(p.flip),
      rev: (Number(p.rev) || 0) + 1,
    }));
    this._renumber();
    if (this.spotlightId && !this.get(this.spotlightId)) this.spotlightId = null;
  }

  get(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  connectedCount() {
    return this.players.filter((p) => p.connected).length;
  }

  // 入室（同じ clientId なら復帰）
  join(id, name) {
    let p = this.get(id);
    if (p) {
      p.connected = true;
      if (name) p.name = sanitizeName(name);
    } else {
      p = {
        id, name: sanitizeName(name), connected: true, submitted: false, revealed: false,
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
    if (!p) return;
    p.flip = sanitizeFlip(flip);
    p.rev++;
    this.changed();
  }

  setSubmitted(id, on) {
    const p = this.get(id);
    if (!p) return;
    p.submitted = !!on;
    if (!on) p.revealed = false;
    this.changed();
  }

  setHand(id, raised) {
    const p = this.get(id);
    if (!p) return;
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

  setTopic(topic, reset) {
    this.topic = String(topic || '').slice(0, 200);
    if (reset) {
      for (const p of this.players) {
        p.revealed = false;
        p.hand = { raised: false };
      }
      this.spotlightId = null;
    }
    this.changed();
  }

  setRevealed(id, on) {
    const p = this.get(id);
    if (!p) return;
    p.revealed = !!on;
    if (!on && this.spotlightId === id) this.spotlightId = null;
    this.changed();
  }

  revealAll(on) {
    for (const p of this.players) p.revealed = !!on;
    if (!on) this.spotlightId = null;
    this.changed();
  }

  // 次の回へ：全員のフリップを空にする
  clearAll() {
    this.round++;
    for (const p of this.players) {
      p.flip = emptyFlip(p.flip.mode);
      p.rev++;
      p.submitted = false;
      p.revealed = false;
      p.hand = { raised: false };
    }
    this.spotlightId = null;
    this.changed();
  }

  resetHands() {
    for (const p of this.players) p.hand = { raised: false };
    this.changed();
  }

  toggleSpotlight(id) {
    this.spotlightId = this.spotlightId === id ? null : id;
    this.changed();
  }

  remove(id) {
    this.players = this.players.filter((p) => p.id !== id);
    if (this.spotlightId === id) this.spotlightId = null;
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
