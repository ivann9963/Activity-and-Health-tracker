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

function showToast(msg, kind) {
  const host = el('toast-host');
  if (!host) return;
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
  const close = () => { host.innerHTML = ''; };
  host.querySelector('[data-act="cancel"]').onclick = close;
  host.querySelector('[data-act="ok"]').onclick = () => { close(); onConfirm(); };
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
