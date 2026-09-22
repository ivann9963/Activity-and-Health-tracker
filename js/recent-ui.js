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
