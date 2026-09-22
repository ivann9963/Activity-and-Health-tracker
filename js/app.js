// === BOOT ===
// Loaded last, after every view has registered itself. Opens the database, applies
// the saved theme, then hands over to the router.

function boot() {
  // The wordmark's glyph, from the same set as everything else.
  const mark = el('app-mark');
  if (mark) mark.innerHTML = icon('running', 20);

  openDB()
    .then(loadSettings)
    .then(settings => {
      document.documentElement.dataset.theme = settings.theme || 'dark';
      renderCurrentView();
      initPWA();
    })
    .catch(err => {
      console.error(err);
      // A failed IndexedDB open is almost always private browsing or a blocked
      // origin, which is worth saying plainly rather than showing a blank page.
      el('view-host').innerHTML = `<div class="card error">
        <h2>Storage is unavailable</h2>
        <p>This app keeps your data in the browser's own database, and it could not be
           opened. That usually means private browsing mode, or site data being blocked
           for this page.</p>
        <pre>${escHtml(err && err.message || String(err))}</pre></div>`;
    });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
