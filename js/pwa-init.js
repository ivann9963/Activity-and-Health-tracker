// === PWA REGISTRATION ===
// Registers the service worker and, when a new version is waiting, offers to switch
// to it rather than silently swapping the app out from under a running import.

// Compare the page in front of the user against what is actually deployed.
//
// A service worker serves the previous version until the new one takes over, so
// "I deployed but I don't see my changes" is a normal state rather than a fault —
// and completely invisible from inside the page. The API endpoint is never cached,
// so it can be trusted to answer for the deployment while the page answers for
// itself.
function checkForStaleCopy() {
  if (APP.build === '__BUILD' + '_ID__') return; // a dev copy has nothing to compare
  fetch('/api/oauth/status', { credentials: 'same-origin', cache: 'no-store' })
    .then(res => (res.ok ? res.json() : null))
    .then(status => {
      if (!status || !status.build || status.build === 'unknown') return;
      if (status.build === APP.build) return;

      // A stale copy is not something to offer a choice about: the person is looking
      // at an app that no longer exists, and every question they ask of it has a
      // wrong answer. So fetch the new worker and swap to it.
      //
      // Once per session, guarded — if the new version somehow still reports as old,
      // an unguarded reload is an infinite loop.
      const key = 'ledger-refreshed-for-' + status.build;
      let alreadyTried = false;
      try { alreadyTried = sessionStorage.getItem(key) === '1'; } catch (err) {}

      if (!alreadyTried) {
        try { sessionStorage.setItem(key, '1'); } catch (err) {}
        showToast(`Updating to ${status.build}…`, 'info');
        return refreshToLatest();
      }

      // The automatic attempt did not take. Say so rather than silently looping, and
      // leave a manual way out.
      const host = el('toast-host');
      if (!host) return;
      const node = document.createElement('div');
      node.className = 'toast toast-update';
      node.innerHTML = `<span>Version ${escHtml(status.build)} is deployed — you are
        still seeing ${escHtml(APP.build)}</span>
        <button class="btn btn-primary btn-small" type="button">Force reload</button>`;
      node.querySelector('button').onclick = () => refreshToLatest();
      host.appendChild(node);
    })
    .catch(() => {}); // offline, or no Worker — neither is worth reporting
}

function initPWA() {
  if (!('serviceWorker' in navigator)) return;
  // A service worker cannot be registered from file://, and trying throws a confusing
  // security error, so skip it outright.
  if (location.protocol === 'file:') return;

  checkForStaleCopy();

  navigator.serviceWorker.register('sw.js').then(reg => {
    // Already waiting when the page loaded — the user updated in another tab.
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);

    reg.addEventListener('updatefound', () => {
      const incoming = reg.installing;
      if (!incoming) return;
      incoming.addEventListener('statechange', () => {
        // controller being present is what distinguishes "an update is ready" from
        // "this is the very first install", which needs no announcement.
        if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
          offerUpdate(incoming);
        }
      });
    });
  }).catch(err => console.warn('[pwa] service worker registration failed', err));

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

// Drop every cache this app owns and reload. The service worker serves assets from
// cache first, so an ordinary reload — even a hard one — can still hand back the old
// files; only clearing the caches is certain.
function refreshToLatest() {
  const clearCaches = ('caches' in self)
    ? caches.keys().then(keys => Promise.all(
        keys.filter(k => k.startsWith('activity-ledger-')).map(k => caches.delete(k))))
    : Promise.resolve();

  return clearCaches
    .then(() => (navigator.serviceWorker
      ? navigator.serviceWorker.getRegistration().then(reg => reg && reg.update())
      : null))
    .catch(() => {})
    .then(() => { location.reload(); });
}

function offerUpdate(worker) {
  const host = el('toast-host');
  if (!host) return;
  const node = document.createElement('div');
  node.className = 'toast toast-update';
  node.innerHTML = `<span>A new version is ready</span>
    <button class="btn btn-primary btn-small" type="button">Reload</button>`;
  node.querySelector('button').onclick = () => {
    node.remove();
    worker.postMessage('skip-waiting');
  };
  host.appendChild(node);
}
