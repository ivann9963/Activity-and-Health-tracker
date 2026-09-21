// === SETTINGS ===
// Units, week start, source priority and the destructive actions. Source priority is
// here rather than buried in the dedupe screen because it is the single lever that
// decides which device's numbers win, and it is worth being able to see at a glance.

function renderSettings(host) {
  // The OAuth callback lands on this screen, so report its outcome before rendering.
  const callback = consumeGoogleCallback();
  if (callback) {
    const msg = googleCallbackMessage(callback);
    showToast(msg.text, msg.kind);
  }

  return Promise.all([loadSettings(), dbCount('sessions'), dbCount('daily'),
                      metricsWithData(), googleStatus()])
    .then(([settings, sessions, daily, withData, google]) => {
      const sources = Object.entries(settings.sourcePriority).sort((a, b) => b[1] - a[1]);
      host.innerHTML = `
        <div class="view-head"><h1>Settings</h1></div>

        <div class="card">
          <h2>Units and weeks</h2>
          <label class="field">
            <span>Distance</span>
            <select id="set-units">
              <option value="metric" ${settings.units === 'metric' ? 'selected' : ''}>Kilometres</option>
              <option value="imperial" ${settings.units === 'imperial' ? 'selected' : ''}>Miles</option>
            </select>
          </label>
          <label class="field">
            <span>Weeks start on</span>
            <select id="set-week">
              <option value="monday" ${settings.firstDayOfWeek === 'monday' ? 'selected' : ''}>Monday</option>
              <option value="sunday" ${settings.firstDayOfWeek === 'sunday' ? 'selected' : ''}>Sunday</option>
            </select>
          </label>
        </div>

        ${googleCardHtml(google)}

        <div class="card">
          <h2>Tiles to show</h2>
          <p class="subtle">Hide anything you do not do. A permanently empty tile reads
             as missing data rather than as a sport you skip.</p>
          ${metricIds().map(id => {
            const hidden = (settings.hiddenMetrics || []).indexOf(id) !== -1;
            const has = withData.has(id);
            return `<label class="field toggle-field">
              <span>${METRICS[id].icon} ${escHtml(METRICS[id].label)}
                ${has ? '' : '<span class="pill">no data</span>'}</span>
              <input type="checkbox" class="metric-toggle" data-metric="${id}"
                     ${hidden ? '' : 'checked'}>
            </label>`;
          }).join('')}
        </div>

        <div class="card">
          <h2>Which device to believe</h2>
          <p class="subtle">When two devices recorded the same thing, the higher-ranked one
             wins. This is a ranking, not a fixed choice: on any given day only the sources
             that actually recorded something are considered, so retiring a device never
             leaves a gap.</p>
          <div class="table-wrap"><table class="data-table">
            <thead><tr><th>Source</th><th class="num">Rank</th></tr></thead>
            <tbody>${sources.map(([name, rank]) => `<tr>
              <td>${escHtml(name)}</td>
              <td class="num"><input type="number" class="rank-input" data-source="${escHtml(name)}"
                  value="${rank}" min="0" max="999" step="5"></td></tr>`).join('')}
            </tbody>
          </table></div>
        </div>

        <div class="card">
          <h2>Backup</h2>
          <p class="subtle">Everything lives in this browser alone. Clearing site data,
             losing the device or reinstalling the browser takes it with it — and
             re-importing means another twenty-minute export from your phone. A backup
             is one file you keep wherever you like.</p>
          <div class="card-actions">
            <button class="btn btn-primary" id="do-backup">Save a backup</button>
            <button class="btn btn-ghost" onclick="navigate('data')">Restore one</button>
          </div>
        </div>

        <div class="card">
          <h2>Stored data</h2>
          <p class="subtle">${humanCount(sessions)} workouts · ${humanCount(daily)} daily figures,
             all held in this browser on this device.</p>
          <div class="card-actions">
            <button class="btn btn-danger" id="wipe">Delete everything</button>
          </div>
        </div>`;

      const connectBtn = el('google-connect');
      if (connectBtn) connectBtn.onclick = connectGoogle;
      const disconnectBtn = el('google-disconnect');
      if (disconnectBtn) disconnectBtn.onclick = () => confirmDialog({
        title: 'Disconnect Google Health?',
        message: 'The app stops receiving new data and the permission is revoked in ' +
                 'your Google account. Everything already imported stays.',
        confirmLabel: 'Disconnect', danger: true
      }, () => disconnectGoogle().then(() => {
        showToast('Disconnected', 'success');
        refreshView();
      }));

      el('set-units').onchange = ev => setSetting('units', ev.target.value)
        .then(() => showToast('Units updated', 'success'));
      el('set-week').onchange = ev => setSetting('firstDayOfWeek', ev.target.value)
        .then(() => showToast('Week start updated', 'success'));

      host.querySelectorAll('.metric-toggle').forEach(input => {
        input.onchange = () => {
          const hidden = new Set(settings.hiddenMetrics || []);
          if (input.checked) hidden.delete(input.dataset.metric);
          else hidden.add(input.dataset.metric);
          const next = [...hidden];
          setSetting('hiddenMetrics', next).then(() => {
            settings.hiddenMetrics = next;
            showToast(input.checked ? 'Tile shown' : 'Tile hidden', 'success');
          });
        };
      });

      host.querySelectorAll('.rank-input').forEach(input => {
        input.onchange = () => {
          const priority = { ...settings.sourcePriority };
          priority[input.dataset.source] = Number(input.value);
          setSetting('sourcePriority', priority).then(() => {
            settings.sourcePriority = priority;
            showToast('Priority updated', 'success');
          });
        };
      });

      el('do-backup').onclick = () => {
        const btn = el('do-backup');
        btn.disabled = true;
        btn.textContent = 'Preparing…';
        exportBackup()
          .then(() => showToast('Backup saved', 'success'))
          .catch(err => {
            console.error(err);
            showToast('Could not write the backup', 'error');
          })
          .finally(() => { btn.disabled = false; btn.textContent = 'Save a backup'; });
      };

      el('wipe').onclick = () => confirmDialog({
        title: 'Delete all stored data?',
        message: 'Every imported workout and daily figure is removed from this device. ' +
                 'Your original export files are untouched, so you can always import again.',
        confirmLabel: 'Delete everything', danger: true
      }, () => {
        Promise.all(['sessions', 'daily', 'imports', 'overrides'].map(dbClear))
          .then(() => { showToast('All data deleted', 'success'); refreshView(); });
      });
    });
}

// Live sync. Fitbit's own Web API was retired in September 2026, so the Google Health
// API is the only route to automatic data — and being an aggregation layer, it covers
// whatever is attached to the Google account rather than one device.
function googleCardHtml(google) {
  if (!google.available) {
    return `<div class="card">
      <h2>Automatic sync</h2>
      <p class="subtle">Syncing needs the deployed version of this app — the part that
         talks to Google cannot run from a local file server. Import an export file on
         the Data screen instead.</p>
    </div>`;
  }
  if (!google.configured) {
    return `<div class="card">
      <h2>Automatic sync</h2>
      <p class="subtle">Not set up yet. The deployment needs
         <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> set as
         environment variables before Google Health can be connected.</p>
    </div>`;
  }
  if (google.connected) {
    return `<div class="card">
      <h2>Automatic sync</h2>
      <p class="subtle"><span class="yes">✓ Connected to Google Health.</span>
         New data arrives without exporting anything by hand.</p>
      <div class="card-actions">
        <button class="btn btn-ghost" id="google-disconnect">Disconnect</button>
      </div>
    </div>`;
  }
  return `<div class="card">
    <h2>Automatic sync</h2>
    <p class="subtle">Connect your Google account and new activity arrives on its own —
       no more exporting archives. Read-only: this app can never change your health
       data. Everything still stays on this device.</p>
    <div class="card-actions">
      <button class="btn btn-primary" id="google-connect">Connect Google Health</button>
    </div>
  </div>`;
}

registerView({ id: 'settings', label: 'Settings', icon: '⚙️', render: renderSettings });
