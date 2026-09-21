// === FILE SNIFFER ===
// Works out what a dropped file actually is, by looking inside it rather than
// trusting its name. The user should be able to drag in whatever their phone or
// Strava gave them without first having to know which is which.

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04"

function isZip(head) {
  return ZIP_MAGIC.every((b, i) => head[i] === b);
}

// Identify a File/Blob. Resolves to { kind, label, detail, entry?, entries? } where
// `kind` is one of the KNOWN_KINDS below, or 'unknown'.
function sniffFile(file) {
  return file.slice(0, 4).arrayBuffer().then(buf => {
    const head = new Uint8Array(buf);
    if (isZip(head)) return sniffZip(file);
    return file.slice(0, 8192).text().then(text => sniffText(text, file));
  });
}

function sniffZip(file) {
  return zipEntries(file).then(entries => {
    const names = entries.map(e => e.name);
    const find = re => entries.find(e => re.test(e.name));

    const appleXml = find(/(^|\/)export\.xml$/i);
    if (appleXml) {
      return { kind: 'apple-zip', label: 'Apple Health export',
               detail: `${entries.length} files in the archive`,
               entry: appleXml, entries };
    }
    const stravaCsv = find(/(^|\/)activities\.csv$/i);
    if (stravaCsv) {
      return { kind: 'strava-zip', label: 'Strava bulk export',
               detail: `${entries.length} files in the archive`,
               entry: stravaCsv, entries };
    }
    // Google renamed the Fitbit app to Google Health in May 2026 but kept the Takeout
    // data category as "Fitbit", so the archive still says Takeout/Fitbit/.
    if (isTakeoutArchive(entries)) {
      return { kind: 'fitbit-zip', label: 'Google Health (Fitbit) export',
               detail: `${entries.length} files in the archive`, entries };
    }
    return { kind: 'unknown-zip', label: 'Unrecognised archive',
             detail: names.slice(0, 5).join(', '), entries };
  });
}

function sniffText(text, file) {
  if (/<HealthData|HKQuantityTypeIdentifier|<!DOCTYPE\s+HealthData/.test(text)) {
    return { kind: 'apple-xml', label: 'Apple Health export.xml',
             detail: humanSize(file.size) };
  }
  if (/^\s*\{/.test(text) && /"activityLedgerBackup"/.test(text)) {
    return { kind: 'app-backup', label: 'Activity Ledger backup', detail: humanSize(file.size) };
  }
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  if (/Activity ID/i.test(firstLine) && /Activity Date/i.test(firstLine)) {
    return { kind: 'strava-csv', label: 'Strava activities.csv', detail: humanSize(file.size) };
  }
  if (/^\s*[\[{]/.test(text)) {
    return { kind: 'unknown-json', label: 'JSON file', detail: humanSize(file.size) };
  }
  return { kind: 'unknown', label: 'Unrecognised file', detail: humanSize(file.size) };
}

// Kinds the importer knows how to act on, as opposed to merely recognise.
const IMPORTABLE_KINDS = ['apple-zip', 'apple-xml', 'strava-zip', 'strava-csv', 'app-backup'];

function humanSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 10 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
}

// For an Apple file, hand back a byte stream of the XML whether it arrived zipped or not.
function appleXmlStream(file, sniff) {
  if (sniff.kind === 'apple-zip') return zipEntryStream(file, sniff.entry);
  return Promise.resolve(file.stream());
}
