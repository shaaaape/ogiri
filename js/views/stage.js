// ステージ画面（OBS取り込み用）。見た目は「寄席」の舞台
// 中央（高座）：MCが呼んだ1人のフリップだけを大きく表示し、右脇の「めくり」に名前
// 上部：回答者のステータスを幕の下に並ぶ提灯で表示
import { Client } from '../net.js';
import { drawFlip } from '../flip.js';
import { playerStatus, STATUS_LABEL } from '../state.js';
import * as se from '../se.js';

const $ = (id) => document.getElementById(id);

// 名前の文字数（サロゲートペアも1文字）
const nameLen = (s) => [...String(s || '')].length;

// 提灯に書く名前（最大6文字、超えたら5文字＋…）
function lanternName(s) {
  const chars = [...String(s || '')];
  return chars.length > 6 ? chars.slice(0, 5).join('') + '…' : chars.join('');
}

// 挙手の順番を丸数字に（①〜⑳、それ以上はそのまま）
function circled(n) {
  return n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : String(n);
}

// 提灯の SVG（グラデーションの id は提灯ごとに別にする。色は CSS 変数 --lt-* で切り替え）
let lanternSeq = 0;
function lanternSvg() {
  const id = 'lt' + (++lanternSeq);
  // 骨（横方向の細い線）。胴は楕円 cx=30 cy=50 rx=26 ry=38
  let ribs = '';
  for (let y = 21; y <= 79; y += 5.8) {
    const w = 26 * Math.sqrt(Math.max(0, 1 - ((y - 50) / 38) ** 2));
    const bow = 1.6 + (y - 50) / 38; // 上は上向き、下は下向きに少し反らせて丸みを出す
    ribs += `<path d="M${(30 - w).toFixed(1)} ${y.toFixed(1)} Q30 ${(y + bow * 1.6).toFixed(1)} ${(30 + w).toFixed(1)} ${y.toFixed(1)}"/>`;
  }
  return `
    <svg class="lt-svg" viewBox="0 0 60 104" aria-hidden="true">
      <defs>
        <radialGradient id="${id}b" cx="50%" cy="50%" r="55%">
          <stop offset="0" class="lt-s-core"/>
          <stop offset=".6" class="lt-s-body"/>
          <stop offset="1" class="lt-s-edge"/>
        </radialGradient>
        <linearGradient id="${id}s" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stop-color="#000" stop-opacity=".45"/>
          <stop offset=".22" stop-color="#000" stop-opacity="0"/>
          <stop offset=".78" stop-color="#000" stop-opacity="0"/>
          <stop offset="1" stop-color="#000" stop-opacity=".45"/>
        </linearGradient>
      </defs>
      <line class="lt-cord" x1="30" y1="0" x2="30" y2="9"/>
      <ellipse class="lt-body" cx="30" cy="50" rx="26" ry="38" fill="url(#${id}b)"/>
      <ellipse cx="30" cy="50" rx="26" ry="38" fill="url(#${id}s)"/>
      <g class="lt-ribs">${ribs}</g>
      <rect class="lt-cap" x="16" y="8" width="28" height="8" rx="1"/>
      <rect class="lt-cap-line" x="16" y="13.4" width="28" height="1"/>
      <rect class="lt-cap" x="16" y="84" width="28" height="8" rx="1"/>
      <rect class="lt-cap-line" x="16" y="86" width="28" height="1"/>
      <circle class="lt-knot" cx="30" cy="94" r="2"/>
      <path class="lt-fringe" d="M27 95 L33 95 L35 104 L25 104 Z"/>
      <path class="lt-fringe-line" d="M28 97 L27.2 103.6 M30 97 L30 103.8 M32 97 L32.8 103.6"/>
    </svg>`;
}

function toArrayBuffer(d) {
  if (d instanceof ArrayBuffer) return d;
  if (d && d.buffer instanceof ArrayBuffer) return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
  return null;
}

export function startStageView({ code, chroma, mute }) {
  se.loadBundled(); // 同梱SE（se/list.json）を読み込んでおく
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
  let changingTo = null;   // MC交代中なら新しいMCの名前（つながり直したら null）
  let lastStatus = 'connecting';

  const client = new Client(code, {
    onOpen() {
      client.send({ t: 'hello', role: 'stage', name: 'ステージ', clientId: stageId });
    },
    onData(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'state') apply(msg);
      else if (msg.t === 'hostChanging') {
        changingTo = String(msg.newHostName || '').slice(0, 16) || 'ななし';
        renderStatus();
      } else if (msg.t === 'se') {
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
      lastStatus = st;
      // 新しいMCにつながったら通常表示に戻す
      if (st === 'connected') changingTo = null;
      renderStatus();
    },
  });

  function renderStatus() {
    const el = $('s-status');
    const map = {
      connecting: '接続しています…（部屋 ' + code + '）',
      connected: '',
      retrying: '再接続中…',
      notfound: '部屋 ' + code + ' が見つかりません（再試行中…）',
    };
    let text = map[lastStatus] == null ? '' : map[lastStatus];
    if (changingTo != null) text = `MC交代中…（${changingTo}さんへ）`;
    el.textContent = text;
    el.hidden = !text;
  }

  // 音声が止められている（普通のブラウザで開いた）ときはクリックを促す
  function checkAudio() {
    if (se.audioState() === 'suspended') $('s-audio-hint').hidden = false;
  }
  document.addEventListener('pointerdown', () => {
    se.unlockAudio();
    $('s-audio-hint').hidden = true;
  });

  // ---- 中央のフリップ ----
  // 裏面は高座の座布団。側面（厚み）・四隅の房はインラインSVG
  const ZABUTON_SIDE = `<svg class="zb-side" viewBox="0 0 400 322" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="zb-side-g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3a1f55"/><stop offset=".9" stop-color="#2f1847"/><stop offset="1" stop-color="#1f0f31"/>
    </linearGradient></defs>
    <path fill="url(#zb-side-g)" d="M20 0H380Q400 0 400 20Q401.6 160 399 296Q398 313 378 315Q200 324 22 315Q2 313 1 296Q-1.6 160 0 20Q0 0 20 0Z"/>
  </svg>`;
  // 房の糸：結び目から短く束ねたあと、外へ扇状にほどける（角度・長さを少しずつ変える）
  const FUSA_THREADS = [[198, 19.5], [207, 21.5], [216, 20.5], [225, 22.5], [234, 20.5], [243, 21.5], [252, 19.5]].map(([deg, len], i) => {
    const r = (deg * Math.PI) / 180;
    const o = (i - 3) * 0.35; // 束ねた部分での糸の並び
    const sx = 24.5 + o, sy = 24.5 - o;
    const f = (n) => n.toFixed(1);
    const ex = 30 + Math.cos(r) * len, ey = 30 + Math.sin(r) * len;
    const cx = 30 + Math.cos(r) * len * 0.55 + 1.2, cy = 30 + Math.sin(r) * len * 0.55 + 1.2;
    return `<path d="M${f(29.5 + o * 0.4)} ${f(29.5 - o * 0.4)}L${f(sx)} ${f(sy)}Q${f(cx)} ${f(cy)} ${f(ex)} ${f(ey)}"/>`;
  }).join('');
  const FUSA_SVG = `<svg viewBox="0 0 40 40" aria-hidden="true">
    <g fill="none" stroke-linecap="round">
      <g stroke="#7d6a44" stroke-width="2.7">${FUSA_THREADS}</g>
      <g stroke="#efe6cf" stroke-width="1.75">${FUSA_THREADS}</g>
    </g>
    <path d="M23.4 27.8L27.8 23.4" stroke="#6b3c14" stroke-width="3" stroke-linecap="round"/><path d="M23.4 27.8L27.8 23.4" stroke="#b07a3a" stroke-width=".8" stroke-linecap="round"/>
    <circle cx="30" cy="30" r="3.4" fill="#5e3412"/><circle cx="29.2" cy="29.2" r="1.3" fill="#a8763a"/>
  </svg>`;
  const ZABUTON_FUSA = ['tl', 'tr', 'bl', 'br'].map((k) => `<i class="zb-fusa ${k}">${FUSA_SVG}</i>`).join('');

  function makeCard(p, opened) {
    const el = document.createElement('div');
    el.className = 's-card entering' + (opened ? ' opened' : '');
    el.innerHTML = `
      <div class="s-flip">
        <div class="flipper">
          <div class="face cover">${ZABUTON_SIDE}<div class="zb-top"></div>${ZABUTON_FUSA}<div class="cover-text"><b class="cover-name"></b><span class="cover-sub">さんの回答</span><small class="mc-tag" hidden>席亭</small></div></div>
          <div class="face content"><canvas class="flip-canvas"></canvas></div>
        </div>
      </div>
      <div class="s-name"><div class="mk-paper blank"></div><div class="mk-paper named"><span class="nm"></span><small class="mc-tag" hidden>席亭</small></div></div>`;
    el.querySelector('.cover-name').textContent = p.name;
    el.querySelector('.nm').textContent = p.name;
    el.style.setProperty('--nlen', Math.max(1, nameLen(p.name)));
    for (const t of el.querySelectorAll('.mc-tag')) t.hidden = !p.isHost;
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
    current.el.style.setProperty('--nlen', Math.max(1, nameLen(p.name)));
    if (force || current.rev !== p.rev) {
      current.rev = p.rev;
      drawFlip(current.canvas, p.flip);
    }
  }

  // 中央カードの大きさ（4:3、右脇のめくり札の分を左右に空けて収まる最大）
  function layout() {
    const vw = window.innerWidth / 100;
    const W = main.clientWidth;
    const H = main.clientHeight;
    const sideW = 9 * vw; // めくり札（約6vw）＋すき間
    let cw = Math.min(W - sideW * 2, H * 4 / 3, window.innerHeight * 0.62 * 4 / 3);
    cw = Math.max(120, Math.floor(cw));
    const changed = main.style.getPropertyValue('--cw') !== cw + 'px';
    main.style.setProperty('--cw', cw + 'px');
    return changed;
  }

  // ---- 上部の提灯の列（ステータス一列） ----
  // 要素の中身：提灯（SVG＋胴の名前）、左に「席亭」札、右に「挙手」札、下にステータスの木札
  function makeItem() {
    const el = document.createElement('div');
    el.className = 's-pl';
    el.innerHTML = `
      <div class="s-pl-lantern">
        ${lanternSvg()}
        <span class="s-pl-name"><span class="nm"></span></span>
        <small class="mc-tag" hidden>席亭</small>
        <span class="s-hand">挙手<b></b></span>
      </div>
      <span class="s-pl-st"></span>`;
    return {
      el,
      name: el.querySelector('.s-pl-name .nm'),
      mc: el.querySelector('.s-pl-lantern .mc-tag'),
      st: el.querySelector('.s-pl-st'),
      handNum: el.querySelector('.s-hand b'),
    };
  }

  function renderStrip(s) {
    const players = s.players || [];
    const ids = new Set(players.map((p) => p.id));
    // 並び順が変わったか（MCがドラッグで並び替えた）。変わったら移動をアニメーションする
    const prevOrder = [...strip.children].map((el) => el.dataset.id).filter((id) => ids.has(id));
    const nextOrder = players.map((p) => p.id).filter((id) => items.has(id));
    const reordered = prevOrder.join('\n') !== nextOrder.join('\n');
    const before = new Map();
    if (reordered) for (const [id, it] of items) before.set(id, it.el.getBoundingClientRect().left);
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
        it.el.dataset.id = p.id;
        items.set(p.id, it);
      }
      // 要素は作り直さずに移動する
      if (strip.children[i] !== it.el) strip.insertBefore(it.el, strip.children[i] || null);
      const st = playerStatus(p, s.stage);
      it.el.className = 's-pl st-' + st + (p.hand.raised ? ' raised' : '') + (p.isHost ? ' is-host' : '');
      const shown = lanternName(p.name);
      it.name.textContent = shown;
      // 4文字以上は2行に分けて書くので、1行あたりの文字数で大きさを決める
      const n = Math.max(1, nameLen(shown));
      it.name.style.setProperty('--nlen', n <= 3 ? n : Math.ceil(n / 2));
      it.mc.hidden = !p.isHost;
      it.st.textContent = STATUS_LABEL[st];
      it.handNum.textContent = p.hand.raised ? circled(p.hand.order) : '';
    });
    strip.style.setProperty('--n', Math.max(1, players.length));
    if (reordered) slideFrom(before);
  }

  // FLIP：前の位置からずらした状態で置き、transition で今の位置へ滑らせる
  function slideFrom(before) {
    const moved = [];
    for (const [id, it] of items) {
      if (!before.has(id)) continue;
      const dx = before.get(id) - it.el.getBoundingClientRect().left;
      if (Math.abs(dx) < 1) continue;
      it.el.style.transition = 'none';
      it.el.style.transform = `translateX(${dx}px)`;
      moved.push(it.el);
    }
    if (!moved.length) return;
    void strip.offsetWidth; // 位置を確定させてからアニメーション開始
    for (const el of moved) {
      el.style.transition = 'transform .4s cubic-bezier(.3, .7, .3, 1)';
      el.style.transform = '';
      clearTimeout(el._slideT);
      el._slideT = setTimeout(() => { el.style.transition = ''; }, 450);
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
