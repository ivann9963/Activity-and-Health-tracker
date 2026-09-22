// === DEDUPE ORCHESTRATION ===
// Runs both strategies over everything in the database and writes back only what
// changed. It is a full pass rather than an incremental one because a newly imported
// record can change the outcome for records imported months ago — a Strava archive
// arriving after an Apple export retroactively makes some of those runs duplicates.
//
// It is also idempotent: running it twice in a row changes nothing the second time,
// which is what lets it be re-run freely after a settings change.

function runDedupe() {
  return Promise.all([
    loadSettings(),
    dbGetAll('sessions'),
    dbGetAll('daily'),
    dbGetAll('overrides')
  ]).then(([settings, sessions, daily, overrideRows]) => {
    const overrides = {};
    for (const o of overrideRows) overrides[o.id] = o;

    // A manual label is reapplied before grouping, not after: what a session IS
    // decides what it can be a duplicate of.
    const relabelled = applyActivityOverrides(sessions, overrides);
    const sessionChanges = applySessionDecisions(dedupeSessions(sessions, settings, overrides));
    for (const r of relabelled) if (!sessionChanges.includes(r)) sessionChanges.push(r);
    const dailyChanges = applyDailyDecisions(electDailySources(daily, settings, overrides));

    const summary = {
      sessionsChanged: sessionChanges.length,
      dailyChanged: dailyChanges.length,
      sessionsSuppressed: sessions.filter(s => s.supersededBy).length,
      dailySuppressed: daily.filter(d => d.supersededBy).length,
      sessionGroups: new Set(sessions.filter(s => s.dedupe && s.dedupe.groupId)
                                     .map(s => s.dedupe.groupId)).size,
      manualOverrides: overrideRows.length,
      at: Date.now()
    };

    return Promise.all([
      dbPutMany('sessions', sessionChanges),
      dbPutMany('daily', dailyChanges)
    ]).then(() => setSetting('dedupeSummary', summary)).then(() => summary);
  });
}

// Record a manual decision and re-run. Keyed by the record's deterministic id, so the
// choice survives deleting and re-importing the same export.
function setOverride(recordId, decision, winnerId) {
  return dbPut('overrides', { id: recordId, decision, winner: winnerId || null, at: Date.now() })
    .then(runDedupe);
}

function clearOverride(recordId) {
  return dbDelete('overrides', recordId).then(runDedupe);
}

// Pin a whole group at once: one record counts and the rest do not, or (with a null
// choice) every record counts. Written as a batch so the engine runs once rather than
// once per record, which matters when a group has half a dozen members.
function overrideGroup(recordIds, chosenId) {
  const writes = recordIds.map(id => dbPut('overrides', {
    id,
    decision: (chosenId == null || id === chosenId) ? 'keep' : 'suppress',
    winner: chosenId && id !== chosenId ? chosenId : null,
    at: Date.now()
  }));
  return Promise.all(writes).then(runDedupe);
}

// Drop the manual decisions for a group and let the rules decide again.
function resetGroup(recordIds) {
  return Promise.all(recordIds.map(id => dbDelete('overrides', id))).then(runDedupe);
}
