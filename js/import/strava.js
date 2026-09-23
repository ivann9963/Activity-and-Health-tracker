// === STRAVA BULK EXPORT ===
// The direct route for anyone without an iPhone, and the honest route for anyone with
// one. Strava can push its workouts into Apple Health, but what arrives there is a
// lossy copy: a sport Apple has no type for becomes HKWorkoutActivityTypeOther, the
// distance often goes missing, and the relay only reaches back as far as it was
// switched on. Read from Strava's own archive, the same workout keeps its sport, its
// distance, and the heart-rate trace of the file the watch uploaded.
//
// The archive is activities.csv plus activities/<id>.fit.gz|.gpx|.tcx.gz, one file
// per workout. The CSV is the list; the files add what the CSV cannot say.

// --- the CSV ------------------------------------------------------------------------
// Strava repeats column names. The first block is in the athlete's display units
// (Distance in km OR miles, depending on a preference the file does not state); a
// second block, added later, repeats Elapsed Time and Distance in SI units. So the
// LAST "Distance" is metres, and a file with only one "Distance" has a unit it does
// not name — which is read as no distance at all, never as a guess between km and mi.
function stravaColumns(header) {
  const idx = Object.create(null);
  header.forEach((h, i) => {
    const key = String(h).trim().toLowerCase();
    (idx[key] = idx[key] || []).push(i);
  });
  const first = name => (idx[name] ? idx[name][0] : -1);
  const last = name => (idx[name] ? idx[name][idx[name].length - 1] : -1);
  return {
    id: first('activity id'),
    date: first('activity date'),
    name: first('activity name'),
    type: first('activity type'),
    elapsed: last('elapsed time'),
    moving: last('moving time'),
    distanceM: idx['distance'] && idx['distance'].length > 1 ? last('distance') : -1,
    avgHr: last('average heart rate'),
    calories: last('calories'),
    filename: first('filename')
  };
}

// "Activity Date" is UTC, written in English as "Mar 12, 2024, 7:41:22 AM" (or with the
// day first, depending on the account's locale). ISO is accepted too. A date in any
// other language is reported as unreadable rather than guessed at.
const STRAVA_MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
                        jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const STRAVA_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2}):(\d{2})/;
const STRAVA_TIME_RE = /(\d{1,2}):(\d{2}):(\d{2})\s*([AaPp][Mm])?/;

function parseStravaDate(str) {
  const s = String(str || '').trim();
  let m = STRAVA_ISO_RE.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);

  const month = /([A-Za-z]{3})[a-z]*\.?/.exec(s);
  const mo = month ? STRAVA_MONTHS[month[1].toLowerCase()] : undefined;
  const time = STRAVA_TIME_RE.exec(s);
  if (mo === undefined || !time) return null;
  const datePart = s.slice(0, time.index);
  const year = /\b(\d{4})\b/.exec(datePart);
  const day = /\b(\d{1,2})\b/.exec(datePart.replace(/\b\d{4}\b/, ''));
  if (!year || !day) return null;

  let h = +time[1];
  const ampm = time[4] && time[4].toLowerCase();
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  const ms = Date.UTC(+year[1], mo, +day[1], h, +time[2], +time[3]);
  return isFinite(ms) ? ms : null;
}

function stravaNumber(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}

// The CSV as a list of workouts, before any file is opened. Rows that cannot be placed
// in time are counted in `notes`, not dropped silently.
function readStravaActivities(text) {
  const rows = parseCSV(text);
  const notes = Object.create(null);
  const note = k => { notes[k] = (notes[k] || 0) + 1; };
  if (!rows.length) return { activities: [], notes, distanceUnitKnown: false };

  const col = stravaColumns(rows[0]);
  if (col.date === -1 || col.type === -1) throw new Error('activities.csv has no Activity Date or Activity Type column');
  const cell = (r, i) => (i === -1 ? '' : r[i]);

  const activities = [];
  for (const r of rows.slice(1)) {
    if (r.length < 2) continue;
    const start = parseStravaDate(cell(r, col.date));
    if (start == null) { note('unreadable date'); continue; }
    const elapsed = stravaNumber(cell(r, col.elapsed));
    const moving = stravaNumber(cell(r, col.moving));
    // Moving time is Strava's headline figure and excludes stops, as Apple's and
    // Fitbit's durations do; elapsed time is what the clock saw, and is what the
    // workout's span must be for it to overlap its copies elsewhere.
    const spanSec = elapsed > 0 ? elapsed : moving;
    if (!(spanSec > 0)) { note('no duration'); continue; }
    const type = String(cell(r, col.type) || '').trim();
    const distance = stravaNumber(cell(r, col.distanceM));
    const hr = stravaNumber(cell(r, col.avgHr));
    const kcal = stravaNumber(cell(r, col.calories));
    activities.push({
      stravaId: String(cell(r, col.id) || '').trim(),
      rawActivity: type ? intern(type) : null,
      start,
      spanSec: Math.round(spanSec),
      durationSec: Math.round(moving > 0 ? moving : spanSec),
      distanceM: distance > 0 ? distance : null,
      avgHr: hr > 0 ? Math.round(hr) : null,
      energyKcal: kcal > 0 ? kcal : null,
      filename: String(cell(r, col.filename) || '').trim()
    });
  }
  return { activities, notes, distanceUnitKnown: col.distanceM !== -1 };
}

// --- one workout --------------------------------------------------------------------
// The browser's own zone, at that instant, is the fallback when nothing in the archive
// states the offset. Only FIT files do; GPX and TCX times are bare UTC. The same
// compromise as Fitbit's wall-clock times, and right whenever the workout happened in
// the zone the importing device is set to.
function fallbackOffset(ms) { return -new Date(ms).getTimezoneOffset(); }

const STRAVA_SOURCE = { vendor: 'strava', app: 'Strava', device: null };

function stravaSession(a, fileData, opts) {
  const o = opts || {};
  let start = a.start;
  // The CSV's time is UTC. If a workout file disagrees by half an hour or more, the
  // CSV was written in some other zone and the device's own record is the truth.
  if (fileData && fileData.startMs != null && Math.abs(fileData.startMs - start) >= 30 * 60000) {
    start = fileData.startMs;
  }
  const offset = fileData && fileData.offsetMin != null ? fileData.offsetMin : fallbackOffset(start);
  const samples = fileData ? fileData.samples : null;
  let avgHr = a.avgHr;
  const beats = samples ? samples.filter(s => s.bpm != null) : [];
  if (avgHr == null && beats.length) {
    avgHr = Math.round(beats.reduce((n, s) => n + s.bpm, 0) / beats.length);
  }
  const rec = makeSession({
    activity: canonicalActivity('strava', a.rawActivity),
    rawActivity: a.rawActivity,
    start,
    end: start + a.spanSec * 1000,
    tzOffset: offset,
    durationSec: a.durationSec,
    distanceM: a.distanceM != null ? a.distanceM
             : (fileData && fileData.distanceM > 0 ? fileData.distanceM : null),
    energyKcal: a.energyKcal,
    avgHr,
    hrBands: samples ? bandsFromSamples(samples) : null,
    source: STRAVA_SOURCE,
    importBatch: o.importBatch || null,
    importedAt: o.importedAt
  });
  return rec;
}

// --- the archive --------------------------------------------------------------------
function readZipBytes(file, entry, gzip) {
  return zipEntryStream(file, entry).then(stream =>
    new Response(gzip ? stream.pipeThrough(new DecompressionStream('gzip')) : stream).arrayBuffer());
}

// Import a Strava export: the zipped archive, or activities.csv on its own (which gives
// every workout, but no heart rate and no recorded time zone).
function importStrava(file, sniff, opts) {
  const o = opts || {};
  const importedAt = o.importedAt || Date.now();
  const csvText = sniff.kind === 'strava-zip' ? zipEntryText(file, sniff.entry) : file.text();

  return csvText.then(text => {
    const parsed = readStravaActivities(text);
    const notes = parsed.notes;
    const note = k => { notes[k] = (notes[k] || 0) + 1; };
    if (!parsed.distanceUnitKnown) note('distance unit not stated');

    // Filenames in the CSV are relative to the folder activities.csv sits in.
    const byName = new Map();
    let prefix = '';
    if (sniff.kind === 'strava-zip') {
      prefix = sniff.entry.name.replace(/activities\.csv$/i, '');
      for (const e of sniff.entries || []) byName.set(e.name, e);
    }

    const sessions = [];
    const work = parsed.activities.slice();
    const total = work.length;
    let done = 0, filesRead = 0, filesFailed = 0;

    const step = () => {
      if (!work.length) return Promise.resolve();
      const a = work.shift();
      const fmt = activityFileFormat(a.filename);
      const entry = fmt ? byName.get(prefix + a.filename) || byName.get(a.filename) : null;

      const read = entry
        ? readZipBytes(file, entry, fmt.gzip)
            .then(buf => { filesRead++; return parseActivityFile(fmt.format, buf); })
            .catch(err => {
              // One corrupt file costs that workout its heart rate, not the import.
              filesFailed++;
              note('unreadable workout file');
              console.warn('[strava] could not read', a.filename, err.message);
              return null;
            })
        : Promise.resolve(null);
      if (!entry && sniff.kind === 'strava-zip') {
        note(a.filename ? (fmt ? 'workout file missing' : 'workout file of unknown kind')
                        : 'no workout file (entered by hand)');
      }

      return read.then(fileData => {
        sessions.push(stravaSession(a, fileData, { importBatch: o.importBatch, importedAt }));
        done++;
        if (o.onProgress && done % 10 === 0) o.onProgress(done, total);
        return step();
      });
    };

    return step().then(() => {
      const dates = sessions.map(s => s.localDate).sort();
      return {
        sessions,
        daily: [],
        meta: { filesRead, filesFailed, notes },
        tally: {
          records: 0,
          workouts: sessions.length,
          from: dates[0] || null,
          to: dates[dates.length - 1] || null,
          sources: { Strava: sessions.length },
          types: {},
          notes
        }
      };
    });
  });
}

if (typeof module !== 'undefined') {
  module.exports = { stravaColumns, parseStravaDate, readStravaActivities, stravaSession,
                     importStrava };
}
