// === DASHBOARD / PERIOD VIEW ===
// Week, month and year share one screen, because they answer the same question at
// three zoom levels: how much did I do, and is that more or less than last time.
// Every number here comes through the rollups, so nothing a duplicate contributed is
// ever counted.

let _period = 'week';
let _anchor = null; // a date inside the period being shown; null means "today"

function renderDashboard(host) {
  return Promise.all([loadSettings(), dbCount('sessions'), dbCount('daily'), dataBounds()])
    .then(([settings, sessionCount, dailyCount, bounds]) => {
      if (!sessionCount && !dailyCount) return renderEmptyState(host);

      const firstDay = settings.firstDayOfWeek;
      // Importing an archive and landing on an empty "this week" is a poor first
      // impression, and looks like the import failed. If the data ends before the
      // current period starts, open on the last period that actually has something.
      if (_anchor == null && bounds.to) {
        const thisPeriod = periodBounds(todayLocal(), _period, firstDay);
        if (bounds.to < thisPeriod.from) _anchor = bounds.to;
      }
      const anchor = _anchor || todayLocal();
      const now = periodBounds(anchor, _period, firstDay);
      const prevAnchor = shiftPeriod(anchor, _period, -1, firstDay);
      const prev = periodBounds(prevAnchor, _period, firstDay);

      const shown = visibleMetricIds(settings);

      return Promise.all([
        rollupAllMetrics(now.from, now.to, shown),
        rollupAllMetrics(prev.from, prev.to, shown),
        bounds.from ? rollupAllMetrics(bounds.from, bounds.to || todayLocal(), shown) : null,
        loadGoals()
      ]).then(([current, previous, allTime, goals]) => {
        host.innerHTML = `
          <div class="segmented" role="tablist">
            ${['week', 'month', 'year'].map(p => `
              <button role="tab" class="${p === _period ? 'active' : ''}" data-period="${p}">
                ${p[0].toUpperCase() + p.slice(1)}</button>`).join('')}
          </div>

          <div class="period-nav">
            <button class="icon-btn" id="prev-period" aria-label="Previous ${_period}">‹</button>
            <h1 class="period-label">${escHtml(periodLabel(now, _period, firstDay))}</h1>
            <button class="icon-btn" id="next-period" aria-label="Next ${_period}"
                    ${isCurrentPeriod(now, firstDay) ? 'disabled' : ''}>›</button>
          </div>

          <div class="metric-grid">
            ${shown.map(id => metricTileHtml(id, current[id], previous[id], now, goals, settings)).join('')}
          </div>

          <div class="customise-row">
            <button class="btn-link" onclick="navigate('settings')">Goals and tiles</button>
          </div>

          ${allTime ? allTimeHtml(allTime, bounds, shown) : ''}`;

        host.querySelectorAll('[data-period]').forEach(b => b.onclick = () => {
          _period = b.dataset.period; _anchor = null; refreshView();
        });
        el('prev-period').onclick = () => {
          _anchor = shiftPeriod(_anchor || todayLocal(), _period, -1, firstDay);
          refreshView();
        };
        el('next-period').onclick = () => {
          _anchor = shiftPeriod(_anchor || todayLocal(), _period, 1, firstDay);
          refreshView();
        };
      });
    });
}

function isCurrentPeriod(bounds, firstDay) {
  const today = todayLocal();
  return today >= bounds.from && today <= bounds.to;
}

function periodLabel(bounds, period, firstDay) {
  if (isCurrentPeriod(bounds, firstDay)) {
    return period === 'week' ? 'This week' : period === 'month' ? 'This month' : 'This year';
  }
  const d = new Date(dateKeyToMs(bounds.from));
  if (period === 'year') return String(d.getUTCFullYear());
  if (period === 'month') {
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  const end = new Date(dateKeyToMs(bounds.to));
  const opts = { day: 'numeric', month: 'short', timeZone: 'UTC' };
  return `${d.toLocaleDateString(undefined, opts)} – ${end.toLocaleDateString(undefined, opts)}`;
}

function metricTileHtml(id, current, previous, bounds, goals, settings) {
  const metric = METRICS[id];
  const value = current && current.value;
  const prevValue = previous && previous.value;
  const empty = value == null || value === 0;
  const goal = goals && goals[goalId(id, _period)];

  return `<a class="metric-tile ${empty ? 'is-empty' : ''}" href="#/metric/${id}">
    <div class="metric-head">
      <span class="metric-icon" aria-hidden="true">${metric.icon}</span>
      <span class="metric-name">${escHtml(metric.label)}</span>
    </div>
    <div class="metric-value">${escHtml(formatMetric(id, value))}</div>
    ${empty ? '' : deltaHtml(id, value, prevValue) + barsHtml(id, current && current.byDay, bounds)}
    ${goal ? goalMeterHtml(id, goal.target, value, bounds) : ''}
    ${!goal && metric.kind === 'total' && current && current.activeDays
      ? `<div class="metric-sub">${plural(current.activeDays, 'active day')}</div>`
      : ''}
  </a>`;
}

// A meter rather than a second number: the question "am I on track" is about a
// position along a length, and a bar answers it at a glance in a way "62%" does not.
// The unfilled track is a lighter step of the same hue, so the whole bar reads as one
// scale rather than as a fill sitting on unrelated grey.
function goalMeterHtml(id, target, value, bounds) {
  const p = goalProgress(target, value, bounds);
  if (!p) return '';
  // Where the calendar says you should be. Without it the bar shows completion, which
  // in March always looks like failure.
  const paceMark = Math.min(100, p.elapsed * 100);

  return `<div class="meter" role="img"
       aria-label="${escHtml(formatMetric(id, value))} of ${escHtml(formatMetric(id, target))}">
      <div class="meter-fill ${p.hit ? 'hit' : ''}" style="width:${p.pct.toFixed(1)}%"></div>
      ${p.finished ? '' : `<div class="meter-pace" style="left:${paceMark.toFixed(1)}%"></div>`}
    </div>
    <div class="metric-sub">${escHtml(paceText(id, p))}</div>`;
}

function paceText(id, p) {
  if (p.hit) return `Goal met — ${formatMetric(id, p.target)}`;
  if (p.finished) return `${formatMetric(id, p.value)} of ${formatMetric(id, p.target)}`;
  const gap = Math.abs(p.ahead);
  // Below a percent of the target the difference is noise, not a signal.
  if (gap < p.target * 0.01) return `on pace for ${formatMetric(id, p.target)}`;
  return p.ahead > 0
    ? `${formatMetric(id, gap)} ahead of pace`
    : `${formatMetric(id, gap)} behind pace`;
}

function deltaHtml(id, value, prevValue) {
  if (value == null || prevValue == null || prevValue === 0) {
    return '<div class="metric-delta neutral">no comparison yet</div>';
  }
  const pct = ((value - prevValue) / prevValue) * 100;
  if (Math.abs(pct) < 1) return '<div class="metric-delta neutral">about the same</div>';
  // "Better" is not always "more": a lower resting heart rate is an improvement.
  const better = METRICS[id].lowerIsBetter ? pct < 0 : pct > 0;
  const arrow = pct > 0 ? '↑' : '↓';
  return `<div class="metric-delta ${better ? 'up' : 'down'}">
    ${arrow} ${Math.abs(pct).toFixed(0)}% vs last ${_period}</div>`;
}

// A compact bar per day (or per month, for a year — 365 bars on a phone is a smear).
function barsHtml(id, byDay, bounds) {
  if (!byDay) return '';
  const series = _period === 'year' ? monthlySeries(byDay, bounds) : dailySeries(byDay, bounds);
  if (!series.length) return '';
  const max = Math.max(...series.map(s => s.value || 0));
  if (!max) return '';
  return `<div class="bars" aria-hidden="true">${series.map(s => `
    <div class="bar" style="height:${Math.max(2, Math.round((s.value || 0) / max * 100))}%"
         title="${escHtml(s.label)}"></div>`).join('')}</div>`;
}

function dailySeries(byDay, bounds) {
  return dateRange(bounds.from, bounds.to).map(d => ({ label: d, value: byDay[d] || 0 }));
}

function monthlySeries(byDay, bounds) {
  const months = new Map();
  for (const [date, value] of Object.entries(byDay)) {
    const key = date.slice(0, 7);
    months.set(key, (months.get(key) || 0) + value);
  }
  const year = bounds.from.slice(0, 4);
  return Array.from({ length: 12 }, (_, i) => {
    const key = `${year}-${String(i + 1).padStart(2, '0')}`;
    return { label: key, value: months.get(key) || 0 };
  });
}

// The number no other app will show you: everything, since your data begins.
function allTimeHtml(allTime, bounds, shown) {
  const totals = shown
    .filter(id => METRICS[id].kind === 'total')
    .map(id => ({ id, value: allTime[id] && allTime[id].value }))
    .filter(t => t.value);
  if (!totals.length) return '';
  const years = daysBetween(bounds.from, bounds.to || todayLocal()) / 365.25;

  return `<div class="card all-time">
    <h2>All time</h2>
    <p class="subtle">Everything on record, from ${escHtml(bounds.from)} onwards${
      years >= 1 ? ` — ${years.toFixed(1)} years` : ''}.</p>
    <div class="stat-row">
      ${totals.map(t => `<div class="stat-tile">
        <div class="stat-label">${METRICS[t.id].icon} ${escHtml(METRICS[t.id].label)}</div>
        <div class="stat-value">${escHtml(formatMetric(t.id, t.value))}</div>
      </div>`).join('')}
    </div>
  </div>`;
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
