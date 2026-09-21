// === DASHBOARD ===
// The home screen. Until an import has happened there is nothing honest to show, so
// it explains what to do next rather than displaying an array of zeroes.
// The week/month/year views that fill this in arrive with the rollup engine.

function renderDashboard(host) {
  return Promise.all([dbCount('sessions'), dbCount('daily'), dbGetAll('imports')])
    .then(([sessions, daily, imports]) => {
      if (!sessions && !daily) return renderEmptyState(host);
      host.innerHTML = `
        <div class="view-head">
          <h1>Your activity</h1>
          <p class="subtle">${humanCount(sessions)} workouts and ${humanCount(daily)} daily
             figures stored from ${imports.length} import${imports.length === 1 ? '' : 's'}.</p>
        </div>
        <div class="card">
          <h2>Totals are on their way</h2>
          <p>The data is in. Weekly, monthly and yearly totals appear once the
             reconciliation step is in place — until then the numbers would double-count
             anything two devices both recorded, and a wrong total is worse than none.</p>
        </div>`;
    });
}

function renderEmptyState(host) {
  host.innerHTML = `
    <div class="view-head">
      <h1>Nothing here yet</h1>
      <p class="subtle">Bring in an export and this becomes your ledger.</p>
    </div>
    <div class="card empty-state">
      <div class="empty-icon" aria-hidden="true">🏃</div>
      <h2>Start with your Apple Health export</h2>
      <p>It holds the deepest history — every run, swim, gym session and step your phone
         and watch have recorded. Drop it in and you will see exactly what is inside
         before anything is saved.</p>
      <button class="btn btn-primary" onclick="navigate('data')">Add your data</button>
    </div>`;
}

registerView({ id: 'home', label: 'Home', icon: '🏠', render: renderDashboard });
