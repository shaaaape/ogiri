// PeerJS 接続（ホスト／クライアント両方）
// Peer はCDNで読み込んだグローバルを使う

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
];
const PEER_OPTS = { config: { iceServers: ICE_SERVERS }, debug: 0 };

export const ID_PREFIX = 'ogiri-';
// 見間違えやすい 0 O 1 I を除いた文字
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RETRY_MS = 3000;

export function peerAvailable() {
  return typeof window.Peer === 'function';
}

export function genCode() {
  const buf = new Uint32Array(4);
  crypto.getRandomValues(buf);
  let s = '';
  for (const n of buf) s += CODE_CHARS[n % CODE_CHARS.length];
  return s;
}

export function normalizeCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
}

// ---- ホスト ----
// h: { onOpen(code), onConnection(conn), onStatus('online'|'waiting'|'reconnecting'|'error') }
// reuse=true のとき（リロード時）は同じコードで数回待ってから新コードにする
export function startHost(initialCode, h, { reuse = false } = {}) {
  let code = initialCode;
  let peer = null;
  let closed = false;
  let sameRetries = reuse ? 3 : 0;

  function create() {
    if (closed) return;
    const p = new window.Peer(ID_PREFIX + code, PEER_OPTS);
    peer = p;

    p.on('open', () => {
      if (p !== peer) return;
      h.onStatus('online');
      h.onOpen(code);
    });
    p.on('connection', (conn) => {
      if (p === peer) h.onConnection(conn);
    });
    p.on('disconnected', () => {
      if (p !== peer || closed || p.destroyed) return;
      h.onStatus('reconnecting');
      setTimeout(() => {
        if (p === peer && !p.destroyed && p.disconnected) {
          try { p.reconnect(); } catch (e) { /* 次の機会に再試行 */ }
        }
      }, 1500);
    });
    p.on('error', (err) => {
      if (p !== peer || closed) return;
      const type = err && err.type;
      if (type === 'unavailable-id') {
        // IDが使用中 → 少し待って同じコード、ダメなら新コード
        peer = null;
        try { p.destroy(); } catch (e) { /* 無視 */ }
        if (sameRetries > 0) {
          sameRetries--;
          h.onStatus('waiting');
          setTimeout(create, 2500);
        } else {
          code = genCode();
          create();
        }
        return;
      }
      if (type === 'peer-unavailable') return;
      h.onStatus('error');
      setTimeout(() => {
        if (p !== peer || closed) return;
        if (p.destroyed) create();
        else if (p.disconnected) {
          try { p.reconnect(); } catch (e) { /* 無視 */ }
        }
      }, RETRY_MS);
    });
  }

  create();
  window.addEventListener('pagehide', () => {
    closed = true;
    try { if (peer) peer.destroy(); } catch (e) { /* 無視 */ }
  });

  return { get code() { return code; } };
}

// ---- クライアント（参加者・ステージ） ----
// h: { onOpen(), onData(msg), onStatus('connecting'|'connected'|'retrying'|'notfound') }
export class Client {
  constructor(code, h) {
    this.hostId = ID_PREFIX + code;
    this.h = h;
    this.peer = null;
    this.conn = null;
    this.stopped = false;
    this.retryTimer = null;
    this.openTimer = null;
    this.everConnected = false;
    this.h.onStatus('connecting');
    this._start();
  }

  get connected() {
    return !!(this.conn && this.conn.open);
  }

  send(msg) {
    if (!this.connected) return false;
    try {
      this.conn.send(msg);
      return true;
    } catch (e) {
      return false;
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.openTimer);
    this._dropConn();
    try { if (this.peer) this.peer.destroy(); } catch (e) { /* 無視 */ }
    this.peer = null;
  }

  _start() {
    if (this.stopped) return;
    const p = this.peer;
    if (!p || p.destroyed) {
      this._createPeer();
    } else if (p.disconnected) {
      try { p.reconnect(); } catch (e) { this._createPeer(); }
      // 再接続できたら open で _connect が呼ばれる。ダメなら再試行
      this._retry();
    } else if (p.open) {
      // 接続待ちのものがあればタイムアウト（openTimer）に任せる
      if (this.conn && !this.conn.open) return;
      this._connect();
    } else {
      this._retry();
    }
  }

  _createPeer() {
    try { if (this.peer) this.peer.destroy(); } catch (e) { /* 無視 */ }
    let p;
    try {
      p = new window.Peer(PEER_OPTS);
    } catch (e) {
      this.peer = null;
      this._retry();
      return;
    }
    this.peer = p;
    p.on('open', () => {
      if (p === this.peer) this._connect();
    });
    p.on('disconnected', () => {
      if (p !== this.peer || this.stopped) return;
      // シグナリングだけ切れた場合。データ接続が生きていれば遊びは続けられる
      setTimeout(() => {
        if (p === this.peer && !p.destroyed && p.disconnected) {
          try { p.reconnect(); } catch (e) { /* 無視 */ }
        }
      }, 1000);
    });
    p.on('error', (err) => {
      if (p !== this.peer || this.stopped) return;
      const type = err && err.type;
      if (type === 'peer-unavailable') {
        this.h.onStatus(this.everConnected ? 'retrying' : 'notfound');
      } else if (!this.connected) {
        this.h.onStatus(this.everConnected ? 'retrying' : 'connecting');
      }
      if (!this.connected) {
        this._dropConn();
        this._retry();
      }
    });
  }

  _connect() {
    if (this.stopped || !this.peer) return;
    if (this.connected) return;
    this._dropConn();
    let c;
    try {
      c = this.peer.connect(this.hostId, { reliable: true });
    } catch (e) {
      this._retry();
      return;
    }
    if (!c) {
      this._retry();
      return;
    }
    this.conn = c;
    clearTimeout(this.openTimer);
    this.openTimer = setTimeout(() => {
      if (c === this.conn && !c.open) {
        this._dropConn();
        this.h.onStatus(this.everConnected ? 'retrying' : 'notfound');
        this._retry();
      }
    }, 12000);

    c.on('open', () => {
      if (c !== this.conn) return;
      clearTimeout(this.openTimer);
      this.everConnected = true;
      this.h.onStatus('connected');
      try { this.h.onOpen(); } catch (e) { console.warn(e); }
    });
    c.on('data', (d) => {
      if (c !== this.conn) return;
      try { this.h.onData(d); } catch (e) { console.warn(e); }
    });
    const lost = () => {
      if (c !== this.conn || this.stopped) return;
      this.conn = null;
      this.h.onStatus(this.everConnected ? 'retrying' : 'notfound');
      this._retry();
    };
    c.on('close', lost);
    c.on('error', lost);
  }

  _dropConn() {
    const c = this.conn;
    this.conn = null;
    if (c) {
      try { c.close(); } catch (e) { /* 無視 */ }
    }
  }

  _retry() {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.connected) return;
      this._start();
    }, RETRY_MS);
  }
}
