// === METRIC DETAIL ===
// One metric, its whole history. The dashboard answers "how am I doing this week";
// this answers "how am I doing, generally" — the shape over years, the records, and
// the individual sessions behind the totals.

// All time by default: this screen exists to answer "how am I doing, generally", and
// anchoring it to the current week or year shows an empty page to anyone whose
// history predates it — the same trap the dashboard had.
let _detailPeriod = 'all';

// Goals are held per week/month/year. "All time" is a viewing range, not something
// you can set a target against, so it maps to the year — and both the editor and the
// reader must agree on that, or a saved goal disappears the moment it is written.
function goalPeriod() {
  return _detailPeriod === 'all' ? 'year' : _detailPeriod;
}

function renderMetricDetail(host) {
  const metricId = routeParam(0);
  const metric = METRICS[metricId];
  if (!metric) {
    host.innerHTML = `<button class="btn-link back-link" onclick="navigate('home')">‹ Home</button>
      <div class="card"><h2>Unknown measure</h2>
      <p class="subtle">There is nothing called “${escHtml(metricId || '')}”.</p></div>`;
    return;
  }

  return Promise.all([loadSettings(), dataBounds(), loadGoals()])
    .then(([settings, bounds, goals]) => {
      if (!bounds.from) {
        host.innerHTML = `<button class="btn-link back-link" onclick="navigate('home')">‹ Home</button>
          <div class="card empty-state"><h2>No data yet</h2></div>`;
        return;
      }

      const today = todayLocal();
      const all = { from: bounds.from, to: bounds.to || today };
      const range = _detailPeriod === 'all'
        ? all
        : periodBounds(today, _detailPeriod, settings.firstDayOfWeek);

      return Promise.all([
        rollupDaily(metricId, all.from, all.to),
        metric.from === 'sessions'
          ? dbRange('sessions', 'byDate', range.from, range.to)
          : Promise.resolve([])
      ]).then(([allByDay, sessions]) => {
        const inRange = {};
        for (const [day, value] of Object.entries(allByDay)) {
          if (day >= range.from && day <= range.to) inRange[day] = value;
        }
        host.innerHTML = detailHtml(metricId, metric, inRange, allByDay, range, all,
                                    sessions, settings, goals);
        drawDetailChart(metricId, inRange, range);
        wireDetail(metricId, goals);
      });
    });
}

function detailHtml(id, metric, byDay, allByDay, range, all, sessions, settings, goals) {
  const values = Object.values(byDay);
  const total = aggregate(values, metric.periodAgg);
  const streak = dayStreaks(byDay, range.from, range.to, id);
  const weeks = weekStreaks(byDay, range.from, range.to, id, settings.firstDayOfWeek);
  const allTime = aggregate(Object.values(allByDay), metric.periodAgg);
  const goal = goals[goalId(id, goalPeriod())];
  const counted = sessions.filter(s => !s.supersededBy && s.activity === metric.activity)
                          .sort((a, b) => b.start - a.start);

  return `
    <button class="btn-link back-link" onclick="navigate('home')">‹ Home</button>
    <div class="view-head">
      <h1>${metric.icon} ${escHtml(metric.label)}</h1>
    </div>

    <div class="segmented" role="tablist">
      ${['week', 'month', 'year', 'all'].map(p => `
        <button role="tab" class="${p === _detailPeriod ? 'active' : ''}" data-detail="${p}">
          ${p === 'all' ? 'All time' : p[0].toUpperCase() + p.slice(1)}</button>`).join('')}
    </div>

    <div class="card">
      <div class="total-value">${escHtml(formatMetric(id, total))}</div>
      ${equivalenceFor(id, total) ? `<p class="equivalence">${escHtml(equivalenceFor(id, total))}</p>` : ''}
      ${goal ? `<p class="subtle">Goal: ${escHtml(formatMetric(id, goal.target))}</p>` : ''}
      <div class="chart-wrap"><div id="detail-chart"></div></div>
    </div>

    <div class="card">
      <h2>Records</h2>
      ${values.length ? '' : `<p class="subtle">Nothing recorded in this period.
        ${_detailPeriod === 'all' ? '' : 'Try a wider range.'}</p>`}
      <div class="total-facts">
        ${recordRow('Best day', bestDay(byDay), id, v => v.date)}
        ${recordRow('Best week', bestPeriod(byDay, 'week', settings.firstDayOfWeek), id,
                    v => 'week of ' + v.key)}
        ${recordRow('Best month', bestPeriod(byDay, 'month'), id,
                    v => v.key ? monthName(v.key) : '')}
        <div><span class="fact-label">Active days</span>
          <span class="fact-value">${streak.activeDays} of ${streak.totalDays}</span></div>
        <div><span class="fact-label">Longest day streak</span>
          <span class="fact-value">${plural(streak.longest, 'day')}</span></div>
        <div><span class="fact-label">Longest week streak</span>
          <span class="fact-value">${plural(weeks.longest, 'week')}</span></div>
        ${_detailPeriod !== 'all' ? `<div><span class="fact-label">All time</span>
          <span class="fact-value">${escHtml(formatMetric(id, allTime))}</span></div>` : ''}
      </div>
    </div>

    ${metric.goalable ? goalEditorHtml(id, goal) : ''}
    ${counted.length ? sessionListHtml(id, counted) : ''}`;
}

function recordRow(label, best, id, describe) {
  if (!best) return '';
  return `<div><span class="fact-label">${escHtml(label)}</span>
    <span class="fact-value">${escHtml(formatMetric(id, best.value))}
      <span class="subtle">${escHtml(describe(best))}</span></span></div>`;
}

// Sessions are listed newest first, and only for the period on screen — a decade of
// runs is not a list anyone scrolls.
function sessionListHtml(id, sessions) {
  const shown = sessions.slice(0, 50);
  return `<div class="card">
    <h2>${plural(sessions.length, 'session')}</h2>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Date</th><th class="num">${METRICS[id].display === 'km' ? 'Distance' : 'Time'}</th>
        <th class="num">Duration</th><th>Source</th></tr></thead>
      <tbody>${shown.map(s => `<tr>
        <td class="nowrap">${escHtml(s.localDate)}</td>
        <td class="num">${escHtml(s.distanceM != null
          ? formatMetric('distance_run', s.distanceM) : formatMetric('time_gym', s.durationSec))}</td>
        <td class="num">${escHtml(formatMetric('time_gym', s.durationSec))}</td>
        <td class="subtle">${escHtml(sourceLabel(s.source))}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    ${sessions.length > shown.length
      ? `<p class="subtle">Showing the most recent ${shown.length}.</p>` : ''}
  </div>`;
}

function goalEditorHtml(id, goal) {
  const label = goalPeriod();
  return `<div class="card">
    <h2>Goal</h2>
    <p class="subtle">A target for one ${escHtml(label)}. Leave it empty for no goal —
       the app will still show totals and trends.</p>
    <div class="goal-row">
      <input type="number" id="goal-input" class="goal-input" min="0" step="any"
             value="${goal ? goalInputValue(id, goal.target) : ''}"
             placeholder="${escHtml(goalPlaceholder(id))}">
      <span class="goal-unit">${escHtml(goalUnit(id))}</span>
      <button class="btn btn-primary" id="goal-save">Save</button>
      ${goal ? `<button class="btn btn-ghost" id="goal-clear">Remove</button>` : ''}
    </div>
    <p class="subtle" id="goal-suggestion"></p>
  </div>`;
}

// Goals are typed in the unit the metric is displayed in — kilometres and hours —
// rather than the metres and seconds it is stored in.
function goalUnit(id) {
  const m = METRICS[id];
  if (m.display === 'km') return 'km';
  if (m.display === 'duration') return 'hours';
  return m.unit;
}
function goalScale(id) {
  const m = METRICS[id];
  if (m.display === 'km') return 1000;
  if (m.display === 'duration') return m.unit === 'min' ? 60 : 3600;
  return 1;
}
function goalInputValue(id, stored) {
  return Number((stored / goalScale(id)).toFixed(2));
}
function goalPlaceholder(id) {
  return METRICS[id].display === 'km' ? 'e.g. 500' : 'e.g. 60';
}

function drawDetailChart(id, byDay, range) {
  const host = el('detail-chart');
  if (!host) return;
  const days = daysBetween(range.from, range.to) + 1;

  // Bucket by whatever keeps the number of columns readable: days for a week or
  // month, months for a year, years for everything.
  let data;
  if (days <= 40) {
    data = dateRange(range.from, range.to).map(d => ({
      label: d.slice(8), value: byDay[d] || 0,
      title: `${d}: ${byDay[d] ? formatMetric(id, byDay[d]) : 'nothing recorded'}`
    }));
  } else if (days <= 400) {
    const months = new Map();
    for (const [day, v] of Object.entries(byDay)) {
      const k = day.slice(0, 7);
      months.set(k, (months.get(k) || 0) + v);
    }
    data = [];
    let cursor = range.from.slice(0, 7) + '-01';
    while (cursor <= range.to) {
      const k = cursor.slice(0, 7);
      const value = months.get(k) || 0;
      data.push({ label: new Date(dateKeyToMs(cursor))
        .toLocaleDateString(undefined, { month: 'narrow', timeZone: 'UTC' }),
        value, title: `${monthName(k)}: ${value ? formatMetric(id, value) : 'nothing recorded'}` });
      cursor = shiftPeriod(cursor, 'month', 1);
    }
  } else {
    const years = new Map();
    for (const [day, v] of Object.entries(byDay)) {
      const k = day.slice(0, 4);
      years.set(k, (years.get(k) || 0) + v);
    }
    data = [...years.entries()].sort().map(([k, value]) => ({
      label: k.slice(2), value, title: `${k}: ${formatMetric(id, value)}` }));
  }

  host.innerHTML = '';
  host.appendChild(columnChart(data, {
    width: 640, height: 170,
    format: (v, isTick) => isTick ? formatMetricAxis(id, v) : formatMetric(id, v),
    ariaLabel: `${METRICS[id].label} over the selected period`
  }));
}

function wireDetail(id, goals) {
  document.querySelectorAll('[data-detail]').forEach(b => b.onclick = () => {
    _detailPeriod = b.dataset.detail;
    refreshView();
  });

  const save = el('goal-save');
  const input = el('goal-input');
  if (save && input) {
    save.onclick = () => {
      const typed = Number(input.value);
      if (!isFinite(typed) || typed <= 0) {
        showToast('Enter a number above zero', 'error');
        return;
      }
      setGoal(id, goalPeriod(), typed * goalScale(id), 'manual')
        .then(() => { showToast('Goal saved', 'success'); refreshView(); });
    };
  }
  const clear = el('goal-clear');
  if (clear) clear.onclick = () => clearGoal(id, goalPeriod())
    .then(() => { showToast('Goal removed', 'success'); refreshView(); });

  // A suggestion is offered, never saved on the user's behalf: the app should not
  // quietly invent commitments.
  const note = el('goal-suggestion');
  if (note) {
    const period = goalPeriod();
    dataBounds().then(bounds => {
      if (!bounds.from) return;
      const to = bounds.to || todayLocal();
      const from = addDays(to, -365);
      return rollupDaily(id, from, to).then(byDay => {
        const suggested = deriveTarget(id, byDay, from, to, period);
        if (!suggested) return;
        note.innerHTML = `Based on the last twelve months, ` +
          `<button class="btn-link" id="goal-accept">${escHtml(formatMetric(id, suggested))}</button>` +
          ` would be a slight stretch.`;
        const accept = el('goal-accept');
        if (accept) accept.onclick = () => setGoal(id, period, suggested, 'derived')
          .then(() => { showToast('Goal set', 'success'); refreshView(); });
      });
    });
  }
}

registerView({ id: 'metric', label: 'Metric', icon: '📈', inNav: false,
               render: renderMetricDetail });
