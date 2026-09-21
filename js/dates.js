// === DATE HELPERS ===
// Everything in this app is keyed by LOCAL date, never UTC. A run at 00:30 on a
// Saturday belongs to Saturday, and an export made in a different timezone must not
// shuffle it into Friday. Apple writes timestamps with an explicit offset
// ("2024-03-12 07:41:22 +0200"), so we keep that offset on the record and use it
// here rather than trusting the browser's current zone.

// Format an epoch-ms instant into 'YYYY-MM-DD' as seen at the given UTC offset
// (in minutes east of UTC, matching what the Apple export carries).
function localDateOf(epochMs, tzOffsetMin) {
  const shifted = new Date(epochMs + (tzOffsetMin || 0) * 60000);
  return shifted.toISOString().slice(0, 10);
}

function todayLocal() {
  const now = new Date();
  return localDateOf(now.getTime(), -now.getTimezoneOffset());
}

// 'YYYY-MM-DD' -> epoch ms at UTC midnight. Only ever used for ordering and for
// stepping day-by-day; never rendered back to the user as a time.
function dateKeyToMs(key) { return Date.parse(key + 'T00:00:00Z'); }
function msToDateKey(ms) { return new Date(ms).toISOString().slice(0, 10); }

const DAY_MS = 86400000;

function addDays(key, n) { return msToDateKey(dateKeyToMs(key) + n * DAY_MS); }

function daysBetween(fromKey, toKey) {
  return Math.round((dateKeyToMs(toKey) - dateKeyToMs(fromKey)) / DAY_MS);
}

// Inclusive list of date keys. Guarded because a corrupt parse can otherwise ask for
// a range of a million days and hang the tab.
function dateRange(fromKey, toKey) {
  const n = daysBetween(fromKey, toKey);
  if (n < 0) return [];
  if (n > 40000) throw new Error('implausible date range: ' + fromKey + '..' + toKey);
  const out = [];
  for (let i = 0; i <= n; i++) out.push(addDays(fromKey, i));
  return out;
}

// Monday-based by default, matching the sibling finance app. Returns the date key of
// the week's first day.
function startOfWeek(key, firstDay) {
  const dow = new Date(dateKeyToMs(key)).getUTCDay(); // 0 = Sunday
  const shift = (firstDay === 'sunday') ? dow : (dow === 0 ? 6 : dow - 1);
  return addDays(key, -shift);
}
function startOfMonth(key) { return key.slice(0, 8) + '01'; }
function startOfYear(key)  { return key.slice(0, 4) + '-01-01'; }

function endOfWeek(key, firstDay) { return addDays(startOfWeek(key, firstDay), 6); }
function endOfMonth(key) {
  const [y, m] = key.split('-').map(Number);
  return msToDateKey(Date.UTC(y, m, 0)); // day 0 of next month = last day of this one
}
function endOfYear(key) { return key.slice(0, 4) + '-12-31'; }

// The bounds of the period containing `key`. One function so week/month/year views
// can share a single code path.
function periodBounds(key, period, firstDay) {
  if (period === 'week')  return { from: startOfWeek(key, firstDay), to: endOfWeek(key, firstDay) };
  if (period === 'month') return { from: startOfMonth(key), to: endOfMonth(key) };
  if (period === 'year')  return { from: startOfYear(key), to: endOfYear(key) };
  throw new Error('unknown period: ' + period);
}

// Step a whole period backwards or forwards — used by the "previous week" comparison
// and the period navigation arrows.
function shiftPeriod(key, period, n, firstDay) {
  if (period === 'week') return addDays(startOfWeek(key, firstDay), n * 7);
  const [y, m] = key.split('-').map(Number);
  if (period === 'month') {
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    return msToDateKey(d);
  }
  return `${y + n}-01-01`;
}

if (typeof module !== 'undefined') {
  module.exports = { localDateOf, todayLocal, dateKeyToMs, msToDateKey, addDays,
                     daysBetween, dateRange, startOfWeek, startOfMonth, startOfYear,
                     endOfWeek, endOfMonth, endOfYear, periodBounds, shiftPeriod, DAY_MS };
}
