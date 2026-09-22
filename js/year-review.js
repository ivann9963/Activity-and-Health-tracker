// === YEAR IN REVIEW ===
// The annual payoff: everything you did in a year, with the numbers made tangible.
//
// The tone is deliberately factual. No confetti, no "amazing work!" — the scale is
// the point, and a total that took twelve months to accumulate does not need help
// from an exclamation mark. Where a number is hard to picture, a real-world
// comparison stands next to it and lets it land on its own.

let _reviewYear = null;

function renderYearReview(host) {
  return Promise.all([loadSettings(), dataBounds()]).then(([settings, bounds]) => {
    if (!bounds.from) {
      host.innerHTML = emptyReviewHtml();
      return;
    }

    const firstYear = Number(bounds.from.slice(0, 4));
    const lastYear = Number((bounds.to || todayLocal()).slice(0, 4));
    const year = _reviewYear || lastYear;
    const shown = visibleMetricIds(settings);

    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const prevFrom = `${year - 1}-01-01`;
    const prevTo = `${year - 1}-12-31`;

    return Promise.all([
      rollupAllMetrics(from, to, shown),
      rollupAllMetrics(prevFrom, prevTo, shown),
      dbRange('sessions', 'byDate', from, to)
    ]).then(([current, previous, sessions]) => {
      const counted = sessions.filter(s => !s.supersededBy);
      host.innerHTML = reviewHtml(year, firstYear, lastYear, current, previous,
                                  counted, shown, settings);
      drawReviewCharts(current, shown, year, settings);
      wireReview(firstYear, lastYear);
    });
  });
}

function emptyReviewHtml() {
  return `<div class="view-head"><h1>Year in review</h1></div>
    <div class="card empty-state">
      <div class="empty-icon" aria-hidden="true">📅</div>
      <h2>Nothing to review yet</h2>
      <p>Import a year of history and this becomes the page worth coming back to
         every December.</p>
      <button class="btn btn-primary" onclick="navigate('data')">Add your data</button>
    </div>`;
}

function reviewHtml(year, firstYear, lastYear, current, previous, sessions, shown, settings) {
  // The hero is active days — the one figure that spans every metric, and the
  // question a year review is really asking: how often did you show up.
  //
  // "Active" means something deliberate, which is why this uses the session-based
  // definition rather than counting any day with steps on it: a day at a desk still
  // records a walk to the kitchen. Where there are no sessions at all — someone who
  // has only ever imported step counts — it falls back rather than reporting zero.
  const days = activeDays(sessions, `${year}-01-01`, `${year}-12-31`, settings.notWorkouts);
  let activeCount = days.active;
  let activeQualifier = days.ambientOnly
    ? `${plural(days.ambientOnly, 'further day')} saw only activities you do not count.` : '';

  if (!activeCount) {
    const fallback = new Set();
    for (const id of shown) {
      if (METRICS[id].kind !== 'total') continue;
      const threshold = activeThreshold(id);
      for (const [day, value] of Object.entries(current[id] ? current[id].byDay : {})) {
        if (value != null && value > threshold) fallback.add(day);
      }
    }
    activeCount = fallback.size;
    activeQualifier = activeCount ? 'Counted from daily figures — no workouts were recorded.' : '';
  }

  const daysInYear = days.total;
  const movingSec = sessions.reduce((n, s) => n + (s.durationSec || 0), 0);
  const share = timeByActivity(sessions, { exclude: settings.notWorkouts || [] });
  // The shares are percentages of the walking-excluded total, so that is what they
  // have to be quoted against — movingSec includes walking and would make the
  // percentages describe a figure they were not computed from.
  const shareTotal = share.reduce((n, a) => n + a.seconds, 0);

  return `
    <div class="year-nav">
      <button class="icon-btn" id="year-prev" aria-label="Previous year"
              ${year <= firstYear ? 'disabled' : ''}>‹</button>
      <h1 class="year-title">${year}</h1>
      <button class="icon-btn" id="year-next" aria-label="Next year"
              ${year >= lastYear ? 'disabled' : ''}>›</button>
    </div>

    <div class="card hero-card">
      <div class="hero-figure">${humanCount(activeCount)}</div>
      <div class="hero-label">active days out of ${daysInYear}</div>
      <p class="subtle">${escHtml(consistencySentence(activeCount, daysInYear))}
        ${sessions.length ? ` ${plural(sessions.length, 'workout')}, ` +
          `${escHtml(formatMetric('time_gym', movingSec))} moving.` : ''}
        ${escHtml(activeQualifier)}</p>
    </div>

    ${share.length ? `<div class="card">
      <h2>Where the time went</h2>
      <p class="headline">Most of it went on ${share[0].icon}
        <strong>${escHtml(share[0].label)}</strong> — ${Math.round(share[0].pct)}% of
        ${escHtml(formatMetric('time_gym', shareTotal))}.</p>
      ${share.map(a => `
        <div class="share-row">
          <span class="share-label">${a.icon} ${escHtml(a.label)}</span>
          <span class="share-value">${escHtml(formatMetric('time_gym', a.seconds))}
            <span class="share-pct">${Math.round(a.pct)}%</span></span>
          <div class="share-track"><div class="share-fill"
            style="width:${a.pct.toFixed(1)}%"></div></div>
        </div>`).join('')}
      <p class="subtle">Activities set aside in Settings are left out.</p>
    </div>` : ''}

    ${shown.filter(id => METRICS[id].kind === 'total')
           .map(id => totalCardHtml(id, current[id], previous[id], year))
           .join('')}

    <div class="card">
      <h2>Every day of ${year}</h2>
      <p class="subtle">Each square is a day. Darker means more — the scale is based on
         your own typical day, not an absolute.</p>
      <div class="field" style="border:none;padding-top:4px">
        <span>Showing</span>
        <select id="heat-metric">
          ${shown.filter(id => METRICS[id].kind === 'total').map(id =>
            `<option value="${id}">${METRICS[id].icon} ${escHtml(METRICS[id].label)}</option>`).join('')}
        </select>
      </div>
      <div class="chart-wrap" id="heatmap-host"></div>
      <div id="heatmap-legend"></div>
    </div>

    ${trendCardHtml(shown, current, previous, year)}`;
}

// A plain reading of how often they turned up. No praise — the ratio speaks.
function consistencySentence(activeDays, totalDays) {
  const pct = Math.round((activeDays / totalDays) * 100);
  if (pct >= 80) return `That is ${pct}% of the year — most days.`;
  if (pct >= 50) return `That is ${pct}% of the year — more days than not.`;
  if (pct >= 25) return `That is ${pct}% of the year, roughly two days in every week.`;
  return `That is ${pct}% of the year.`;
}

function totalCardHtml(metricId, current, previous, year) {
  const value = current && current.value;
  if (!value) return '';
  const metric = METRICS[metricId];
  const equivalence = equivalenceFor(metricId, value);
  const prev = previous && previous.value;
  const best = bestPeriod(current.byDay, 'month');
  const bestSingle = bestDay(current.byDay);

  return `<div class="card total-card">
    <div class="metric-head">
      <span class="metric-icon" aria-hidden="true">${metric.icon}</span>
      <span class="metric-name">${escHtml(metric.label)}</span>
    </div>
    <div class="total-value">${escHtml(formatMetric(metricId, value))}</div>
    ${equivalence ? `<p class="equivalence">${escHtml(equivalence)}</p>` : ''}
    <div class="chart-wrap"><div class="months" data-metric="${metricId}"></div></div>
    <div class="total-facts">
      ${prev ? `<div><span class="fact-label">vs ${year - 1}</span>
        <span class="fact-value">${escHtml(deltaText(metricId, value, prev))}</span></div>` : ''}
      ${best ? `<div><span class="fact-label">Best month</span>
        <span class="fact-value">${escHtml(monthName(best.key))} ·
        ${escHtml(formatMetric(metricId, best.value))}</span></div>` : ''}
      ${bestSingle ? `<div><span class="fact-label">Best day</span>
        <span class="fact-value">${escHtml(bestSingle.date)} ·
        ${escHtml(formatMetric(metricId, bestSingle.value))}</span></div>` : ''}
      <div><span class="fact-label">Active days</span>
        <span class="fact-value">${current.activeDays}</span></div>
    </div>
  </div>`;
}

function deltaText(metricId, value, prev) {
  const diff = value - prev;
  const pct = Math.round((diff / prev) * 100);
  const sign = diff >= 0 ? '+' : '−';
  return `${sign}${formatMetric(metricId, Math.abs(diff))} (${diff >= 0 ? '+' : '−'}${Math.abs(pct)}%)`;
}

function monthName(key) {
  return new Date(dateKeyToMs(key + '-01'))
    .toLocaleDateString(undefined, { month: 'long', timeZone: 'UTC' });
}

// Trend metrics get their own card: there is no "total weight for 2026", so these
// report where the year started and ended instead.
function trendCardHtml(shown, current, previous, year) {
  const trends = shown.filter(id => METRICS[id].kind === 'trend' && current[id] && current[id].value != null);
  if (!trends.length) return '';
  return `<div class="card">
    <h2>Where things ended up</h2>
    <p class="subtle">These are averages and trends rather than totals — there is no
       such thing as a yearly total weight.</p>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Measure</th><th class="num">${year} average</th>
        <th class="num">Started</th><th class="num">Ended</th></tr></thead>
      <tbody>${trends.map(id => {
        const days = Object.keys(current[id].byDay).sort();
        const first = days.length ? current[id].byDay[days[0]] : null;
        const last = days.length ? current[id].byDay[days[days.length - 1]] : null;
        return `<tr>
          <td>${METRICS[id].icon} ${escHtml(METRICS[id].label)}</td>
          <td class="num">${escHtml(formatMetric(id, current[id].value))}</td>
          <td class="num">${escHtml(formatMetric(id, first))}</td>
          <td class="num">${escHtml(formatMetric(id, last))}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
  </div>`;
}

// Charts are built as real SVG nodes rather than markup strings, so the tooltips and
// hit targets come along with them.
function drawReviewCharts(current, shown, year, settings) {
  document.querySelectorAll('.months').forEach(host => {
    const id = host.dataset.metric;
    const byDay = current[id] ? current[id].byDay : {};
    const months = Array.from({ length: 12 }, (_, i) => {
      const key = `${year}-${String(i + 1).padStart(2, '0')}`;
      let total = 0;
      for (const [day, value] of Object.entries(byDay)) {
        if (day.startsWith(key) && value != null) total += value;
      }
      return {
        label: new Date(Date.UTC(year, i, 1))
          .toLocaleDateString(undefined, { month: 'narrow', timeZone: 'UTC' }),
        value: total,
        title: `${monthName(key)}: ${total ? formatMetric(id, total) : 'nothing recorded'}`
      };
    });
    host.innerHTML = '';
    host.appendChild(columnChart(months, {
      width: 640, height: 150,
      format: (v, isTick) => isTick ? formatMetricAxis(id, v) : formatMetric(id, v),
      ariaLabel: `${METRICS[id].label} by month in ${year}`
    }));
  });

  drawHeatmap(current, shown, year, settings);
}

function drawHeatmap(current, shown, year, settings) {
  const select = el('heat-metric');
  const host = el('heatmap-host');
  const legend = el('heatmap-legend');
  if (!select || !host) return;

  const paint = () => {
    const id = select.value;
    host.innerHTML = '';
    host.appendChild(calendarHeatmap(current[id] ? current[id].byDay : {}, year, {
      firstDayOfWeek: settings.firstDayOfWeek,
      format: v => formatMetric(id, v),
      ariaLabel: `${METRICS[id].label} for every day of ${year}`
    }));
    if (legend) { legend.innerHTML = ''; legend.appendChild(heatmapLegend()); }
  };
  select.onchange = paint;
  paint();
}

function wireReview(firstYear, lastYear) {
  const prev = el('year-prev');
  const next = el('year-next');
  const shown = _reviewYear || lastYear;
  if (prev) prev.onclick = () => { _reviewYear = shown - 1; refreshView(); };
  if (next) next.onclick = () => { _reviewYear = shown + 1; refreshView(); };
}

registerView({ id: 'year', label: 'Year', icon: '🏆', render: renderYearReview });
