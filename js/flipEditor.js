// フリップ編集（手書き・文字）。参加者画面とMC画面の「自分の回答」で共通利用
// ツールバーは index.html の <template id="tpl-flip-tools"> から tools 要素の中に作る
//
//   const ed = createFlipEditor({ canvas, tools, onChange(flip) { ... } });
//   ed.setFlip(flip)   外から内容を差し替える（描きかけの線・文字の送信待ちは捨てる）
//   ed.clear()         今のモードのまま白紙にする
//   ed.setLocked(bool) 編集ロック（提出済み・発表中）
//   ed.setMode(mode)   'draw' | 'text'
//   ed.flush()         文字の送信待ち（300ms）があれば今すぐ onChange
//   ed.getFlip()       今の内容
//
// onChange は 手書き：1ストロークごと（pointerup）／戻す／全消し／モード切替 で即時、
// 文字：入力から300msデバウンスで呼ぶ
import { drawFlip, FLIP_W, FLIP_H, INK } from './flip.js';

const TEXT_DEBOUNCE = 300;

export function createFlipEditor({ canvas, tools, onChange }) {
  const tpl = document.getElementById('tpl-flip-tools');
  tools.appendChild(tpl.content.cloneNode(true));
  const q = (sel) => tools.querySelector(sel);
  const modeSeg = q('.fe-mode');
  const drawTools = q('.fe-draw-tools');
  const textTools = q('.fe-text-tools');
  const textArea = q('.fe-text');
  const eraserBtn = q('.fe-eraser');

  const local = { mode: 'draw', strokes: [], text: '' }; // 編集中のフリップ（ローカルが即時反映）
  const tool = { color: INK.black, width: 8, erase: false };
  let cur = null;          // 描いている途中の線
  let curPointer = null;
  let locked = false;
  let textTimer = null;
  let drawQueued = false;

  function getFlip() {
    return { mode: local.mode, strokes: local.strokes, text: local.text };
  }

  function emit() {
    clearTimeout(textTimer);
    textTimer = null;
    onChange(getFlip());
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
  // 表示サイズが変わったら描き直す
  new ResizeObserver(requestDraw).observe(canvas);

  function toLogical(e) {
    const r = canvas.getBoundingClientRect();
    return [
      Math.round(((e.clientX - r.left) / r.width) * FLIP_W),
      Math.round(((e.clientY - r.top) / r.height) * FLIP_H),
    ];
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (local.mode !== 'draw' || locked) return;
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
    emit();
  }
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---- ツール ----
  function updateModeUI() {
    for (const b of modeSeg.querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === local.mode);
    drawTools.hidden = local.mode !== 'draw';
    textTools.hidden = local.mode !== 'text';
    canvas.classList.toggle('text-mode', local.mode === 'text');
  }

  function updateToolUI() {
    for (const b of drawTools.querySelectorAll('[data-color]')) {
      b.classList.toggle('on', !tool.erase && INK[b.dataset.color] === tool.color);
    }
    for (const b of drawTools.querySelectorAll('[data-width]')) {
      b.classList.toggle('on', Number(b.dataset.width) === tool.width);
    }
    eraserBtn.classList.toggle('on', tool.erase);
  }

  function setMode(mode) {
    const m = mode === 'text' ? 'text' : 'draw';
    if (m === local.mode) return;
    local.mode = m;
    cur = null;
    curPointer = null;
    updateModeUI();
    requestDraw();
    emit();
  }

  modeSeg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b || locked) return;
    setMode(b.dataset.mode);
  });

  for (const b of drawTools.querySelectorAll('[data-color]')) {
    b.addEventListener('click', () => {
      tool.color = INK[b.dataset.color];
      tool.erase = false;
      updateToolUI();
    });
  }
  for (const b of drawTools.querySelectorAll('[data-width]')) {
    b.addEventListener('click', () => {
      tool.width = Number(b.dataset.width);
      updateToolUI();
    });
  }
  eraserBtn.addEventListener('click', () => {
    tool.erase = !tool.erase;
    updateToolUI();
  });
  q('.fe-undo').addEventListener('click', () => {
    if (locked || !local.strokes.length) return;
    local.strokes.pop();
    requestDraw();
    emit();
  });
  q('.fe-clear').addEventListener('click', () => {
    if (locked || !local.strokes.length) return;
    if (!window.confirm('手書きを全部消しますか？')) return;
    local.strokes = [];
    requestDraw();
    emit();
  });

  textArea.addEventListener('input', () => {
    local.text = textArea.value;
    requestDraw();
    clearTimeout(textTimer);
    textTimer = setTimeout(emit, TEXT_DEBOUNCE);
  });

  // ---- 外からの操作 ----
  function setFlip(flip) {
    cur = null;
    curPointer = null;
    clearTimeout(textTimer);
    textTimer = null;
    const f = flip || {};
    local.mode = f.mode === 'text' ? 'text' : 'draw';
    local.strokes = Array.isArray(f.strokes) ? f.strokes.slice() : [];
    local.text = typeof f.text === 'string' ? f.text : '';
    if (textArea.value !== local.text) textArea.value = local.text;
    updateModeUI();
    requestDraw();
  }

  function clear() {
    setFlip({ mode: local.mode, strokes: [], text: '' });
  }

  function setLocked(on) {
    locked = !!on;
    textArea.disabled = locked;
    for (const b of tools.querySelectorAll('.fe-draw-tools button, .fe-mode button')) b.disabled = locked;
  }

  function flush() {
    emit();
  }

  updateModeUI();
  updateToolUI();
  requestDraw();

  return { getFlip, setFlip, clear, setLocked, setMode, flush, redraw: requestDraw };
}
