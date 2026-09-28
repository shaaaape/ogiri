// ページ内ダイアログ（window.confirm / window.alert / window.prompt の置き換え）
// デスクトップアプリ内蔵ブラウザやアプリ内ブラウザ（LINE/Discordなど）では
// window.confirm / window.alert / window.prompt が使えず、常に false・null（何もしない）扱いになることがあるため、
// <dialog> 要素で同じことをする。<dialog>.showModal が無い古いブラウザ向けには
// window.confirm / window.alert / window.prompt にフォールバックする。
//
//   if (!(await confirmDialog('本当に消しますか？'))) return;
//   await alertDialog('保存できませんでした。');
//   const name = await promptDialog('名前を入力', { defaultValue: myName });

let dialogEl = null;

function ensureDialog() {
  if (dialogEl) return dialogEl;
  const dlg = document.createElement('dialog');
  dlg.id = 'app-dialog';
  dlg.className = 'app-dialog';
  dlg.innerHTML = `
    <div class="app-dialog-msg"></div>
    <div class="app-dialog-btns">
      <button type="button" class="btn app-dialog-cancel"></button>
      <button type="button" class="btn primary app-dialog-ok"></button>
    </div>`;
  document.body.appendChild(dlg);
  dialogEl = dlg;
  return dlg;
}

// 改行（\n）を <br> として表示する
function setMessage(el, message) {
  el.textContent = '';
  const lines = String(message == null ? '' : message).split('\n');
  lines.forEach((line, i) => {
    if (i > 0) el.appendChild(document.createElement('br'));
    el.appendChild(document.createTextNode(line));
  });
}

function supportsDialog() {
  const d = document.createElement('dialog');
  return typeof d.showModal === 'function';
}

// バックドロップ（ダイアログの外側）クリックか判定
function isBackdropClick(dlg, e) {
  const r = dlg.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
}

function openDialog(message, { okText, cancelText, danger, showCancel }) {
  return new Promise((resolve) => {
    const dlg = ensureDialog();
    const msgEl = dlg.querySelector('.app-dialog-msg');
    const okBtn = dlg.querySelector('.app-dialog-ok');
    const cancelBtn = dlg.querySelector('.app-dialog-cancel');
    setMessage(msgEl, message);
    okBtn.textContent = okText;
    cancelBtn.textContent = cancelText;
    cancelBtn.hidden = !showCancel;
    okBtn.classList.toggle('danger', !!danger);
    okBtn.classList.toggle('primary', !danger);

    let done = false;
    function finish(result) {
      if (done) return;
      done = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onCancelEvent);
      dlg.removeEventListener('click', onBackdrop);
      resolve(result);
      if (dlg.open) dlg.close();
    }
    function onOk() { finish(true); }
    function onCancel() { finish(false); }
    function onCancelEvent(e) { e.preventDefault(); finish(false); } // Escapeキー
    function onBackdrop(e) { if (isBackdropClick(dlg, e)) finish(false); }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onCancelEvent);
    dlg.addEventListener('click', onBackdrop);

    dlg.showModal();
    okBtn.focus();
  });
}

export function confirmDialog(message, { okText = 'OK', cancelText = 'キャンセル', danger = false } = {}) {
  if (!supportsDialog()) return Promise.resolve(window.confirm(message));
  return openDialog(message, { okText, cancelText, danger, showCancel: true });
}

export function alertDialog(message, { okText = 'OK' } = {}) {
  if (!supportsDialog()) {
    window.alert(message);
    return Promise.resolve();
  }
  return openDialog(message, { okText, cancelText: '', danger: false, showCancel: false }).then(() => {});
}

let promptDialogEl = null;

function ensurePromptDialog() {
  if (promptDialogEl) return promptDialogEl;
  const dlg = document.createElement('dialog');
  dlg.id = 'app-prompt-dialog';
  dlg.className = 'app-dialog';
  dlg.innerHTML = `
    <div class="app-dialog-msg"></div>
    <input type="text" class="app-dialog-input">
    <div class="app-dialog-btns">
      <button type="button" class="btn app-dialog-cancel"></button>
      <button type="button" class="btn primary app-dialog-ok"></button>
    </div>`;
  document.body.appendChild(dlg);
  promptDialogEl = dlg;
  return dlg;
}

export function promptDialog(message, { defaultValue = '', okText = 'OK', cancelText = 'キャンセル', placeholder = '', maxLength = 40 } = {}) {
  if (!supportsDialog()) return Promise.resolve(window.prompt(message, defaultValue));
  return new Promise((resolve) => {
    const dlg = ensurePromptDialog();
    const msgEl = dlg.querySelector('.app-dialog-msg');
    const inputEl = dlg.querySelector('.app-dialog-input');
    const okBtn = dlg.querySelector('.app-dialog-ok');
    const cancelBtn = dlg.querySelector('.app-dialog-cancel');
    setMessage(msgEl, message);
    inputEl.value = defaultValue == null ? '' : String(defaultValue);
    inputEl.placeholder = placeholder;
    if (maxLength) inputEl.maxLength = maxLength; else inputEl.removeAttribute('maxlength');
    okBtn.textContent = okText;
    cancelBtn.textContent = cancelText;

    let done = false;
    function finish(result) {
      if (done) return;
      done = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      inputEl.removeEventListener('keydown', onKeydown);
      dlg.removeEventListener('cancel', onCancelEvent);
      dlg.removeEventListener('click', onBackdrop);
      resolve(result);
      if (dlg.open) dlg.close();
    }
    function onOk() { finish(inputEl.value); }
    function onCancel() { finish(null); }
    function onCancelEvent(e) { e.preventDefault(); finish(null); } // Escapeキー
    function onBackdrop(e) { if (isBackdropClick(dlg, e)) finish(null); }
    function onKeydown(e) { if (e.key === 'Enter') { e.preventDefault(); finish(inputEl.value); } }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    inputEl.addEventListener('keydown', onKeydown);
    dlg.addEventListener('cancel', onCancelEvent);
    dlg.addEventListener('click', onBackdrop);

    dlg.showModal();
    inputEl.focus();
    inputEl.select();
  });
}
