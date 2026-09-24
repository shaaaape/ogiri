// MC画面（ホスト）
import { startHost, genCode } from '../net.js';
import { HostState, playerStatus, STATUS_LABEL } from '../state.js';
import { drawFlip } from '../flip.js';
import * as se from '../se.js';

const $ = (id) => document.getElementById(id);
const SE_LIMIT = 1.5 * 1024 * 1024;
const LS_TOPICS = 'ogiri.topics';
const SS_ROOM = 'ogiri.hostRoom';
const SS_STATE = 'ogiri.hostState';
const SS_USED = 'ogiri.usedTopics';
const LS_AUTO_DON = 'ogiri.autoDon';
const SS_PENDING = 'ogiri.handoverPending'; // MC交代で引き継いだ直後の起動（player.js が書く）
const SS_HANDED = 'ogiri.handedOver';       // MCを渡した相手の名前（トップ画面でお知らせ）
const HANDOVER_TIMEOUT = 3000;

const pad2 = (n) => String(n).padStart(2, '0');
function hhmm(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const SAMPLE_TOPICS = [
  'こんなコンビニは嫌だ',
  '桃太郎が鬼ヶ島に行かなかった理由とは？',
  '「この人、絶対に初心者だな」と思った瞬間',
  '宇宙人が地球に来て最初に言った一言とは？',
  'こんな卒業式は嫌だ',
  '100年後のオリンピックの新種目とは？',
  '全然流行らなかった新しいあいさつ',
  '校長先生の話が長すぎて起きたこと',
].join('\n');

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('コピーしました');
    return;
  } catch (e) { /* 下の方法で */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  if (ok) toast('コピーしました');
  else window.prompt('このURLをコピーしてください', text);
}

export function startHostView() {
  document.body.classList.add('mode-host');
  const savedRoom = sessionStorage.getItem(SS_ROOM);
  let code = savedRoom || genCode();
  history.replaceState(null, '', location.pathname + '?host=1');

  const state = new HostState(code, onStateChange);
  try {
    const s = JSON.parse(sessionStorage.getItem(SS_STATE) || 'null');
    if (s && s.room === code) state.load(s);
  } catch (e) { /* 無視 */ }

  const conns = new Map(); // conn -> { role, id, kicked, replaced }
  const cards = new Map(); // playerId -> カード要素
  let firedFor = state.timer.endsAt && state.timer.endsAt <= Date.now() ? state.timer.endsAt : null;
  let saveTimer = null;
  let historyKey = null;
  // リロード復元時に既にオープン済みならドンを鳴らし直さない
  const stageKey = (st) => st.playerId + ':' + st.since;
  let lastOpenKey = state.stage && state.stage.opened ? stageKey(state.stage) : null;
  // MC交代
  let pending = !!savedRoom && sessionStorage.getItem(SS_PENDING) === '1'; // 引き継いで起動中
  let waitPlayers = false; // 引き継ぎ後、参加者が戻ってくるのを待っている
  let handingTo = null;    // 渡している相手 { id, name, timer }
  let leaving = false;     // MCを渡し終えてページを離れるところ

  $('h-code').textContent = code;
  if (pending) {
    setNet('MCを引き継いでいます…', 'warn');
    setBanner('MCを引き継いでいます…（前のMCが部屋を手放すのを待っています）');
  }

  // ---- 接続 ----
  const net = startHost(code, {
    onOpen(c) {
      const changedCode = c !== code;
      if (changedCode) {
        code = c;
        state.room = c;
        state.changed();
        toast('部屋コードが変わりました: ' + c);
      }
      sessionStorage.setItem(SS_ROOM, c);
      $('h-code').textContent = c;
      setNet('受付中', 'ok');
      if (changedCode && savedRoom) {
        // 同じコードで部屋を作り直せなかった → 参加者は自動では戻れない
        setBanner('部屋コードが変わりました：', { alert: true, code: c,
          after: ' 参加用URL・ステージURLをコピーして送り直してください' });
        waitPlayers = false;
      } else if (pending) {
        setBanner('MCを引き継ぎました。参加者とステージが自動でつながり直すのを待っています…');
        waitPlayers = true;
        setTimeout(() => {
          if (waitPlayers) { waitPlayers = false; hideBanner(); }
        }, 30000);
      }
      if (pending) {
        pending = false;
        sessionStorage.removeItem(SS_PENDING);
      }
    },
    onConnection: handleConn,
    onStatus(s) {
      if (s === 'waiting') setNet(pending ? 'MCを引き継いでいます…' : '部屋を準備中…', 'warn');
      else if (s === 'reconnecting') setNet('サーバー再接続中…', 'warn');
      else if (s === 'error') setNet('通信エラー（再試行中）', 'warn');
    },
  }, { reuse: !!savedRoom, retries: pending ? 8 : 3 });

  function setNet(text, cls) {
    const el = $('h-net');
    el.textContent = text;
    el.className = 'net-badge ' + cls;
  }

  // ヘッダのお知らせ帯
  function setBanner(text, { alert = false, code: c = null, after = '' } = {}) {
    const t = $('h-banner-text');
    t.textContent = text;
    if (c) {
      const b = document.createElement('b');
      b.textContent = c;
      t.append(b, after);
    }
    $('h-banner').classList.toggle('alert', alert);
    $('h-banner').hidden = false;
  }
  function hideBanner() {
    $('h-banner').hidden = true;
  }
  $('h-banner-close').addEventListener('click', () => {
    waitPlayers = false;
    hideBanner();
  });

  function showOverlay(title, sub) {
    $('handover-title').textContent = title;
    $('handover-sub').textContent = sub || '';
    $('handover-overlay').hidden = false;
  }

  function handleConn(conn) {
    conns.set(conn, { role: null, id: null, kicked: false, replaced: false });
    conn.on('data', (msg) => {
      try { onMsg(conn, msg); } catch (e) { console.warn(e); }
    });
    const gone = () => onClose(conn);
    conn.on('close', gone);
    conn.on('error', gone);
  }

  function onClose(conn) {
    const m = conns.get(conn);
    if (!m) return;
    conns.delete(conn);
    if (m.role === 'player' && !m.replaced && !m.kicked) {
      const still = [...conns.values()].some((x) => x.role === 'player' && x.id === m.id);
      if (!still) state.setConnected(m.id, false);
    }
    updateCount();
  }

  function sendTo(conn, msg) {
    if (!conn || !conn.open) return;
    try { conn.send(msg); } catch (e) { /* 無視 */ }
  }

  function broadcast(msg, filter) {
    for (const [c, m] of conns) {
      if (m.role && (!filter || filter(m))) sendTo(c, msg);
    }
  }

  function onMsg(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    const m = conns.get(conn);
    if (!m || leaving) return;

    // MCを渡している間は受け取り確認だけ受け付ける
    if (handingTo) {
      if (msg.t === 'handoverAck' && m.role === 'player' && m.id === handingTo.id) finishHandover();
      return;
    }

    if (msg.t === 'hello') {
      if (msg.role === 'stage') {
        m.role = 'stage';
      } else {
        const id = String(msg.clientId || '').slice(0, 64) || 'p' + Math.random().toString(36).slice(2, 10);
        // 同じ人の古い接続は置き換える
        for (const [c, mm] of conns) {
          if (c !== conn && mm.role === 'player' && mm.id === id) {
            mm.replaced = true;
            try { c.close(); } catch (e) { /* 無視 */ }
          }
        }
        m.role = 'player';
        m.id = id;
        state.join(id, msg.name);
      }
      sendTo(conn, { t: 'state', ...state.snapshot() });
      sendCustomsTo(conn, m.role);
      updateCount();
      return;
    }

    if (m.role !== 'player' || m.kicked) return;
    switch (msg.t) {
      case 'flip': state.setFlip(m.id, msg); break;
      case 'submit': state.setSubmitted(m.id, !!msg.submitted); break;
      case 'hand': state.setHand(m.id, !!msg.raised); break;
      case 'rename': state.rename(m.id, msg.name); break;
      case 'open': state.openStage(m.id); break;
      default: break;
    }
  }

  function kick(id) {
    for (const [c, m] of conns) {
      if (m.role === 'player' && m.id === id) {
        m.kicked = true;
        sendTo(c, { t: 'kicked' });
        setTimeout(() => { try { c.close(); } catch (e) { /* 無視 */ } }, 800);
      }
    }
    state.remove(id);
  }

  // ---- MCの交代 ----
  // 参加者 id にMCを渡す。相手のブラウザが同じ部屋コードで新しいホストになる
  function handOver(id) {
    if (handingTo || leaving) return;
    const p = state.get(id);
    if (!p || !p.connected || state.isOnStage(id)) return;
    const findConn = () => {
      for (const [c, m] of conns) {
        if (m.role === 'player' && m.id === id && !m.kicked && c.open) return c;
      }
      return null;
    };
    if (!findConn()) {
      toast('その人とはいまつながっていません');
      return;
    }
    if (!window.confirm(`「${p.name}」さんにMCを渡しますか？\nあなたは参加者として入り直せます。`)) return;
    // 確認ダイアログの間に状況が変わっていないか
    const conn = findConn();
    if (!conn || !state.get(id) || state.isOnStage(id) || handingTo || leaving) {
      toast('MCを渡せませんでした（相手の状態が変わりました）');
      return;
    }
    handingTo = { id, name: p.name, timer: null };
    // 渡す相手以外（参加者・ステージ）へ予告
    broadcast({ t: 'hostChanging', newHostName: p.name }, (m) => !(m.role === 'player' && m.id === id));
    const customSE = se.listCustomMeta()
      .filter((m) => se.hasCustom(m.id))
      .map((m) => ({ id: m.id, name: m.name, mime: m.mime }));
    sendTo(conn, {
      t: 'handover',
      code,
      snapshot: state.toSave(true),
      topicList: topicList.value,
      customSE,
      usedTopics: [...used], // ランダム出題の「出題済み」
      now: Date.now(),       // タイマーの時計合わせ用
    });
    showOverlay(`${p.name}さんにMCを渡しています…`, '受け取りの確認を待っています');
    handingTo.timer = setTimeout(finishHandover, HANDOVER_TIMEOUT);
  }

  // 受け取り確認（またはタイムアウト）→ 部屋を手放して参加フォームへ
  function finishHandover() {
    if (leaving || !handingTo) return;
    leaving = true;
    clearTimeout(handingTo.timer);
    clearTimeout(saveTimer);
    const list = [...conns.keys()];
    conns.clear();
    for (const c of list) {
      try { c.close(); } catch (e) { /* 無視 */ }
    }
    net.destroy(); // Peer ID（ogiri-CODE）を解放
    for (const k of [SS_STATE, SS_ROOM, SS_USED, SS_PENDING]) sessionStorage.removeItem(k);
    try { sessionStorage.setItem(SS_HANDED, handingTo.name); } catch (e) { /* 無視 */ }
    showOverlay('MCを渡しました', '参加者として入り直す画面へ移動します…');
    location.replace(location.pathname + '?room=' + code);
  }

  // ---- 状態変更 → 全員へ送信・画面更新 ----
  function onStateChange(snap) {
    if (leaving) return;
    broadcast({ t: 'state', ...snap });
    // オープンされた瞬間（false→true）にドン
    const st = snap.stage;
    if (st && st.opened && stageKey(st) !== lastOpenKey) {
      lastOpenKey = stageKey(st);
      if ($('h-auto-don').checked) fireSE('don');
    }
    render(snap);
    scheduleSave();
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    if (leaving) return;
    saveTimer = setTimeout(() => {
      if (leaving) return;
      try {
        sessionStorage.setItem(SS_STATE, JSON.stringify(state.toSave(true)));
      } catch (e) {
        try { sessionStorage.setItem(SS_STATE, JSON.stringify(state.toSave(false))); } catch (e2) { /* 無視 */ }
      }
    }, 800);
  }

  // ---- 描画 ----
  function render(s) {
    const nt = $('h-now-topic');
    nt.textContent = s.topic || '（まだ出題していません）';
    nt.classList.toggle('empty', !s.topic);
    renderPlayers(s, false);
    renderHands(s);
    renderHistory(false);
    updateCount();
  }

  function makeCard(id) {
    const el = document.createElement('div');
    el.className = 'pcard';
    el.innerHTML = `
      <div class="pcard-head">
        <span class="pcard-name"></span>
        <span class="pcard-hand"></span>
      </div>
      <div class="pcard-flip">
        <canvas class="flip-canvas"></canvas>
        <span class="pcard-badge"></span>
      </div>
      <div class="pcard-btns">
        <button type="button" class="btn small primary b-call">ステージへ</button>
        <button type="button" class="btn small primary b-open">オープン（MC側で）</button>
        <button type="button" class="btn small b-dismiss">下げる</button>
        <button type="button" class="btn small danger b-kick">退室させる</button>
        <button type="button" class="btn small subtle b-handover" title="この人を新しいMCにする">MCを渡す</button>
      </div>`;
    const c = {
      el,
      name: el.querySelector('.pcard-name'),
      hand: el.querySelector('.pcard-hand'),
      canvas: el.querySelector('canvas'),
      badge: el.querySelector('.pcard-badge'),
      call: el.querySelector('.b-call'),
      open: el.querySelector('.b-open'),
      dismiss: el.querySelector('.b-dismiss'),
      kick: el.querySelector('.b-kick'),
      handover: el.querySelector('.b-handover'),
      rev: -1,
    };
    c.handover.addEventListener('click', () => handOver(id));
    c.call.addEventListener('click', () => state.callToStage(id));
    c.open.addEventListener('click', () => state.openStage());
    c.dismiss.addEventListener('click', () => {
      if (state.isOnStage(id)) state.dismissStage();
    });
    c.kick.addEventListener('click', () => {
      const p = state.get(id);
      if (p && window.confirm(`「${p.name}」を退室させますか？（フリップも消えます）`)) kick(id);
    });
    return c;
  }

  function renderPlayers(s, force) {
    const grid = $('h-players');
    const ids = new Set(s.players.map((p) => p.id));
    for (const [id, c] of cards) {
      if (!ids.has(id)) {
        c.el.remove();
        cards.delete(id);
      }
    }
    s.players.forEach((p, i) => {
      let c = cards.get(p.id);
      if (!c) {
        c = makeCard(p.id);
        cards.set(p.id, c);
      }
      if (grid.children[i] !== c.el) grid.insertBefore(c.el, grid.children[i] || null);
      const onStage = !!(s.stage && s.stage.playerId === p.id);
      const opened = onStage && s.stage.opened;
      const st = playerStatus(p, s.stage);
      c.el.classList.toggle('off', !p.connected);
      c.el.classList.toggle('onstage', onStage);
      c.name.textContent = p.name + (p.connected ? '' : '（切断中）');
      c.hand.textContent = p.hand.raised ? `✋ ${p.hand.order}` : '';
      c.badge.textContent = st === 'onstage' ? (opened ? '発表中（オープン）' : '発表中') : STATUS_LABEL[st];
      c.badge.className = 'pcard-badge st-' + st;
      c.call.hidden = onStage;
      c.kick.hidden = onStage;
      c.open.hidden = !onStage || opened;
      c.dismiss.hidden = !onStage;
      // 切断中・発表中の人には渡せない
      c.handover.disabled = !p.connected || onStage || !!handingTo;
      c.handover.title = !p.connected ? '切断中の人には渡せません'
        : onStage ? '発表中の人には渡せません（下げてから）' : 'この人を新しいMCにする';
      if (force || c.rev !== p.rev) {
        c.rev = p.rev;
        drawFlip(c.canvas, p.flip);
      }
    });
    $('h-empty').hidden = s.players.length > 0;
  }

  function renderHands(s) {
    const ol = $('h-hands');
    const raised = s.players.filter((p) => p.hand.raised).sort((a, b) => a.hand.order - b.hand.order);
    ol.innerHTML = '';
    if (!raised.length) {
      const li = document.createElement('li');
      li.className = 'muted none';
      li.textContent = '（まだいません）';
      ol.appendChild(li);
      return;
    }
    for (const p of raised) {
      const li = document.createElement('li');
      const nm = document.createElement('span');
      nm.className = 'hand-name';
      nm.textContent = p.name;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn small primary';
      btn.textContent = 'ステージへ';
      btn.addEventListener('click', () => state.callToStage(p.id));
      li.append(nm, btn);
      ol.appendChild(li);
    }
  }

  // 回答履歴（新しい順）。中身が変わったときだけ作り直す
  function renderHistory(force) {
    const list = state.history;
    const key = list.map((h) => h.id).join(',');
    $('h-history-count').textContent = list.length ? `${list.length}件` : '';
    $('h-history-empty').hidden = list.length > 0;
    if (!force && key === historyKey) return;
    historyKey = key;
    const box = $('h-history');
    box.innerHTML = '';
    for (const h of list.slice().reverse()) {
      const item = document.createElement('div');
      item.className = 'hist-item';
      item.innerHTML = `
        <div class="hist-flip"><canvas class="flip-canvas"></canvas></div>
        <div class="hist-meta"><span class="hist-name"></span><span class="hist-time muted small"></span></div>`;
      item.querySelector('.hist-name').textContent = h.name;
      item.querySelector('.hist-time').textContent = hhmm(h.at);
      box.appendChild(item);
      drawFlip(item.querySelector('canvas'), h.flip);
    }
  }
  $('h-history-clear').addEventListener('click', () => {
    if (!state.history.length) return;
    if (window.confirm('回答履歴を消しますか？')) state.clearHistory();
  });

  function updateCount() {
    const players = state.connectedCount();
    const stages = [...conns.values()].filter((m) => m.role === 'stage').length;
    $('h-count').textContent = `参加者 ${players}人` + (stages ? ` ／ ステージ ${stages}` : '');
    // 引き継ぎ後、誰かが戻ってきたらお知らせを消す
    if (waitPlayers && (players > 0 || stages > 0)) {
      waitPlayers = false;
      hideBanner();
      toast('MCを引き継ぎました');
    }
  }

  // リサイズ時にプレビューを描き直す
  let roQueued = false;
  new ResizeObserver(() => {
    if (roQueued) return;
    roQueued = true;
    requestAnimationFrame(() => {
      roQueued = false;
      renderPlayers(state.snapshot(), true);
    });
  }).observe($('h-players'));

  // ---- ヘッダ ----
  const baseUrl = () => location.origin + location.pathname;
  $('h-copy-join').addEventListener('click', () => copyText(`${baseUrl()}?room=${code}`));
  $('h-copy-stage').addEventListener('click', () => copyText(`${baseUrl()}?room=${code}&stage=1`));

  // ---- お題 ----
  const topicList = $('h-topic-list');
  let listText = null;
  try { listText = localStorage.getItem(LS_TOPICS); } catch (e) { /* 無視 */ }
  topicList.value = listText == null ? SAMPLE_TOPICS : listText;
  let used;
  try { used = new Set(JSON.parse(sessionStorage.getItem(SS_USED) || '[]')); } catch (e) { used = new Set(); }

  const topicLines = () => topicList.value.split('\n').map((s) => s.trim()).filter(Boolean);
  function saveUsed() {
    try { sessionStorage.setItem(SS_USED, JSON.stringify([...used])); } catch (e) { /* 無視 */ }
  }
  function updateLeft() {
    const lines = topicLines();
    const left = lines.filter((t) => !used.has(t)).length;
    $('h-topic-left').textContent = lines.length ? `未出題 ${left} ／ ${lines.length}` : '';
  }
  topicList.addEventListener('input', () => {
    try { localStorage.setItem(LS_TOPICS, topicList.value); } catch (e) { /* 無視 */ }
    updateLeft();
  });

  function giveTopic(t) {
    used.add(t);
    saveUsed();
    updateLeft();
    state.setTopic(t, $('h-auto-reset').checked);
  }
  function sendTopicInput() {
    const t = $('h-topic-input').value.trim();
    if (!t) {
      toast('お題を入力してください');
      return;
    }
    giveTopic(t);
    $('h-topic-input').value = '';
  }
  $('h-topic-send').addEventListener('click', sendTopicInput);
  $('h-topic-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) sendTopicInput();
  });
  $('h-topic-random').addEventListener('click', () => {
    const lines = topicLines();
    if (!lines.length) {
      toast('お題リストが空です');
      return;
    }
    let cand = lines.filter((t) => !used.has(t));
    if (!cand.length) {
      used.clear();
      cand = lines;
      toast('全部出したので最初からです');
    }
    giveTopic(cand[Math.floor(Math.random() * cand.length)]);
  });
  updateLeft();

  // ---- 全体操作 ----
  $('h-clear-all').addEventListener('click', () => state.clearAll());
  $('h-hands-reset').addEventListener('click', () => state.resetHands());

  // ---- タイマー ----
  $('h-timer-start').addEventListener('click', () => {
    const sec = Math.min(999, Math.max(1, parseInt($('h-timer-sec').value, 10) || 60));
    $('h-timer-sec').value = sec;
    state.startTimer(sec);
  });
  $('h-timer-stop').addEventListener('click', () => state.stopTimer());
  setInterval(() => {
    const el = $('h-timer-display');
    const t = state.timer;
    if (!t.endsAt) {
      el.textContent = '--';
      el.classList.remove('danger');
      return;
    }
    const left = Math.max(0, Math.ceil((t.endsAt - Date.now()) / 1000));
    el.textContent = String(left);
    el.classList.toggle('danger', left <= 10);
    if (left <= 0 && firedFor !== t.endsAt) {
      firedFor = t.endsAt;
      if ($('h-timer-jan').checked) fireSE('jan');
    }
  }, 200);

  // ---- SEパッド ----
  function fireSE(id) {
    se.playSE(id);
    broadcast({ t: 'se', id });
  }

  // 「オープン時に自動でドン」の設定（localStorage）
  const autoDon = $('h-auto-don');
  try {
    const v = localStorage.getItem(LS_AUTO_DON);
    if (v != null) autoDon.checked = v === '1';
  } catch (e) { /* 無視 */ }
  autoDon.addEventListener('change', () => {
    try { localStorage.setItem(LS_AUTO_DON, autoDon.checked ? '1' : '0'); } catch (e) { /* 無視 */ }
  });

  const builtin = $('h-se-builtin');
  for (const b of se.BUILTIN_SE) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn se-btn';
    btn.textContent = b.name;
    btn.addEventListener('click', () => fireSE(b.id));
    builtin.appendChild(btn);
  }

  function sendCustomsTo(conn, role) {
    for (const m of se.listCustomMeta()) {
      const buf = se.getCustomRaw(m.id);
      if (!buf) continue;
      if (role === 'stage' || buf.byteLength <= SE_LIMIT) {
        sendTo(conn, { t: 'seCustom', id: m.id, name: m.name, mime: m.mime, data: buf });
      }
    }
  }

  function bindLongPress(btn, onLong) {
    let tm = null;
    let fired = false;
    // 長押し後のクリックを打ち消す（再生より先に登録）
    btn.addEventListener('click', (e) => {
      if (fired) {
        fired = false;
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    });
    btn.addEventListener('pointerdown', () => {
      fired = false;
      clearTimeout(tm);
      tm = setTimeout(() => { fired = true; onLong(); }, 700);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
      btn.addEventListener(ev, () => clearTimeout(tm));
    }
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  async function removeCustom(m) {
    if (!window.confirm(`「${m.name}」を削除しますか？`)) return;
    await se.deleteCustom(m.id);
    renderCustom();
  }

  function renderCustom() {
    const box = $('h-se-custom');
    box.innerHTML = '';
    for (const m of se.listCustomMeta()) {
      if (!se.hasCustom(m.id)) continue;
      const wrap = document.createElement('div');
      wrap.className = 'se-custom';
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'btn se-btn custom';
      play.textContent = m.name;
      play.title = (m.size > SE_LIMIT ? '（1.5MB超：ホストとステージのみ）' : '') + '長押しで削除';
      if (m.size > SE_LIMIT) play.classList.add('big-file');
      bindLongPress(play, () => removeCustom(m));
      play.addEventListener('click', () => fireSE(m.id));
      const ren = document.createElement('button');
      ren.type = 'button';
      ren.className = 'mini';
      ren.title = '名前を変更';
      ren.textContent = '✎';
      ren.addEventListener('click', () => {
        const n = window.prompt('ボタンの名前', m.name);
        if (n && n.trim()) {
          se.renameCustom(m.id, n);
          renderCustom();
        }
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'mini';
      del.title = '削除';
      del.textContent = '×';
      del.addEventListener('click', () => removeCustom(m));
      wrap.append(play, ren, del);
      box.appendChild(wrap);
    }
  }

  se.loadAllCustom().then(() => {
    renderCustom();
    // 既に接続済みの相手にも送る
    for (const [c, m] of conns) if (m.role) sendCustomsTo(c, m.role);
  }).catch((e) => console.warn(e));

  $('h-se-file').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const f of files) {
      try {
        const { meta, buf } = await se.addCustomFile(f);
        renderCustom();
        const big = buf.byteLength > SE_LIMIT;
        broadcast({ t: 'seCustom', id: meta.id, name: meta.name, mime: meta.mime, data: buf },
          (m) => m.role === 'stage' || !big);
        if (big) {
          window.alert(`「${meta.name}」は1.5MBを超えているため、参加者には送られません。\nホストとステージ画面でのみ鳴ります。`);
        } else {
          toast(`「${meta.name}」を追加しました`);
        }
      } catch (err) {
        window.alert(`「${f.name}」を音声として読み込めませんでした。mp3などの音声ファイルを選んでください。`);
      }
    }
  });

  const vol = $('h-se-vol');
  vol.value = Math.round(se.getVolume() * 100);
  vol.addEventListener('input', () => se.setVolume(vol.value / 100));
  const muteBtn = $('h-se-mute');
  const renderMute = () => {
    muteBtn.textContent = se.isMuted() ? '🔇 ミュート中' : '🔊';
    muteBtn.classList.toggle('on', se.isMuted());
  };
  muteBtn.addEventListener('click', () => {
    se.setMuted(!se.isMuted());
    renderMute();
  });
  renderMute();

  // 初期表示
  render(state.snapshot());
  window.addEventListener('beforeunload', (e) => {
    if (leaving) return; // MCを渡して移動するときは確認しない
    if (state.players.some((p) => p.connected)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}
