// 画面で使う小さな線画アイコン（墨色の線。色は currentColor）と丸数字
// 絵文字は使わない（端末ごとに見た目が変わり、寄席の雰囲気にも合わないため）

const SPEAKER_BODY = '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/>';

// スピーカー（音あり）
export const ICON_SPEAKER = `<svg class="ico" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SPEAKER_BODY}<path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>`;

// スピーカー（ミュート中）
export const ICON_MUTED = `<svg class="ico" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SPEAKER_BODY}<path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/></svg>`;

// 並び替えのつまみ（縦3本線）
export const ICON_GRIP = '<svg class="ico" viewBox="0 0 12 20" width="12" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2.5 3v14M6 3v14M9.5 3v14"/></svg>';

// 挙手の順番を丸数字に（①〜⑳、それ以上はそのまま）
export function circled(n) {
  n = Number(n);
  return n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : String(n || '…');
}
