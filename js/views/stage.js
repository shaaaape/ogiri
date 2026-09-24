// ステージ画面（OBS取り込み用）
// 中央：MCが呼んだ1人のフリップだけを大きく表示。下部：回答者のステータス一列
import { Client } from '../net.js';
import { drawFlip } from '../flip.js';
import { playerStatus, STATUS_LABEL } from '../state.js';
import * as se from '../se.js';

const $ = (id) => document.getElementById(id);

function toArrayBuffer(d) {
  if (d instanceof ArrayBuffer) return d;
  if (d && d.buffer instanceof ArrayBuffer) return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
  return null;
}

export function startStageView({ code, chroma, mute }) {
  document.body.classList.add('mode-stage');
  if (chroma) document.body.classList.add('chroma');
  se.setMuted(!!mute);

  const stageId = 'stage-' + Math.random().toString(36).slice(2, 10);
  const main = $('s-main');
  const strip = $('s-strip');
  const items = new Map(); // playerId -> ステータス行の要素
  let snap = null;
  let offset = 0;
  let lastTopic = null;
  let current = null;      // { key, playerId, el, canvas, name, rev }

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

  // ---- 中央のフリップ ----
  function makeCard(p, opened) {
    const el = document.createElement('div');
    el.className = 's-card entering' + (opened ? ' opened' : '');
    el.innerHTML = `
      <div class="s-flip">
        <div class="flipper">
          <div class="face cover"><div class="cover-text"><b class="cover-name"></b><span>さんの回答</span></div></div>
          <div class="face content"><canvas class="flip-canvas"></canvas></div>
        </div>
      </div>
      <div class="s-name"><span class="nm"></span></div>`;
    el.querySelector('.cover-name').textContent = p.name;
    el.querySelector('.nm').textContent = p.name;
    el.addEventListener('animationend', (e) => {
      if (e.animationName === 's-enter') el.classList.remove('entering');
    });
    return {
      el,
      canvas: el.querySelector('canvas'),
      coverName: el.querySelector('.cover-name'),
      name: el.querySelector('.nm'),
      rev: -1,
    };
  }

  // 下げられたとき：フェードアウトして消す
  function leave(c, animate) {
    if (!animate) {
      c.el.remove();
      return;
    }
    c.el.classList.remove('entering');
    c.el.classList.add('leaving');
    const done = () => c.el.remove();
    c.el.addEventListener('animationend', done, { once: true });
    setTimeout(done, 450); // animationend が来ない場合の保険
  }

  function renderStage(s, force) {
    const st = s.stage;
    const p = st ? (s.players || []).find((x) => x.id === st.playerId) : null;
    const key = p ? st.playerId + ':' + st.since : null;

    if (current && current.key !== key) {
      // 入れ替え（別の人が呼ばれた）は即消し、下げられたときはアニメで消す
      // 残っている退場アニメ中の要素も即消す
      for (const old of main.querySelectorAll('.s-card.leaving')) old.remove();
      leave(current, !key);
      current = null;
    }
    if (!p) return;
    if (!current) {
      for (const old of main.querySelectorAll('.s-card')) old.remove();
      const c = makeCard(p, st.opened);
      c.key = key;
      c.playerId = p.id;
      main.appendChild(c.el);
      current = c;
      force = true;
    }
    current.el.classList.toggle('opened', !!st.opened);
    current.coverName.textContent = p.name;
    current.name.textContent = p.name;
    if (force || current.rev !== p.rev) {
      current.rev = p.rev;
      drawFlip(current.canvas, p.flip);
    }
  }

  // 中央カードの大きさ（4:3、名前の分を引いて収まる最大。高さは約58vhが目安）
  function layout() {
    const vw = window.innerWidth / 100;
    const W = main.clientWidth;
    const H = main.clientHeight;
    const nameH = 5 * vw;
    let cw = Math.min(W * 0.9, (H - nameH) * 4 / 3, window.innerHeight * 0.62 * 4 / 3);
    cw = Math.max(120, Math.floor(cw));
    const changed = main.style.getPropertyValue('--cw') !== cw + 'px';
    main.style.setProperty('--cw', cw + 'px');
    return changed;
  }

  // ---- 下部のステータス一列 ----
  function makeItem() {
    const el = document.createElement('div');
    el.className = 's-pl';
    el.innerHTML = `
      <span class="s-pl-name"></span>
      <span class="s-pl-st"></span>
      <span class="s-hand">✋<b></b></span>`;
    return {
      el,
      name: el.querySelector('.s-pl-name'),
      st: el.querySelector('.s-pl-st'),
      handNum: el.querySelector('.s-hand b'),
    };
  }

  function renderStrip(s) {
    const players = s.players || [];
    const ids = new Set(players.map((p) => p.id));
    for (const [id, it] of items) {
      if (!ids.has(id)) {
        it.el.remove();
        items.delete(id);
      }
    }
    players.forEach((p, i) => {
      let it = items.get(p.id);
      if (!it) {
        it = makeItem();
        items.set(p.id, it);
      }
      if (strip.children[i] !== it.el) strip.insertBefore(it.el, strip.children[i] || null);
      const st = playerStatus(p, s.stage);
      it.el.className = 's-pl st-' + st + (p.hand.raised ? ' raised' : '');
      it.name.textContent = p.name;
      it.st.textContent = STATUS_LABEL[st];
      it.handNum.textContent = p.hand.raised ? String(p.hand.order) : '';
    });
    strip.style.setProperty('--n', Math.max(1, players.length));
  }

  // ---- 状態の反映 ----
  function apply(s) {
    snap = s;
    if (typeof s.now === 'number') offset = s.now - Date.now();
    if (s.topic !== lastTopic) {
      lastTopic = s.topic;
      fitTopic();
    }
    renderStrip(s);
    const resized = layout();
    renderStage(s, resized);
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
    layout();
    if (snap) renderStage(snap, true);
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
  layout();
}
