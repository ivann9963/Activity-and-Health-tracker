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
      // Pace deserves a longer view than one period: a trend over three months is a
      // trend, a trend over one week is noise.
      dbRange('sessions', 'byDate', addDays(range.to, -730), range.to)
    ]).then(([sessions, paceSessions]) => {
      host.innerHTML = insightsHtml(sessions, paceSessions, range, settings);
      drawInsightCharts(paceSessions);
      wireInsights(firstDay);
    });
  });
}

function insightsHtml(sessions, paceSessions, range, settings) {
  const notWorkouts = settings.notWorkouts || [];
  const share = timeByActivity(sessions, { exclude: notWorkouts });
  const days = activeDays(sessions, range.from, range.to, notWorkouts);
  const hr = avgHrByActivity(sessions, { exclude: notWorkouts });
  // Same exclusion list as the share: an activity set aside leaves the bands too.
  const bands = hrBandTotals(sessions, { exclude: notWorkouts });
  const totalSeconds = share.reduce((n, s) => n + s.seconds, 0);
  // What was set aside, named — a hidden thing with no way back is a bug, not a setting.
  const hidden = activityGroupsPresent(sessions)
    .filter(g => notWorkouts.indexOf(g.key) !== -1);

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

    ${shareCardHtml(share, totalSeconds, hidden)}
    ${activeDaysCardHtml(days)}
    ${hrBandCardHtml(bands)}
    ${hrByActivityCardHtml(hr)}
    ${paceCardHtml(paceSessions)}`;
}

function shareCardHtml(share, totalSeconds, hidden) {
  const hiddenRow = (hidden || []).length ? `
    <div class="hidden-row">
      <span class="subtle">Set aside:</span>
      ${hidden.map(g => `<button class="chip-toggle" data-show-activity="${escHtml(g.key)}"
          title="Count ${escHtml(g.label)} again">${g.icon} ${escHtml(g.label)} <span aria-hidden="true">+</span></button>`).join('')}
    </div>` : '';

  if (!share.length) {
    return `<div class="card"><h2>Where the time went</h2>
      <p class="subtle">No workouts recorded in this period.</p>${hiddenRow}</div>`;
  }
  const top = share[0];
  const unlabelled = share.filter(s => s.unlabelled);

  return `<div class="card">
    <h2>Where the time went</h2>
    <p class="headline">Mostly ${top.icon} <strong>${escHtml(top.label)}</strong> —
       ${Math.round(top.pct)}% of ${escHtml(formatMetric('time_gym', totalSeconds))}.</p>
    <div class="metric-grid">
      ${share.map(s => `<div class="metric-tile ${s.unlabelled ? 'is-unlabelled' : ''}">
        <button class="tile-hide" data-hide-activity="${escHtml(s.key)}"
                aria-label="Set aside ${escHtml(s.label)}"
                title="Set aside ${escHtml(s.label)}">×</button>
        <div class="metric-head">
          <span class="metric-icon" aria-hidden="true">${s.icon}</span>
          <span class="metric-name">${escHtml(s.label)}</span>
        </div>
        <div class="metric-value">${escHtml(formatMetric('time_gym', s.seconds))}</div>
        <div class="metric-delta neutral">${Math.round(s.pct)}% of your time</div>
      </div>`).join('')}
    </div>
    ${hiddenRow}
    ${unlabelled.length ? unlabelledDetailHtml(unlabelled) : ''}
    <details class="why"><summary>How this is counted</summary>
      <p class="subtle">Share of time, not number of sessions — twelve short runs and
         twelve long gym sessions are not the same period. Anything set aside under
         Settings → What counts as a workout is left out.</p></details>
  </div>`;
}

// An uncategorised group is a number with no explanation attached. The sessions behind
// it are the explanation, so they are one tap away rather than unreachable.
function unlabelledDetailHtml(groups) {
  const all = groups.reduce((rows, g) => rows.concat(g.sessions), [])
    .sort((a, b) => b.start - a.start);
  return `<details class="why">
    <summary>What is uncategorised? (${plural(all.length, 'workout')})</summary>
    <p class="subtle">These were recorded without a sport. The device that logged them
       did not say what they were, so neither can this app — but here they are, and the
       date and time usually give it away.</p>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>When</th><th class="num">Length</th><th>Recorded by</th></tr></thead>
      <tbody>${all.slice(0, 25).map(s => `<tr>
        <td class="nowrap">${escHtml(s.localDate)}
          <span class="subtle">${escHtml(new Date(s.start)
            .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</span></td>
        <td class="num">${escHtml(formatMetric('time_gym', s.durationSec))}</td>
        <td class="subtle">${escHtml(sourceLabel(s.source))}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    ${all.length > 25 ? `<p class="subtle">Showing the most recent 25.</p>` : ''}
  </details>`;
}

function activeDaysCardHtml(d) {
  return `<div class="card">
    <h2>Active days</h2>
    <div class="stat-row">
      ${statTile('Active', String(d.active), `${Math.round(d.pct)}% of ${d.total} days`)}
      ${statTile('Not counted', String(d.ambientOnly), 'set in Settings')}
      ${statTile('Nothing recorded', String(d.inactive), '')}
    </div>
    <details class="why"><summary>What counts as active</summary>
      <p class="subtle">Something deliberate. By default walking does not qualify — a
         day at a desk still records a walk to the kitchen, and counting it would make
         every day look active. Change which activities count under
         Settings → What counts as a workout.</p></details>
  </div>`;
}

function hrBandCardHtml(rows) {
  const total = rows.reduce((n, r) => n + r.seconds, 0);
  if (!total) {
    return `<div class="card"><h2>Time by heart rate</h2>
      <p class="subtle">No heart-rate data in this period. Apple Health and Google
         Health exports both carry it; it arrives with the next import.</p></div>`;
  }

  const REPORTED_FLOOR = 100;
  const shown = rows.filter(r => r.floor >= REPORTED_FLOOR && r.seconds > 0).reverse();
  const belowFloor = rows.filter(r => r.floor < REPORTED_FLOOR)
                         .reduce((n, r) => n + r.seconds, 0);
  const hard = rows.filter(r => r.floor >= 140).reduce((n, r) => n + r.seconds, 0);
  const max = Math.max(...shown.map(r => r.seconds), 0);

  return `<div class="card">
    <h2>Time by heart rate</h2>
    <div class="hero-inline">${escHtml(formatMetric('time_gym', hard))}
      <span class="subtle">above 140 bpm</span></div>
    ${shown.map(r => `
      <div class="share-row">
        <span class="share-label">${escHtml(r.label)}</span>
        <span class="share-value">${escHtml(formatMetric('time_gym', r.seconds))}</span>
        <div class="share-track"><div class="share-fill"
          style="width:${max ? (r.seconds / max * 100).toFixed(1) : 0}%"></div></div>
      </div>`).join('')}
    <details class="why"><summary>How this is measured</summary>
      <p class="subtle">Only heart rate recorded during a workout is counted — the rest
         of the day is sitting still and would drown everything else.</p>
      <p class="subtle">Bands are exclusive, so any threshold is the sum of the bands
         above it. Each reading counts for the gap until the next one of the same
         workout, capped at five minutes — a longer gap means the watch was off, not a
         slow heartbeat.</p>
      <p class="subtle">Counted per workout rather than per day, so anything set aside
         under Settings → What counts as a workout leaves this too.</p>
      ${belowFloor ? `<p class="subtle">Below ${REPORTED_FLOOR} bpm:
        ${escHtml(formatMetric('time_gym', belowFloor))} — warm-ups, rests between sets
        and the walk to the car. Counted, but left off the chart: over a full history
        it is most of the time recorded, and it would flatten every other band.</p>` : ''}
    </details>
  </div>`;
}

function hrByActivityCardHtml(hr) {
  if (!hr.length) return '';
  return `<div class="card">
    <h2>Effort by sport</h2>
    ${hr.map(h => `
      <div class="effort-row">
        <span class="effort-icon" aria-hidden="true">${h.icon}</span>
        <span class="effort-name">${escHtml(h.label)}</span>
        <span class="effort-value">${h.avgHr}<span class="effort-unit"> bpm</span></span>
        <span class="effort-note">hardest ${h.highestSessionAvg} bpm ·
          ${h.sessions} session${h.sessions === 1 ? '' : 's'}</span>
      </div>`).join('')}
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
  // Hiding an activity is done where the activity is, not in a settings screen two
  // taps away. It writes the same setting, so the two stay in step.
  document.querySelectorAll('[data-hide-activity]').forEach(b => {
    b.onclick = () => setActivityCounted(b.dataset.hideActivity, false);
  });
  document.querySelectorAll('[data-show-activity]').forEach(b => {
    b.onclick = () => setActivityCounted(b.dataset.showActivity, true);
  });
}

// Shared by the tile's × and the "set aside" chips, so one path writes the setting.
function setActivityCounted(key, counted) {
  return loadSettings().then(settings => {
    const off = new Set(settings.notWorkouts || []);
    if (counted) off.delete(key); else off.add(key);
    const next = [...off];
    return setSetting('notWorkouts', next).then(() => {
      showToast(counted ? 'Counted again' : 'Set aside — percentages redone', 'success');
      refreshView();
    });
  });
}

registerView({ id: 'insights', label: 'Insights', icon: '📊', render: renderInsights });
