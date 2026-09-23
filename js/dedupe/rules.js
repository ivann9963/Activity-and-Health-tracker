// === DEDUPE RULES ===
// The shared vocabulary of the two dedupe strategies: how sources are ranked, how two
// sessions are judged to be the same event, and how a user override pins a decision.

// Rank a source by its label. Unknown sources sit below every configured one but above
// nothing, so a newly-appearing device never silently outranks an established one.
function sourceRank(settings, label) {
  const table = (settings && settings.sourcePriority) || DEFAULT_SOURCE_PRIORITY;
  return table[label] != null ? table[label] : 10;
}

// How much of the shorter session the two have in common, 0..1.
function overlapRatio(a, b) {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  const shared = end - start;
  if (shared <= 0) return 0;
  const shorter = Math.min(a.end - a.start, b.end - b.start);
  return shorter > 0 ? shared / shorter : 0;
}

// Are these two records the same real-world workout?
//
// Overlap alone is not enough. A two-hour "walk" logged by the phone can wholly
// contain a twenty-minute run logged by the watch, giving an overlap ratio of 1.0 —
// but they are two different things and merging them would erase the run. Requiring
// the start times to be close as well is what separates "the same event seen twice"
// from "one event inside another".
function sessionsOverlap(a, b, settings) {
  const cfg = (settings && settings.dedupe) || DEFAULT_SETTINGS.dedupe;
  if (!activitiesCompatible(a.activity, b.activity)) return false;
  if (Math.abs(a.start - b.start) > cfg.maxStartDriftSec * 1000) return false;
  return overlapRatio(a, b) >= cfg.minOverlapRatio;
}

// How much a record actually carries. Used to break ties between equally-ranked
// sources: given two copies of the same run, keep the one that knows the distance
// and the heart rate rather than the bare one.
function richness(session) {
  let n = 0;
  if (session.distanceM != null) n += 2;   // the field most often missing, and most wanted
  if (session.energyKcal != null) n += 1;
  if (session.avgHr != null) n += 1;
  if (session.durationSec) n += 1;
  return n;
}

// Pick the winner among candidates for the same event.
//
// A copy that names its sport beats one that does not, before source rank is asked.
// 'other' belongs to no metric, so electing it would take the workout out of every
// tile — and it is exactly what a relay writes when it cannot name what it carries
// (Strava into Apple Health, for one). Heart rate is not lost by this: the winner
// inherits the richest band set in its group whichever copy that came from.
function pickWinner(candidates, settings) {
  return candidates.slice().sort((a, b) => {
    const named = (b.activity !== 'other') - (a.activity !== 'other');
    if (named) return named;
    const rank = sourceRank(settings, sourceLabel(b.source)) - sourceRank(settings, sourceLabel(a.source));
    if (rank) return rank;
    const rich = richness(b) - richness(a);
    if (rich) return rich;
    // Last resort: the longer record, then the id, so the result is stable across runs
    // rather than depending on which order IndexedDB happened to return rows in.
    const dur = (b.durationSec || 0) - (a.durationSec || 0);
    if (dur) return dur;
    return a.id < b.id ? -1 : 1;
  })[0];
}

// --- overrides ------------------------------------------------------------------
// A manual decision, keyed by the record's own deterministic id so it survives a
// re-import of the same export. 'keep' forces a record to count; 'suppress' forces it
// out. Anything without an override is decided by the rules above.

function overrideFor(overrides, id) { return overrides && overrides[id]; }

function applyOverride(overrides, rec, computedSupersededBy) {
  const o = overrideFor(overrides, rec.id);
  // A row carrying only a manual label says nothing about duplication.
  if (!o || !o.decision) return computedSupersededBy;
  if (o.decision === 'keep') return null;
  if (o.decision === 'suppress') return o.winner || 'manual';
  return computedSupersededBy;
}

if (typeof module !== 'undefined') {
  module.exports = { sourceRank, overlapRatio, sessionsOverlap, richness, pickWinner };
}
