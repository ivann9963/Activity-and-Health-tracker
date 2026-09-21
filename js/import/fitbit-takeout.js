// === GOOGLE HEALTH / FITBIT TAKEOUT ===
// Google renamed the Fitbit app to Google Health in May 2026 but left the underlying
// data category alone, so a Google Health export still arrives from Takeout labelled
// "Fitbit", as Takeout/Fitbit/… inside the archive.
//
// The layout of that archive has changed across Fitbit's own history — folder names,
// file names and JSON field names all differ by export vintage — so rather than
// guessing a schema, this inspects: it reports the folders, the date coverage implied
// by the file names, and the actual keys found inside a sample of each kind of file.
// That report is what a parser should be written against.

const TAKEOUT_ROOT_RE = /^(Takeout\/)?Fitbit\//i;

// Most Fitbit export files carry their date in the name, in one of a few shapes:
//   steps-2024-01-15.json · sleep-2024-01-15.json · steps-2024-01-15.csv
//   Physical Activity/steps-2024-01-15.json
// Files without a date (exercise-0.json, Your Profile) are reported separately.
const FILE_DATE_RE = /(\d{4})-(\d{2})-(\d{2})/;

function isTakeoutArchive(entries) {
  return entries.some(e => TAKEOUT_ROOT_RE.test(e.name));
}

// Group an archive's entries by the folder they live in, which is how Fitbit
// separates data types (Sleep/, Heart Rate/, Global Export Data/, …).
function takeoutFolders(entries) {
  const folders = new Map();
  for (const e of entries) {
    if (!TAKEOUT_ROOT_RE.test(e.name)) continue;
    const rel = e.name.replace(TAKEOUT_ROOT_RE, '');
    const slash = rel.lastIndexOf('/');
    const folder = slash === -1 ? '(root)' : rel.slice(0, slash);
    const file = rel.slice(slash + 1);
    if (!file) continue; // a directory entry
    if (!folders.has(folder)) {
      folders.set(folder, { name: folder, files: [], from: null, to: null, bytes: 0 });
    }
    const f = folders.get(folder);
    f.files.push({ name: file, entry: e, size: e.uncompressedSize });
    f.bytes += e.uncompressedSize || 0;
    const m = FILE_DATE_RE.exec(file);
    if (m) {
      const key = `${m[1]}-${m[2]}-${m[3]}`;
      if (!f.from || key < f.from) f.from = key;
      if (!f.to || key > f.to) f.to = key;
    }
  }
  return [...folders.values()].sort((a, b) => b.files.length - a.files.length);
}

// Read one modest file per folder and describe its shape: whether it is an array or an
// object, how many entries, and which keys the first entry carries. This is the part
// that removes the guesswork from writing the real parser.
function sampleFolder(file, folder) {
  // Prefer a small file — some heart-rate exports are tens of megabytes per day, and
  // we only need to see the shape.
  const candidates = folder.files
    .filter(f => /\.(json|csv)$/i.test(f.name) && f.size > 2)
    .sort((a, b) => a.size - b.size);
  if (!candidates.length) return Promise.resolve(null);

  const pick = candidates[Math.floor(candidates.length / 2)] || candidates[0];
  return zipEntryText(file, pick.entry)
    .then(text => describeSample(pick.name, text))
    .catch(err => ({ file: pick.name, error: err.message }));
}

function describeSample(name, text) {
  if (/\.csv$/i.test(name)) {
    const rows = parseCSV(text.slice(0, 20000));
    return { file: name, format: 'csv', count: Math.max(0, rows.length - 1),
             keys: (rows[0] || []).slice(0, 20) };
  }
  let data;
  try { data = JSON.parse(text); }
  catch (err) { return { file: name, format: 'json', error: 'could not be parsed: ' + err.message }; }

  if (Array.isArray(data)) {
    const first = data.find(v => v && typeof v === 'object');
    return { file: name, format: 'json-array', count: data.length,
             keys: first ? Object.keys(first).slice(0, 25) : [],
             example: first ? truncateValues(first) : null };
  }
  if (data && typeof data === 'object') {
    return { file: name, format: 'json-object', count: 1,
             keys: Object.keys(data).slice(0, 25), example: truncateValues(data) };
  }
  return { file: name, format: 'json', count: 0, keys: [] };
}

// Keep the example small: it is shown in a report, not used as data, and a nested
// sleep-stages object can run to hundreds of entries.
function truncateValues(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj).slice(0, 12)) {
    if (v == null) out[k] = null;
    else if (typeof v === 'object') out[k] = Array.isArray(v) ? `[${v.length} items]` : '{…}';
    else out[k] = String(v).slice(0, 60);
  }
  return out;
}

// What a folder's files will feed, decided by the same classifier the importer uses so
// the report cannot promise something the import then ignores.
const FITBIT_KIND_METRIC = {
  steps: 'steps', resting_hr: 'resting_hr', sleep: 'sleep',
  weight: 'weight', exercise: 'workouts'
};

function folderMetric(folder) {
  const kinds = new Set();
  for (const f of folder.files) {
    const k = classifyFitbitFile(f.name);
    if (k && k !== 'ignore') kinds.add(FITBIT_KIND_METRIC[k]);
  }
  return kinds.size ? [...kinds].join(', ') : null;
}

// Full inspection of a Takeout archive: what is in it, how far back it goes, and the
// real shape of each kind of file.
function inspectTakeout(file, entries) {
  const folders = takeoutFolders(entries);
  // Sampling every folder of a large export would mean dozens of inflate operations;
  // the biggest handful is enough to characterise the archive.
  const toSample = folders.slice(0, 12);

  return Promise.all(toSample.map(f => sampleFolder(file, f).then(s => ({ ...f, sample: s }))))
    .then(sampled => {
      const byName = new Map(sampled.map(f => [f.name, f]));
      const all = folders.map(f => byName.get(f.name) || f);

      let from = null, to = null, fileCount = 0;
      for (const f of all) {
        fileCount += f.files.length;
        if (f.from && (!from || f.from < from)) from = f.from;
        if (f.to && (!to || f.to > to)) to = f.to;
      }

      return {
        totals: { records: fileCount, workouts: 0, bytes: 0 },
        range: { from, to },
        sources: [{ name: 'Google Health (Fitbit)', count: fileCount }],
        types: all.map(f => ({
          type: f.name,
          count: f.files.length,
          from: f.from, to: f.to,
          sources: [{ name: 'Google Health (Fitbit)', count: f.files.length }],
          units: [],
          mapped: folderMetric(f),
          sample: f.sample
        })),
        takeout: true
      };
    });
}

// === IMPORTING A TAKEOUT ARCHIVE ===================================================
// Walks the archive one file at a time. Sequential rather than parallel on purpose:
// a Takeout export can hold thousands of files, and inflating them all at once would
// spike memory for no gain, since the work is I/O-bound on one zip anyway.

function createFitbitCollector(batch, importedAt) {
  const buckets = new DailyBuckets();
  const sessions = [];
  const notes = Object.create(null);
  const source = { vendor: 'fitbit', app: 'Google Health', device: 'Fitbit' };

  return {
    buckets, sessions, notes,
    addDaily(metric, localDate, value, agg, at) {
      buckets.add(metric, localDate, source, value, agg, at);
    },
    addSession(raw) {
      sessions.push(makeSession({ ...raw, importBatch: batch, importedAt }));
    },
    note(key) { notes[key] = (notes[key] || 0) + 1; },
    finish() {
      return { sessions, daily: buckets.toRecords(batch, importedAt), notes };
    }
  };
}

function importTakeout(file, entries, opts) {
  const o = opts || {};
  const batch = o.importBatch || null;
  const importedAt = o.importedAt || Date.now();
  const collector = createFitbitCollector(batch, importedAt);

  // The account's weight unit is stated only in the profile export, so find it first.
  const profile = entries.find(e => /Your Profile\/.*\.csv$/i.test(e.name));
  const unitPromise = profile
    ? zipEntryText(file, profile).then(fitbitWeightUnit).catch(() => null)
    : Promise.resolve(null);

  return unitPromise.then(weightUnit => {
    const work = [];
    const skipped = Object.create(null);
    for (const e of entries) {
      if (!TAKEOUT_ROOT_RE.test(e.name)) continue;
      const kind = classifyFitbitFile(e.name);
      if (!kind || kind === 'ignore') {
        if (/\.json$/i.test(e.name)) skipped[kind || 'unrecognised'] =
          (skipped[kind || 'unrecognised'] || 0) + 1;
        continue;
      }
      if (kind === 'weight' && !weightUnit) { collector.note('weight-unit-unknown'); continue; }
      work.push({ entry: e, kind });
    }

    let done = 0, failed = 0;
    const step = () => {
      if (!work.length) return Promise.resolve();
      const job = work.shift();
      return zipEntryText(file, job.entry)
        .then(text => {
          const data = JSON.parse(text);
          if (job.kind === 'weight') parseFitbitWeight(data, collector, weightUnit);
          else FITBIT_PARSERS[job.kind](data, collector);
        })
        .catch(err => {
          // One malformed file must not abandon an import of thousands. Count it,
          // report it at the end, carry on.
          failed++;
          collector.note('unreadable:' + job.kind);
          console.warn('[takeout] skipped', job.entry.name, err.message);
        })
        .then(() => {
          done++;
          if (o.onProgress && done % 10 === 0) o.onProgress(done, done + work.length);
          return step();
        });
    };

    return step().then(() => {
      const res = collector.finish();
      const dates = res.daily.map(d => d.localDate).concat(res.sessions.map(s => s.localDate));
      dates.sort();
      return {
        sessions: res.sessions,
        daily: res.daily,
        meta: { weightUnit, filesRead: done, filesFailed: failed, skipped },
        tally: {
          records: res.daily.length,
          workouts: res.sessions.length,
          from: dates[0] || null,
          to: dates[dates.length - 1] || null,
          sources: { Fitbit: res.daily.length + res.sessions.length },
          types: {},
          notes: res.notes
        }
      };
    });
  });
}
