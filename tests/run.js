// Unit tests. Plain Node, no dependencies, no browser:  node tests/run.js
// The harness loads the REAL js/ modules, so these exercise shipped code, not copies.
const fs = require('fs');
const path = require('path');
const { loadApp, makeZip, namedBlob } = require('./harness');

const app = loadApp();
const FIXTURES = path.join(__dirname, 'fixtures');
const appleXml = fs.readFileSync(path.join(FIXTURES, 'apple-export.xml'), 'utf8');

// --- tiny assertion framework ----------------------------------------------------
let passed = 0, failed = 0, currentSuite = '';
const C = { green: '\x1b[32m', red: '\x1b[31m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' };

function suite(name, fn) { currentSuite = name; console.log(`\n${C.bold}${name}${C.off}`); return fn(); }
function ok(label, cond, detail) {
  if (cond) { passed++; console.log(`  ${C.green}✓${C.off} ${label}`); }
  else { failed++; console.log(`  ${C.red}✗ ${label}${C.off}`); if (detail) console.log(`    ${C.dim}${detail}${C.off}`); }
}
function eq(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  ok(label, same, same ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function close(label, actual, expected, tol) {
  const d = Math.abs(actual - expected);
  ok(label, d <= (tol == null ? 0.01 : tol), `expected ≈${expected}, got ${actual}`);
}

// --- dates ------------------------------------------------------------------------
suite('dates — local days, never UTC days', () => {
  // 00:30 local on the 12th in UTC+2 is 22:30 UTC on the 11th. It is still the 12th.
  eq('after-midnight local time keeps its own day',
     app.localDateOf(Date.UTC(2024, 2, 11, 22, 30), 120), '2024-03-12');
  eq('before-midnight local time keeps its own day',
     app.localDateOf(Date.UTC(2024, 2, 12, 23, 30), -300), '2024-03-12');
  eq('monday-start week', app.startOfWeek('2024-03-14', 'monday'), '2024-03-11');
  eq('sunday belongs to the week that began on monday',
     app.startOfWeek('2024-03-17', 'monday'), '2024-03-11');
  eq('sunday-start week', app.startOfWeek('2024-03-14', 'sunday'), '2024-03-10');
  eq('end of week', app.endOfWeek('2024-03-14', 'monday'), '2024-03-17');
  eq('february in a leap year', app.endOfMonth('2024-02-10'), '2024-02-29');
  eq('february in a common year', app.endOfMonth('2023-02-10'), '2023-02-28');
  eq('end of year', app.endOfYear('2024-05-05'), '2024-12-31');
  eq('previous month across a year boundary',
     app.shiftPeriod('2024-01-15', 'month', -1), '2023-12-01');
  eq('next year', app.shiftPeriod('2024-06-01', 'year', 1), '2025-01-01');
  eq('previous week', app.shiftPeriod('2024-03-14', 'week', -1, 'monday'), '2024-03-04');
  eq('days between', app.daysBetween('2024-02-27', '2024-03-01'), 3); // leap year
  eq('inclusive range length', app.dateRange('2024-03-01', '2024-03-05').length, 5);
});

// --- metrics ----------------------------------------------------------------------
suite('metrics — aggregation and formatting', () => {
  eq('sum', app.aggregate([1, 2, 3], 'sum'), 6);
  eq('avg', app.aggregate([2, 4], 'avg'), 3);
  eq('last', app.aggregate([81.4, 82.2], 'last'), 82.2);
  // "no data" must stay distinguishable from zero, or a missing weight plots as 0kg.
  eq('empty aggregates to null, not zero', app.aggregate([], 'sum'), null);
  eq('non-numbers are ignored', app.aggregate([1, null, undefined, NaN, 2], 'sum'), 3);
  eq('short distance keeps two decimals', app.formatMetric('distance_run', 6200), '6.20 km');
  eq('long distance drops to whole km', app.formatMetric('distance_run', 812000), '812 km');
  eq('duration renders as hours and minutes', app.formatMetric('time_gym', 3720), '1h 02m');
  eq('sub-hour duration omits the hour', app.formatMetric('time_gym', 1500), '25m');
  eq('sleep is stored in minutes', app.formatMetric('sleep', 420), '7h 00m');
  eq('weight keeps one decimal', app.formatMetric('weight', 82.24), '82.2 kg');
  eq('missing value renders as a dash', app.formatMetric('steps', null), '—');
});

// --- taxonomy ---------------------------------------------------------------------
suite('activity taxonomy', () => {
  eq('apple running', app.canonicalActivity('apple', 'HKWorkoutActivityTypeRunning'), 'running');
  eq('apple tennis collapses into racket sports',
     app.canonicalActivity('apple', 'HKWorkoutActivityTypeTennis'), 'racket');
  eq('so does squash', app.canonicalActivity('apple', 'HKWorkoutActivityTypeSquash'), 'racket');
  eq('strength training is the gym',
     app.canonicalActivity('apple', 'HKWorkoutActivityTypeTraditionalStrengthTraining'), 'strength');
  eq('strava trail run', app.canonicalActivity('strava', 'Trail Run'), 'running');
  eq('strava ride', app.canonicalActivity('strava', 'Ride'), 'cycling');
  eq('unknown types fall through to other',
     app.canonicalActivity('apple', 'HKWorkoutActivityTypeCurling'), 'other');
  ok('a gym session and an "other" workout may be the same thing',
     app.activitiesCompatible('strength', 'other'));
  ok('a run and a swim never are', !app.activitiesCompatible('running', 'swimming'));
});

// --- units and source names --------------------------------------------------------
suite('normalisation', () => {
  close('miles to metres', app.toMetres(5.2, 'mi'), 8368.5888);
  close('km to metres', app.toMetres(6.2, 'km'), 6200);
  close('pounds to kg', app.toKg(180, 'lb'), 81.6466, 0.001);
  eq('minutes to seconds', app.toSeconds(32.5, 'min'), 1950);
  eq('apple writes kcal as "Cal"', app.toKcal(410, 'Cal'), 410);
  // An unknown unit is a bug, not a number to guess at.
  eq('unknown units yield null rather than a wrong number', app.toMetres(5, 'furlongs'), null);
  eq('personalised phone name', app.normalizeSourceName("Ivan's iPhone"), 'iPhone');
  eq('personalised watch name', app.normalizeSourceName('Ivan’s Apple Watch'), 'Apple Watch');
  eq('google health relay', app.normalizeSourceName('Google Health'), 'Google Health');
  // A substring taken from a parsed chunk is a view that keeps the whole parent
  // alive in V8. Stored on every record, those views pinned 192MB of buffers for
  // 2.6MB of data — enough to exhaust a phone on a large import.
  const a = app.intern('Apple Watch');
  const b = app.intern(['Apple', 'Watch'].join(' '));
  ok('equal strings collapse to one shared copy', a === b);
  eq('and the value is unchanged', a, 'Apple Watch');
  ok('different strings stay different', app.intern('iPhone') !== a);
  eq('null passes through', app.intern(null), null);

  eq('device blob yields the device name',
     app.deviceNameFrom('<<HKDevice: 0x28>, name:Apple Watch, manufacturer:Apple Inc.>'), 'Apple Watch');
});

// --- deterministic ids -------------------------------------------------------------
suite('record ids — the basis of idempotent re-import', () => {
  const base = { activity: 'running', rawActivity: 'HKWorkoutActivityTypeRunning',
                 start: 1710259200000, end: 1710261150000, tzOffset: 120, distanceM: 6200,
                 source: { vendor: 'apple', app: 'Apple Health', device: 'Apple Watch' } };
  const a = app.makeSession({ ...base });
  const b = app.makeSession({ ...base, importBatch: 'later-batch', importedAt: 999 });
  eq('the same workout imported twice keeps one id', a.id, b.id);

  const other = app.makeSession({ ...base, source: { ...base.source, device: 'Strava' } });
  ok('a different source is a different record', a.id !== other.id);

  const drifted = app.makeSession({ ...base, start: base.start + 400 }); // <1s of drift
  eq('sub-second drift does not mint a duplicate', a.id, drifted.id);

  const later = app.makeSession({ ...base, start: base.start + 60000 });
  ok('a minute of drift does', a.id !== later.id);
  eq('the local day comes from the record\'s own offset', a.localDate, '2024-03-12');
});

// --- CSV ---------------------------------------------------------------------------
suite('CSV parsing', () => {
  const rows = app.parseCSVObjects('Activity ID,Activity Date,Activity Name\n' +
    '123,"Mar 12, 2024, 6:00:00 PM","Evening run, easy"\n' +
    '124,"Mar 13, 2024, 7:00:00 AM","He said ""go"""\n');
  eq('row count', rows.length, 2);
  eq('a comma inside quotes stays in the field', rows[0]['Activity Name'], 'Evening run, easy');
  eq('a date containing commas survives', rows[0]['Activity Date'], 'Mar 12, 2024, 6:00:00 PM');
  eq('doubled quotes become one quote', rows[1]['Activity Name'], 'He said "go"');
  const bom = app.parseCSVObjects('﻿id,name\n1,x\n');
  eq('a byte-order mark does not corrupt the first header', Object.keys(bom[0])[0], 'id');
});

// --- XML scanner --------------------------------------------------------------------
suite('streaming XML scanner', () => {
  const tags = [];
  const s = new app.XmlTagScanner((n, a, k) => tags.push([n, a, k]));
  s.feed('<?xml version="1.0"?><!DOCTYPE HealthData [<!ELEMENT a (b)><!ATTLIST a x CDATA #REQUIRED>]>');
  s.feed('<HealthData locale="en_GB"><Record type="X" value="1"/><!-- note --><Workout a="1">');
  s.feed('<WorkoutStatistics sum="2"/></Workout></HealthData>');
  eq('declarations, the DOCTYPE internal subset and comments are skipped',
     tags.map(t => t[0]), ['HealthData', 'Record', 'Workout', 'WorkoutStatistics', 'Workout', 'HealthData']);
  eq('self-closing tags are marked', tags[1][2], 'self');
  eq('open tags are marked', tags[2][2], 'open');
  eq('close tags are marked', tags[4][2], 'close');
  eq('attributes are parsed', tags[0][1].locale, 'en_GB');

  eq('numeric entity', app.xmlUnescape('a&#39;b'), "a'b");
  eq('named entities', app.xmlUnescape('&lt;&amp;&gt;&quot;&apos;'), `<&>"'`);
  eq('text without entities passes through', app.xmlUnescape('plain'), 'plain');
  eq('an unknown entity is left alone', app.xmlUnescape('&nope;'), '&nope;');
});

// --- Apple parser ---------------------------------------------------------------------
async function parseFixture(chunkSize) {
  const bytes = new TextEncoder().encode(appleXml);
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    }
  });
  return app.scanAppleExport(stream, { importBatch: 'test' });
}

let fixtureResult = null;

async function appleTests() {
  const res = await parseFixture(1 << 20); // one chunk
  fixtureResult = res;
  suite('Apple Health parser', () => {
    eq('every Record element is counted', res.tally.records, 23);
    eq('every Workout element is counted', res.tally.workouts, 6);
    eq('the export date is read', res.meta.exportDate, '2026-09-20 11:02:19 +0300');
    eq('coverage starts at the oldest record', res.tally.from, '2019-06-01');
    eq('coverage ends at the newest', res.tally.to, '2026-07-04');

    eq('one session per workout', res.sessions.length, 6);

    // One source object shared by every record from that source, rather than
    // thousands of identical copies each pinning its own parse buffer.
    const watchRecords = res.daily.filter(d => d.source.device === 'Apple Watch');
    ok('records from one source share a single source object',
       watchRecords.length > 1 && watchRecords.every(d => d.source === watchRecords[0].source));
    ok('and different sources do not share one',
       res.daily.find(d => d.source.device === 'iPhone').source !== watchRecords[0].source);
    const watchRun = res.sessions.find(s => s.source.device === 'Apple Watch' && s.localDate === '2024-03-12');
    eq('nested WorkoutStatistics give the distance', watchRun.distanceM, 6200);
    eq('duration is converted to seconds', watchRun.durationSec, 1950);
    eq('energy is read from "Cal"', watchRun.energyKcal, 410);
    eq('average heart rate is rounded', watchRun.avgHr, 156);
    eq('the activity is canonicalised', watchRun.activity, 'running');

    const legacy = res.sessions.find(s => s.localDate === '2019-06-01');
    close('legacy totalDistance attributes are read, in miles', legacy.distanceM, 8368.5888);
    eq('legacy energy', legacy.energyKcal, 520);

    const tennis = res.sessions.find(s => s.rawActivity === 'HKWorkoutActivityTypeTennis');
    eq('tennis lands in racket sports', tennis.activity, 'racket');
    eq('tennis duration', tennis.durationSec, 5400);

    const byMetric = m => res.daily.filter(d => d.metric === m);
    eq('steps are split per source per day', byMetric('steps').length, 4);
    const steps0312 = byMetric('steps').filter(d => d.localDate === '2024-03-12');
    eq('the phone total for that day',
       steps0312.find(d => d.source.device === 'iPhone').value, 2000);
    eq('the watch total for the same day',
       steps0312.find(d => d.source.device === 'Apple Watch').value, 2600);

    const w = byMetric('weight');
    eq('a same-day re-weigh keeps the later reading',
       w.find(d => d.localDate === '2024-03-12').value, 82.2);
    close('pounds are converted', w.find(d => d.localDate === '2024-03-13').value, 81.6466, 0.001);

    eq('resting heart rate is averaged over the day',
       byMetric('resting_hr')[0].value, 55);

    // 180 asleep + 60 deep + 180 REM. InBed (460) and Awake (15) excluded.
    const sleep = byMetric('sleep');
    eq('sleep is attributed to the wake day', sleep[0].localDate, '2024-03-12');
    eq('only genuinely-asleep stages count', sleep[0].value, 420);

    // Banded heart rate is no longer a daily figure: it belongs to the workout it
    // was recorded during. A pass with no workout windows knows of no workout, so it
    // credits nothing — which is the honest answer, not a zero.
    ok('bands are not stored against the day', !res.daily.some(d => /^hr_band_/.test(d.metric)));
    ok('and without windows nothing is credited',
       res.sessions.every(s => !s.hrBands));

    ok('an unmapped record type is reported but not stored',
       res.tally.types['HKQuantityTypeIdentifierEnvironmentalAudioExposure'].count === 1 &&
       !res.daily.some(d => d.metric === 'audio'));
  });

  // The real hazard in a streaming parser is a tag split across a chunk boundary.
  const tiny = await parseFixture(7);
  suite('Apple parser — chunk boundaries', () => {
    eq('7-byte chunks give the same record count', tiny.tally.records, res.tally.records);
    eq('…the same workouts', tiny.tally.workouts, res.tally.workouts);
    eq('…the same sessions', tiny.sessions.map(s => s.id), res.sessions.map(s => s.id));
    eq('…and byte-identical daily figures',
       tiny.daily.map(d => [d.id, d.value]).sort(), res.daily.map(d => [d.id, d.value]).sort());
  });

  suite('idempotent re-import', () => {
    const again = res.daily.map(d => d.id);
    const dupes = again.filter((id, i) => again.indexOf(id) !== i);
    eq('no two daily records collide within one import', dupes, []);
    const sids = res.sessions.map(s => s.id);
    eq('no two sessions collide either', sids.filter((id, i) => sids.indexOf(id) !== i), []);
  });
}


// --- deduplication -------------------------------------------------------------------
function session(over) {
  const base = { activity: 'running', start: Date.parse('2024-03-12T16:00:00Z'),
                 end: Date.parse('2024-03-12T16:32:30Z'), tzOffset: 120, distanceM: 6200,
                 source: { vendor: 'apple', app: 'Apple Health', device: 'Apple Watch' } };
  return app.makeSession({ ...base, ...over,
    source: { ...base.source, ...(over && over.source || {}) } });
}
function daily(metric, date, device, value) {
  return app.makeDaily({ metric, localDate: date, value,
    source: { vendor: 'apple', app: 'Apple Health', device } });
}
const settings = app.DEFAULT_SETTINGS;
const counted = decisions => decisions.filter(d => !d.supersededBy).map(d => d.record);

suite('session dedupe — the same run seen twice', () => {
  const watch = session({});
  const strava = session({ source: { device: 'Strava' },
    start: Date.parse('2024-03-12T16:00:35Z'), end: Date.parse('2024-03-12T16:32:59Z'),
    distanceM: 6180 });
  const d = app.dedupeSessions([watch, strava], settings, {});
  eq('one of the two copies is counted', counted(d).length, 1);
  eq('the higher-ranked source wins', app.sourceLabel(counted(d)[0].source), 'Apple Watch');
  ok('the loser records why it was set aside',
     /same workout/.test(d.find(x => x.supersededBy).reason));

  // The hazard case: a long walk that wholly CONTAINS a short run overlaps it by 100%
  // of the shorter session, but they are two different things.
  const walk = session({ activity: 'walking', source: { device: 'iPhone' },
    start: Date.parse('2024-03-12T15:00:00Z'), end: Date.parse('2024-03-12T17:00:00Z'),
    distanceM: 9000 });
  const both = app.dedupeSessions([walk, session({})], settings, {});
  eq('a run inside a longer walk is not swallowed by it', counted(both).length, 2);

  const morning = session({ start: Date.parse('2024-03-12T06:00:00Z'),
                            end: Date.parse('2024-03-12T06:30:00Z') });
  eq('two separate runs on one day both count',
     counted(app.dedupeSessions([session({}), morning], settings, {})).length, 2);

  eq('a run and a swim are never the same event',
     counted(app.dedupeSessions([session({}),
       session({ activity: 'swimming', source: { device: 'Strava' } })], settings, {})).length, 2);
});

suite('session dedupe — the winner inherits the effort', () => {
  // The importer credits banded heart rate to whichever copy of a workout owned the
  // clock, which need not be the copy that wins here. Without this the effort of a
  // duplicated session disappears the moment it is deduplicated — and a duplicated
  // session is the normal case for someone running two devices.
  const watch = session({ hrBands: { 140: 900, 160: 300 } });
  const strava = session({ source: { device: 'Strava' },
    start: Date.parse('2024-03-12T16:00:35Z'), end: Date.parse('2024-03-12T16:32:59Z'),
    distanceM: 6180 });
  const d = app.dedupeSessions([strava, watch], settings, {});
  app.applySessionDecisions(d);
  const kept = counted(d)[0];
  eq('the surviving copy carries the bands', kept.hrBands, { 140: 900, 160: 300 });

  // Two recordings of one hour are not two hours: the fuller set is taken, not a sum.
  const a = session({ hrBands: { 140: 600 } });
  const b = session({ source: { device: 'Strava' }, hrBands: { 140: 900 },
    start: Date.parse('2024-03-12T16:00:35Z') });
  const two = app.dedupeSessions([a, b], settings, {});
  app.applySessionDecisions(two);
  eq('the fuller recording wins, and they are never added up',
     counted(two)[0].hrBands, { 140: 900 });

  // Running it twice must not change anything, since dedupe re-runs on every import.
  const again = app.dedupeSessions([a, b], settings, {});
  eq('a second pass writes nothing back', app.applySessionDecisions(again).length, 0);
});

suite('session dedupe — tie-breaking and overrides', () => {
  const rich = session({ source: { device: 'Strava' }, avgHr: 156, energyKcal: 410 });
  const bare = session({ source: { device: 'Strava' }, distanceM: null, avgHr: null,
                         start: Date.parse('2024-03-12T16:00:10Z') });
  const d = app.dedupeSessions([bare, rich], settings, {});
  eq('between equal sources the fuller record wins', counted(d)[0].id, rich.id);

  const watch = session({});
  const strava = session({ source: { device: 'Strava' },
    start: Date.parse('2024-03-12T16:00:35Z') });
  const forced = app.dedupeSessions([watch, strava], settings,
    { [strava.id]: { decision: 'keep' }, [watch.id]: { decision: 'suppress', winner: strava.id } });
  eq('a manual choice overrules the ranking', counted(forced).map(r => r.id), [strava.id]);
});

suite('stream election — steps are never summed across devices', () => {
  const watch = daily('steps', '2024-03-12', 'Apple Watch', 2600);
  const phone = daily('steps', '2024-03-12', 'iPhone', 2000);
  const d = app.electDailySources([watch, phone], settings, {});
  eq('exactly one source counts for the day', counted(d).length, 1);
  eq('the wrist beats the pocket', app.sourceLabel(counted(d)[0].source), 'Apple Watch');

  // A watch left on the charger reports a small number, not no number. Trusting the
  // ranking blindly here would throw away 9,000 real steps.
  const unworn = daily('steps', '2024-03-13', 'Apple Watch', 200);
  const carried = daily('steps', '2024-03-13', 'iPhone', 9000);
  const d2 = app.electDailySources([unworn, carried], settings, {});
  eq('a device that was clearly not worn loses to one that was',
     app.sourceLabel(counted(d2)[0].source), 'iPhone');
  ok('and it says so', /not worn all day/.test(counted(d2)[0] && d2.find(x => !x.supersededBy).reason));

  const zero = daily('steps', '2024-03-14', 'Apple Watch', 0);
  const some = daily('steps', '2024-03-14', 'iPhone', 4000);
  eq('a source that recorded nothing never wins',
     app.sourceLabel(counted(app.electDailySources([zero, some], settings, {}))[0].source), 'iPhone');
});

suite('stream election — retiring a device leaves no cliff', () => {
  // The switch from an Apple Watch to a Fitbit is the regression this exists to stop:
  // a global "Apple Watch wins" rule would elect a source with no data from July on.
  const records = [];
  for (const date of ['2026-06-28', '2026-06-29', '2026-06-30']) {
    records.push(daily('steps', date, 'Apple Watch', 11000));
    records.push(daily('steps', date, 'iPhone', 7000));
  }
  for (const date of ['2026-07-01', '2026-07-02', '2026-07-03']) {
    records.push(daily('steps', date, 'Google Health', 10500)); // the Fitbit, relayed
    records.push(daily('steps', date, 'iPhone', 6800));
  }
  const kept = counted(app.electDailySources(records, settings, {}));
  eq('every day still elects exactly one source', kept.length, 6);
  const byDate = Object.fromEntries(kept.map(r => [r.localDate, r.value]));
  eq('the watch era counts the watch', byDate['2026-06-29'], 11000);
  eq('the fitbit era counts the fitbit', byDate['2026-07-02'], 10500);
  ok('no day collapses to the phone-only figure',
     Object.values(byDate).every(v => v >= 10000), JSON.stringify(byDate));
});

suite('stream election — trend metrics are not "bigger is better"', () => {
  // A higher resting heart rate is not a more trustworthy one, so the partial-wear
  // guard must not apply here.
  const watch = daily('resting_hr', '2024-03-12', 'Apple Watch', 54);
  const phone = daily('resting_hr', '2024-03-12', 'iPhone', 99);
  eq('the ranking stands regardless of magnitude',
     app.sourceLabel(counted(app.electDailySources([watch, phone], settings, {}))[0].source),
     'Apple Watch');

  const scale = daily('weight', '2024-03-12', 'Withings', 82.2);
  const manual = daily('weight', '2024-03-12', 'iPhone', 120);
  eq('one weight per day', counted(app.electDailySources([scale, manual], settings, {})).length, 1);
});

suite('dedupe is idempotent', () => {
  const recs = [session({}), session({ source: { device: 'Strava' },
    start: Date.parse('2024-03-12T16:00:35Z') })];
  const first = app.applySessionDecisions(app.dedupeSessions(recs, settings, {}));
  eq('the first pass changes something', first.length > 0, true);
  const second = app.applySessionDecisions(app.dedupeSessions(recs, settings, {}));
  eq('running it again changes nothing', second.length, 0);

  const days = [daily('steps', '2024-03-12', 'Apple Watch', 2600),
                daily('steps', '2024-03-12', 'iPhone', 2000)];
  app.applyDailyDecisions(app.electDailySources(days, settings, {}));
  eq('same for the daily election',
     app.applyDailyDecisions(app.electDailySources(days, settings, {})).length, 0);
});

function fixtureDedupeTests() { suite('dedupe over the real fixture', () => {
  const parsed = fixtureResult;
  const d = app.dedupeSessions(parsed.sessions, settings, {});
  const kept = counted(d);
  // The fixture holds the same 2024-03-12 run twice: once from the watch, once relayed
  // from Strava. Everything else is distinct.
  eq('six workouts become five once the duplicate is set aside', kept.length, 5);
  eq('the Apple Watch copy is the one that counts',
     app.sourceLabel(kept.find(s => s.localDate === '2024-03-12').source), 'Apple Watch');

  const dd = app.electDailySources(parsed.daily, settings, {});
  const keptDaily = counted(dd);
  const steps = keptDaily.filter(r => r.metric === 'steps');
  eq('two step-days survive from four records', steps.length, 2);
  eq('2024-03-12 counts the watch',
     steps.find(s => s.localDate === '2024-03-12').value, 2600);
  eq('2026-07-04 counts Google Health, not the phone',
     steps.find(s => s.localDate === '2026-07-04').value, 9400);
}); }

// --- ZIP + sniffing + inspection ------------------------------------------------------
async function zipTests() {
  const zip = namedBlob(await makeZip({
    'apple_health_export/export.xml': appleXml,
    'apple_health_export/export_cda.xml': '<ClinicalDocument/>'
  }), 'export.zip');

  const entries = await app.zipEntries(zip);
  suite('ZIP reader', () => {
    eq('both entries are listed', entries.length, 2);
    eq('names survive', entries[0].name, 'apple_health_export/export.xml');
    eq('the uncompressed size is recorded', entries[0].uncompressedSize,
       new TextEncoder().encode(appleXml).length);
  });

  const text = await app.zipEntryText(zip, entries[0]);
  ok('an entry inflates back to its original bytes', text === appleXml,
     `got ${text.length} chars, expected ${appleXml.length}`);

  const sniff = await app.sniffFile(zip);
  suite('file sniffing', () => {
    eq('an Apple archive is recognised by its contents, not its name', sniff.kind, 'apple-zip');
    eq('and the XML entry is located', sniff.entry.name, 'apple_health_export/export.xml');
  });

  const bare = namedBlob(new Blob([appleXml]), 'export.xml');
  const sniff2 = await app.sniffFile(bare);
  eq('a bare export.xml is recognised too', sniff2.kind, 'apple-xml');

  const csv = namedBlob(new Blob(['Activity ID,Activity Date,Activity Type\n1,"Mar 12, 2024, 6:00:00 PM",Run\n']), 'activities.csv');
  eq('a Strava CSV is recognised', (await app.sniffFile(csv)).kind, 'strava-csv');

  const report = await app.inspectFile(zip);
  suite('inspector', () => {
    eq('it reports the true coverage', [report.range.from, report.range.to],
       ['2019-06-01', '2026-07-04']);
    eq('it lists every recording source',
       report.sources.map(s => s.name).sort(),
       ['Apple Watch', 'Google Health', 'Strava', 'Withings', 'iPhone']);
    ok('it says which types feed a metric',
       report.types.find(t => t.type === 'HKQuantityTypeIdentifierStepCount').mapped === 'steps');
    ok('and which do not',
       report.types.find(t => t.type === 'HKQuantityTypeIdentifierEnvironmentalAudioExposure').mapped === null);
    const text = app.inspectionReportText(report);
    ok('the report renders as copyable text', /RECORDING SOURCES/.test(text) && /Apple Watch/.test(text));
  });

  const stravaReport = await app.inspectFile(csv);
  eq('a Strava CSV inspects to an activity count', stravaReport.totals.workouts, 1);
}

// --- visibility and rollups -------------------------------------------------------
function rollupTests() {
  suite('tile visibility', () => {
    eq('everything shows by default', app.visibleMetricIds({}).length, app.metricIds().length);
    const hidden = app.visibleMetricIds({ hiddenMetrics: ['distance_cycle', 'weight'] });
    ok('hidden metrics drop out',
       !hidden.includes('distance_cycle') && !hidden.includes('weight'));
    ok('the rest keep their order', hidden.includes('distance_run') && hidden.includes('steps'));
    eq('hiding everything is allowed',
       app.visibleMetricIds({ hiddenMetrics: app.metricIds() }).length, 0);
  });

  suite('rollups', () => {
    const sessions = [
      { localDate: '2024-03-12', activity: 'running', distanceM: 6200, durationSec: 1950 },
      { localDate: '2024-03-12', activity: 'running', distanceM: 3000, durationSec: 900 },
      { localDate: '2024-03-14', activity: 'racket', durationSec: 5400 },
      // Suppressed by dedupe: must not reach any total.
      { localDate: '2024-03-12', activity: 'running', distanceM: 6180, supersededBy: 'x' },
      // Outside the range asked for.
      { localDate: '2024-04-01', activity: 'running', distanceM: 9999 }
    ];
    const daily = [
      { localDate: '2024-03-12', metric: 'steps', value: 2600 },
      { localDate: '2024-03-13', metric: 'steps', value: 4000 },
      { localDate: '2024-03-12', metric: 'steps', value: 2000, supersededBy: 'y' },
      { localDate: '2024-03-12', metric: 'weight', value: 82.2 },
      { localDate: '2024-03-14', metric: 'weight', value: 81.8 }
    ];
    const r = app.computeRollups(sessions, daily, '2024-03-11', '2024-03-17',
                                 ['distance_run', 'time_racket', 'steps', 'weight']);

    eq('two runs on one day are summed', r.distance_run.byDay['2024-03-12'], 9200);
    eq('a superseded run is never counted', r.distance_run.value, 9200);
    eq('records outside the range are excluded',
       r.distance_run.byDay['2024-04-01'], undefined);
    eq('active days count only days with something', r.distance_run.activeDays, 1);
    eq('duration metrics come from the same pass', r.time_racket.value, 5400);

    eq('steps sum across the period', r.steps.value, 6600);
    eq('a superseded day is not added on top', r.steps.byDay['2024-03-12'], 2600);

    // A trend metric averages across the period rather than summing: nobody weighs
    // 164kg because they stood on the scales twice.
    close('weight averages', r.weight.value, 82.0, 0.001);

    const only = app.computeRollups(sessions, daily, '2024-03-11', '2024-03-17', ['steps']);
    eq('asking for one metric computes only that one', Object.keys(only), ['steps']);
  });
}

// --- Google Health / Fitbit Takeout ---------------------------------------------------
async function takeoutTests() {
  // Shaped like a real export: Takeout/Fitbit/<folder>/<name>-YYYY-MM-DD.json.
  // Google renamed the app to Google Health but left the Takeout category as "Fitbit",
  // so recognition has to key off the path, not the branding.
  const zip = namedBlob(await makeZip({
    'Takeout/Fitbit/Global Export Data/steps-2026-07-01.json':
      JSON.stringify([{ dateTime: '07/01/26 00:00:00', value: '52' },
                      { dateTime: '07/01/26 00:01:00', value: '118' }]),
    'Takeout/Fitbit/Global Export Data/steps-2026-07-02.json':
      JSON.stringify([{ dateTime: '07/02/26 00:00:00', value: '40' }]),
    'Takeout/Fitbit/Global Export Data/steps-2026-09-15.json':
      JSON.stringify([{ dateTime: '09/15/26 00:00:00', value: '77' }]),
    'Takeout/Fitbit/Sleep/sleep-2026-07-01.json':
      JSON.stringify([{ logId: 42, dateOfSleep: '2026-07-01',
                        startTime: '2026-06-30T23:30:00.000',
                        endTime: '2026-07-01T07:00:00.000',
                        duration: 27000000, minutesAsleep: 420,
                        levels: { summary: {}, data: [1, 2, 3] } }]),
    'Takeout/Fitbit/Physical Activity/exercise-0.json':
      JSON.stringify([{ logId: 9, activityName: 'Run', startTime: '07/01/26 07:30:00',
                        duration: 1800000, distance: 5.2, distanceUnit: 'Kilometer',
                        calories: 410, averageHeartRate: 156 }]),
    'Takeout/Fitbit/Your Profile/Profile.csv': 'full_name,date_of_birth\nIvan,1990-01-01\n'
  }), 'takeout-20260921.zip');

  const sniff = await app.sniffFile(zip);
  suite('Google Health (Fitbit) Takeout', () => {
    eq('the archive is recognised by its path, not the word Fitbit',
       sniff.kind, 'fitbit-zip');
    eq('and labelled by the app\'s current name', sniff.label, 'Google Health (Fitbit) export');
  });

  const rep = await app.inspectFile(zip);
  suite('Takeout inspection', () => {
    eq('coverage comes from the file names', [rep.range.from, rep.range.to],
       ['2026-07-01', '2026-09-15']);
    eq('every data folder is listed',
       rep.types.map(t => t.type).sort(),
       ['Global Export Data', 'Physical Activity', 'Sleep', 'Your Profile']);
    eq('files are counted per folder',
       rep.types.find(t => t.type === 'Global Export Data').count, 3);

    // The point of the pass: report the real schema rather than assume one.
    const exercise = rep.types.find(t => t.type === 'Physical Activity').sample;
    eq('a JSON array is identified as such', exercise.format, 'json-array');
    ok('and its real keys are reported',
       ['activityName', 'startTime', 'duration', 'distance'].every(k => exercise.keys.includes(k)),
       JSON.stringify(exercise.keys));
    eq('nested values are summarised rather than dumped',
       app.describeSample('sleep-2026-07-01.json',
         JSON.stringify([{ levels: { data: [1, 2, 3] } }])).example.levels, '{…}');

    const profile = rep.types.find(t => t.type === 'Your Profile').sample;
    eq('CSV files are described too', profile.format, 'csv');
    eq('with their column names', profile.keys, ['full_name', 'date_of_birth']);

    // The report must promise exactly what the importer will actually do.
    eq('step files are marked as feeding steps',
       rep.types.find(t => t.type === 'Global Export Data').mapped, 'steps');
    eq('exercise files are marked as workouts',
       rep.types.find(t => t.type === 'Physical Activity').mapped, 'workouts');
    eq('sleep files are marked as sleep',
       rep.types.find(t => t.type === 'Sleep').mapped, 'sleep');
    eq('a profile folder feeds nothing',
       rep.types.find(t => t.type === 'Your Profile').mapped, null);

    const text = app.inspectionReportText(rep);
    ok('the text report carries the schema, which is the point of pasting it back',
       /keys: .*activityName/.test(text), text.slice(0, 600));
  });
}

// --- Fitbit parsing -------------------------------------------------------------------
function fitbitParseTests() {
  suite('Fitbit dates — wall clock, no timezone anywhere', () => {
    // Fitbit writes MM/DD/YY with no offset. Read as local wall time, which is the
    // only reading that keeps a Fitbit run aligned with its Apple Health twin.
    const d = app.parseFitbitDate('07/04/26 07:30:00');
    eq('the day is read correctly', d.localDate, '2026-07-04');
    eq('and it resolves to that local wall time',
       new Date(d.ms).getHours() + ':' + new Date(d.ms).getMinutes(), '7:30');
    eq('two-digit years are this century', app.parseFitbitDate('01/02/09').localDate, '2009-01-02');
    eq('ISO timestamps are accepted too',
       app.parseFitbitDate('2026-07-04T23:30:00.000').localDate, '2026-07-04');
    eq('a bare ISO date works', app.parseFitbitDate('2026-07-04').localDate, '2026-07-04');
    eq('nonsense yields null', app.parseFitbitDate('not a date'), null);
    eq('so does nothing at all', app.parseFitbitDate(''), null);
  });

  suite('Fitbit file classification', () => {
    eq('steps', app.classifyFitbitFile('Takeout/Fitbit/Global Export Data/steps-2026-07-01.json'), 'steps');
    eq('exercise', app.classifyFitbitFile('Takeout/Fitbit/Physical Activity/exercise-0.json'), 'exercise');
    eq('sleep', app.classifyFitbitFile('Takeout/Fitbit/Sleep/sleep-2026-07-01.json'), 'sleep');
    // The specific pattern must beat the broad one, or every heart-rate file would be
    // read as a resting-heart-rate file and vice versa.
    eq('resting heart rate is not plain heart rate',
       app.classifyFitbitFile('Global Export Data/resting_heart_rate-2026-07-01.json'), 'resting_hr');
    // `steps[-_]` also matches `steps_intraday`, so the narrower rule has to come
    // first or those files are read as daily steps and counted twice.
    eq('intraday steps are skipped, not summed a second time',
       app.classifyFitbitFile('Global Export Data/steps_intraday-2026-07-01.json'), 'ignore');
    eq('ordinary daily steps still read',
       app.classifyFitbitFile('Global Export Data/steps-2026-07-01.json'), 'steps');
    eq('raw heart rate is read, for the bands',
       app.classifyFitbitFile('Global Export Data/heart_rate-2026-07-01.json'), 'heart_rate');
    eq('distance is skipped — it already arrives on the exercise records',
       app.classifyFitbitFile('Global Export Data/distance-2026-07-01.json'), 'ignore');
    eq('non-JSON is not classified', app.classifyFitbitFile('Your Profile/Profile.csv'), null);
  });

  suite('Fitbit record parsing', () => {
    const out = app.createFitbitCollector('b1', 1000);

    // Intraday buckets fold into days; a file may hold a day or a month, so the day
    // comes from each entry rather than from the file name.
    app.parseFitbitSteps([
      { dateTime: '07/04/26 08:00:00', value: '520' },
      { dateTime: '07/04/26 08:01:00', value: '480' },
      { dateTime: '07/05/26 09:00:00', value: '1000' }
    ], out);

    app.parseFitbitRestingHr([
      { dateTime: '07/04/26', value: { date: '07/04/26', value: 58.0, error: 6.0 } },
      { dateTime: '07/05/26', value: 60 }
    ], out);

    app.parseFitbitSleep([
      { dateOfSleep: '2026-07-04', startTime: '2026-07-03T23:30:00.000',
        endTime: '2026-07-04T07:00:00.000', duration: 27000000, minutesAsleep: 420 },
      { dateOfSleep: '2026-07-05', startTime: '2026-07-04T23:00:00.000',
        endTime: '2026-07-05T06:00:00.000', minutesAsleep: 0 }
    ], out);

    app.parseFitbitExercise([
      { logId: 1, activityName: 'Run', startTime: '07/04/26 07:30:00',
        duration: 1900000, activeDuration: 1800000, distance: 5.2,
        distanceUnit: 'Kilometer', calories: 410, averageHeartRate: 156.7 },
      { logId: 2, activityName: 'Tennis', startTime: '07/06/26 17:00:00',
        duration: 5400000, calories: 600 }
    ], out);

    const res = out.finish();
    const day = (metric, date) => res.daily.find(d => d.metric === metric && d.localDate === date);

    eq('step buckets sum into a day', day('steps', '2026-07-04').value, 1000);
    eq('a second day stays separate', day('steps', '2026-07-05').value, 1000);
    eq('resting heart rate unwraps the nested value object',
       day('resting_hr', '2026-07-04').value, 58);
    eq('…and accepts the plain form too', day('resting_hr', '2026-07-05').value, 60);
    eq('sleep uses Fitbit\'s own wake-day label', day('sleep', '2026-07-04').value, 420);
    eq('a night with no sleep recorded is not stored', day('sleep', '2026-07-05'), undefined);

    eq('two workouts', res.sessions.length, 2);
    const run = res.sessions.find(s => s.rawActivity === 'Run');
    eq('activeDuration wins over duration, since it excludes pauses', run.durationSec, 1800);
    close('distance is converted to metres', run.distanceM, 5200);
    eq('heart rate is rounded', run.avgHr, 157);
    eq('the activity is canonicalised', run.activity, 'running');
    eq('and it is attributed to Fitbit', app.sourceLabel(run.source), 'Fitbit');
    eq('tennis lands in racket sports',
       res.sessions.find(s => s.rawActivity === 'Tennis').activity, 'racket');
    eq('a workout without a distance keeps null rather than zero',
       res.sessions.find(s => s.rawActivity === 'Tennis').distanceM, null);
  });

  suite('Fitbit heart rate', () => {
    // The workout the readings fall inside. Bands belong to a session now, so there
    // has to be one — which is also how the real import runs: exercise files first.
    const workout = () => ({
      activity: 'running', rawActivity: 'Run',
      start: Date.UTC(2026, 6, 4, 7, 0, 0), end: Date.UTC(2026, 6, 4, 7, 10, 0),
      tzOffset: 0, source: { vendor: 'fitbit', app: 'Google Health', device: 'Fitbit' }
    });

    const out = app.createFitbitCollector('b', 1);
    out.addSession(workout());
    const windows = app.windowsFromSessions(out.sessions);
    // Readings at 07:00:00, 07:00:30, 07:02:30 and then an hour later. Each reading
    // is worth the gap to the next reading OF THE SAME WORKOUT: 30s at 150 and 120s
    // at 165. The 175 is the last one inside the run, and the next reading is an
    // hour later with the band on a wrist doing nothing — so it is worth nothing.
    // Crediting it the capped five minutes would be inventing the end of the run.
    app.parseFitbitHeartRate([
      { dateTime: '07/04/26 07:00:00', value: { bpm: 150, confidence: 2 } },
      { dateTime: '07/04/26 07:00:30', value: { bpm: 165, confidence: 3 } },
      { dateTime: '07/04/26 07:02:30', value: { bpm: 175, confidence: 3 } },
      { dateTime: '07/04/26 08:00:00', value: { bpm: 80, confidence: 2 } }
    ], out, windows);
    const res = out.finish();
    const bands = res.sessions[0].hrBands || {};
    eq('the 140 band gets the first gap', bands[140], 30);
    eq('the 160 band gets the second gap', bands[160], 120);
    eq('the last reading of a workout is not credited a span', bands[160] < 120 + 300, true);
    eq('the reading an hour later is outside the workout', bands[0], undefined);
    ok('and nothing is written against the day',
       !res.daily.some(d => /^hr_band_/.test(d.metric)));

    // A plain numeric value, as some export vintages write it.
    const plain = app.createFitbitCollector('b', 1);
    plain.addSession(workout());
    app.parseFitbitHeartRate([
      { dateTime: '07/04/26 07:00:00', value: 150 },
      { dateTime: '07/04/26 07:01:00', value: 150 }
    ], plain, app.windowsFromSessions(plain.sessions));
    eq('a bare numeric reading works too',
       plain.finish().sessions[0].hrBands[140], 60);
  });

  suite('Fitbit file classification, revisited', () => {
    // The specific pattern must still beat the broad one now that plain heart rate
    // is parsed rather than skipped.
    eq('resting heart rate is still its own thing',
       app.classifyFitbitFile('Global Export Data/resting_heart_rate-2026-07-01.json'),
       'resting_hr');
    eq('raw heart rate is now read',
       app.classifyFitbitFile('Global Export Data/heart_rate-2026-07-01.json'), 'heart_rate');
    eq("Fitbit's own zone banding is still skipped, since its boundaries are " +
       'percentages of an unstated max',
       app.classifyFitbitFile('Global Export Data/time_in_heart_rate_zones-2026-07-01.json'),
       'ignore');
  });

  suite('Fitbit weight — never guess the unit', () => {
    const noUnit = app.createFitbitCollector('b', 1);
    app.parseFitbitWeight([{ weight: 180, date: '07/04/26', time: '07:00:00' }], noUnit, null);
    const r = noUnit.finish();
    eq('without a stated unit nothing is stored', r.daily.length, 0);
    eq('and the reason is recorded', r.notes['weight-unit-unknown'], 1);

    const lbs = app.createFitbitCollector('b', 1);
    app.parseFitbitWeight([{ weight: 180, date: '07/04/26', time: '07:00:00' }], lbs, 'lb');
    close('pounds convert', lbs.finish().daily[0].value, 81.6466, 0.001);

    eq('the profile states the unit',
       app.fitbitWeightUnit('full_name,weight_unit\nIvan,POUND\n'), 'lb');
    eq('metric profiles too',
       app.fitbitWeightUnit('full_name,weight_unit\nIvan,KILOGRAM\n'), 'kg');
    eq('an absent column yields null',
       app.fitbitWeightUnit('full_name\nIvan\n'), null);
  });
}

async function fitbitImportTests() {
  const zip = namedBlob(await makeZip({
    'Takeout/Fitbit/Global Export Data/steps-2026-07-01.json':
      JSON.stringify([{ dateTime: '07/04/26 08:00:00', value: '5200' },
                      { dateTime: '07/04/26 09:00:00', value: '4200' }]),
    'Takeout/Fitbit/Global Export Data/resting_heart_rate-2026-07-01.json':
      JSON.stringify([{ dateTime: '07/04/26', value: { value: 58.0 } }]),
    // Deliberately present and deliberately skipped: per-second heart rate is enormous
    // and feeds nothing the app shows.
    'Takeout/Fitbit/Global Export Data/heart_rate-2026-07-04.json':
      JSON.stringify([{ dateTime: '07/04/26 08:00:00', value: { bpm: 90, confidence: 2 } }]),
    'Takeout/Fitbit/Sleep/sleep-2026-07-01.json':
      JSON.stringify([{ dateOfSleep: '2026-07-04', endTime: '2026-07-04T07:00:00.000',
                        minutesAsleep: 431 }]),
    'Takeout/Fitbit/Physical Activity/exercise-0.json':
      JSON.stringify([{ logId: 9, activityName: 'Run', startTime: '07/04/26 07:30:00',
                        activeDuration: 1800000, distance: 5.2, distanceUnit: 'Kilometer',
                        calories: 410, averageHeartRate: 156 }]),
    'Takeout/Fitbit/Global Export Data/weight-2026-07.json':
      JSON.stringify([{ weight: 185.2, date: '07/04/26', time: '07:10:00' }]),
    'Takeout/Fitbit/Your Profile/Profile.csv': 'full_name,weight_unit\nIvan,POUND\n',
    // A corrupt file must not abandon an import of everything else.
    'Takeout/Fitbit/Sleep/sleep-2026-07-02.json': '{ this is not json'
  }), 'takeout.zip');

  const entries = await app.zipEntries(zip);
  const res = await app.importTakeout(zip, entries, { importBatch: 'fb1' });

  suite('Takeout import', () => {
    eq('the workout is imported', res.sessions.length, 1);
    eq('with its distance in metres', Math.round(res.sessions[0].distanceM), 5200);
    eq('coverage is derived from the records', [res.tally.from, res.tally.to],
       ['2026-07-04', '2026-07-04']);

    const day = m => res.daily.find(d => d.metric === m);
    eq('steps fold into one day', day('steps').value, 9400);
    eq('resting heart rate arrives', day('resting_hr').value, 58);
    eq('sleep arrives', day('sleep').value, 431);
    close('weight uses the unit from the profile', day('weight').value, 84.0, 0.1);
    eq('the profile unit is reported', res.meta.weightUnit, 'lb');

    // A single reading in the file has no successor, so it contributes no span —
    // the file is read, but one sample cannot imply a duration.
    ok('a lone heart-rate reading yields no band',
       !res.daily.some(d => d.metric.startsWith('hr_band_')));
    eq('one bad file is skipped, not fatal', res.meta.filesFailed, 1);
    ok('and the rest still imported', res.sessions.length === 1 && day('steps') != null);

    // The whole point: these must reconcile against Apple, not stack on top of it.
    eq('Fitbit records are attributed to Fitbit',
       app.sourceLabel(res.sessions[0].source), 'Fitbit');
  });

  suite('Fitbit and Apple reconcile against each other', () => {
    // The same run, once from the Apple export and once from Takeout. Dedupe must
    // treat them as one — which only works because the Fitbit wall-clock time was
    // resolved into a real instant.
    const when = app.parseFitbitDate('07/04/26 07:30:00');
    const appleCopy = app.makeSession({
      activity: 'running', rawActivity: 'HKWorkoutActivityTypeRunning',
      start: when.ms + 20000, end: when.ms + 1800000, tzOffset: when.offsetMin,
      distanceM: 5190,
      source: { vendor: 'apple', app: 'Apple Health', device: 'Google Health' }
    });
    const d = app.dedupeSessions([res.sessions[0], appleCopy], app.DEFAULT_SETTINGS, {});
    const kept = d.filter(x => !x.supersededBy);
    eq('the same run from two exports counts once', kept.length, 1);
    eq('the direct Fitbit record outranks the relayed copy',
       app.sourceLabel(kept[0].record.source), 'Fitbit');
  });
}

// --- charts -----------------------------------------------------------------------
function chartTests() {
  suite('axis formatting', () => {
    // Full formatting renders "0.00 km" for nothing and "20,000" where an axis has
    // room for three characters, so ticks get their own shorter rendering.
    eq('zero is a bare zero, not a unit', app.formatMetricAxis('distance_run', 0), '0');
    eq('short distances keep one decimal', app.formatMetricAxis('distance_run', 5200), '5.2 km');
    eq('long ones drop it', app.formatMetricAxis('distance_run', 447000), '447 km');
    eq('steps become thousands', app.formatMetricAxis('steps', 20000), '20k');
    eq('and millions', app.formatMetricAxis('steps', 3400000), '3.4M');
    eq('durations become hours', app.formatMetricAxis('time_gym', 3600 * 7), '7h');
    eq('sub-hour stays in minutes', app.formatMetricAxis('time_gym', 1800), '30m');
  });

  suite('axis scaling', () => {
    // Ticks should land on numbers a person would write down.
    eq('a maximum rounds up to a readable ceiling', app.niceCeiling(447), 500);
    eq('and again at another magnitude', app.niceCeiling(17100), 20000);
    eq('just over a power of ten', app.niceCeiling(1050), 2000);
    eq('exactly a power of ten stays put', app.niceCeiling(1000), 1000);
    eq('nothing has no scale', app.niceCeiling(0), 0);
  });

  suite('bar geometry', () => {
    // The data-end is rounded and the baseline is square: rounding both would
    // detach the mark from the axis it grows out of.
    const path = app.barPath(10, 20, 12, 40, 4);
    ok('the bar starts at its baseline', path.startsWith('M10,60'));
    ok('and curves only at the top', (path.match(/Q/g) || []).length === 2);
    eq('a zero-height bar draws nothing', app.barPath(0, 0, 10, 0, 4), '');
    // A radius larger than the bar would invert the curve.
    ok('the radius is capped by the bar itself',
       app.barPath(0, 0, 4, 40, 10).includes('Q'));
  });
}

// --- the motivation layer -------------------------------------------------------------
function motivationTests() {
  suite('scale comparisons', () => {
    // 447 km — the user's actual running year.
    eq('a year of running, in recognisable units',
       app.distanceEquivalence(447000), 'the distance from Sofia to Varna');
    eq('further out, a multiplier of the same yardstick',
       app.distanceEquivalence(900000), '2 trips from Sofia to Varna');
    // Close to exactly one: name the thing rather than say "1.0 of it".
    eq('a near-exact match names the thing', app.distanceEquivalence(340000),
       'the length of Bulgaria');
    eq('a modest distance uses a smaller yardstick',
       app.distanceEquivalence(90000), '2.1 marathons');
    eq('swimming gets its own scale',
       app.distanceEquivalence(1500, 'swimming'), '30 lengths of an Olympic pool');
    // Too small to compare usefully — better to say nothing than to say "0.1 laps".
    eq('tiny distances have no useful comparison', app.distanceEquivalence(50), null);

    eq('gym hours become days', app.durationEquivalence(3600 * 30), '1.3 full days');
    eq('scale comparisons never carry spurious precision',
       app.durationEquivalence(3600 * 31), '1.3 full days');
    eq('a year in the gym becomes working weeks',
       app.durationEquivalence(3600 * 252), '6.3 working weeks');
    eq('an hour is not worth comparing', app.durationEquivalence(3600), null);

    // 3.4M steps at 0.75m ≈ 2,550 km.
    ok('steps convert to ground covered',
       /lengths of Great Britain|Sofia to Varna|Danube/.test(app.stepsEquivalence(3388544)),
       app.stepsEquivalence(3388544));

    eq('a metric with no sensible comparison gets none',
       app.equivalenceFor('weight', 82), null);
    eq('zero is never compared', app.equivalenceFor('distance_run', 0), null);
  });

  suite('streaks', () => {
    const byDay = {};
    // Ten consecutive active days, a gap, then three more up to "today".
    for (const d of ['2026-09-01','2026-09-02','2026-09-03','2026-09-04','2026-09-05',
                     '2026-09-06','2026-09-07','2026-09-08','2026-09-09','2026-09-10']) byDay[d] = 5000;
    for (const d of ['2026-09-18','2026-09-19','2026-09-20']) byDay[d] = 6000;

    const s = app.dayStreaks(byDay, '2026-09-01', '2026-09-21', 'distance_run', '2026-09-21');
    eq('the longest run is found', s.longest, 10);
    eq('and dated', [s.longestStart, s.longestEnd], ['2026-09-01', '2026-09-10']);
    // Today is not over, so a run ending yesterday is still live. Ending it at
    // midnight would report a broken streak while the shoes are still being laced.
    eq('a run ending yesterday is still current', s.current, 3);
    eq('active days are counted', s.activeDays, 13);
    eq('out of the whole range', s.totalDays, 21);

    const broken = app.dayStreaks(byDay, '2026-09-01', '2026-09-25', 'distance_run', '2026-09-25');
    eq('a run that stopped days ago is not current', broken.current, 0);

    // Steps need a threshold: a phone in a pocket logs a few hundred on a sofa day.
    const steps = { '2026-09-01': 300, '2026-09-02': 9000, '2026-09-03': 200 };
    eq('a sofa day does not count as an active step day',
       app.dayStreaks(steps, '2026-09-01', '2026-09-03', 'steps', '2026-09-03').activeDays, 1);
    eq('but any distance at all counts for running',
       app.dayStreaks({ '2026-09-01': 500 }, '2026-09-01', '2026-09-01',
                      'distance_run', '2026-09-01').activeDays, 1);

    // For something done twice a week, a day streak is always 1 and says nothing.
    const gym = { '2026-09-01': 3600, '2026-09-04': 3600, '2026-09-08': 3600,
                  '2026-09-11': 3600, '2026-09-15': 3600 };
    const w = app.weekStreaks(gym, '2026-09-01', '2026-09-21', 'time_gym', 'monday', '2026-09-16');
    eq('three consecutive active weeks', w.longest, 3);
    eq('and the run is current', w.current, 3);

    eq('the best day is found', app.bestDay(byDay).value, 6000);
    eq('the best month too', app.bestPeriod(byDay, 'month').key, '2026-09');
  });

  suite('goals — derived from what actually happened', () => {
    eq('a running target rounds to something a person would choose',
       app.niceTarget(512340, 'distance_run'), 500000);
    eq('small distances round finer', app.niceTarget(23400, 'distance_run'), 25000);
    eq('gym time rounds to whole hours', app.niceTarget(3600 * 61.4, 'time_gym'), 3600 * 60);
    eq('steps round to a readable number', app.niceTarget(3388544, 'steps'), 3500000);

    // A year at ~1.22 km/day, stretched by 8% and rounded.
    const byDay = {};
    for (const d of dateRangeOf('2025-09-21', 365)) byDay[d] = 1225;
    const target = app.deriveTarget('distance_run', byDay, '2025-09-21', '2026-09-20', 'year');
    ok('a year target lands near last year plus a stretch',
       target >= 450000 && target <= 500000, String(target));

    eq('too little history proposes nothing',
       app.deriveTarget('distance_run', { '2026-09-01': 5000 }, '2026-09-01', '2026-09-05', 'year'),
       null);
    eq('a metric with no meaningful total gets no goal',
       app.deriveTarget('weight', byDay, '2025-09-21', '2026-09-20', 'year'), null);

    const bounds = { from: '2026-01-01', to: '2026-12-31' };
    // Half the year gone, half the target done: exactly on pace.
    const onPace = app.goalProgress(500000, 250000, bounds, '2026-07-02');
    ok('being level with the calendar reads as on pace',
       Math.abs(onPace.ahead) < 2000, String(onPace.ahead));
    eq('and the percentage is separate from the pace', Math.round(onPace.pct), 50);

    const ahead = app.goalProgress(500000, 300000, bounds, '2026-07-02');
    ok('running ahead of the calendar shows as ahead', ahead.ahead > 45000, String(ahead.ahead));
    ok('and it says what is left per day', ahead.perDayNeeded > 0 && ahead.daysLeft > 180);

    const done = app.goalProgress(500000, 520000, bounds, '2026-12-31');
    ok('a target met is marked met', done.hit && done.remaining === 0);
    eq('percentage never runs past 100', done.pct, 100);

    // After the period ends, "expected" is the whole target, not a fraction of it.
    const over = app.goalProgress(500000, 400000, bounds, '2027-02-01');
    ok('a finished period compares against the full target',
       over.finished && Math.round(over.expected) === 500000);
  });
}

function dateRangeOf(start, days) {
  const out = [];
  for (let i = 0; i < days; i++) out.push(app.addDays(start, i));
  return out;
}

// --- heart-rate spans -----------------------------------------------------------
async function heartRateSpanTests() {
  // A record that states its own interval is credited that interval. It must then
  // stop being "pending", or the next reading credits it a second time by closing
  // the gap behind it. Sources that mix both forms are exactly where this bites.
  const xml = `<?xml version="1.0"?><HealthData locale="en_GB">
    <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min"
      startDate="2026-03-01 10:00:00 +0000" endDate="2026-03-01 10:01:00 +0000" value="150"/>
    <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min"
      startDate="2026-03-01 10:04:00 +0000" endDate="2026-03-01 10:04:00 +0000" value="150"/>
    <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min"
      startDate="2026-03-01 10:05:00 +0000" endDate="2026-03-01 10:05:00 +0000" value="150"/>
    <Workout workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="Watch"
      duration="6" durationUnit="min"
      startDate="2026-03-01 10:00:00 +0000" endDate="2026-03-01 10:06:00 +0000"/>
    </HealthData>`;
  const bytes = new TextEncoder().encode(xml);
  // Read twice, as a real import does: once for the workouts, once for everything.
  const makeStream = () => new ReadableStream({
    start(c) { c.enqueue(bytes); c.close(); }
  });
  const windows = await app.scanAppleWorkoutWindows(makeStream());
  const res = await app.scanAppleExport(makeStream(), {
    importBatch: 't', workoutWindows: windows
  });
  const banded = res.sessions.find(s => s.hrBands) || { hrBands: {} };

  suite('heart rate: an interval is counted once', () => {
    // 60s for the stated interval, plus 60s for the gap between the two instants.
    // The old behaviour also credited the 180s gap after the interval record,
    // inflating this to 300s.
    eq('the stated interval and the instant gap, and nothing more',
       banded.hrBands[140], 120);
  });
}

// --- heart rate during workouts only ------------------------------------------------
async function heartRateWindowTests() {
  const bytes = new TextEncoder().encode(appleXml);
  const makeStream = () => new ReadableStream({
    start(c) { c.enqueue(bytes); c.close(); }
  });

  const windows = await app.scanAppleWorkoutWindows(makeStream());
  const withWindows = await app.scanAppleExport(makeStream(), {
    importBatch: 'w', workoutWindows: windows
  });
  // Summed across every workout, which is what the screen does before filtering.
  const band = f => withWindows.sessions
    .reduce((n, s) => n + ((s.hrBands || {})[f] || 0), 0);

  suite('heart rate is banded only during workouts', () => {
    ok('the first pass finds the workouts', windows.length >= 5, String(windows.length));
    ok('and they are sorted and non-overlapping',
       windows.every((w, i) => i === 0 || w[0] >= windows[i - 1][1]));

    // The fixture's readings sit inside the 18:00 run except the last, an hour later
    // while sitting down. Without windows that idle hour contributed a capped five
    // minutes to the 160 band; with them it contributes nothing.
    eq('readings inside the workout still count', band(140), 120);
    eq('the reading after it no longer credits an idle gap', band(160), 60);
    // The whole point of moving them off the day: each figure names its workout.
    eq('and they are attached to the workout they happened in',
       withWindows.sessions.filter(s => s.hrBands).length, 1);

    // Everything that is not heart rate is unaffected.
    eq('steps are untouched',
       withWindows.daily.filter(d => d.metric === 'steps').length, 4);
    eq('and so are workouts', withWindows.sessions.length, 6);
  });

  suite('workout windows', () => {
    const sessions = [
      { start: 1000, end: 2000, id: 'a' },
      { start: 1500, end: 3000, id: 'b' },   // overlaps the first
      { start: 900000, end: 901000, id: 'c' }
    ];
    const windows = app.windowsFromSessions(sessions, 0);

    ok('every instant of both overlapping workouts is covered',
       [1000, 1500, 1999, 2500, 3000].every(ms => app.insideWindow(windows, ms)));
    ok('one before is not', !app.insideWindow(windows, 500));
    ok('one in the gap is not', !app.insideWindow(windows, 500000));
    ok('one after is not', !app.insideWindow(windows, 1000000));
    ok('nothing matches an empty list', !app.insideWindow([], 1500));

    // The point of keeping the id: banded time has to be credited to a workout, and
    // a merged interval cannot say which. The shorter workout owns the overlap —
    // a half-hour run logged inside a two-hour walk is a run, not a walk.
    eq('the shorter workout owns the stretch they share',
       app.windowAt(windows, 1800)[2], 'a');
    eq('and the longer one keeps the rest of its own time',
       app.windowAt(windows, 2500)[2], 'b');
    eq('a workout on its own is undivided', app.windowAt(windows, 900500)[2], 'c');
    eq('windows stay sorted so the search holds',
       windows.every((w, i) => i === 0 || w[0] >= windows[i - 1][1]), true);

    // A workout's heart rate starts before the watch is told the workout has begun.
    const padded = app.windowsFromSessions([{ start: 100000, end: 200000, id: 'x' }], 60);
    eq('windows are padded either side', [padded[0][0], padded[0][1]], [40000, 260000]);

    // A workout split in the middle by a shorter one must not come back as three
    // separate intervals with the same owner on either side.
    const split = app.windowsFromSessions([
      { start: 0, end: 10000, id: 'long' },
      { start: 4000, end: 5000, id: 'short' }
    ], 0);
    eq('an interrupted workout is three stretches, not more', split.length, 3);
    eq('and the interruption is attributed to the shorter one',
       split.map(w => w[2]), ['long', 'short', 'long']);
  });
}

// --- insights ---------------------------------------------------------------------
function insightsTests() {
  const S = (over) => ({ activity: 'running', localDate: '2026-03-02',
                         durationSec: 1800, distanceM: 5000, avgHr: 150, ...over });

  suite('unrecognised workouts keep their own name', () => {
    // "Other — 19% of your time" tells you nothing. Apple records the type on the
    // session, so it is used rather than thrown away.
    eq('an unmapped Apple type becomes readable',
       app.humaniseRawActivity('HKWorkoutActivityTypeClimbing'), 'Climbing');
    // Some vendor names read badly once they are on screen: "Cardio dance" is what
    // Apple calls it, "Dance" is what the person did.
    eq('awkward vendor names are renamed',
       app.humaniseRawActivity('HKWorkoutActivityTypeCardioDance'), 'Dance');
    eq('as are the other dance variants',
       app.humaniseRawActivity('HKWorkoutActivityTypeSocialDance'), 'Dance');
    eq('camel case becomes words',
       app.humaniseRawActivity('HKWorkoutActivityTypeWaterPolo'), 'Water polo');
    eq('a renamed type wins over the generic rule',
       app.humaniseRawActivity('HKWorkoutActivityTypeCrossCountrySkiing'),
       'Cross-country skiing');
    eq('a type that really is "other" has no better name',
       app.humaniseRawActivity('HKWorkoutActivityTypeOther'), null);
    eq('and nothing at all falls back', app.activityLabel('other', null), 'Unlabelled');
    eq('a known category keeps its own label', app.activityLabel('running', 'anything'),
       'Running');

    // Two different unmapped sports must not merge into one bar.
    const share = app.timeByActivity([
      S({ activity: 'other', rawActivity: 'HKWorkoutActivityTypeClimbing', durationSec: 3600 }),
      S({ activity: 'other', rawActivity: 'HKWorkoutActivityTypeGolf', durationSec: 1800 }),
      S({ activity: 'running', durationSec: 1800 })
    ]);
    eq('each unmapped sport gets its own row', share.length, 3);
    eq('named by its own type', share[0].label, 'Climbing');
    ok('and they did not merge',
       share.some(r => r.label === 'Golf') && share.some(r => r.label === 'Climbing'));
    ok('no row is called "Other"', !share.some(r => r.label === 'Other'));
  });

  suite('hiding an activity you do not want to see', () => {
    // The regression this exists for: "Dance" is an unmapped Apple type, so it has no
    // entry in ACTIVITIES. A hide list keyed only on canonical activities could not
    // name it, and the one row the user actually wanted gone was the one row they
    // could not switch off.
    const dance = S({ activity: 'other', rawActivity: 'HKWorkoutActivityTypeCardioDance',
                      durationSec: 3600 });
    const run = S({ activity: 'running', durationSec: 1800 });
    const bare = S({ activity: 'other', rawActivity: null, durationSec: 900,
                     source: { vendor: 'apple', app: 'Fitbit' } });

    const groups = app.activityGroupsPresent([dance, run, bare]);
    eq('every activity present is offered, mapped or not', groups.length, 3);
    ok('including the unmapped one, by its own name',
       groups.some(g => g.label === 'Dance'));
    ok('and the uncategorised ones, as one entry',
       groups.some(g => g.key === 'unlabelled'));
    eq('ordered by how much time they account for', groups[0].label, 'Dance');

    const key = groups.find(g => g.label === 'Dance').key;
    const share = app.timeByActivity([dance, run, bare], { exclude: [key] });
    ok('hiding it removes the row', !share.some(r => r.label === 'Dance'));
    eq('and its time leaves the denominator, so the rest add up',
       Math.round(share.reduce((n, r) => n + r.pct, 0)), 100);

    // A canonical id must keep working: that is what every existing setting holds.
    const noRun = app.timeByActivity([dance, run], { exclude: ['running'] });
    eq('a plain activity id still excludes', noRun.length, 1);
    eq('leaving the other at the whole of the time', Math.round(noRun[0].pct), 100);

    // Active days uses the same list, so "set aside" means set aside everywhere.
    const days = app.activeDays([dance], '2026-03-01', '2026-03-03', [key]);
    eq('a day of only set-aside activity is not an active day', days.active, 0);
    eq('but it is not counted as nothing happening either', days.ambientOnly, 1);
    eq('while counting it makes the day active',
       app.activeDays([dance], '2026-03-01', '2026-03-03', []).active, 1);
  });

  suite('heart-rate bands follow the same exclusions', () => {
    // The inconsistency this closes: time by heart rate was a daily figure, so an
    // activity set aside vanished from every card except that one, which went on
    // reporting its minutes.
    const dance = S({ activity: 'other', rawActivity: 'HKWorkoutActivityTypeCardioDance',
                      durationSec: 3600, hrBands: { 120: 1800, 140: 600 } });
    const run = S({ durationSec: 1800, hrBands: { 140: 900, 160: 300 } });
    const all = app.hrBandTotals([dance, run]);
    const at = (rows, floor) => rows.find(r => r.floor === floor).seconds;

    eq('bands sum across workouts', at(all, 140), 1500);
    eq('every band is reported, including the empty ones', all.length, 6);
    eq('a band nobody reached is zero rather than missing', at(all, 180), 0);

    const key = app.sessionKey(dance);
    const kept = app.hrBandTotals([dance, run], { exclude: [key] });
    eq('setting an activity aside takes its heart rate with it', at(kept, 140), 900);
    eq('and its other bands too', at(kept, 120), 0);

    // Dedupe already decided which copy of a workout is real; the bands must respect
    // that, or two sources recording one run double its time above 140.
    const loser = S({ durationSec: 1800, hrBands: { 140: 900 }, supersededBy: 'x' });
    eq('a superseded copy contributes nothing',
       at(app.hrBandTotals([run, loser]), 140), 900);
  });

  suite('where the time goes', () => {
    const share = app.timeByActivity([
      S({ activity: 'running', durationSec: 3600 }),
      S({ activity: 'strength', durationSec: 5400 }),
      S({ activity: 'strength', durationSec: 1800 }),
      S({ activity: 'racket', durationSec: 1800 })
    ]);
    eq('the biggest share leads', share[0].activity, 'strength');
    eq('and it is a share of time, not of sessions', Math.round(share[0].pct), 57);
    eq('every activity is represented', share.length, 3);
    eq('shares add up', Math.round(share.reduce((n, s) => n + s.pct, 0)), 100);

    // Walking is ambient rather than chosen and swamps everything when included.
    const withWalk = [S({ activity: 'walking', durationSec: 36000 }),
                      S({ activity: 'running', durationSec: 3600 })];
    eq('an excluded activity is left out',
       app.timeByActivity(withWalk, { exclude: ['walking'] }).map(s => s.activity), ['running']);
    eq('or kept in when nothing is excluded', app.timeByActivity(withWalk).length, 2);
    // The list is a setting, not a rule: somebody whose training is walking excludes
    // something else instead.
    eq('any activity can be the excluded one',
       app.timeByActivity(withWalk, { exclude: ['running'] }).map(s => s.activity), ['walking']);

    eq('a superseded session never counts',
       app.timeByActivity([S({ durationSec: 3600, supersededBy: 'x' })]).length, 0);
  });

  suite('average heart rate per sport', () => {
    // Weighted by duration: a ten-minute warm-up must not count as much as a
    // two-hour ride when averaging.
    const hr = app.avgHrByActivity([
      S({ activity: 'running', avgHr: 160, durationSec: 7200 }),
      S({ activity: 'running', avgHr: 120, durationSec: 600 }),
      S({ activity: 'strength', avgHr: 110, durationSec: 3600 })
    ]);
    const run = hr.find(h => h.activity === 'running');
    eq('running averages toward the longer session', run.avgHr, 157);
    eq('the hardest sport leads', hr[0].activity, 'running');
    eq('session counts come along', run.sessions, 2);
    eq('as does the highest single session', run.highestSessionAvg, 160);
    eq('sessions with no heart rate are skipped',
       app.avgHrByActivity([S({ avgHr: null })]).length, 0);
  });

  suite('running pace', () => {
    eq('pace is seconds per kilometre',
       app.sessionPace({ distanceM: 10000, durationSec: 3000 }), 300);
    eq('and renders as minutes and seconds', app.formatPace(300), '5:00 /km');
    eq('padding the seconds', app.formatPace(305), '5:05 /km');

    // Implausible values are data errors, not achievements.
    eq('faster than a world record is rejected',
       app.sessionPace({ distanceM: 10000, durationSec: 600 }), null);
    eq('slower than walking is not a run',
       app.sessionPace({ distanceM: 1000, durationSec: 2400 }), null);
    eq('a distance too short to mean anything is rejected',
       app.sessionPace({ distanceM: 200, durationSec: 60 }), null);
    eq('a session with no distance has no pace',
       app.sessionPace({ durationSec: 1800 }), null);

    const prog = app.paceProgression([
      S({ localDate: '2026-01-05', distanceM: 5000, durationSec: 1800 }),   // 6:00/km
      S({ localDate: '2026-01-20', distanceM: 5000, durationSec: 1500 }),   // 5:00/km
      S({ localDate: '2026-02-10', distanceM: 10000, durationSec: 2700 })   // 4:30/km
    ]);
    eq('one entry per month', prog.length, 2);
    // Weighted by distance: total time over total distance, so a short sprint does
    // not outweigh a long steady run.
    eq('January is the weighted average of its runs', Math.round(prog[0].pace), 330);
    eq('and its best single run is kept', prog[0].best, 300);
    eq('February is faster', Math.round(prog[1].pace), 270);
    eq('runs are counted', prog[0].runs, 2);

    const best = app.bestPaces([
      S({ localDate: '2026-01-05', distanceM: 5000, durationSec: 1800 }),
      S({ localDate: '2026-02-10', distanceM: 5000, durationSec: 1350 })
    ]);
    eq('the fastest run leads', best[0].date, '2026-02-10');
  });

  suite('active days', () => {
    // Walking does not make a day active: a day at a desk still records a walk to
    // the kitchen, and counting it makes every day look active.
    const days = app.activeDays([
      S({ localDate: '2026-03-01', activity: 'running' }),
      S({ localDate: '2026-03-01', activity: 'walking' }),
      S({ localDate: '2026-03-02', activity: 'walking' }),
      S({ localDate: '2026-03-04', activity: 'strength' })
    ], '2026-03-01', '2026-03-05', ['walking']);

    // With walking counted as training, the walking-only day becomes active.
    const walkerDays = app.activeDays([
      S({ localDate: '2026-03-01', activity: 'running' }),
      S({ localDate: '2026-03-02', activity: 'walking' })
    ], '2026-03-01', '2026-03-05', []);
    eq('a walker who counts walking gets both days', walkerDays.active, 2);
    eq('and nothing is set aside', walkerDays.ambientOnly, 0);

    eq('two genuinely active days', days.active, 2);
    eq('one day of only uncounted activity', days.ambientOnly, 1);
    eq('and two with nothing at all', days.inactive, 2);
    eq('which adds up to the range', days.active + days.walkingOnly + days.inactive, days.total);
    eq('a day with both counts as active, not as walking-only', days.dates.has('2026-03-01'), true);
    eq('the share is of the whole range', Math.round(days.pct), 40);
  });
}

// --- run ------------------------------------------------------------------------------
(async () => {
  try {
    await appleTests();
    fixtureDedupeTests();
    rollupTests();
    motivationTests();
    chartTests();
    insightsTests();
    await heartRateSpanTests();
    await heartRateWindowTests();
    await zipTests();
    await takeoutTests();
    fitbitParseTests();
    await fitbitImportTests();
  } catch (err) {
    failed++;
    console.log(`\n${C.red}Uncaught: ${err && err.stack || err}${C.off}`);
  }
  console.log(`\n${failed ? C.red : C.green}${passed} passed, ${failed} failed${C.off}\n`);
  process.exit(failed ? 1 : 0);
})();
