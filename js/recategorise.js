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
function recategorisePlan(sessions, overrides) {
  const changes = [];
  const named = overrides || {};
  for (const s of sessions) {
    // A person's own answer outranks any mapping, now and after any future change to
    // it. Their answers live in `overrides`, so that is where this has to look.
    if (named[s.id] && named[s.id].activity) continue;
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

// --- labelling by hand ---------------------------------------------------------------
// Strava writes a sport Apple has no type for as HKWorkoutActivityTypeOther, and then
// there is genuinely nothing in the file to read: padel arrives as "Other" and no
// amount of parsing will recover the word. The app cannot know. The person can.
//
// `manualActivity` marks the answer as theirs, which is what protects it from the
// re-reading pass above and from any future mapping change.

// Reapply stored labels onto session records. Called by the dedupe pass, which runs
// after every import — so a re-import loses nothing. Returns the records it changed
// so the caller can write back a minimal set.
function applyActivityOverrides(sessions, overrides) {
  const changed = [];
  for (const s of sessions) {
    const o = overrides[s.id];
    if (!o || !o.activity || o.activity === s.activity) continue;
    s.activity = o.activity;
    changed.push(s);
  }
  return changed;
}

// Sessions the app could not name. These are the ones worth asking about — there is
// no point offering to relabel a run the vendor already called a run.
function unnamedSessions(sessions) {
  return sessions.filter(s => !s.supersededBy &&
                         activityLabel(s.activity, s.rawActivity) === 'Unlabelled');
}

// Stored in `overrides` against the session's deterministic id, the same place and
// for the same reason as a manual dedupe decision: re-importing the export rewrites
// every session record, so an answer written onto the record itself would be erased
// by the next import of the very file it describes. runDedupe reapplies it.
function setManualActivity(sessionId, activity) {
  return dbPut('overrides', { id: sessionId, activity, at: Date.now() })
    .then(runDedupe);
}

function clearManualActivity(sessionId) {
  return dbGet('overrides', sessionId).then(o => {
    if (!o) return null;
    // A row may also carry a dedupe decision; drop only the label.
    if (o.decision) { delete o.activity; return dbPut('overrides', o); }
    return dbDelete('overrides', sessionId);
  }).then(runDedupe);
}

if (typeof module !== 'undefined') {
  module.exports = { recategorisePlan, recategoriseSummary, unnamedSessions,
                     applyActivityOverrides };
}
