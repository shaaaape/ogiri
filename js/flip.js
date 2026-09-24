// フリップ描画（論理座標 800×600 を任意サイズの canvas に描く）
// 参加者の編集キャンバス・MCのプレビュー・ステージで共通利用

export const FLIP_W = 800;
export const FLIP_H = 600;
export const INK = { black: '#111111', red: '#e53935', blue: '#1e5bd8' };

const FONT = '"Hiragino Maru Gothic ProN", "Hiragino Sans", "BIZ UDPGothic", "Meiryo", "Yu Gothic", sans-serif';
const TEXT_PAD = 40;
const MAX_FONT = 96;
const MIN_FONT = 20;
const LINE_H = 1.25;

// canvas の実ピクセルを表示サイズ×devicePixelRatio に合わせ、論理座標で描ける ctx を返す
export function prepareCanvas(canvas) {
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (!cssW || !cssH) return null;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, w, h);
  ctx.setTransform(w / FLIP_W, 0, 0, h / FLIP_H, 0, 0);
  return ctx;
}

// フリップ全体を描く。extraStroke は描いている途中の線（参加者画面用）
export function drawFlip(canvas, flip, extraStroke = null) {
  const ctx = prepareCanvas(canvas);
  if (!ctx || !flip) return;
  if (flip.mode === 'text') {
    drawText(ctx, flip.text || '');
  } else {
    for (const s of flip.strokes || []) drawStroke(ctx, s);
    if (extraStroke) drawStroke(ctx, extraStroke);
  }
}

// 1ストローク（二次ベジェで中点補間）
export function drawStroke(ctx, s) {
  const pts = s && s.pts;
  if (!pts || !pts.length) return;
  ctx.save();
  ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
  const color = s.erase ? '#000' : (s.color || INK.black);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = s.width || 6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0][0], pts[0][1], ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    if (pts.length === 2) {
      ctx.lineTo(pts[1][0], pts[1][1]);
    } else {
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2;
        const my = (pts[i][1] + pts[i + 1][1]) / 2;
        ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(last[0], last[1]);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// 文字をフリップに収まるように自動縮小して中央に描く
export function drawText(ctx, text) {
  if (!text || !text.trim()) return;
  const maxW = FLIP_W - TEXT_PAD * 2;
  const maxH = FLIP_H - TEXT_PAD * 2;
  const { size, lines } = fitText(ctx, text, maxW, maxH);
  const lh = size * LINE_H;
  ctx.save();
  ctx.font = `bold ${size}px ${FONT}`;
  ctx.fillStyle = INK.black;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const top = (FLIP_H - lines.length * lh) / 2 + lh / 2;
  lines.forEach((line, i) => ctx.fillText(line, FLIP_W / 2, top + i * lh));
  ctx.restore();
}

// measureText でループして収まる最大サイズを探す（改行は反映、長い行は折り返し）
export function fitText(ctx, text, maxW, maxH) {
  const paras = String(text).replace(/\r/g, '').split('\n');
  for (let size = MAX_FONT; size >= MIN_FONT; size -= 2) {
    ctx.font = `bold ${size}px ${FONT}`;
    const lines = wrapLines(ctx, paras, maxW);
    if (lines.length * size * LINE_H <= maxH) return { size, lines };
  }
  // 最小サイズでも収まらない場合は入る行だけ
  ctx.font = `bold ${MIN_FONT}px ${FONT}`;
  const lines = wrapLines(ctx, paras, maxW);
  const maxLines = Math.max(1, Math.floor(maxH / (MIN_FONT * LINE_H)));
  return { size: MIN_FONT, lines: lines.slice(0, maxLines) };
}

function wrapLines(ctx, paras, maxW) {
  const out = [];
  for (const p of paras) {
    if (p === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const ch of Array.from(p)) {
      if (line && ctx.measureText(line + ch).width > maxW) {
        out.push(line);
        line = ch;
      } else {
        line += ch;
      }
    }
    out.push(line);
  }
  return out;
}
