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

async function appleTests() {
  const res = await parseFixture(1 << 20); // one chunk
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

// --- run ------------------------------------------------------------------------------
(async () => {
  try {
    await appleTests();
    await zipTests();
  } catch (err) {
    failed++;
    console.log(`\n${C.red}Uncaught: ${err && err.stack || err}${C.off}`);
  }
  console.log(`\n${failed ? C.red : C.green}${passed} passed, ${failed} failed${C.off}\n`);
  process.exit(failed ? 1 : 0);
})();
