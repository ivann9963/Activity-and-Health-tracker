// === THE DUPLICATES SCREEN ===
// Every reconciliation decision, visible and reversible. The engine is deliberately
// opinionated so the totals are right the moment an import finishes — but an
// opinionated engine you cannot audit is just a black box that might be lying, so
// this screen shows what was set aside, why, and lets any of it be overruled.

const REVIEW_PAGE = 40;
let _reviewTab = 'sessions';
let _reviewShown = REVIEW_PAGE;

function renderReview(host) {
  return Promise.all([dbGetAll('sessions'), dbGetAll('daily'), dbGetAll('overrides'), loadSettings()])
    .then(([sessions, daily, overrideRows, settings]) => {
      const overrides = {};
      for (const o of overrideRows) overrides[o.id] = o;

      const sessionGroups = groupBy(sessions.filter(s => s.dedupe && s.dedupe.groupId),
                                    s => s.dedupe.groupId);
      // Only days where something was actually set aside are worth showing; a day with
      // a single source has nothing to review.
      const dailyGroups = groupBy(daily.filter(d => d.dedupeGroup), d => d.dedupeGroup)
        .filter(g => g.items.length > 1);

      const suppressedSessions = sessions.filter(s => s.supersededBy).length;
      const suppressedDaily = daily.filter(d => d.supersededBy).length;

      if (!sessionGroups.length && !dailyGroups.length) {
        host.innerHTML = `
          <button class="btn-link back-link" onclick="navigate('data')">‹ Data</button>
          <div class="view-head"><h1>Duplicates</h1></div>
          <div class="card empty-state">
            <div class="empty-icon">${icon('check', 40)}</div>
            <h2>Nothing overlapping</h2>
            <p>No two sources have recorded the same workout or the same day.
               Once you import a second source there will be decisions here to review.</p>
          </div>`;
        return;
      }

      host.innerHTML = `
        <button class="btn-link back-link" onclick="navigate('data')">‹ Data</button>
        <div class="view-head">
          <h1>Duplicates</h1>
          <p class="subtle">${plural(suppressedSessions, 'workout')} and
             ${plural(suppressedDaily, 'daily figure')} are being set aside so they are
             not counted twice. Nothing has been deleted.</p>
        </div>

        <div class="segmented" role="tablist">
          <button role="tab" class="${_reviewTab === 'sessions' ? 'active' : ''}"
                  data-tab="sessions">Workouts (${sessionGroups.length})</button>
          <button role="tab" class="${_reviewTab === 'daily' ? 'active' : ''}"
                  data-tab="daily">Daily figures (${dailyGroups.length})</button>
        </div>

        <div id="review-list">${
          _reviewTab === 'sessions'
            ? sessionGroupsHtml(sessionGroups, overrides)
            : dailyGroupsHtml(dailyGroups, overrides)
        }</div>`;

      host.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
        _reviewTab = b.dataset.tab; _reviewShown = REVIEW_PAGE; refreshView();
      });
      wireReviewActions();
    });
}

// The surviving record leads: it is the answer to "what is being counted?", and
// burying it under the discarded ones makes the screen read backwards.
function countedFirst(items) {
  return items.slice().sort((a, b) => (a.supersededBy ? 1 : 0) - (b.supersededBy ? 1 : 0));
}

function groupBy(items, keyOf) {
  const map = new Map();
  for (const it of items) {
    const k = keyOf(it);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(it);
  }
  return [...map.entries()].map(([key, items]) => ({ key, items }));
}

function sessionGroupsHtml(groups, overrides) {
  const shown = groups.slice(0, _reviewShown);
  return shown.map(g => {
    const ids = g.items.map(i => i.id);
    const manual = ids.some(id => overrides[id]);
    return `<div class="card dup-group">
      <div class="dup-head">
        <strong>${escHtml(ACTIVITIES[g.items[0].activity].label)}</strong>
        <span class="subtle">${escHtml(g.items[0].localDate)}</span>
        ${manual ? '<span class="pill">your choice</span>' : ''}
      </div>
      ${countedFirst(g.items).map(s => sessionRowHtml(s, ids)).join('')}
      <div class="card-actions">
        <button class="btn btn-ghost btn-small" data-keep-all="${escHtml(ids.join(','))}">
          Count all of them</button>
        ${manual ? `<button class="btn btn-ghost btn-small"
          data-reset="${escHtml(ids.join(','))}">Use the automatic choice</button>` : ''}
      </div>
    </div>`;
  }).join('') + moreButton(groups.length);
}

function sessionRowHtml(s, ids) {
  const counted = !s.supersededBy;
  const bits = [];
  if (s.distanceM != null) bits.push(formatMetric('distance_run', s.distanceM));
  if (s.durationSec) bits.push(formatMetric('time_gym', s.durationSec));
  if (s.avgHr) bits.push(s.avgHr + ' bpm');
  if (s.energyKcal) bits.push(Math.round(s.energyKcal) + ' kcal');
  return `<div class="dup-row ${counted ? 'counted' : 'set-aside'}">
    <div class="dup-mark">${counted ? icon('check', 16) : icon('close', 16)}</div>
    <div class="dup-body">
      <div class="dup-source">${escHtml(sourceLabel(s.source))}
        <span class="subtle">${escHtml(new Date(s.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</span>
      </div>
      <div class="subtle">${escHtml(bits.join(' · ') || 'no details recorded')}</div>
      ${s.dedupe && s.dedupe.reason ? `<div class="dup-reason">${escHtml(s.dedupe.reason)}</div>` : ''}
    </div>
    ${counted ? '' : `<button class="btn btn-ghost btn-small"
      data-choose="${escHtml(s.id)}" data-group="${escHtml(ids.join(','))}">Count this</button>`}
  </div>`;
}

function dailyGroupsHtml(groups, overrides) {
  // Biggest disagreements first: a day where two sources differ by 4,000 steps is
  // worth a look, a day where they differ by 12 is not.
  const scored = groups.map(g => {
    const values = g.items.map(i => i.value);
    return { ...g, spread: Math.max(...values) - Math.min(...values) };
  }).sort((a, b) => b.spread - a.spread);

  const shown = scored.slice(0, _reviewShown);
  return shown.map(g => {
    const metricId = g.items[0].metric;
    const ids = g.items.map(i => i.id);
    const manual = ids.some(id => overrides[id]);
    return `<div class="card dup-group">
      <div class="dup-head">
        <strong>${escHtml(METRICS[metricId] ? METRICS[metricId].label : metricId)}</strong>
        <span class="subtle">${escHtml(g.items[0].localDate)}</span>
        ${manual ? '<span class="pill">your choice</span>' : ''}
      </div>
      ${countedFirst(g.items).map(d => {
        const counted = !d.supersededBy;
        return `<div class="dup-row ${counted ? 'counted' : 'set-aside'}">
          <div class="dup-mark">${counted ? icon('check', 16) : icon('close', 16)}</div>
          <div class="dup-body">
            <div class="dup-source">${escHtml(sourceLabel(d.source))}
              <strong class="dup-value">${escHtml(formatMetric(metricId, d.value))}</strong></div>
            ${d.dedupeReason ? `<div class="dup-reason">${escHtml(d.dedupeReason)}</div>` : ''}
          </div>
          ${counted ? '' : `<button class="btn btn-ghost btn-small"
            data-choose="${escHtml(d.id)}" data-group="${escHtml(ids.join(','))}">Count this</button>`}
        </div>`;
      }).join('')}
      ${manual ? `<div class="card-actions"><button class="btn btn-ghost btn-small"
        data-reset="${escHtml(ids.join(','))}">Use the automatic choice</button></div>` : ''}
    </div>`;
  }).join('') + moreButton(groups.length);
}

function moreButton(total) {
  if (total <= _reviewShown) return '';
  return `<div class="card-actions center">
    <button class="btn btn-ghost" id="review-more">
      Show more (${humanCount(total - _reviewShown)} left)</button></div>`;
}

function wireReviewActions() {
  const after = msg => { showToast(msg, 'success'); refreshView(); };

  document.querySelectorAll('[data-choose]').forEach(b => b.onclick = () =>
    overrideGroup(b.dataset.group.split(','), b.dataset.choose)
      .then(() => after('Counting that one instead')));

  document.querySelectorAll('[data-keep-all]').forEach(b => b.onclick = () =>
    overrideGroup(b.dataset.keepAll.split(','), null)
      .then(() => after('All of them now count')));

  document.querySelectorAll('[data-reset]').forEach(b => b.onclick = () =>
    resetGroup(b.dataset.reset.split(','))
      .then(() => after('Back to the automatic choice')));

  const more = el('review-more');
  if (more) more.onclick = () => { _reviewShown += REVIEW_PAGE; refreshView(); };
}

// Reconciliation is plumbing, not a headline feature — it earns a permanent tab about
// as much as a database migration would. It lives one tap deep, reached from the Data
// screen, which is where questions about data quality actually arise.
registerView({ id: 'duplicates', label: 'Duplicates', icon: 'refresh',
               inNav: false, render: renderReview });
