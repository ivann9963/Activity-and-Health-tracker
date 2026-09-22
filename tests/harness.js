// Test harness: loads the browser-global app modules into a sandboxed Node context
// (with minimal DOM/storage stubs) so the REAL functions are unit-tested, not a copy.
// Same approach as the sibling Personal-Finance repo.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
// Order matters: config defines constants the rest close over.
const FILES = [
  'js/config.js',
  'js/dates.js',
  'js/metrics.js',
  'js/activity-types.js',
  'js/records.js',
  'js/import/normalize.js',
  'js/import/csv.js',
  'js/import/xml-stream.js',
  'js/import/zip.js',
  'js/import/apple-health.js',
  'js/import/fitbit-parse.js',
  'js/import/fitbit-takeout.js',
  'js/import/sniffer.js',
  'js/import/inspector.js',
  'js/dedupe/rules.js',
  'js/dedupe/sessions.js',
  'js/dedupe/streams.js',
  'js/rollups.js',
  'js/equivalences.js',
  'js/streaks.js',
  'js/goals.js',
  'js/charts.js',
  'js/insights.js',
  'js/targets.js',
  'js/recategorise.js'
];

function loadApp() {
  const sandbox = {
    console, Intl,
    TextDecoder, TextEncoder,
    Blob, Response, ReadableStream, DecompressionStream, CompressionStream,
    setTimeout, clearTimeout,
    // The parsers never touch these, but sniffer/inspector reference them at load time.
    document: { getElementById: () => null },
    window: {}, navigator: {},
    indexedDB: undefined
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const src = FILES
    .filter(f => fs.existsSync(path.join(ROOT, f)))
    .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8'))
    .join('\n;\n');

  vm.runInContext(src + `
    ;globalThis.__app = {
      // dates
      localDateOf, todayLocal, addDays, daysBetween, dateRange,
      startOfWeek, endOfWeek, startOfMonth, endOfMonth, startOfYear, endOfYear,
      periodBounds, shiftPeriod,
      // metrics
      METRICS, METRIC_ORDER, metricIds, visibleMetricIds, aggregate, formatMetric,
      formatMetricAxis, niceCeiling, barPath,
      // taxonomy
      ACTIVITIES, canonicalActivity, activitiesCompatible,
      humaniseRawActivity, activityLabel, activityGroupKey,
      // records
      hash64, makeSession, makeDaily, sourceLabel,
      // import
      toMetres, toSeconds, toKg, toKcal, normalizeSourceName, deviceNameFrom, intern,
      parseCSV, parseCSVObjects,
      XmlTagScanner, xmlUnescape, parseAttrs,
      zipEntries, zipEntryText, zipEntryStream,
      parseAppleDate, AppleCollector, scanAppleExport, APPLE_DAILY_METRICS,
      scanAppleWorkoutWindows, windowsFromSessions, insideWindow, windowAt,
      sniffFile, humanSize,
      isTakeoutArchive, takeoutFolders, inspectTakeout, describeSample, importTakeout,
      parseFitbitDate, classifyFitbitFile, fitbitWeightUnit,
      parseFitbitSteps, parseFitbitSleep, parseFitbitExercise, parseFitbitRestingHr,
      parseFitbitWeight, parseFitbitHeartRate, createFitbitCollector, DailyBuckets,
      inspectFile, inspectionReportText,
      // dedupe + rollups (present from phase 3 onward)
      dedupeSessions, applySessionDecisions, applyOverride,
      unnamedSessions, applyActivityOverrides,
      electDailySources, applyDailyDecisions,
      sessionsOverlap, overlapRatio, sourceRank, pickWinner, richness,
      PARTIAL_WEAR_RATIO,
      computeRollups,
      distanceEquivalence, durationEquivalence, stepsEquivalence, equivalenceFor,
      dayStreaks, weekStreaks, bestDay, bestPeriod, activeThreshold,
      niceTarget, deriveTarget, goalProgress,
      activityFromKeywords, recategorisePlan, recategoriseSummary,
      timeByActivity, avgHrByActivity, sessionPace, formatPace, paceProgression,
      bestPaces, activeDays, sessionKey, isExcluded, activityGroupsPresent, hrBandTotals,
      targetComparison, meetsTarget, targetResult, workoutStreaks, sessionRecords,
      formatRecord, DAY_PERIOD,
      DEFAULT_SETTINGS
    };`, sandbox, { filename: 'app-bundle.js' });

  return sandbox.__app;
}

// Build a real ZIP archive in memory, so the ZIP reader is tested against bytes it
// did not produce itself rather than against a mock.
async function makeZip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const raw = enc.encode(content);
    const deflated = new Uint8Array(await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))
    ).arrayBuffer());
    const nameBytes = enc.encode(name);
    const crc = crc32(raw);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);           // version needed
    local.setUint16(8, 8, true);            // method: deflate
    local.setUint32(14, crc, true);
    local.setUint32(18, deflated.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, nameBytes.length, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, deflated);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(10, 8, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, deflated.length, true);
    cd.setUint32(24, raw.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);

    offset += 30 + nameBytes.length + deflated.length;
  }

  const cdBytes = concat(central);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, Object.keys(files).length, true);
  eocd.setUint16(10, Object.keys(files).length, true);
  eocd.setUint32(12, cdBytes.length, true);
  eocd.setUint32(16, offset, true);

  return new Blob([concat(chunks), cdBytes, new Uint8Array(eocd.buffer)]);
}

function concat(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const a of arrays) { out.set(a, p); p += a.length; }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// A Blob with a .name, which is what sniffFile expects from a dropped File.
function namedBlob(blob, name) {
  return Object.assign(blob, { name });
}

module.exports = { loadApp, makeZip, namedBlob };
