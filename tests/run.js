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
    eq('every Record element is counted', res.tally.records, 17);
    eq('every Workout element is counted', res.tally.workouts, 6);
    eq('the export date is read', res.meta.exportDate, '2026-09-20 11:02:19 +0300');
    eq('coverage starts at the oldest record', res.tally.from, '2019-06-01');
    eq('coverage ends at the newest', res.tally.to, '2026-07-04');

    eq('one session per workout', res.sessions.length, 6);
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
    eq('per-second heart rate is skipped on purpose',
       app.classifyFitbitFile('Global Export Data/heart_rate-2026-07-01.json'), 'ignore');
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

    ok('per-second heart rate is never read',
       !res.daily.some(d => d.metric === 'heart_rate'));
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

// --- run ------------------------------------------------------------------------------
(async () => {
  try {
    await appleTests();
    fixtureDedupeTests();
    rollupTests();
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
