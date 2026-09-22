// === SESSION DEDUPLICATION ===
// One run can be recorded three times: by the watch that measured it, by Strava which
// the watch pushed it to, and by Google Health relaying it back into Apple Health.
// They arrive as three separate records with slightly different start times and
// distances. This groups them and elects one to count.
//
// Nothing is deleted. Losers get `supersededBy` pointing at the winner, so the
// Duplicates screen can show exactly what was set aside and the decision can be
// reversed without re-importing anything.

function dedupeSessions(sessions, settings, overrides) {
  // Sorting by start turns the grouping into a forward sweep: a session can only
  // join a group whose members started within maxStartDrift of it, so once we are
  // past that window the earlier groups are closed.
  const sorted = sessions.slice().sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
  const groups = [];
  let open = [];

  const driftMs = ((settings && settings.dedupe) || DEFAULT_SETTINGS.dedupe).maxStartDriftSec * 1000;

  for (const s of sorted) {
    // Retire groups that can no longer match anything further along.
    open = open.filter(g => s.start - g.lastStart <= driftMs);
    const hit = open.find(g => g.members.some(m => sessionsOverlap(m, s, settings)));
    if (hit) {
      hit.members.push(s);
      hit.lastStart = s.start;
    } else {
      const g = { id: 'g' + s.id, members: [s], lastStart: s.start };
      groups.push(g);
      open.push(g);
    }
  }

  const decisions = [];
  for (const g of groups) {
    if (g.members.length === 1) {
      const only = g.members[0];
      decisions.push({ record: only, supersededBy: applyOverride(overrides, only, null),
                       groupId: null, reason: null });
      continue;
    }
    const winner = pickWinner(g.members, settings);
    // Heart-rate bands hang off whichever copy the importer credited, which is not
    // necessarily the copy that wins here — so the winner inherits the fullest set in
    // the group, or a duplicated workout's effort disappears with the losing record.
    // The richest set, never the sum: these are two recordings of one hour, not two.
    const bands = richestBands(g.members);
    for (const m of g.members) {
      const computed = m.id === winner.id ? null : winner.id;
      decisions.push({
        record: m,
        supersededBy: applyOverride(overrides, m, computed),
        hrBands: m.id === winner.id ? bands : undefined,
        groupId: g.id,
        reason: m.id === winner.id
          ? `kept: ${sourceLabel(m.source)} outranks the ` +
            (g.members.length === 2 ? 'other copy' : `${g.members.length - 1} other copies`)
          : `same workout as the ${sourceLabel(winner.source)} record`
      });
    }
  }
  return decisions;
}

function bandSeconds(bands) {
  if (!bands) return 0;
  let n = 0;
  for (const k of Object.keys(bands)) n += bands[k] || 0;
  return n;
}

// The member carrying the most banded time. Ties go to nothing in particular, since
// equal totals over the same hour say the same thing.
function richestBands(members) {
  let best = null;
  for (const m of members) {
    if (bandSeconds(m.hrBands) > bandSeconds(best)) best = m.hrBands;
  }
  return best;
}

// Apply decisions onto the records themselves, returning only those that changed so
// the caller can write back a minimal set.
function applySessionDecisions(decisions) {
  const changed = [];
  for (const d of decisions) {
    const next = d.supersededBy || null;
    const nextDedupe = d.groupId ? { groupId: d.groupId, reason: d.reason } : null;
    const nextBands = d.hrBands === undefined ? d.record.hrBands : (d.hrBands || null);
    if (d.record.supersededBy === next &&
        JSON.stringify(d.record.dedupe) === JSON.stringify(nextDedupe) &&
        JSON.stringify(d.record.hrBands) === JSON.stringify(nextBands)) continue;
    d.record.supersededBy = next;
    d.record.dedupe = nextDedupe;
    d.record.hrBands = nextBands;
    changed.push(d.record);
  }
  return changed;
}

if (typeof module !== 'undefined') {
  module.exports = { dedupeSessions, applySessionDecisions };
}
