// ステージ画面（OBS取り込み用）
import { Client } from '../net.js';
import { drawFlip } from '../flip.js';
import * as se from '../se.js';

const $ = (id) => document.getElementById(id);

function toArrayBuffer(d) {
  if (d instanceof ArrayBuffer) return d;
  if (d && d.buffer instanceof ArrayBuffer) return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
  return null;
}

// 人数に応じた列数
function colsFor(n) {
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}

export function startStageView({ code, chroma, mute }) {
  document.body.classList.add('mode-stage');
  if (chroma) document.body.classList.add('chroma');
  se.setMuted(!!mute);

  const stageId = 'stage-' + Math.random().toString(36).slice(2, 10);
  const inner = $('s-grid-inner');
  const cards = new Map(); // id -> カード
  let snap = null;
  let offset = 0;
  let spot = null;         // { id, card }
  let lastTopic = null;
  let lastCw = 0;

  const client = new Client(code, {
    onOpen() {
      client.send({ t: 'hello', role: 'stage', name: 'ステージ', clientId: stageId });
    },
    onData(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'state') apply(msg);
      else if (msg.t === 'se') {
        if (!mute) {
          se.playSE(msg.id);
          checkAudio();
        }
      } else if (msg.t === 'seCustom') {
        const buf = toArrayBuffer(msg.data);
        if (buf) se.addCustomData(msg.id, buf);
      }
    },
    onStatus(st) {
      const el = $('s-status');
      const map = {
        connecting: '接続しています…（部屋 ' + code + '）',
        connected: '',
        retrying: '再接続中…',
        notfound: '部屋 ' + code + ' が見つかりません（再試行中…）',
      };
      const text = map[st] == null ? '' : map[st];
      el.textContent = text;
      el.hidden = !text;
    },
  });

  // 音声が止められている（普通のブラウザで開いた）ときはクリックを促す
  function checkAudio() {
    if (se.audioState() === 'suspended') $('s-audio-hint').hidden = false;
  }
  document.addEventListener('pointerdown', () => {
    se.unlockAudio();
    $('s-audio-hint').hidden = true;
  });

  // ---- カード ----
  function makeCard(big = false) {
    const el = document.createElement('div');
    el.className = 's-card' + (big ? ' big' : '');
    el.innerHTML = `
      <div class="s-flip">
        <div class="flipper">
          <div class="face cover"><span class="stamp">提出済</span></div>
          <div class="face content"><canvas class="flip-canvas"></canvas></div>
        </div>
      </div>
      <div class="s-name"><span class="nm"></span><span class="s-hand">✋<b></b></span></div>`;
    return {
      el,
      canvas: el.querySelector('canvas'),
      name: el.querySelector('.nm'),
      handNum: el.querySelector('.s-hand b'),
      rev: -1,
    };
  }

  function updateCard(c, p, force) {
    c.el.classList.toggle('submitted', !!p.submitted);
    c.el.classList.toggle('revealed', !!p.revealed);
    c.el.classList.toggle('off', !p.connected);
    c.el.classList.toggle('raised', !!p.hand.raised);
    c.name.textContent = p.name;
    c.handNum.textContent = p.hand.raised ? String(p.hand.order) : '';
    if (force || c.rev !== p.rev) {
      c.rev = p.rev;
      drawFlip(c.canvas, p.flip);
    }
  }

  // ---- 状態の反映 ----
  function apply(s) {
    snap = s;
    if (typeof s.now === 'number') offset = s.now - Date.now();
    if (s.topic !== lastTopic) {
      lastTopic = s.topic;
      fitTopic();
    }

    const players = s.players || [];
    const ids = new Set(players.map((p) => p.id));
    for (const [id, c] of cards) {
      if (!ids.has(id)) {
        c.el.remove();
        cards.delete(id);
      }
    }
    players.forEach((p, i) => {
      let c = cards.get(p.id);
      if (!c) {
        c = makeCard();
        cards.set(p.id, c);
      }
      if (inner.children[i] !== c.el) inner.insertBefore(c.el, inner.children[i] || null);
    });
    $('s-waiting').hidden = players.length > 0;

    const resized = layout();
    players.forEach((p) => updateCard(cards.get(p.id), p, resized));

    // スポットライト
    const target = s.spotlightId ? players.find((p) => p.id === s.spotlightId) : null;
    const box = $('s-spot');
    if (target) {
      let fresh = false;
      if (!spot || spot.id !== target.id) {
        box.innerHTML = '';
        spot = { id: target.id, card: makeCard(true) };
        box.appendChild(spot.card.el);
        fresh = true;
      }
      box.hidden = false;
      $('s-root').classList.add('spot-on');
      updateCard(spot.card, target, fresh);
    } else {
      spot = null;
      box.innerHTML = '';
      box.hidden = true;
      $('s-root').classList.remove('spot-on');
    }
  }

  // グリッドの大きさ計算。カード幅が変わったら true
  function layout() {
    const n = snap ? (snap.players || []).length : 0;
    if (!n) return false;
    const cols = colsFor(n);
    const rows = Math.ceil(n / cols);
    const grid = $('s-grid');
    const W = grid.clientWidth;
    const H = grid.clientHeight;
    const vw = window.innerWidth / 100;
    const gx = 2 * vw;
    const gy = 1.2 * vw;
    const nameH = 3.6 * vw;
    let cw = Math.min((W - gx * (cols - 1)) / cols, ((H - gy * (rows - 1)) / rows - nameH) * 4 / 3);
    cw = Math.max(80, Math.floor(cw));
    inner.style.setProperty('--cw', cw + 'px');
    inner.style.setProperty('--gx', gx + 'px');
    inner.style.setProperty('--gy', gy + 'px');
    inner.style.width = Math.ceil(cw * cols + gx * (cols - 1) + 1) + 'px';
    const changed = cw !== lastCw;
    lastCw = cw;
    return changed;
  }

  // お題を枠に収まるよう縮小
  function fitTopic() {
    const box = $('s-topic');
    const span = box.querySelector('span');
    span.textContent = lastTopic || 'お題を待っています…';
    box.classList.toggle('waiting', !lastTopic);
    let size = window.innerWidth * 0.029;
    const min = window.innerWidth * 0.012;
    box.style.fontSize = size + 'px';
    while (span.offsetHeight > box.clientHeight + 1 && size > min) {
      size -= 2;
      box.style.fontSize = size + 'px';
    }
  }

  window.addEventListener('resize', () => {
    fitTopic();
    if (!snap) return;
    layout();
    for (const p of snap.players || []) {
      const c = cards.get(p.id);
      if (c) updateCard(c, p, true);
    }
    if (spot) {
      const p = (snap.players || []).find((x) => x.id === spot.id);
      if (p) updateCard(spot.card, p, true);
    }
  });

  // ---- タイマー ----
  setInterval(() => {
    const el = $('s-timer');
    const t = snap && snap.timer;
    if (!t || !t.endsAt) {
      el.hidden = true;
      return;
    }
    const left = Math.max(0, Math.ceil((t.endsAt - (Date.now() + offset)) / 1000));
    el.hidden = false;
    el.textContent = String(left);
    el.classList.toggle('danger', left <= 10);
  }, 200);

  fitTopic();
}
