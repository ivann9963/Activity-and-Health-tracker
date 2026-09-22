// === RE-READING STORED WORKOUTS ===
// A session's activity is decided at import time and stored on the record, so
// improving the mapping does nothing for data already in the app. The alternative
// is asking someone to re-import a gigabyte because a sport's name was added to a
// table, which is not a reasonable thing to ask.
//
// Every record keeps the vendor's own `rawActivity`, so the decision can simply be
// taken again. This changes only the derived field: the raw name, the times, the
// figures and the id are untouched — `sessionId` hashes `rawActivity || activity`,
// so a record that has its raw name keeps the same id and nothing is duplicated.

// The sessions whose mapping would come out differently today, with what changes.
// Pure, so the caller can show the list before writing anything.
function recategorisePlan(sessions) {
  const changes = [];
  for (const s of sessions) {
    // Nothing to re-read: the vendor never said what it was.
    if (!s.rawActivity) continue;
    const vendor = s.source && s.source.vendor;
    if (!vendor) continue;
    const next = canonicalActivity(vendor, s.rawActivity);
    if (next === s.activity) continue;
    changes.push({ session: s, from: s.activity, to: next });
  }
  return changes;
}

// A one-line summary of what a plan would do, grouped by the move being made, so the
// confirmation says "14 sessions: other -> racket" rather than a bare count.
function recategoriseSummary(changes) {
  const moves = {};
  for (const c of changes) {
    const k = `${activityLabelFor(c.from)} → ${activityLabelFor(c.to)}`;
    moves[k] = (moves[k] || 0) + 1;
  }
  return Object.entries(moves)
    .sort((a, b) => b[1] - a[1])
    .map(([move, n]) => `${n} × ${move}`);
}

function activityLabelFor(key) {
  return (ACTIVITIES[key] || {}).label || key;
}

// Apply, then re-run dedupe: changing an activity changes which records are eligible
// to be the same workout, so the grouping has to be taken again or the totals would
// be right about the sport and wrong about the count.
function applyRecategorise(changes) {
  if (!changes.length) return Promise.resolve({ changed: 0 });
  for (const c of changes) c.session.activity = c.to;
  return dbPutMany('sessions', changes.map(c => c.session))
    .then(() => runDedupe())
    .then(() => ({ changed: changes.length }));
}

if (typeof module !== 'undefined') {
  module.exports = { recategorisePlan, recategoriseSummary };
}
