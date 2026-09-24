// 参加者画面
import { Client } from '../net.js';
import { drawFlip, FLIP_W, FLIP_H, INK } from '../flip.js';
import { sanitizeName, flipHasContent } from '../state.js';
import * as se from '../se.js';

const $ = (id) => document.getElementById(id);
const LS_NAME = 'ogiri.name';

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2200);
}

function toArrayBuffer(d) {
  if (d instanceof ArrayBuffer) return d;
  if (d && d.buffer instanceof ArrayBuffer) return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
  return null;
}

export function startPlayerView({ code, name, clientId, onExit }) {
  document.body.classList.add('mode-player');
  let myName = sanitizeName(name);

  const local = { mode: 'draw', strokes: [], text: '' }; // 自分のフリップ（ローカルが即時反映）
  const tool = { color: INK.black, width: 8, erase: false };
  let cur = null;          // 描いている途中の線
  let curPointer = null;
  let me = null;           // 最新 state の自分
  let synced = false;      // 接続後の最初の state で同期したか
  let lastRound = null;
  let stage = null;        // 最新 state の stage
  let wasOnStage = false;  // 直前まで自分が発表中だったか
  let openPending = false; // 「オープン」送信済みで反映待ち
  let offset = 0;          // ホスト時計との差
  let timer = { endsAt: null };
  let textTimer = null;
  let drawQueued = false;

  const canvas = $('p-canvas');
  const textArea = $('p-text');
  $('p-room').textContent = '部屋 ' + code;
  $('p-name').textContent = myName;

  // ---- 通信 ----
  const client = new Client(code, {
    onOpen() {
      synced = false;
      client.send({ t: 'hello', role: 'player', name: myName, clientId });
    },
    onData,
    onStatus: setStatus,
  });

  function setStatus(st) {
    const el = $('p-status');
    const map = {
      connecting: ['接続しています…', 'warn'],
      connected: ['接続中', 'ok'],
      retrying: ['再接続中…', 'warn'],
      notfound: ['部屋が見つかりません（再試行中…）', 'ng'],
    };
    const [text, cls] = map[st] || map.connecting;
    el.textContent = text;
    el.className = 'net-badge ' + cls;
  }

  function onData(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'state': applyState(msg); break;
      case 'se': se.playSE(msg.id); break;
      case 'seCustom': {
        const buf = toArrayBuffer(msg.data);
        if (buf) se.addCustomData(msg.id, buf);
        break;
      }
      case 'kicked':
        client.stop();
        window.alert('MCにより退室しました。');
        onExit();
        break;
      default: break;
    }
  }

  function sendFlip() {
    client.send({ t: 'flip', mode: local.mode, strokes: local.strokes, text: local.text });
  }

  function clearLocal() {
    local.strokes = [];
    local.text = '';
    textArea.value = '';
    cur = null;
    curPointer = null;
  }

  function applyState(s) {
    if (typeof s.now === 'number') offset = s.now - Date.now();
    timer = s.timer || { endsAt: null };
    const topic = $('p-topic');
    topic.textContent = s.topic || 'お題を待っています…';
    topic.classList.toggle('waiting', !s.topic);

    // 「全部クリア（次の回へ）」されたら自分のフリップも空に
    if (lastRound !== null && s.round !== lastRound) clearLocal();
    lastRound = s.round;

    const mine = (s.players || []).find((p) => p.id === clientId) || null;
    const prevStage = stage;
    stage = s.stage || null;
    const nowOnStage = !!(stage && stage.playerId === clientId);
    if (!nowOnStage || stage.opened || !prevStage || prevStage.since !== stage.since) openPending = false;
    // MCに下げられた（ステージから外れてフリップが白紙に戻った）ら通常状態へ
    if (wasOnStage && !nowOnStage && mine && !flipHasContent(mine.flip)) clearLocal();
    wasOnStage = nowOnStage;
    // 発表中はホストの内容が正（ステージに出ているものと同じにする）
    if (nowOnStage && mine && mine.flip) {
      cur = null;
      curPointer = null;
      clearTimeout(textTimer);
      local.mode = mine.flip.mode === 'text' ? 'text' : 'draw';
      local.strokes = (mine.flip.strokes || []).slice();
      local.text = mine.flip.text || '';
      if (textArea.value !== local.text) textArea.value = local.text;
      updateModeUI();
      synced = true;
    }
    if (!synced && mine) {
      synced = true;
      if (flipHasContent(local)) {
        // オフライン中に書いた分をホストへ
        sendFlip();
      } else if (flipHasContent(mine.flip)) {
        // リロード後はホストの内容を復元
        local.mode = mine.flip.mode === 'text' ? 'text' : 'draw';
        local.strokes = (mine.flip.strokes || []).slice();
        local.text = mine.flip.text || '';
        textArea.value = local.text;
        updateModeUI();
      } else if (mine.flip && mine.flip.mode !== local.mode) {
        sendFlip();
      }
    }
    me = mine;
    if (mine && mine.name && mine.name !== myName) {
      myName = mine.name;
      $('p-name').textContent = myName;
    }
    updateActionUI();
    requestDraw();
  }

  // ---- 描画 ----
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      drawFlip(canvas, local, cur);
    });
  }

  function onStage() {
    return !!(stage && stage.playerId === clientId);
  }

  // 提出済み、または発表中は編集できない
  function locked() {
    return !!(me && me.submitted) || onStage();
  }

  function toLogical(e) {
    const r = canvas.getBoundingClientRect();
    return [
      Math.round(((e.clientX - r.left) / r.width) * FLIP_W),
      Math.round(((e.clientY - r.top) / r.height) * FLIP_H),
    ];
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (local.mode !== 'draw' || locked()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (cur) return; // 2本目の指は無視
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 無視 */ }
    curPointer = e.pointerId;
    cur = {
      color: tool.erase ? '#000' : tool.color,
      width: tool.erase ? tool.width * 3 : tool.width,
      erase: tool.erase,
      pts: [toLogical(e)],
    };
    requestDraw();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!cur || e.pointerId !== curPointer) return;
    e.preventDefault();
    const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const list = evs.length ? evs : [e];
    for (const ev of list) {
      const p = toLogical(ev);
      const last = cur.pts[cur.pts.length - 1];
      const dx = p[0] - last[0];
      const dy = p[1] - last[1];
      if (dx * dx + dy * dy >= 4) cur.pts.push(p);
    }
    requestDraw();
  });

  function endStroke(e) {
    if (!cur || e.pointerId !== curPointer) return;
    const last = cur.pts[cur.pts.length - 1];
    const p = toLogical(e);
    if (p[0] !== last[0] || p[1] !== last[1]) cur.pts.push(p);
    local.strokes.push(cur);
    cur = null;
    curPointer = null;
    requestDraw();
    sendFlip();
  }
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---- ツール ----
  function updateModeUI() {
    for (const b of $('p-mode').querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === local.mode);
    $('p-draw-tools').hidden = local.mode !== 'draw';
    $('p-text-tools').hidden = local.mode !== 'text';
    canvas.classList.toggle('text-mode', local.mode === 'text');
  }

  function updateToolUI() {
    for (const b of document.querySelectorAll('#p-draw-tools [data-color]')) {
      b.classList.toggle('on', !tool.erase && INK[b.dataset.color] === tool.color);
    }
    for (const b of document.querySelectorAll('#p-draw-tools [data-width]')) {
      b.classList.toggle('on', Number(b.dataset.width) === tool.width);
    }
    $('p-eraser').classList.toggle('on', tool.erase);
  }

  $('p-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b || b.dataset.mode === local.mode) return;
    local.mode = b.dataset.mode;
    cur = null;
    updateModeUI();
    requestDraw();
    sendFlip();
  });

  for (const b of document.querySelectorAll('#p-draw-tools [data-color]')) {
    b.addEventListener('click', () => {
      tool.color = INK[b.dataset.color];
      tool.erase = false;
      updateToolUI();
    });
  }
  for (const b of document.querySelectorAll('#p-draw-tools [data-width]')) {
    b.addEventListener('click', () => {
      tool.width = Number(b.dataset.width);
      updateToolUI();
    });
  }
  $('p-eraser').addEventListener('click', () => {
    tool.erase = !tool.erase;
    updateToolUI();
  });
  $('p-undo').addEventListener('click', () => {
    if (locked() || !local.strokes.length) return;
    local.strokes.pop();
    requestDraw();
    sendFlip();
  });
  $('p-clear').addEventListener('click', () => {
    if (locked() || !local.strokes.length) return;
    if (!window.confirm('手書きを全部消しますか？')) return;
    local.strokes = [];
    requestDraw();
    sendFlip();
  });

  textArea.addEventListener('input', () => {
    local.text = textArea.value;
    requestDraw();
    clearTimeout(textTimer);
    textTimer = setTimeout(sendFlip, 300);
  });

  // ---- 提出・挙手 ----
  function updateActionUI() {
    const submitted = !!(me && me.submitted);
    const mine = onStage();
    const opened = mine && !!stage.opened;
    const lock = submitted || mine;
    const raised = !!(me && me.hand && me.hand.raised);
    const sb = $('p-submit');
    sb.textContent = submitted && !mine ? '書き直す' : '提出する';
    sb.classList.toggle('primary', !submitted || mine);
    sb.disabled = mine;
    const hb = $('p-hand');
    hb.textContent = raised ? `✋ ${me.hand.order || '…'}番目（取り下げ）` : '✋ 挙手';
    hb.classList.toggle('on', raised);
    hb.disabled = mine;
    const badge = $('p-badge');
    if (opened) {
      badge.textContent = 'オープン中';
      badge.className = 'flip-badge b-open';
      badge.hidden = false;
    } else if (submitted && !mine) {
      badge.textContent = '提出済';
      badge.className = 'flip-badge b-done';
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
    // 下部の帯：提出済み or オープン中
    const lockEl = $('p-lock');
    if (opened) {
      $('p-lock-main').textContent = '発表中';
      $('p-lock-sub').textContent = 'MCが下げると次の回答を書けます';
      lockEl.hidden = false;
    } else if (submitted && !mine) {
      $('p-lock-main').textContent = '提出済み';
      $('p-lock-sub').textContent = '直すときは「書き直す」';
      lockEl.hidden = false;
    } else {
      lockEl.hidden = true;
    }
    // 自分の番（未オープン）：大きなオーバーレイ
    $('p-turn').hidden = !(mine && !opened);
    const ob = $('p-open');
    ob.disabled = openPending;
    ob.textContent = openPending ? 'オープン中…' : 'フリップをオープン！';
    $('p-flip-wrap').classList.toggle('locked', lock);
    textArea.disabled = lock;
    for (const b of document.querySelectorAll('#p-draw-tools button, #p-mode button')) b.disabled = lock;
  }

  $('p-open').addEventListener('click', () => {
    if (!onStage() || stage.opened || openPending) return;
    if (!client.connected) {
      toast('まだ接続されていません');
      return;
    }
    client.send({ t: 'open' });
    openPending = true;
    updateActionUI();
  });

  $('p-submit').addEventListener('click', () => {
    if (!me || !client.connected) {
      toast('まだ接続されていません');
      return;
    }
    if (onStage()) return;
    if (me.submitted) {
      client.send({ t: 'submit', submitted: false });
      me = { ...me, submitted: false };
    } else {
      clearTimeout(textTimer);
      sendFlip();
      client.send({ t: 'submit', submitted: true });
      me = { ...me, submitted: true };
    }
    updateActionUI();
  });

  $('p-hand').addEventListener('click', () => {
    if (!me || !client.connected) {
      toast('まだ接続されていません');
      return;
    }
    if (onStage()) return;
    const raised = !!(me.hand && me.hand.raised);
    client.send({ t: 'hand', raised: !raised });
    me = { ...me, hand: raised ? { raised: false } : { raised: true, order: 0 } };
    updateActionUI();
  });

  // ---- 名前・ミュート ----
  $('p-name').addEventListener('click', () => {
    const n = window.prompt('新しい名前（16文字まで）', myName);
    if (n == null || !n.trim()) return;
    myName = sanitizeName(n);
    try { localStorage.setItem(LS_NAME, myName); } catch (e) { /* 無視 */ }
    $('p-name').textContent = myName;
    client.send({ t: 'rename', name: myName });
  });

  const muteBtn = $('p-mute');
  muteBtn.addEventListener('click', () => {
    se.setMuted(!se.isMuted());
    muteBtn.textContent = se.isMuted() ? '🔇' : '🔊';
    muteBtn.classList.toggle('on', se.isMuted());
  });

  // ---- タイマー表示 ----
  setInterval(() => {
    const el = $('p-timer');
    if (!timer || !timer.endsAt) {
      el.hidden = true;
      return;
    }
    const left = Math.max(0, Math.ceil((timer.endsAt - (Date.now() + offset)) / 1000));
    el.hidden = false;
    el.textContent = `⏱ ${left}`;
    el.classList.toggle('danger', left <= 10);
  }, 250);

  // ---- フリップの大きさを画面に合わせる ----
  const area = $('p-flip-area');
  const wrap = $('p-flip-wrap');
  function fit() {
    const w = area.clientWidth;
    const h = area.clientHeight;
    const fw = Math.max(160, Math.floor(Math.min(w, (h * 4) / 3)));
    wrap.style.width = fw + 'px';
    requestDraw();
  }
  new ResizeObserver(fit).observe(area);

  updateModeUI();
  updateToolUI();
  updateActionUI();
  fit();
}
