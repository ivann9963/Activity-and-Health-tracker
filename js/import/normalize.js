// === NORMALISATION ===
// Units and source names, made consistent before anything reaches the database.
// Every parser runs its values through here, so the rest of the app can assume
// metres, seconds, kilograms and kcal without checking.

const LENGTH_TO_M = {
  m: 1, meter: 1, meters: 1, metre: 1, metres: 1,
  km: 1000, kilometer: 1000, kilometers: 1000,
  mi: 1609.344, mile: 1609.344, miles: 1609.344,
  ft: 0.3048, feet: 0.3048,
  yd: 0.9144, yard: 0.9144, yards: 0.9144
};
const TIME_TO_S = { s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
                    min: 60, mins: 60, minute: 60, minutes: 60,
                    h: 3600, hr: 3600, hour: 3600, hours: 3600 };
const MASS_TO_KG = { kg: 1, kilogram: 1, kilograms: 1,
                     g: 0.001, lb: 0.45359237, lbs: 0.45359237, pound: 0.45359237,
                     st: 6.35029318, stone: 6.35029318 };

function convert(value, unit, table, what) {
  const v = Number(value);
  if (!isFinite(v)) return null;
  const f = table[String(unit || '').trim().toLowerCase()];
  // An unknown unit is a parsing bug, not a value to guess at. Returning null keeps
  // the bad number out of the totals and lets the Inspector surface it.
  if (f == null) { warnOnce(`unknown ${what} unit: ${unit}`); return null; }
  return v * f;
}

const _warned = new Set();
function warnOnce(msg) {
  if (_warned.has(msg)) return;
  _warned.add(msg);
  if (typeof console !== 'undefined') console.warn('[import]', msg);
}

function toMetres(value, unit)  { return convert(value, unit, LENGTH_TO_M, 'length'); }
function toSeconds(value, unit) { return convert(value, unit, TIME_TO_S, 'duration'); }
function toKg(value, unit)      { return convert(value, unit, MASS_TO_KG, 'mass'); }
function toKcal(value, unit) {
  const u = String(unit || '').trim().toLowerCase();
  const v = Number(value);
  if (!isFinite(v)) return null;
  if (u === 'kcal' || u === 'cal' || u === 'calorie' || u === 'calories') return v; // Apple's "Cal" is kcal
  if (u === 'kj') return v / 4.184;
  warnOnce('unknown energy unit: ' + unit);
  return null;
}

// Apple writes whatever the device calls itself — "Ivan's iPhone", "Ivan’s Apple
// Watch", "Иван iPhone". Source priority and the Duplicates screen need stable keys,
// so personalised names collapse onto canonical ones here. The original is kept on
// the record as `app` for display.
function normalizeSourceName(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'Unknown';
  const l = s.toLowerCase();
  if (l.includes('watch')) return 'Apple Watch';
  if (l.includes('iphone')) return 'iPhone';
  if (l.includes('ipad')) return 'iPad';
  if (l.includes('fitbit')) return 'Fitbit';
  if (l.includes('google health') || l.includes('google fit')) return 'Google Health';
  if (l.includes('strava')) return 'Strava';
  if (l.includes('health') && l.includes('apple')) return 'Apple Health';
  return s;
}

// The `device` attribute is an opaque-looking blob:
//   <<HKDevice: 0x28…>, name:Apple Watch, manufacturer:Apple Inc., model:Watch, …>
// The name field inside it is more reliable than sourceName for telling an Apple
// Watch record apart from an iPhone one, so pull it out when present.
function deviceNameFrom(deviceAttr) {
  if (!deviceAttr) return null;
  const m = /name:([^,>]+)/.exec(deviceAttr);
  return m ? normalizeSourceName(m[1].trim()) : null;
}

if (typeof module !== 'undefined') {
  module.exports = { toMetres, toSeconds, toKg, toKcal, normalizeSourceName, deviceNameFrom };
}
