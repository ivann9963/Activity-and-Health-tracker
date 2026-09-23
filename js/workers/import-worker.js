// === IMPORT WORKER ===
// Parsing happens off the main thread. A multi-hundred-megabyte export takes tens of
// seconds to read, and doing that on the UI thread would freeze the tab hard enough
// that the browser offers to kill the page — while also making the progress bar,
// the one thing that would reassure the user, impossible to paint.
//
// Loaded as a classic worker so the same plain script files the page uses can be
// reused verbatim, with no build step and no duplicate module system.

importScripts(
  '../config.js',
  '../dates.js',
  // The parser buckets heart-rate readings into bands defined in the metric registry,
  // so the worker needs it too. Leaving it out made every import throw.
  '../metrics.js',
  '../activity-types.js',
  '../records.js',
  '../import/normalize.js',
  '../import/zip.js',
  '../import/xml-stream.js',
  '../import/apple-health.js',
  '../import/csv.js',
  '../import/fitbit-parse.js',
  '../import/fitbit-takeout.js',
  '../import/activity-files.js',
  '../import/strava.js'
);

self.onmessage = function (ev) {
  const { file, kind, entry, entries, batch } = ev.data;

  // Progress is throttled here rather than in the page: posting a message per chunk
  // would flood the main thread with exactly the work we moved off it.
  let lastPost = 0;
  const onProgress = bytes => {
    const now = Date.now();
    if (now - lastPost < 120) return;
    lastPost = now;
    self.postMessage({ type: 'progress', bytes });
  };

  // A Takeout archive is thousands of small files rather than one huge one, so it
  // reports progress by file count and its own walker handles the streaming.
  // Apple exports are read twice. The first pass reads only workouts, to learn when
  // they happened; the second uses those windows so heart rate is banded during
  // training rather than across the whole day. Skipping every Record makes the first
  // pass a fraction of the second, and the alternative — holding every sample in
  // memory until the workouts arrive at the end of the file — does not survive a
  // decade of data on a phone.
  const byCount = (done, total) => self.postMessage({ type: 'progress', done, total });
  const parse = kind === 'fitbit-zip'
    ? importTakeout(file, entries, { importBatch: batch, onProgress: byCount })
    // A Strava archive is a CSV plus one small file per workout — like Takeout, it
    // reports progress by count.
    : kind === 'strava-zip' || kind === 'strava-csv'
    ? importStrava(file, { kind, entry, entries }, { importBatch: batch, onProgress: byCount })
    : openStream(file, kind, entry)
        .then(stream => scanAppleWorkoutWindows(stream, {
          onProgress: bytes => self.postMessage({ type: 'progress', bytes, phase: 'windows' })
        }))
        .then(workoutWindows => openStream(file, kind, entry)
          .then(stream => scanAppleExport(stream, {
            collect: true, importBatch: batch, workoutWindows, onProgress
          })));

  parse
    .then(res => {
      self.postMessage({
        type: 'done',
        sessions: res.sessions,
        daily: res.daily,
        tally: res.tally,
        meta: res.meta,
        bytes: res.bytes || 0
      });
    })
    .catch(err => {
      self.postMessage({ type: 'error', message: err && err.message || String(err) });
    });
};

function openStream(file, kind, entry) {
  if (kind === 'apple-zip') return zipEntryStream(file, entry);
  if (kind === 'apple-xml') return Promise.resolve(file.stream());
  return Promise.reject(new Error('The worker cannot read ' + kind + ' files'));
}
