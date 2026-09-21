// === SETTINGS ===
// Units, week start, source priority and the destructive actions. Source priority is
// here rather than buried in the dedupe screen because it is the single lever that
// decides which device's numbers win, and it is worth being able to see at a glance.

function renderSettings(host) {
  return Promise.all([loadSettings(), dbCount('sessions'), dbCount('daily'), metricsWithData()])
    .then(([settings, sessions, daily, withData]) => {
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
          <h2>Stored data</h2>
          <p class="subtle">${humanCount(sessions)} workouts · ${humanCount(daily)} daily figures,
             all held in this browser on this device.</p>
          <div class="card-actions">
            <button class="btn btn-danger" id="wipe">Delete everything</button>
          </div>
        </div>`;

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

registerView({ id: 'settings', label: 'Settings', icon: '⚙️', render: renderSettings });
