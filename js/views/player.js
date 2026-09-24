// 参加者画面
import { Client, normalizeCode } from '../net.js';
import { createFlipEditor } from '../flipEditor.js';
import { sanitizeName, flipHasContent } from '../state.js';
import { alertDialog } from '../dialog.js';
import * as se from '../se.js';

const $ = (id) => document.getElementById(id);
const LS_NAME = 'ogiri.name';
// MC交代で新しいMCになるときに書くキー（host.js と同じもの）
const LS_TOPICS = 'ogiri.topics';
const SS_HOST_ROOM = 'ogiri.hostRoom';
const SS_HOST_STATE = 'ogiri.hostState';
const SS_USED = 'ogiri.usedTopics';
const SS_PENDING = 'ogiri.handoverPending';
const SS_PLAYER = 'ogiri.playerRoom';

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

  let me = null;           // 最新 state の自分
  let synced = false;      // 接続後の最初の state で同期したか
  let lastRound = null;
  let stage = null;        // 最新 state の stage
  let wasOnStage = false;  // 直前まで自分が発表中だったか
  let openPending = false; // 「オープン」送信済みで反映待ち
  let offset = 0;          // ホスト時計との差
  let timer = { endsAt: null };
  let changingTo = null;   // MC交代中なら新しいMCの名前（つながり直したら null）
  let takingOver = false;  // 自分が新しいMCになるところ
  let lastStatus = 'connecting';

  // 自分のフリップ（編集はローカルで即時反映、変わったらホストへ送る）
  const editor = createFlipEditor({
    canvas: $('p-canvas'),
    tools: $('p-tools'),
    onChange: (flip) => sendFlip(flip),
  });
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
    lastStatus = st;
    // 新しいMCにつながったら通常表示に戻す
    if (st === 'connected') changingTo = null;
    renderStatus();
  }

  function renderStatus() {
    const el = $('p-status');
    // MC交代の予告を受けてから、新しいMCにつながるまで
    if (changingTo != null) {
      el.textContent = `MC交代中…（${changingTo}さんへ）`;
      el.className = 'net-badge warn';
      return;
    }
    const st = lastStatus;
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

  async function onData(msg) {
    if (!msg || typeof msg !== 'object' || takingOver) return;
    switch (msg.t) {
      case 'hostChanging':
        changingTo = sanitizeName(msg.newHostName);
        renderStatus();
        toast(`MCが${changingTo}さんに交代します`);
        break;
      case 'handover': takeOver(msg); break;
      case 'state': applyState(msg); break;
      case 'se': se.playSE(msg.id); break;
      case 'seCustom': {
        const buf = toArrayBuffer(msg.data);
        if (buf) se.addCustomData(msg.id, buf);
        break;
      }
      case 'kicked':
        client.stop();
        await alertDialog('MCにより退室しました。');
        onExit();
        break;
      default: break;
    }
  }

  // ---- MCの交代：自分が新しいMCになる ----
  // 受け取った状態を sessionStorage に書いて ?host=1 へ移動し、
  // MC画面の「リロード復元」の仕組みで同じ部屋コードのホストとして立ち上がる
  async function takeOver(msg) {
    if (takingOver) return;
    takingOver = true;
    const t0 = Date.now();
    client.send({ t: 'handoverAck' });
    $('handover-title').textContent = 'MCを引き継ぎます…';
    $('handover-sub').textContent = 'このあとMC画面に切り替わります';
    $('handover-overlay').hidden = false;

    const room = normalizeCode(msg.code).length === 4 ? normalizeCode(msg.code) : code;
    const snap = msg.snapshot && typeof msg.snapshot === 'object' ? { ...msg.snapshot } : {};
    snap.room = room;
    // 自分は参加者から外す（挙手の順番は詰める。発表中ならステージも下げる）
    snap.players = (Array.isArray(snap.players) ? snap.players : []).filter((p) => p && p.id !== clientId);
    snap.players
      .filter((p) => p.hand && p.hand.raised)
      .sort((a, b) => (Number(a.hand.at) || 0) - (Number(b.hand.at) || 0))
      .forEach((p, i) => { p.hand = { ...p.hand, order: i + 1 }; });
    if (snap.stage && snap.stage.playerId === clientId) snap.stage = null;
    // 並び順：前のMCの位置は外し、自分がいた位置に新しいMC（自分の 'host'）を置く
    if (Array.isArray(snap.order)) {
      snap.order = snap.order.filter((id) => id !== 'host').map((id) => (id === clientId ? 'host' : id));
    }
    // タイマーの終了時刻を自分の時計に合わせる
    const sentAt = Number(msg.now);
    if (snap.timer && snap.timer.endsAt && sentAt) {
      snap.timer = { ...snap.timer, endsAt: Number(snap.timer.endsAt) + (Date.now() - sentAt) };
    }

    try {
      try {
        sessionStorage.setItem(SS_HOST_STATE, JSON.stringify(snap));
      } catch (e) {
        // 容量オーバー時はフリップの中身を省く
        const blank = (f) => ({ mode: f && f.mode === 'text' ? 'text' : 'draw', strokes: [], text: '' });
        const lite = {
          ...snap,
          players: snap.players.map((p) => ({ ...p, flip: blank(p.flip) })),
          history: (Array.isArray(snap.history) ? snap.history : []).map((h) => ({ ...h, flip: blank(h && h.flip) })),
        };
        sessionStorage.setItem(SS_HOST_STATE, JSON.stringify(lite));
      }
      if (Array.isArray(msg.usedTopics)) sessionStorage.setItem(SS_USED, JSON.stringify(msg.usedTopics));
      sessionStorage.setItem(SS_HOST_ROOM, room);
      sessionStorage.setItem(SS_PENDING, '1');
      sessionStorage.removeItem(SS_PLAYER);
    } catch (e) {
      console.warn('引き継ぎ状態の保存に失敗', e);
    }

    // お題リスト：前のMCの行を先に、自分の行を後ろに（重複は除く）
    const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
    let myList = null;
    try { myList = localStorage.getItem(LS_TOPICS); } catch (e) { /* 無視 */ }
    const merged = [...new Set([...lines(msg.topicList), ...lines(myList)])];
    if (merged.length) {
      try { localStorage.setItem(LS_TOPICS, merged.join('\n')); } catch (e) { /* 無視 */ }
    }

    // 受信済みのカスタムSEを保存（新しいMC画面でも鳴らせる・配れるように）
    try {
      await Promise.race([
        se.saveReceivedCustom(msg.customSE),
        new Promise((r) => setTimeout(r, 4000)),
      ]);
    } catch (e) { /* 無視 */ }

    // 受け取り確認が届くよう、少なくとも 300ms 待ってから移動
    const wait = Math.max(0, 300 - (Date.now() - t0));
    setTimeout(() => {
      client.stop();
      location.replace(location.pathname + '?host=1');
    }, wait);
  }

  function sendFlip(flip = editor.getFlip()) {
    client.send({ t: 'flip', mode: flip.mode, strokes: flip.strokes, text: flip.text });
  }

  function clearLocal() {
    editor.clear();
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
      editor.setFlip(mine.flip);
      synced = true;
    }
    if (!synced && mine) {
      synced = true;
      const local = editor.getFlip();
      if (flipHasContent(local)) {
        // オフライン中に書いた分をホストへ
        sendFlip();
      } else if (flipHasContent(mine.flip)) {
        // リロード後はホストの内容を復元
        editor.setFlip(mine.flip);
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
    editor.redraw();
  }

  function onStage() {
    return !!(stage && stage.playerId === clientId);
  }

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
    editor.setLocked(lock);
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
      editor.flush(); // 文字の送信待ちがあれば先に送る
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
    editor.redraw();
  }
  new ResizeObserver(fit).observe(area);

  updateActionUI();
  fit();
}
