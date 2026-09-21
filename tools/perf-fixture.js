// Generates a realistically large Apple Health export, for measuring the import path
// against something the size of a real archive rather than a 7KB fixture.
//
//   node tools/perf-fixture.js [years] [outfile]
//
// The shape matters as much as the size: step counts arrive as hundreds of small
// samples per day from two competing sources, heart rate is by far the most numerous
// record type, and workouts are comparatively rare. An export that is merely large
// but uniform would not exercise the parts that actually cost.
const fs = require('fs');

const years = Number(process.argv[2] || 3);
const out = process.argv[3] || '/tmp/perf-export.xml';

const DAY_MS = 86400000;
const end = new Date('2026-09-01T00:00:00Z');
const start = new Date(end.getTime() - years * 365 * DAY_MS);

function stamp(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
         `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0200`;
}

const stream = fs.createWriteStream(out);
stream.write(`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE HealthData [\n<!ELEMENT HealthData (Record|Workout)*>\n]>\n<HealthData locale="en_GB">\n<ExportDate value="${stamp(end)}"/>\n`);

let records = 0, workouts = 0;
const WORKOUT_TYPES = ['Running', 'TraditionalStrengthTraining', 'Swimming', 'Tennis', 'Cycling'];

for (let day = new Date(start); day < end; day = new Date(day.getTime() + DAY_MS)) {
  const iso = day.toISOString().slice(0, 10);

  // Steps: ~96 samples a day from the phone, and the same again from the watch.
  for (const source of ["Ivan&apos;s iPhone", "Ivan&apos;s Apple Watch"]) {
    for (let i = 0; i < 96; i++) {
      const t = new Date(day.getTime() + i * 900000);
      stream.write(`<Record type="HKQuantityTypeIdentifierStepCount" sourceName="${source}" unit="count" startDate="${stamp(t)}" endDate="${stamp(new Date(t.getTime() + 900000))}" value="${80 + (i % 40)}"/>\n`);
      records++;
    }
  }

  // Heart rate: a reading every five minutes, the most numerous type in a real export.
  for (let i = 0; i < 288; i++) {
    const t = new Date(day.getTime() + i * 300000);
    const bpm = 55 + ((i * 7) % 120);
    stream.write(`<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Ivan&apos;s Apple Watch" unit="count/min" startDate="${stamp(t)}" endDate="${stamp(t)}" value="${bpm}"/>\n`);
    records++;
  }

  // Sleep, as fragmented stage records.
  for (let i = 0; i < 6; i++) {
    const s = new Date(day.getTime() - 3600000 * (8 - i));
    stream.write(`<Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Ivan&apos;s Apple Watch" value="HKCategoryValueSleepAnalysisAsleepCore" startDate="${stamp(s)}" endDate="${stamp(new Date(s.getTime() + 3600000))}"/>\n`);
    records++;
  }

  stream.write(`<Record type="HKQuantityTypeIdentifierBodyMass" sourceName="Withings" unit="kg" startDate="${stamp(day)}" endDate="${stamp(day)}" value="${(82 + Math.sin(day / 1e9) * 2).toFixed(1)}"/>\n`);
  stream.write(`<Record type="HKQuantityTypeIdentifierRestingHeartRate" sourceName="Ivan&apos;s Apple Watch" unit="count/min" startDate="${stamp(day)}" endDate="${stamp(day)}" value="${54 + (records % 8)}"/>\n`);
  records += 2;

  // A workout every other day, sometimes duplicated by Strava as a real export would.
  const n = Math.floor(day.getTime() / DAY_MS);
  if (n % 2 === 0) {
    const type = WORKOUT_TYPES[n % WORKOUT_TYPES.length];
    const s = new Date(day.getTime() + 18 * 3600000);
    const e = new Date(s.getTime() + 45 * 60000);
    stream.write(`<Workout workoutActivityType="HKWorkoutActivityType${type}" duration="45" durationUnit="min" sourceName="Ivan&apos;s Apple Watch" startDate="${stamp(s)}" endDate="${stamp(e)}">\n`);
    stream.write(` <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="${(5 + (n % 5)).toFixed(2)}" unit="km"/>\n`);
    stream.write(` <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="${140 + (n % 20)}" unit="count/min"/>\n`);
    stream.write(`</Workout>\n`);
    workouts++;
    if (n % 6 === 0) {
      const s2 = new Date(s.getTime() + 30000);
      stream.write(`<Workout workoutActivityType="HKWorkoutActivityType${type}" duration="45" durationUnit="min" sourceName="Strava" startDate="${stamp(s2)}" endDate="${stamp(new Date(e.getTime() + 30000))}"/>\n`);
      workouts++;
    }
  }
}

stream.write('</HealthData>\n');
stream.end(() => {
  const size = fs.statSync(out).size;
  console.log(`${out}: ${(size / 1024 / 1024).toFixed(1)} MB · ` +
              `${records.toLocaleString()} records · ${workouts.toLocaleString()} workouts`);
});
