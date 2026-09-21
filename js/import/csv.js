// === CSV PARSING ===
// Strava's activities.csv contains activity names typed by humans, which means commas,
// quotes and newlines inside fields. A split(',') would shred it, so this is a real
// (if small) RFC4180 parser.

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  // Strip a UTF-8 BOM: Strava's export has one, and it would otherwise become part of
  // the first header name and break every column lookup.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // doubled quote = literal quote
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Rows as objects keyed by header name, with the header row consumed.
function parseCSVObjects(text) {
  const rows = parseCSV(text);
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1)
    .filter(r => r.length > 1 || (r[0] || '').trim() !== '')
    .map(r => {
      const o = {};
      headers.forEach((h, i) => { o[h] = r[i] != null ? r[i] : ''; });
      return o;
    });
}

if (typeof module !== 'undefined') module.exports = { parseCSV, parseCSVObjects };
