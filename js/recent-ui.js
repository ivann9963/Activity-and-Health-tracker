// === WHAT IS ACTUALLY IN HERE ===
// Every screen in this app aggregates. That is the point of it — but when a total
// looks wrong there is no way to check, and "I ran yesterday and it says I did not"
// has no answer without seeing the rows.
//
// This is the ledger in the literal sense: the last workouts, exactly as stored,
// including the ones dedupe set aside and the ones whose figures are incomplete.
// It is the first place to look when a number is disputed.

const RECENT_LIMIT = 40;

function recentSessionsHtml(sessions, settings) {
  if (!sessions.length) {
    return `<div class="card">
      <h2>Recent workouts</h2>
      <p class="subtle">No workouts stored yet. Import an export above and they
         appear here, exactly as they were read.</p>
    </div>`;
  }

  const excluded = settings.notWorkouts || [];
  const rows = sessions.slice(0, RECENT_LIMIT);

  return `<div class="card">
    <h2>Recent workouts</h2>
    <p class="subtle">The last ${rows.length} as stored, newest first — including
       copies dedupe set aside. If something you did is missing here, it was not in
       the file; if it is here but not in a total, this row says why.</p>
    ${rows.map(s => {
      const label = activityLabel(s.activity, s.rawActivity);
      const aside = !!s.supersededBy;
      const hidden = isExcluded(s, excluded);
      // The facts a person recognises a workout by, and nothing else.
      const facts = [
        s.durationSec ? formatMetric('time_gym', s.durationSec) : null,
        s.distanceM ? formatMetric('distance_run', s.distanceM) : null,
        s.avgHr ? `${Math.round(s.avgHr)} bpm` : null
      ].filter(Boolean);

      // Why a row might not be in the totals. Stated on the row, because that is
      // where the question gets asked.
      const notes = [];
      if (aside) notes.push('duplicate, set aside');
      if (hidden && !aside) notes.push('set aside in Settings');
      if (!s.distanceM && METRICS.distance_run.activity === s.activity) {
        notes.push('no distance recorded');
      }

      return `<div class="recent-row ${aside ? 'is-aside' : ''}">
        <span class="recent-icon">${iconOrText((ACTIVITIES[s.activity] || {}).icon || 'other', 18)}</span>
        <span class="recent-date">${escHtml(s.localDate)}</span>
        <span class="recent-name">${escHtml(label === 'Unlabelled' ? 'Uncategorised' : label)}</span>
        <span class="recent-facts">${escHtml(facts.join(' · ') || 'no figures')}</span>
        <span class="recent-source">${escHtml(sourceLabel(s.source))}</span>
        ${notes.length ? `<span class="recent-note">${escHtml(notes.join(' · '))}</span>` : ''}
      </div>`;
    }).join('')}
  </div>`;
}

// Newest first, across everything stored. The list is short, so this reads the whole
// store rather than inventing an index for a view used once in a while.
function loadRecentSessions() {
  return Promise.all([dbGetAll('sessions'), loadSettings()]).then(([all, settings]) => {
    all.sort((a, b) => (b.start || 0) - (a.start || 0));
    return { sessions: all, settings };
  });
}

// --- range check --------------------------------------------------------------------
// "The last couple of weeks are off" is not answerable from a total. This runs the
// same records through the same rules and prints what it finds, so the discrepancy
// becomes something anybody can point at.

// Offered only when there is something to do. A button that reports "0 changed" every
// time teaches people to ignore it.
function recategoriseHtml(changes) {
  if (!changes.length) return '';
  return `<div class="card">
    <h2>Re-read ${plural(changes.length, 'workout')}</h2>
    <p class="subtle">These were filed under a category that no longer matches how the
       app reads their name — usually a sport added to the mapping after they were
       imported. Their times and figures do not change; only which total they count
       towards. No re-import needed.</p>
    <ul class="recat-list">
      ${recategoriseSummary(changes).map(line => `<li>${escHtml(line)}</li>`).join('')}
    </ul>
    <div class="card-actions">
      <button class="btn btn-primary btn-small" id="do-recat">
        ${icon('refresh', 16)} Re-read them</button>
    </div>
  </div>`;
}

function wireRecategorise(changes) {
  const btn = el('do-recat');
  if (!btn) return;
  btn.onclick = () => {
    btn.disabled = true;
    return applyRecategorise(changes)
      .then(r => {
        showToast(`${plural(r.changed, 'workout')} re-read`, 'success');
        refreshView();
      })
      .catch(err => {
        btn.disabled = false;
        showToast('Could not re-read: ' + err.message, 'error');
      });
  };
}

function rangeCheckHtml() {
  const to = todayLocal();
  const from = addDays(to, -13);
  return `<div class="card">
    <h2>Check a date range</h2>
    <p class="subtle">Lists every workout stored between these dates, what each source
       contributed, and any two sessions that overlap in time without having been
       merged — each of those is counted twice, which is right if they were two
       workouts and wrong if one device saw the other's.</p>
    <label class="field">
      <span>From</span>
      <input type="date" id="range-from" class="date-input" value="${from}">
    </label>
    <label class="field">
      <span>To</span>
      <input type="date" id="range-to" class="date-input" value="${to}">
    </label>
    <div class="card-actions">
      <button class="btn btn-primary btn-small" id="run-range">${icon('target', 16)} Run the check</button>
      <button class="btn btn-ghost btn-small" id="copy-range" hidden>Copy as text</button>
    </div>
    <pre id="range-out" class="scroll" hidden></pre>
  </div>`;
}

function wireRangeCheck() {
  const run = el('run-range');
  if (!run) return;
  let lastReport = '';

  run.onclick = () => {
    const from = el('range-from').value;
    const to = el('range-to').value;
    if (!from || !to || from > to) {
      showToast('Pick a start date on or before the end date', 'error');
      return;
    }
    return Promise.all([dbGetAll('sessions'), dbGetAll('daily'), loadSettings()])
      .then(([sessions, daily, settings]) => {
        lastReport = rangeReport(sessions, daily, from, to, settings);
        const out = el('range-out');
        out.textContent = lastReport;
        out.hidden = false;
        el('copy-range').hidden = false;
      });
  };

  const copy = el('copy-range');
  if (copy) copy.onclick = () => navigator.clipboard.writeText(lastReport)
    .then(() => showToast('Report copied', 'success'))
    .catch(() => showToast('Could not copy — check clipboard permissions', 'error'));
}
