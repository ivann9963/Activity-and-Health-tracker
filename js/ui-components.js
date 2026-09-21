// === SHARED UI PRIMITIVES ===
// Toast, confirm dialog, progress bar and the escaping helpers every view needs.
// Deliberately tiny: there is no framework here, and the rest of the app renders by
// building HTML strings, so escaping has to be easy enough that nobody skips it.

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function el(id) { return document.getElementById(id); }

// At most this many on screen at once. Several actions in quick succession — two
// imports and a saved goal — otherwise stack into a wall that covers the content the
// toasts are reporting on.
const MAX_TOASTS = 2;

function showToast(msg, kind) {
  const host = el('toast-host');
  if (!host) return;
  while (host.children.length >= MAX_TOASTS) host.firstElementChild.remove();
  const node = document.createElement('div');
  node.className = 'toast toast-' + (kind || 'info');
  node.textContent = msg;
  host.appendChild(node);
  // Fade then remove, so a burst of toasts does not pile up forever.
  setTimeout(() => node.classList.add('leaving'), 3200);
  setTimeout(() => node.remove(), 3600);
}

function confirmDialog(opts, onConfirm) {
  const host = el('dialog-host');
  if (!host) return;
  host.innerHTML = `
    <div class="dialog-backdrop">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
        <h3 id="dlg-title">${escHtml(opts.title || 'Are you sure?')}</h3>
        <p>${escHtml(opts.message || '')}</p>
        <div class="dialog-actions">
          <button class="btn btn-ghost" data-act="cancel">${escHtml(opts.cancelLabel || 'Cancel')}</button>
          <button class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">
            ${escHtml(opts.confirmLabel || 'Confirm')}</button>
        </div>
      </div>
    </div>`;
  // Focus has to move into the dialog, or a keyboard user is left tabbing through the
  // page behind it with no idea a question is being asked. It returns to wherever it
  // came from on close.
  const returnFocus = document.activeElement;
  const close = () => {
    host.innerHTML = '';
    document.removeEventListener('keydown', onKey, true);
    if (returnFocus && returnFocus.focus) returnFocus.focus();
  };

  const confirmBtn = host.querySelector('[data-act="ok"]');
  const cancelBtn = host.querySelector('[data-act="cancel"]');
  // The cancel button takes focus rather than the confirm one: these dialogs guard
  // destructive actions, and a stray Enter should not be the thing that deletes
  // everything.
  cancelBtn.focus();

  function onKey(ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
    if (ev.key !== 'Tab') return;
    // Keep Tab inside the dialog; two buttons make the trap trivial.
    const focusable = [cancelBtn, confirmBtn];
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  }
  document.addEventListener('keydown', onKey, true);

  cancelBtn.onclick = close;
  confirmBtn.onclick = () => { close(); onConfirm(); };
  host.querySelector('.dialog-backdrop').onclick = ev => { if (ev.target === ev.currentTarget) close(); };
}

// A progress bar that can report either a percentage or an indeterminate byte count.
// Imports of a multi-hundred-megabyte file take a while, and a frozen screen with no
// feedback reads as a crash.
function progressBar(pct, label) {
  const known = pct != null && isFinite(pct);
  return `<div class="progress ${known ? '' : 'indeterminate'}">
            <div class="progress-fill" style="width:${known ? Math.min(100, pct) : 100}%"></div>
          </div>
          <div class="progress-label">${escHtml(label || '')}</div>`;
}

function humanCount(n) { return Number(n || 0).toLocaleString(); }

// "1 workouts" reads as a bug even when the number is right.
function plural(n, word, pluralForm) {
  return `${humanCount(n)} ${n === 1 ? word : (pluralForm || word + 's')}`;
}
