// === CANONICAL RECORDS ===
// Every parser, whatever it read, produces records in exactly these two shapes. The
// dedupe engine, the rollups and the UI know nothing about Apple, Fitbit or Strava.
//
// The important property here is the DETERMINISTIC ID. A record's id is a hash of its
// own content — source, type, instant, value — so importing the same export twice
// produces the same ids, and `put` overwrites rather than duplicates. That is what
// lets the user re-export Apple Health every month and just drop the file in, which
// is the closest thing to "sync" that Apple actually permits.

// 64-bit FNV-1a, carried in two 32-bit halves because JS bitwise ops are 32-bit.
// Not cryptographic — it only needs to avoid collisions across a few hundred thousand
// records, which 64 bits does with room to spare.
function hash64(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (c + i); h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

// Round to the second before hashing. Vendors disagree on sub-second precision for
// what is demonstrably the same event, and a millisecond of drift must not mint a
// second copy of a workout.
function sec(ms) { return Math.round((ms || 0) / 1000); }

function sessionId(rec) {
  return 's' + hash64([
    rec.source.vendor, rec.source.app || '', rec.source.device || '',
    rec.rawActivity || rec.activity,
    sec(rec.start), sec(rec.end),
    Math.round(rec.distanceM || 0)
  ].join('|'));
}

function dailyId(rec) {
  return 'd' + hash64([
    rec.source.vendor, rec.source.app || '', rec.source.device || '',
    rec.metric, rec.localDate
  ].join('|'));
}

// Build a session record. `raw` carries whatever the parser extracted; this fills in
// the derived fields and the id so no parser has to remember to.
function makeSession(raw) {
  const rec = {
    id: null,
    activity: raw.activity || 'other',
    rawActivity: raw.rawActivity || null,
    start: raw.start,
    end: raw.end,
    tzOffset: raw.tzOffset == null ? 0 : raw.tzOffset,
    durationSec: raw.durationSec != null ? raw.durationSec
                 : Math.max(0, Math.round(((raw.end || 0) - (raw.start || 0)) / 1000)),
    distanceM: raw.distanceM != null ? raw.distanceM : null,
    energyKcal: raw.energyKcal != null ? raw.energyKcal : null,
    avgHr: raw.avgHr != null ? raw.avgHr : null,
    source: raw.source,
    localDate: null,
    importBatch: raw.importBatch || null,
    importedAt: raw.importedAt || Date.now(),
    supersededBy: null,
    dedupe: null
  };
  rec.localDate = localDateOf(rec.start, rec.tzOffset);
  rec.id = sessionId(rec);
  return rec;
}

function makeDaily(raw) {
  const rec = {
    id: null,
    metric: raw.metric,
    localDate: raw.localDate,
    value: raw.value,
    source: raw.source,
    importBatch: raw.importBatch || null,
    importedAt: raw.importedAt || Date.now(),
    supersededBy: null
  };
  rec.id = dailyId(rec);
  return rec;
}

// Accumulates many samples into one figure per (metric, day, source). Shared by every
// importer, because they all face the same problem: a day holds hundreds of step
// samples and two weigh-ins, and only the folded result is worth storing.
//
// Values are folded in as they arrive rather than collected into arrays — a decade of
// step samples is millions of numbers and we only ever need their sum.
class DailyBuckets {
  constructor() { this.map = new Map(); }

  add(metric, localDate, source, value, agg, at) {
    if (value == null || !isFinite(value)) return;
    const key = metric + '|' + localDate + '|' + sourceLabel(source);
    let b = this.map.get(key);
    if (!b) {
      b = { metric, localDate, source, agg, sum: 0, count: 0, last: null, lastAt: -Infinity };
      this.map.set(key, b);
    }
    b.sum += value;
    b.count++;
    // 'last' means the latest reading of the day, so ordering is by timestamp rather
    // than by the order records happened to appear in the file.
    if (at >= b.lastAt) { b.last = value; b.lastAt = at; }
  }

  toRecords(importBatch, importedAt) {
    const out = [];
    for (const b of this.map.values()) {
      const value = b.agg === 'sum' ? b.sum
                  : b.agg === 'avg' ? b.sum / b.count
                  : b.last;
      if (value == null || !isFinite(value)) continue;
      out.push(makeDaily({ metric: b.metric, localDate: b.localDate, value,
                           source: b.source, importBatch, importedAt }));
    }
    return out;
  }
}

// A short, stable label for a source — what the Duplicates screen and the source
// priority settings show. Prefers the recording device over the app that relayed it,
// because "Apple Watch" is the useful distinction, not "Apple Health".
function sourceLabel(source) {
  if (!source) return 'Unknown';
  return source.device || source.app || (VENDORS[source.vendor] || {}).label || source.vendor;
}

if (typeof module !== 'undefined') {
  module.exports = { hash64, sessionId, dailyId, makeSession, makeDaily, sourceLabel,
                     DailyBuckets };
}
