// 提灯の SVG（ステージの提灯の列・MC画面の参加者カードで共用）
// 色は CSS 変数 --lt-core / --lt-body / --lt-edge / --lt-rib で切り替える

// 提灯の SVG（グラデーションの id は提灯ごとに別にする。色は CSS 変数 --lt-* で切り替え）
let lanternSeq = 0;
export function lanternSvg() {
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
