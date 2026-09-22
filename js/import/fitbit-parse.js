// === GOOGLE HEALTH / FITBIT TAKEOUT — PARSING ===
// Turns a Takeout archive into canonical records. Pure functions over already-read
// text, so every shape below is testable without a zip or a browser.
//
// Fitbit's export has accumulated layers over the years and the same data appears
// under different folder names depending on when the account was created, so files
// are matched by NAME PATTERN wherever they sit in the archive rather than by folder.
// Anything unrecognised is counted and reported, never silently dropped.

// --- dates ------------------------------------------------------------------------
// Fitbit writes wall-clock local time with no offset: "01/15/24 07:30:00", or ISO
// without a zone: "2024-01-15T07:30:00.000". There is no timezone anywhere in the
// export, so the only sane reading is "the time the user saw on the clock".
//
// We resolve that against the BROWSER's timezone using the Date constructor's local
// components, which applies the rules in force on that date — so historical DST is
// handled correctly. This matters beyond display: an Apple record carries a true UTC
// instant, and if the Fitbit copy of the same run were off by the zone offset the two
// would never be recognised as duplicates and the run would be counted twice.
const FITBIT_SLASH_RE = /^(\d{2})\/(\d{2})\/(\d{2})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/;
const FITBIT_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2}))?/;

function parseFitbitDate(str) {
  const s = String(str || '').trim();
  let y, mo, d, h = 0, mi = 0, sec = 0;

  let m = FITBIT_ISO_RE.exec(s);
  if (m) {
    y = +m[1]; mo = +m[2]; d = +m[3];
    h = +(m[4] || 0); mi = +(m[5] || 0); sec = +(m[6] || 0);
  } else {
    m = FITBIT_SLASH_RE.exec(s);
    if (!m) return null;
    // Two-digit years: Fitbit did not exist before 2007, so a year below 70 is 20xx.
    const yy = +m[3];
    y = yy + (yy < 70 ? 2000 : 1900);
    mo = +m[1]; d = +m[2];
    h = +(m[4] || 0); mi = +(m[5] || 0); sec = +(m[6] || 0);
  }

  const local = new Date(y, mo - 1, d, h, mi, sec);
  if (isNaN(local.getTime())) return null;
  return {
    ms: local.getTime(),
    offsetMin: -local.getTimezoneOffset(),
    localDate: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  };
}

// --- file classification ------------------------------------------------------------
// Ordered: the first pattern that matches wins, so `resting_heart_rate-` is tested
// before the far broader `heart_rate-`.
const FITBIT_FILE_KINDS = [
  { kind: 'resting_hr', re: /(^|\/)resting_heart_rate[-_]/i },
  { kind: 'heart_rate', re: /(^|\/)heart_rate[-_]/i },
  // Must precede the steps rule: `steps[-_]` also matches `steps_intraday`, and
  // reading those would sum the same steps twice.
  { kind: 'ignore',     re: /(^|\/)steps_intraday[-_]/i },
  { kind: 'steps',      re: /(^|\/)steps[-_]/i },
  { kind: 'sleep',      re: /(^|\/)sleep[-_]/i },
  { kind: 'exercise',   re: /(^|\/)(exercise|activities)[-_]/i },
  { kind: 'weight',     re: /(^|\/)weight[-_]/i },
  // Deliberately ignored: these are large and feed nothing the app shows. Distance
  // and calories arrive on the exercise records already; altitude and SpO2 have no
  // home here. time_in_heart_rate_zones is Fitbit's own banding, but its boundaries
  // are percentages of a max heart rate the export does not state, so it cannot be
  // placed on an absolute bpm scale — the raw samples above can.
  { kind: 'ignore',     re: /(^|\/)(altitude|calories|distance|swim_lengths|estimated_oxygen|time_in_heart_rate_zones)[-_]/i }
];

function classifyFitbitFile(name) {
  if (!/\.json$/i.test(name)) return null;
  const hit = FITBIT_FILE_KINDS.find(k => k.re.test(name));
  return hit ? hit.kind : null;
}

// --- per-kind parsers ---------------------------------------------------------------
// Each takes parsed JSON and pushes onto a collector. They tolerate both the array
// form and a single object, because both occur across export vintages.

function asArray(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') return [data];
  return [];
}

// Intraday step buckets, summed into days. A file may hold a day or a month depending
// on the export's age, so the day comes from each entry rather than from the filename.
function parseFitbitSteps(data, out) {
  for (const row of asArray(data)) {
    const when = parseFitbitDate(row.dateTime || row.date);
    const value = Number(row.value);
    if (!when || !isFinite(value)) continue;
    out.addDaily('steps', when.localDate, value, 'sum', when.ms);
  }
}

// "value" is sometimes the number and sometimes an object carrying it plus an error
// margin: {"date":"01/15/24","value":58.0,"error":6.0}.
function parseFitbitRestingHr(data, out) {
  for (const row of asArray(data)) {
    const when = parseFitbitDate(row.dateTime || row.date);
    const raw = row.value && typeof row.value === 'object' ? row.value.value : row.value;
    const value = Number(raw);
    if (!when || !isFinite(value) || value <= 0) continue;
    out.addDaily('resting_hr', when.localDate, value, 'avg', when.ms);
  }
}

// Sleep is already summarised per night by Fitbit, so unlike Apple there is no need to
// add up stages — minutesAsleep is authoritative. It is attributed to the wake day,
// matching how the Apple side does it.
function parseFitbitSleep(data, out) {
  for (const row of asArray(data)) {
    const minutes = Number(row.minutesAsleep);
    if (!isFinite(minutes) || minutes <= 0) continue;
    const end = parseFitbitDate(row.endTime);
    const stated = row.dateOfSleep ? parseFitbitDate(row.dateOfSleep) : null;
    // dateOfSleep is Fitbit's own wake-day label; trust it when present.
    const day = (stated && stated.localDate) || (end && end.localDate);
    if (!day) continue;
    out.addDaily('sleep', day, minutes, 'sum', end ? end.ms : 0);
  }
}

// Weight units follow the account's preference and the file does not say which, so the
// caller supplies what it found in the profile. Without that we skip rather than guess:
// a number that might be pounds or might be kilograms is worse than no number.
function parseFitbitWeight(data, out, unit) {
  for (const row of asArray(data)) {
    const value = Number(row.weight);
    if (!isFinite(value) || value <= 0) continue;
    const when = parseFitbitDate(row.date ? `${row.date} ${row.time || '12:00:00'}` : row.dateTime);
    if (!when) continue;
    if (!unit) { out.note('weight-unit-unknown'); continue; }
    const kg = toKg(value, unit);
    if (kg == null) continue;
    out.addDaily('weight', when.localDate, kg, 'last', when.ms);
  }
}

function parseFitbitExercise(data, out) {
  for (const row of asArray(data)) {
    const when = parseFitbitDate(row.startTime || row.originalStartTime);
    if (!when) continue;
    // activeDuration excludes pauses and is the better figure when both are present.
    const durMs = Number(row.activeDuration != null ? row.activeDuration : row.duration);
    const durationSec = isFinite(durMs) && durMs > 0 ? Math.round(durMs / 1000) : null;
    if (!durationSec) continue;

    const name = row.activityName || row.activityTypeName || 'Workout';
    const distance = Number(row.distance);
    out.addSession({
      activity: canonicalActivity('fitbit', name),
      rawActivity: name,
      start: when.ms,
      end: when.ms + durationSec * 1000,
      tzOffset: when.offsetMin,
      durationSec,
      distanceM: isFinite(distance) && distance > 0
        ? toMetres(distance, row.distanceUnit || 'km') : null,
      energyKcal: isFinite(Number(row.calories)) ? Number(row.calories) : null,
      avgHr: isFinite(Number(row.averageHeartRate)) ? Math.round(Number(row.averageHeartRate)) : null,
      source: { vendor: 'fitbit', app: 'Google Health', device: 'Fitbit' }
    });
  }
}

// Fitbit records heart rate as instants a few seconds apart, exactly as Apple does,
// so the time attributed to a reading is the gap to the next one — capped, because a
// long gap means the band was off a wrist rather than a long slow heartbeat.
//
// This runs per file, and Fitbit writes one file per day, so the reading that ends a
// file has no successor and contributes nothing. At five-second sampling that loses
// a few seconds a day, which is not worth carrying state between files to recover.
const FITBIT_HR_GAP_CAP_MS = 5 * 60 * 1000;

function parseFitbitHeartRate(data, out, workoutWindows) {
  let previous = null;
  for (const row of asArray(data)) {
    const when = parseFitbitDate(row.dateTime || row.date);
    if (!when) continue;
    // Only during a workout — the rest is sitting still, and it drowns the bands.
    // The window also names the workout, so the time can be credited to it.
    const window = workoutWindows ? windowAt(workoutWindows, when.ms) : null;
    const owner = window ? window[2] : null;
    if (workoutWindows && !window) { previous = null; continue; }
    const bpm = Number(row.value && typeof row.value === 'object' ? row.value.bpm : row.value);
    if (!isFinite(bpm) || bpm <= 0) { previous = null; continue; }

    // Only the gap between two readings of the same workout is measured time; across
    // a boundary the next reading may be hours and a different sport away.
    if (previous && previous.owner === owner) {
      const gap = when.ms - previous.ms;
      if (gap > 0) {
        out.band(previous.owner, previous.bpm, Math.min(gap, FITBIT_HR_GAP_CAP_MS) / 1000);
      }
    }
    previous = { ms: when.ms, bpm, owner };
  }
}

const FITBIT_PARSERS = {
  steps: parseFitbitSteps,
  resting_hr: parseFitbitRestingHr,
  heart_rate: parseFitbitHeartRate,
  sleep: parseFitbitSleep,
  exercise: parseFitbitExercise
};

// Fitbit's profile export records the account's unit preferences, which is the only
// place the weight unit is stated.
function fitbitWeightUnit(profileCsvText) {
  if (!profileCsvText) return null;
  const rows = parseCSVObjects(profileCsvText);
  if (!rows.length) return null;
  const row = rows[0];
  const key = Object.keys(row).find(k => /weight.*unit|unit.*weight/i.test(k));
  const raw = key ? String(row[key]).trim().toUpperCase() : '';
  if (/^(KILOGRAM|KG|METRIC)/.test(raw)) return 'kg';
  if (/^(POUND|LB|US|EN_US)/.test(raw)) return 'lb';
  if (/^(STONE|ST|UK|EN_GB)/.test(raw)) return 'st';
  return null;
}

if (typeof module !== 'undefined') {
  module.exports = { parseFitbitDate, classifyFitbitFile, parseFitbitSteps,
                     parseFitbitRestingHr, parseFitbitSleep, parseFitbitWeight,
                     parseFitbitExercise, parseFitbitHeartRate, fitbitWeightUnit };
}
