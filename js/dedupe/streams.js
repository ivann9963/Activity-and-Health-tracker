// === CONTINUOUS-STREAM DEDUPLICATION ===
// Steps and the like are NEVER summed across sources. An iPhone in a pocket and a
// watch on a wrist both counted the same walk; adding them would roughly double the
// year. Instead, for each metric on each day, exactly one source is elected and the
// rest are suppressed.
//
// The election is per-day, which is what makes it time-aware. A global "the Apple
// Watch wins" rule would be right for 2024 and catastrophic for 2026, when the watch
// is in a drawer and the Fitbit is on the wrist: every day after the switch would
// elect a source with no data and the step count would fall off a cliff. Because only
// the sources that actually recorded something that day are candidates, retiring a
// device is handled by doing nothing at all.

// How much larger a lower-ranked source has to be before we distrust the ranking.
// A wearable that spent the day on a charger reports a small number, not no number,
// so "the highest-ranked source that day" is not enough on its own. Undercounting is
// the characteristic failure of a device that was not worn; overcounting is rare.
const PARTIAL_WEAR_RATIO = 1.5;

function electDailySources(records, settings, overrides) {
  const groups = new Map(); // "metric|date" -> records
  for (const r of records) {
    const key = r.metric + '|' + r.localDate;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const decisions = [];
  for (const [key, members] of groups) {
    if (members.length === 1) {
      const only = members[0];
      decisions.push({ record: only, supersededBy: applyOverride(overrides, only, null),
                       groupId: null, reason: null });
      continue;
    }

    const metric = METRICS[members[0].metric] || {};
    const ranked = members.slice().sort((a, b) =>
      sourceRank(settings, sourceLabel(b.source)) - sourceRank(settings, sourceLabel(a.source)) ||
      (a.id < b.id ? -1 : 1));

    let winner = ranked[0];
    let reason = `${sourceLabel(winner.source)} is the highest-ranked source with data that day`;

    // The partial-wear guard applies only to accumulating metrics. For a trend metric
    // a bigger number is not a better one — a higher resting heart rate is not more
    // trustworthy, it is just higher — so there the ranking stands unconditionally.
    if (metric.kind === 'total' && metric.dayAgg === 'sum') {
      const largest = ranked.reduce((a, b) => (b.value > a.value ? b : a), ranked[0]);
      if (largest.id !== winner.id && winner.value > 0 &&
          largest.value / winner.value >= PARTIAL_WEAR_RATIO) {
        reason = `${sourceLabel(largest.source)} recorded ` +
                 `${Math.round(largest.value / winner.value * 10) / 10}× more than ` +
                 `${sourceLabel(winner.source)} — the higher-ranked device looks like it ` +
                 `was not worn all day`;
        winner = largest;
      } else if (largest.id !== winner.id && winner.value === 0) {
        reason = `${sourceLabel(winner.source)} recorded nothing that day`;
        winner = largest;
      }
    }

    for (const m of members) {
      const computed = m.id === winner.id ? null : winner.id;
      decisions.push({
        record: m,
        supersededBy: applyOverride(overrides, m, computed),
        groupId: key,
        reason: m.id === winner.id ? reason
              : `${sourceLabel(winner.source)} counted instead for this day`
      });
    }
  }
  return decisions;
}

function applyDailyDecisions(decisions) {
  const changed = [];
  for (const d of decisions) {
    const next = d.supersededBy || null;
    if (d.record.supersededBy === next && d.record.dedupeReason === d.reason) continue;
    d.record.supersededBy = next;
    d.record.dedupeReason = d.reason;
    d.record.dedupeGroup = d.groupId;
    changed.push(d.record);
  }
  return changed;
}

if (typeof module !== 'undefined') {
  module.exports = { electDailySources, applyDailyDecisions, PARTIAL_WEAR_RATIO };
}
