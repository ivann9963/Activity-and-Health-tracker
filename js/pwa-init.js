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
      const host = el('toast-host');
      if (!host) return;
      const node = document.createElement('div');
      node.className = 'toast toast-update';
      node.innerHTML = `<span>Version ${escHtml(status.build)} is deployed — you are
        seeing ${escHtml(APP.build)}</span>
        <button class="btn btn-primary btn-small" type="button">Reload</button>`;
      node.querySelector('button').onclick = () => location.reload(true);
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
