// Times the parser against a large export, in Node, with no browser in the way.
//   node tools/perf-parse.js <file.xml>
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { loadApp } = require('../tests/harness');

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('usage: node tools/perf-parse.js <export.xml>');
  process.exit(1);
}

const app = loadApp();
const size = fs.statSync(file).size;

(async () => {
  // Forcing a collection before and after separates real retention from garbage that
  // simply has not been collected yet — without it the number is meaningless.
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  let peakRss = process.memoryUsage().rss;
  const watch = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 50);
  const started = Date.now();
  const stream = Readable.toWeb(fs.createReadStream(file, { highWaterMark: 1 << 20 }));
  const res = await app.scanAppleExport(stream, { collect: true, importBatch: 'perf' });
  const ms = Date.now() - started;
  clearInterval(watch);
  if (global.gc) global.gc();
  const peak = process.memoryUsage().heapUsed;

  console.log(`file        ${(size / 1048576).toFixed(1)} MB`);
  console.log(`parsed in   ${(ms / 1000).toFixed(1)}s  (${(size / 1048576 / (ms / 1000)).toFixed(1)} MB/s)`);
  console.log(`records     ${res.tally.records.toLocaleString()}`);
  console.log(`workouts    ${res.tally.workouts.toLocaleString()}`);
  console.log(`-> sessions ${res.sessions.length.toLocaleString()}`);
  console.log(`-> daily    ${res.daily.length.toLocaleString()}`);
  console.log(`retained    ${((peak - before) / 1048576).toFixed(0)} MB after collection` +
              (global.gc ? '' : '  (run with --expose-gc for a real figure)'));
  console.log(`peak RSS    ${(peakRss / 1048576).toFixed(0)} MB during the parse`);
  console.log(`stored JSON ${(JSON.stringify({ s: res.sessions, d: res.daily }).length / 1048576).toFixed(1)} MB`);

  // The reduction is the whole point of storing aggregates rather than samples.
  console.log(`reduction   ${(size / JSON.stringify({ s: res.sessions, d: res.daily }).length).toFixed(0)}x smaller than the source`);

  const settings = app.DEFAULT_SETTINGS;
  let t = Date.now();
  const sessionDecisions = app.dedupeSessions(res.sessions, settings, {});
  const sessionMs = Date.now() - t;
  t = Date.now();
  const dailyDecisions = app.electDailySources(res.daily, settings, {});
  const dailyMs = Date.now() - t;
  app.applySessionDecisions(sessionDecisions);
  app.applyDailyDecisions(dailyDecisions);

  console.log(`dedupe      sessions ${sessionMs}ms · daily ${dailyMs}ms`);
  console.log(`suppressed  ${sessionDecisions.filter(d => d.supersededBy).length} sessions · ` +
              `${dailyDecisions.filter(d => d.supersededBy).length} daily`);

  t = Date.now();
  const from = res.tally.from, to = res.tally.to;
  const roll = app.computeRollups(res.sessions, res.daily, from, to, app.metricIds());
  console.log(`rollup      ${Date.now() - t}ms for ${app.metricIds().length} metrics over ${from}..${to}`);
  console.log(`            running total ${app.formatMetric('distance_run', roll.distance_run.value)}`);
})();
