// === RANGE DIAGNOSTIC ===
// Every other screen aggregates, and an aggregate cannot explain itself. When someone
// says "the last two weeks are off", the only useful reply is a listing of what the
// app actually holds for those two weeks and why each row was or was not counted.
//
// This produces that as plain text, to be read or pasted somewhere. It computes
// nothing new — it reports the same records and the same rules every other screen
// uses, which is the point: if a total is wrong, the wrongness is visible here.

// Two sessions that overlap in time but were NOT merged. Each one is a candidate for
// a double count, and the reason names which rule kept them apart — so the answer is
// "the rule is too strict here" or "they really are two things", rather than a shrug.
//
// Reported, never acted upon. Merging on suspicion is how a real second workout gets
// erased, and nothing in this app deletes data on a guess.
function nearMisses(sessions, settings) {
  const cfg = (settings && settings.dedupe) || DEFAULT_SETTINGS.dedupe;
  const counted = sessions.filter(s => !s.supersededBy && s.start && s.end);
  const sorted = counted.slice().sort((a, b) => a.start - b.start);
  const out = [];

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i], b = sorted[j];
      if (b.start >= a.end) break;              // sorted, so nothing later can overlap
      if (overlapRatio(a, b) <= 0) continue;
      // Already judged the same event and kept apart deliberately? Then the pair is
      // not a near miss, it is a decision.
      if (a.dedupe && b.dedupe && a.dedupe.groupId === b.dedupe.groupId) continue;

      let reason;
      if (!activitiesCompatible(a.activity, b.activity)) {
        reason = `activities not treated as compatible (${a.activity} vs ${b.activity})`;
      } else if (Math.abs(a.start - b.start) > cfg.maxStartDriftSec * 1000) {
        reason = `start times differ by ${Math.round(Math.abs(a.start - b.start) / 60000)} min, ` +
                 `over the ${Math.round(cfg.maxStartDriftSec / 60)} min limit`;
      } else if (overlapRatio(a, b) < cfg.minOverlapRatio) {
        reason = `overlap ${Math.round(overlapRatio(a, b) * 100)}% of the shorter session, ` +
                 `under the ${Math.round(cfg.minOverlapRatio * 100)}% threshold`;
      } else {
        reason = 'overlaps and matches the rules — check the Duplicates screen';
      }

      out.push({ a, b, overlap: overlapRatio(a, b), reason,
                 sameSource: sourceLabel(a.source) === sourceLabel(b.source) });
    }
  }
  return out;
}

function hhmm(ms, offsetMin) {
  const d = new Date(ms + (offsetMin || 0) * 60000);
  return String(d.getUTCHours()).padStart(2, '0') + ':' +
         String(d.getUTCMinutes()).padStart(2, '0');
}

function sessionLine(s) {
  const bits = [
    s.localDate,
    hhmm(s.start, s.tzOffset),
    (activityLabel(s.activity, s.rawActivity) || '?').padEnd(14),
    s.durationSec ? formatMetric('time_gym', s.durationSec).padStart(8) : '       -',
    s.distanceM ? formatMetric('distance_run', s.distanceM).padStart(9) : '        -',
    s.avgHr ? (Math.round(s.avgHr) + 'bpm').padStart(6) : '     -',
    sourceLabel(s.source)
  ];
  if (s.supersededBy) bits.push('[SET ASIDE: ' + ((s.dedupe && s.dedupe.reason) || 'duplicate') + ']');
  return bits.join('  ');
}

// The whole report for a range. Plain text on purpose: it has to survive being pasted
// into a message, and a table that only renders in this app helps nobody debug it.
function rangeReport(sessions, daily, fromDate, toDate, settings) {
  const inRange = sessions.filter(s => s.localDate >= fromDate && s.localDate <= toDate);
  const kept = inRange.filter(s => !s.supersededBy);
  const L = [];

  L.push(`ACTIVITY LEDGER — range report`);
  L.push(`${fromDate} .. ${toDate}   (${buildLabel()})`);
  L.push('');
  L.push(`SESSIONS  ${inRange.length} stored, ${kept.length} counted, ` +
         `${inRange.length - kept.length} set aside by dedupe`);

  // What each source contributed, which is the fastest way to spot one device's
  // records arriving twice or not at all.
  const bySource = {};
  for (const s of kept) {
    const k = sourceLabel(s.source);
    bySource[k] = bySource[k] || { n: 0, sec: 0 };
    bySource[k].n++;
    bySource[k].sec += s.durationSec || 0;
  }
  L.push('');
  L.push('BY SOURCE (counted only)');
  for (const [k, v] of Object.entries(bySource).sort((a, b) => b[1].n - a[1].n)) {
    L.push(`  ${k.padEnd(18)} ${String(v.n).padStart(3)} ${v.n === 1 ? 'session ' : 'sessions'}  ` +
           `${formatMetric('time_gym', v.sec)}`);
  }

  const byActivity = {};
  for (const s of kept) {
    const k = activityLabel(s.activity, s.rawActivity);
    byActivity[k] = byActivity[k] || { n: 0, sec: 0, m: 0 };
    byActivity[k].n++;
    byActivity[k].sec += s.durationSec || 0;
    byActivity[k].m += s.distanceM || 0;
  }
  L.push('');
  L.push('BY ACTIVITY (counted only)');
  for (const [k, v] of Object.entries(byActivity).sort((a, b) => b[1].sec - a[1].sec)) {
    L.push(`  ${k.padEnd(18)} ${String(v.n).padStart(3)} ${v.n === 1 ? 'session ' : 'sessions'}  ` +
           `${formatMetric('time_gym', v.sec)}` +
           (v.m ? `  ${formatMetric('distance_run', v.m)}` : ''));
  }

  L.push('');
  L.push('EVERY SESSION  (date time activity duration distance hr source)');
  for (const s of inRange.slice().sort((a, b) => a.start - b.start)) L.push('  ' + sessionLine(s));

  const misses = nearMisses(inRange, settings);
  L.push('');
  L.push(`OVERLAPPING BUT NOT MERGED  ${misses.length}`);
  if (!misses.length) {
    L.push('  none — no two counted sessions in this range share any time');
  } else {
    L.push('  Each pair below is counted twice. That is correct if they really were');
    L.push('  two workouts, and a double count if they are one seen by two devices.');
    for (const m of misses) {
      L.push('');
      L.push('  ' + sessionLine(m.a));
      L.push('  ' + sessionLine(m.b));
      L.push(`    overlap ${Math.round(m.overlap * 100)}% · ` +
             `${m.sameSource ? 'SAME source' : 'different sources'} · ${m.reason}`);
    }
  }

  // Daily figures, which come from a different store and a different rule, so a
  // discrepancy between these and the session totals is itself informative.
  const inRangeDaily = daily.filter(d => !d.supersededBy &&
                                    d.localDate >= fromDate && d.localDate <= toDate);
  const byMetric = {};
  for (const d of inRangeDaily) {
    byMetric[d.metric] = byMetric[d.metric] || { days: 0, sum: 0, sources: new Set() };
    byMetric[d.metric].days++;
    byMetric[d.metric].sum += d.value || 0;
    byMetric[d.metric].sources.add(sourceLabel(d.source));
  }
  L.push('');
  L.push('DAILY FIGURES (counted only)');
  for (const [k, v] of Object.entries(byMetric).sort()) {
    L.push(`  ${k.padEnd(16)} ${String(v.days).padStart(3)} days  ` +
           `total ${Math.round(v.sum)}  from ${[...v.sources].join(', ')}`);
  }

  return L.join('\n');
}

if (typeof module !== 'undefined') {
  module.exports = { nearMisses, rangeReport, sessionLine };
}
