// === ROUTING ===
// Hash-based, so the app works from a file:// URL and from GitHub Pages without any
// server rewrite rules. Views register themselves; the tab bar is generated from the
// registry, which means adding a screen is one registerView call and nothing else.

const VIEWS = [];
let _currentView = null;

function registerView(spec) {
  VIEWS.push(spec); // { id, label, icon, render(host), inNav }
}

// Segments after the view id: '#/metric/distance_run' -> routeParam(0) === 'distance_run'.
function routeParam(index) {
  const parts = (location.hash || '').replace(/^#\/?/, '').split('?')[0].split('/');
  return parts[index + 1] || null;
}

function currentViewId() {
  const id = (location.hash || '').replace(/^#\/?/, '').split('/')[0];
  return VIEWS.some(v => v.id === id) ? id : (VIEWS[0] && VIEWS[0].id);
}

function navigate(id) {
  if (location.hash === '#/' + id) renderCurrentView();
  else location.hash = '#/' + id;
}

function renderNav() {
  const nav = el('main-nav');
  if (!nav) return;
  const active = currentViewId();
  nav.innerHTML = VIEWS.filter(v => v.inNav !== false).map(v => `
    <button class="nav-btn ${v.id === active ? 'active' : ''}"
            onclick="navigate('${v.id}')" aria-current="${v.id === active ? 'page' : 'false'}">
      <span class="nav-icon">${iconOrText(v.icon, 22)}</span>
      <span class="nav-label">${escHtml(v.label)}</span>
    </button>`).join('');
}

function renderCurrentView() {
  const id = currentViewId();
  const view = VIEWS.find(v => v.id === id);
  const host = el('view-host');
  if (!view || !host) return;
  const changed = _currentView !== id;
  _currentView = id;
  renderNav();
  // Views may render synchronously or return a promise; either is fine.
  Promise.resolve(view.render(host))
    .then(() => {
      // Restart the entrance on every render, not only on a route change: switching
      // week to month is a change of data, and it should look like one.
      host.classList.remove('view-enter');
      void host.offsetWidth;          // forces the removal to commit
      host.classList.add('view-enter');
      if (changed) window.scrollTo({ top: 0, behavior: 'auto' });
      animateView(host);
    })
    .catch(err => {
      console.error(err);
      host.innerHTML = `<div class="card error"><h2>Something went wrong</h2>
        <pre>${escHtml(err && err.message || String(err))}</pre></div>`;
    });
}

// Re-render the active view after data changes, but only if it is still on screen.
function refreshView() { renderCurrentView(); }

window.addEventListener('hashchange', renderCurrentView);
