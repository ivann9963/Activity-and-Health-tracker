// === INSIGHTS SCREEN ===
// The questions that cut across metrics: where the time went, how hard each sport is,
// whether the running is getting faster, and how many days were genuinely active.
//
// Everything here shares the dashboard's period switcher, so the same question can be
// asked of a week, a month or a year.

let _insightPeriod = 'year';
let _insightAnchor = null;
let _hrThreshold = 140;

function renderInsights(host) {
  return Promise.all([loadSettings(), dataBounds()]).then(([settings, bounds]) => {
    if (!bounds.from) {
      host.innerHTML = `<div class="view-head"><h1>Insights</h1></div>
        <div class="card empty-state"><div class="empty-icon" aria-hidden="true">📊</div>
        <h2>Nothing to analyse yet</h2>
        <p>Import your history and this fills in.</p>
        <button class="btn btn-primary" onclick="navigate('data')">Add your data</button></div>`;
      return;
    }

    const firstDay = settings.firstDayOfWeek;
    // Same rule as the dashboard: never open on an empty period just because the
    // calendar says it is current.
    if (_insightAnchor == null && bounds.to) {
      const thisPeriod = periodBounds(todayLocal(), _insightPeriod, firstDay);
      if (bounds.to < thisPeriod.from) _insightAnchor = bounds.to;
    }
    const anchor = _insightAnchor || todayLocal();
    const range = periodBounds(anchor, _insightPeriod, firstDay);

    return Promise.all([
      dbRange('sessions', 'byDate', range.from, range.to),
      rollupAllMetrics(range.from, range.to, HR_BANDS.map(hrBandMetric)),
      // Pace deserves a longer view than one period: a trend over three months is a
      // trend, a trend over one week is noise.
      dbRange('sessions', 'byDate', addDays(range.to, -730), range.to)
    ]).then(([sessions, hrBands, paceSessions]) => {
      host.innerHTML = insightsHtml(sessions, hrBands, paceSessions, range, settings);
      drawInsightCharts(paceSessions);
      wireInsights(firstDay);
    });
  });
}

function insightsHtml(sessions, hrBands, paceSessions, range, settings) {
  const share = timeByActivity(sessions, { excludeWalking: true });
  const days = activeDays(sessions, range.from, range.to);
  const hr = avgHrByActivity(sessions);
  const totalSeconds = share.reduce((n, s) => n + s.seconds, 0);

  return `
    <div class="segmented" role="tablist">
      ${['week', 'month', 'year'].map(p => `
        <button role="tab" class="${p === _insightPeriod ? 'active' : ''}" data-insight="${p}">
          ${p[0].toUpperCase() + p.slice(1)}</button>`).join('')}
    </div>

    <div class="period-nav">
      <button class="icon-btn" id="insight-prev" aria-label="Previous ${_insightPeriod}">‹</button>
      <h1 class="period-label">${escHtml(periodLabel(range, _insightPeriod, settings.firstDayOfWeek))}</h1>
      <button class="icon-btn" id="insight-next" aria-label="Next ${_insightPeriod}"
              ${isCurrentPeriod(range, settings.firstDayOfWeek) ? 'disabled' : ''}>›</button>
    </div>

    ${shareCardHtml(share, totalSeconds)}
    ${activeDaysCardHtml(days)}
    ${hrBandCardHtml(hrBands)}
    ${hrByActivityCardHtml(hr)}
    ${paceCardHtml(paceSessions)}`;
}

function shareCardHtml(share, totalSeconds) {
  if (!share.length) {
    return `<div class="card"><h2>Where the time went</h2>
      <p class="subtle">No workouts recorded in this period.</p></div>`;
  }
  const top = share[0];
  return `<div class="card">
    <h2>Where the time went</h2>
    <p class="headline">Mostly ${top.icon} <strong>${escHtml(top.label)}</strong> —
       ${Math.round(top.pct)}% of ${escHtml(formatMetric('time_gym', totalSeconds))}.</p>
    ${share.map(s => `
      <div class="share-row">
        <span class="share-label">${s.icon} ${escHtml(s.label)}</span>
        <span class="share-value">${escHtml(formatMetric('time_gym', s.seconds))}
          <span class="share-pct">${Math.round(s.pct)}%</span></span>
        <div class="share-track"><div class="share-fill" style="width:${s.pct.toFixed(1)}%"></div></div>
      </div>`).join('')}
    <details class="why"><summary>How this is counted</summary>
      <p class="subtle">Share of time, not number of sessions — twelve short runs and
         twelve long gym sessions are not the same period. Walking is excluded: it is
         ambient rather than chosen, and it swamps everything else.</p></details>
  </div>`;
}

function activeDaysCardHtml(d) {
  return `<div class="card">
    <h2>Active days</h2>
    <div class="stat-row">
      ${statTile('Active', String(d.active), `${Math.round(d.pct)}% of ${d.total} days`)}
      ${statTile('Walking only', String(d.walkingOnly), '')}
      ${statTile('Nothing recorded', String(d.inactive), '')}
    </div>
    <details class="why"><summary>What counts as active</summary>
      <p class="subtle">Something deliberate. Walking alone does not qualify — a day at
         a desk still records a walk to the kitchen, and counting it would make every
         day look active.</p></details>
  </div>`;
}

function hrBandCardHtml(bands) {
  const rows = HR_BANDS.map(floor => ({
    floor,
    label: hrBandLabel(floor),
    seconds: (bands[hrBandMetric(floor)] && bands[hrBandMetric(floor)].value) || 0
  }));
  const total = rows.reduce((n, r) => n + r.seconds, 0);
  if (!total) {
    return `<div class="card"><h2>Time by heart rate</h2>
      <p class="subtle">No heart-rate data in this period. Apple Health exports carry it;
         it arrives with the next import.</p></div>`;
  }

  const above = rows.filter(r => r.floor >= _hrThreshold).reduce((n, r) => n + r.seconds, 0);
  const max = Math.max(...rows.map(r => r.seconds));

  return `<div class="card">
    <h2>Time by heart rate</h2>
    <div class="field" style="border:none">
      <span>Time above</span>
      <select id="hr-threshold">
        ${HR_BANDS.filter(f => f > 0).map(f =>
          `<option value="${f}" ${f === _hrThreshold ? 'selected' : ''}>${f} bpm</option>`).join('')}
      </select>
    </div>
    <div class="hero-inline">${escHtml(formatMetric('time_gym', above))}
      <span class="subtle">above ${_hrThreshold} bpm</span></div>
    ${rows.filter(r => r.seconds > 0).reverse().map(r => `
      <div class="share-row">
        <span class="share-label">${escHtml(r.label)}</span>
        <span class="share-value">${escHtml(formatMetric('time_gym', r.seconds))}</span>
        <div class="share-track"><div class="share-fill"
          style="width:${max ? (r.seconds / max * 100).toFixed(1) : 0}%"></div></div>
      </div>`).join('')}
    <details class="why"><summary>How this is measured</summary>
      <p class="subtle">Bands are exclusive, so any threshold is the sum of the bands
         above it. Each reading counts for the gap until the next one, capped at five
         minutes — a longer gap means the watch was off, not a slow heartbeat.</p>
    </details>
  </div>`;
}

function hrByActivityCardHtml(hr) {
  if (!hr.length) return '';
  return `<div class="card">
    <h2>Effort by sport</h2>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Sport</th><th class="num">Average</th><th class="num">Hardest session</th>
        <th class="num">Sessions</th></tr></thead>
      <tbody>${hr.map(h => `<tr>
        <td>${h.icon} ${escHtml(h.label)}</td>
        <td class="num">${h.avgHr} bpm</td>
        <td class="num">${h.highestSessionAvg} bpm</td>
        <td class="num">${h.sessions}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <details class="why"><summary>How this is averaged</summary>
      <p class="subtle">Weighted by session length, so a ten-minute warm-up does not
         count as much as a two-hour ride.</p></details>
  </div>`;
}

function paceCardHtml(sessions) {
  const prog = paceProgression(sessions, 'running');
  if (prog.length < 2) {
    return `<div class="card"><h2>Running pace</h2>
      <p class="subtle">Two months of runs are needed before a trend means anything.</p></div>`;
  }
  const first = prog[0], last = prog[prog.length - 1];
  const change = first.pace - last.pace; // positive means faster now
  const best = bestPaces(sessions, 'running', 3);

  return `<div class="card">
    <h2>Running pace</h2>
    <div class="hero-inline">${escHtml(formatPace(last.pace))}
      <span class="subtle">${change > 5 ? `${formatPace(Math.abs(change)).replace(' /km', '')} per km faster than ${monthName(first.month)}`
        : change < -5 ? `${formatPace(Math.abs(change)).replace(' /km', '')} per km slower than ${monthName(first.month)}`
        : 'about the same as when this record starts'}</span></div>
    <div class="chart-wrap"><div id="pace-chart"></div></div>
    <p class="subtle">Faster is higher on the chart.</p>
    <h3>Fastest runs</h3>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Date</th><th class="num">Pace</th><th class="num">Distance</th></tr></thead>
      <tbody>${best.map(b => `<tr>
        <td class="nowrap">${escHtml(b.date)}</td>
        <td class="num">${escHtml(formatPace(b.pace))}</td>
        <td class="num">${escHtml(formatMetric('distance_run', b.distanceM))}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <details class="why"><summary>How pace is calculated</summary>
      <p class="subtle">Each month is its total time over its total distance, so one
         short sprint does not outweigh a long steady run.</p></details>
  </div>`;
}

function drawInsightCharts(sessions) {
  const host = el('pace-chart');
  if (!host) return;
  const prog = paceProgression(sessions, 'running');
  if (prog.length < 2) return;

  host.innerHTML = '';
  host.appendChild(lineChart(prog.map(p => ({
    label: p.month.slice(2).replace('-', '/'),
    value: p.pace,
    title: `${monthName(p.month)}: ${formatPace(p.pace)} over ${p.runs} run${p.runs === 1 ? '' : 's'}`
  })), {
    width: 640, height: 180,
    // Pace runs the wrong way round: a lower number is a better one, so the axis is
    // inverted and improvement reads as the line climbing.
    invert: true,
    format: v => formatPace(v).replace(' /km', ''),
    ariaLabel: 'Running pace by month, faster is higher'
  }));
}

function wireInsights(firstDay) {
  document.querySelectorAll('[data-insight]').forEach(b => b.onclick = () => {
    _insightPeriod = b.dataset.insight; _insightAnchor = null; refreshView();
  });
  const prev = el('insight-prev');
  const next = el('insight-next');
  if (prev) prev.onclick = () => {
    _insightAnchor = shiftPeriod(_insightAnchor || todayLocal(), _insightPeriod, -1, firstDay);
    refreshView();
  };
  if (next) next.onclick = () => {
    _insightAnchor = shiftPeriod(_insightAnchor || todayLocal(), _insightPeriod, 1, firstDay);
    refreshView();
  };
  const hr = el('hr-threshold');
  if (hr) hr.onchange = () => { _hrThreshold = Number(hr.value); refreshView(); };
}

registerView({ id: 'insights', label: 'Insights', icon: '📊', render: renderInsights });
