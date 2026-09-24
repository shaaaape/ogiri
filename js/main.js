// 起点：URLパラメータ判定と画面切り替え
import { normalizeCode, peerAvailable } from './net.js';
import { unlockAudio, audioState } from './se.js';
import { sanitizeName } from './state.js';
import { startHostView } from './views/host.js';
import { startPlayerView } from './views/player.js';
import { startStageView } from './views/stage.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const LS_NAME = 'ogiri.name';
const LS_CID = 'ogiri.clientId';
const SS_PLAYER = 'ogiri.playerRoom';
const SS_HOST = 'ogiri.hostRoom';

function lsGet(k) {
  try { return localStorage.getItem(k); } catch (e) { return null; }
}
function lsSet(k, v) {
  try { localStorage.setItem(k, v); } catch (e) { /* 無視 */ }
}

function showView(name) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== 'view-' + name;
}

function uuid() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function getClientId() {
  let id = lsGet(LS_CID);
  if (!id) {
    id = uuid();
    lsSet(LS_CID, id);
  }
  return id;
}

// 最初のユーザー操作で AudioContext を作成・resume（モバイル対策）
const gestureEvents = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'];
function onGesture() {
  unlockAudio();
  if (audioState() === 'running') {
    for (const ev of gestureEvents) window.removeEventListener(ev, onGesture, true);
  }
}
for (const ev of gestureEvents) window.addEventListener(ev, onGesture, true);

// ---- 画面の起動 ----
function goHost() {
  showView('host');
  startHostView();
}

function goPlayer(code, name) {
  sessionStorage.setItem(SS_PLAYER, code);
  history.replaceState(null, '', location.pathname + '?room=' + code);
  showView('player');
  startPlayerView({
    code,
    name,
    clientId: getClientId(),
    onExit() {
      sessionStorage.removeItem(SS_PLAYER);
      location.href = location.pathname;
    },
  });
}

function goStage(code) {
  showView('stage');
  startStageView({
    code,
    chroma: params.get('chroma') === '1',
    mute: params.get('mute') === '1',
  });
}

function goTop(prefillCode) {
  showView('top');
  const joinForm = $('join-form');
  const stageForm = $('stage-form');
  $('join-name').value = lsGet(LS_NAME) || '';

  if (location.protocol === 'file:') {
    showFatal('このページは file:// では動きません。README の手順で http(s) から開いてください。');
  }

  $('btn-create').addEventListener('click', () => {
    if (!peerAvailable()) return;
    goHost();
  });
  $('btn-show-join').addEventListener('click', () => {
    stageForm.hidden = true;
    joinForm.hidden = !joinForm.hidden;
    if (!joinForm.hidden) ($('join-code').value ? $('join-name') : $('join-code')).focus();
  });
  $('btn-show-stage').addEventListener('click', () => {
    joinForm.hidden = true;
    stageForm.hidden = !stageForm.hidden;
    if (!stageForm.hidden) $('stage-code').focus();
  });

  for (const id of ['join-code', 'stage-code']) {
    const el = $(id);
    el.addEventListener('input', () => {
      const v = normalizeCode(el.value);
      if (v !== el.value) el.value = v;
    });
  }

  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!peerAvailable()) return;
    const code = normalizeCode($('join-code').value);
    const rawName = $('join-name').value.trim();
    if (code.length !== 4) {
      $('join-error').textContent = '部屋コードは4文字です';
      return;
    }
    if (!rawName) {
      $('join-error').textContent = '名前を入力してください';
      return;
    }
    const name = sanitizeName(rawName);
    lsSet(LS_NAME, name);
    goPlayer(code, name);
  });

  stageForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = normalizeCode($('stage-code').value);
    if (code.length !== 4) {
      $('stage-error').textContent = '部屋コードは4文字です';
      return;
    }
    let url = `${location.pathname}?room=${code}&stage=1`;
    if ($('stage-chroma').checked) url += '&chroma=1';
    if ($('stage-mute').checked) url += '&mute=1';
    location.href = url;
  });

  if (prefillCode) {
    $('join-code').value = prefillCode;
    $('stage-code').value = prefillCode;
    joinForm.hidden = false;
    $('join-name').focus();
  }
}

function showFatal(msg) {
  const el = $('fatal');
  el.textContent = msg;
  el.hidden = false;
}

// ---- ルーティング ----
function route() {
  const room = normalizeCode(params.get('room'));
  if (!peerAvailable()) {
    goTop(room.length === 4 ? room : '');
    showFatal('通信ライブラリ（PeerJS）を読み込めませんでした。インターネット接続を確認して再読み込みしてください。');
    return;
  }
  if (params.get('host') === '1' && sessionStorage.getItem(SS_HOST)) {
    goHost();
    return;
  }
  if (room.length === 4 && params.get('stage') === '1') {
    goStage(room);
    return;
  }
  if (room.length === 4) {
    const savedName = lsGet(LS_NAME);
    // 同じタブでリロードしたときは自動で再入室
    if (sessionStorage.getItem(SS_PLAYER) === room && savedName) {
      goPlayer(room, savedName);
      return;
    }
    goTop(room);
    return;
  }
  goTop('');
}

route();
