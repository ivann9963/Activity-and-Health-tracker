// Browser smoke test: serves the app, drives the real UI in Chromium, and fails on
// any console error. Unit tests cannot catch a script that does not load or a handler
// wired to a missing element, which is exactly what this is for.
//
//   node tests/ui-smoke.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// By default the source tree is served. Point SMOKE_ROOT at _site to run the same
// checks against the built output instead — which is what actually gets deployed,
// service worker and all.
const ROOT = path.resolve(REPO, process.env.SMOKE_ROOT || '.');
const AGAINST_BUILD = ROOT !== REPO;
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
                '.webmanifest': 'application/manifest+json', '.xml': 'text/xml' };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(path.resolve(ROOT)) || !fs.existsSync(file)) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

let failures = 0;
const check = (label, cond, detail) => {
  console.log(cond ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}\x1b[0m${detail ? '\n    ' + detail : ''}`);
  if (!cond) failures++;
};

await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;

// The sandbox ships a pinned Chromium; point Playwright at it rather than letting it
// try to download a matching build.
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(
  fs.existsSync(PINNED) ? { executablePath: PINNED } : {});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // iPhone-ish
const errors = [];
// The app probes /api/oauth/status to find out whether the OAuth broker exists. Here
// it does not — Pages Functions only run on the deployed site — so that probe 404s by
// design and the app correctly falls back to "sync needs the deployed version".
// Only that one path is exempt; every other console error still fails the run.
// Figures count up on entrance, so reading the screen too early samples a frame
// mid-count. js/motion.js marks a running counter; wait for none to be left.
const settled = () => page.waitForFunction(
  () => document.querySelectorAll('[data-counting]').length === 0,
  null, { timeout: 10000 });

const EXPECTED_404 = /\/api\/oauth\//;
const isExpected = text => /404|Failed to load resource/.test(text) && EXPECTED_404.test(text);
page.on('console', m => {
  if (m.type() !== 'error') return;
  const text = m.text();
  if (isExpected(text) || (/Failed to load resource/.test(text) && !text.includes('http'))) {
    // Chromium reports the failing URL on the request, not always in the message.
    return;
  }
  errors.push(text);
});
page.on('requestfailed', r => { if (!EXPECTED_404.test(r.url())) errors.push('request failed: ' + r.url()); });
page.on('pageerror', e => errors.push(String(e)));

try {
  console.log(`\n\x1b[1mUI smoke test\x1b[0m ${AGAINST_BUILD ? '(against the build)' : '(against the source tree)'}`);
  await page.goto(base, { waitUntil: 'networkidle' });

  const tabs = await page.locator('.nav-btn').allTextContents();
  const tabText = tabs.join(' ');
  check('the tab bar carries the primary screens', tabs.length === 5, `got ${JSON.stringify(tabs)}`);
  check('including the year review and insights', /Year/.test(tabText) && /Insights/.test(tabText));
  check('reconciliation is not one of them', !/Duplicates/.test(tabText));
  check('the empty state invites an import',
    await page.locator('.empty-state').isVisible());

  await page.locator('button:has-text("Add your data")').click();
  // Views render asynchronously (they read from IndexedDB first), so wait rather
  // than asserting on whatever happens to be on screen this millisecond.
  await page.waitForSelector('#dropzone', { state: 'visible' });
  check('the call to action reaches the Data screen', true);

  // Feed the real fixture through the real file input.
  await page.locator('#file-input').setInputFiles(path.join(REPO, 'tests/fixtures/apple-export.xml'));
  await page.waitForSelector('#inspection-result .card', { timeout: 20000 });

  const body = await page.locator('#inspection-result').innerText();
  check('the report states the true coverage', /2019-06-01/.test(body) && /2026-07-04/.test(body));
  check('every recording device is listed',
    ['Apple Watch', 'iPhone', 'Strava', 'Withings', 'Google Health'].every(s => body.includes(s)),
    body.slice(0, 300));
  check('workouts are counted', /\b6\b/.test(body));
  check('tracked types are marked', body.includes('steps') && body.includes('sleep'));

  // --- import, then check the reconciled numbers ---
  await page.locator('#do-import').click();
  await page.waitForSelector('.list-row', { timeout: 30000 });
  check('the import is recorded in the history',
    (await page.locator('.list-row').count()) === 1);

  await page.locator('.nav-btn:has-text("Home")').click();
  await page.waitForSelector('.metric-grid');
  const home = await page.locator('#view-host').innerText();
  check('the view opens on a period that actually has data', !/This week/.test(home), home.slice(0, 200));

  // Figures count up on entrance. The first version counted the STORED value into
  // the FORMATTED string — 5200 metres inside the template "5.20 km" — and showed
  // 3376.66 km on the way up. Every frame must stay within the final value, so
  // sample mid-count and check no number has overshot.
  await page.locator('.segmented button:has-text("Month")').click();
  await page.waitForSelector('.metric-grid');
  await page.waitForTimeout(90);
  const midCount = await page.evaluate(() =>
    [...document.querySelectorAll('.metric-value')].map(n => n.textContent.trim()));
  await page.waitForFunction(
    () => document.querySelectorAll('[data-counting]').length === 0, null, { timeout: 10000 });
  const settledCount = await page.evaluate(() =>
    [...document.querySelectorAll('.metric-value')].map(n => n.textContent.trim()));
  const num = t => { const m = String(t).match(/[\d][\d,]*(\.\d+)?/); return m ? Number(m[0].replace(/,/g, '')) : 0; };
  const overshot = midCount.filter((t, i) => num(t) > num(settledCount[i]) + 0.001);
  check('a counting figure never exceeds the value it is counting to',
    overshot.length === 0, `${JSON.stringify(overshot)} vs ${JSON.stringify(settledCount)}`);
  check('and the units survive the count',
    midCount.every((t, i) => t.replace(/[\d.,]/g, '') === settledCount[i].replace(/[\d.,]/g, '')),
    JSON.stringify(midCount));
  check('all-time totals are shown', /All time/.test(home));

  await page.locator('.segmented button:has-text("Year")').click();
  await page.waitForSelector('.metric-grid');

  // --- second source: a Google Health (Fitbit) Takeout archive ---
  // This exercises the whole second pipeline in a real browser: zip walking, the
  // worker, the Fitbit parsers, and reconciliation against what Apple already gave us.
  await page.locator('.nav-btn:has-text("Data")').click();
  await page.waitForSelector('#dropzone');
  await page.locator('#file-input').setInputFiles(path.join(REPO, 'tests/fixtures/takeout-sample.zip'));
  await page.waitForSelector('#inspection-result .card', { timeout: 20000 });
  const takeout = await page.locator('#inspection-result').innerText();
  check('a Takeout archive is recognised as Google Health',
    /Google Health \(Fitbit\)/.test(takeout), takeout.slice(0, 200));
  check('its folders are listed with what they feed',
    /Physical Activity/.test(takeout) && /workouts/.test(takeout), takeout.slice(0, 400));

  await page.locator('#do-import').click();
  await page.waitForFunction(
    () => document.querySelectorAll('.list-row').length === 2, null, { timeout: 30000 });
  check('both sources now appear in the import history', true);

  await page.locator('.nav-btn:has-text("Home")').click();
  await page.waitForSelector('.metric-grid');
  await page.locator('.segmented button:has-text("Year")').click();
  await page.waitForSelector('.metric-grid');
  const combined = await page.locator('#view-host').innerText();
  check('Fitbit data reaches the totals', /Racket|Tennis|RACKET/i.test(combined),
    combined.slice(0, 300));

  // --- insights ---
  await page.locator('.nav-btn:has-text("Insights")').click();
  await page.waitForSelector('.card:has-text("Where the time went")', { timeout: 15000 });
  const insights = await page.locator('#view-host').innerText();
  check('the time share names where most of it went',
    /Mostly/i.test(insights) && /% of/.test(insights), insights.slice(0, 400));
  // Methodology stays available but no longer sits above the answer.
  check('the reasoning is one tap away rather than in the way',
    /how this is counted/i.test(insights));
  check('active days separate deliberate activity from the rest',
    /active days/i.test(insights) && /not counted/i.test(insights), insights.slice(0, 400));
  check('where the time went renders as tiles',
    (await page.locator('.card:has-text("Where the time went") .metric-tile').count()) >= 1);
  // Hiding an activity from the tile it appears on: the whole point is that the
  // percentages are recomputed, so the remaining ones still total 100.
  const tiles = page.locator('.card:has-text("Where the time went") .metric-tile');
  const tileCount = await tiles.count();
  const hiddenName = await tiles.first().locator('.metric-name').innerText();
  await tiles.first().locator('.tile-hide').click({ force: true });
  await page.waitForFunction(
    n => document.querySelectorAll('.metric-tile').length < n, tileCount,
    { timeout: 10000 });
  const afterHide = await page.locator('#view-host').innerText();
  check('setting an activity aside drops its tile',
    !new RegExp(`\\b${hiddenName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
      .test(afterHide.split('Set aside:')[0]), afterHide.slice(0, 500));
  check('and says where it went, so it can be brought back',
    /set aside/i.test(afterHide) &&
    (await page.locator('[data-show-activity]').count()) >= 1);
  await page.locator('[data-show-activity]').first().click();
  await page.waitForFunction(
    n => document.querySelectorAll('.metric-tile').length === n, tileCount,
    { timeout: 10000 });
  check('counting it again restores the tile',
    (await page.locator('.card:has-text("Where the time went") .metric-tile').count())
      === tileCount);

  const insights2 = await page.locator('#view-host').innerText();
  check('effort by sport reports a weighted average',
    /effort by sport/i.test(insights2) && /bpm/.test(insights2), insights2.slice(0, 900));
  check('the period can be switched', (await page.locator('[data-insight]').count()) === 3);
  // A four-column table used to run off the side of a 390px screen, hiding the column
  // it was cut off at. Nothing on a phone screen may scroll sideways.
  check('nothing on the insights screen runs off the side of the phone',
    !(await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth)));

  // Heart-rate bands live in 2024 in the fixture, so stepping back a year is also a
  // check that the period navigation actually moves the data.
  await page.locator('#insight-prev').click();
  await page.waitForTimeout(300);
  await page.locator('#insight-prev').click();
  // The card renders even with nothing in it, so waiting for the card alone races the
  // re-render. Wait for a band row, which only exists once the data is there.
  await page.waitForFunction(() => {
    const card = [...document.querySelectorAll('.card')]
      .find(c => /Time by heart rate/.test(c.textContent));
    return card && card.querySelectorAll('.share-row').length > 0;
  }, null, { timeout: 15000 });
  const hr2024 = await page.locator('#view-host').innerText();
  check('stepping back reaches the heart-rate data',
    /above 140 bpm/i.test(hr2024), hr2024.slice(0, 500));
  check('and the bands are labelled as ranges', /140–159 bpm/.test(hr2024));
  // The dropdown restated what the bands already showed.
  check('no redundant threshold control', (await page.locator('#hr-threshold').count()) === 0);
  // Almost every hour of a life sits under 100 bpm, so charting it buries the rest.
  const hrCard = page.locator('.card:has-text("Time by heart rate")');
  const hrRows = await hrCard.locator('.share-row').allTextContents();
  check('the resting band is not charted against the working ones',
    !hrRows.some(r => /0–99 bpm/.test(r)), JSON.stringify(hrRows));
  // The disclosure is collapsed, so read the text rather than what is laid out.
  const hrAll = await hrCard.evaluate(n => n.textContent);
  check('but it is still accounted for, not silently dropped',
    /below 100 bpm/i.test(hrAll), hrAll.slice(0, 600));

  // --- metric detail and goals ---
  await page.locator('.nav-btn:has-text("Home")').click();
  await page.waitForSelector('.metric-grid');
  await page.locator('a.metric-tile').first().click();
  await page.waitForSelector('#detail-chart svg', { timeout: 15000 });
  const detail = await page.locator('#view-host').innerText();
  check('a tile opens its own history', /Records/.test(detail), detail.slice(0, 200));
  check('it opens on all time, so history is never hidden behind an empty period',
    /best day/i.test(detail) && /all time/i.test(detail), detail.slice(0, 400));
  check('records include streaks and best periods',
    /longest day streak/i.test(detail) && /best month/i.test(detail), detail.slice(0, 400));
  check('all four time ranges are offered',
    (await page.locator('[data-detail]').count()) === 4);

  // A goal is typed in the unit shown, not the unit stored.
  await page.locator('#goal-input').fill('12');
  await page.locator('#goal-save').click();
  await page.waitForSelector('#goal-clear', { timeout: 10000 });
  check('a goal can be saved and removed again', true);

  await page.locator('.nav-btn:has-text("Home")').click();
  await page.waitForSelector('.metric-grid');
  await page.locator('.segmented button:has-text("Year")').click();
  await page.waitForSelector('.meter', { timeout: 10000 });
  check('the goal shows as a meter on the dashboard',
    (await page.locator('.meter-fill').count()) >= 1);
  const pace = await page.locator('.metric-tile:has(.meter)').first().innerText();
  check('with a plain-language pace reading',
    /pace|Goal met|of /.test(pace), pace.slice(0, 160));

  // --- year in review ---
  await page.locator('.nav-btn:has-text("Year")').click();
  await page.waitForSelector('.hero-figure', { timeout: 15000 });
  const review = await page.locator('#view-host').innerText();
  check('the review leads with active days', /active days out of/.test(review),
    review.slice(0, 200));
  check('totals carry a scale comparison',
    /marathon|Bulgaria|Sofia|pool|Channel|track|5K/i.test(review), review.slice(0, 600));
  check('the month chart renders as real SVG',
    (await page.locator('.months svg').count()) > 0);
  check('the calendar heatmap renders',
    (await page.locator('.heatmap .heat-cell').count()) > 300);
  // Four steps, not five: the "nothing recorded" state is not a level on the scale,
  // and showing it as one implies zero is a shade of green.
  check('the heatmap legend shows the four data steps',
    (await page.locator('.heat-swatch').count()) === 4);
  // Every mark must be able to explain itself on hover — including the empty ones,
  // where "nothing recorded" is the useful answer rather than silence.
  const firstChartTips = await page.locator('.months').first().locator('svg title').count();
  check('every month in a chart carries a tooltip', firstChartTips === 12,
    `got ${firstChartTips}`);
  const tipText = await page.locator('.months').first().locator('svg title').first().innerText()
    .catch(() => '');
  check('and the tooltip names the month',
    /January|February|March|April|May|June|July|August|September|October|November|December/
      .test(await page.locator('.months').first().locator('svg title').first().textContent()),
    tipText);

  await page.locator('.nav-btn:has-text("Data")').click();
  await page.waitForSelector('button:has-text("Review the decisions")', { timeout: 10000 });
  check('the Data screen reports what reconciliation did', true);
  await page.locator('button:has-text("Review the decisions")').click();
  await page.waitForSelector('.dup-group', { timeout: 10000 });
  const dups = await page.locator('#view-host').innerText();
  check('the duplicated run is surfaced for review', /Running/.test(dups));
  check('and the reason is explained', /same workout/.test(dups), dups.slice(0, 400));
  check('the losing source is named', /Strava/.test(dups));

  // Overruling the engine must actually change the stored decision.
  await page.locator('[data-choose]').first().click();
  await page.waitForSelector('.pill', { timeout: 10000 });
  check('a manual override is recorded',
    (await page.locator('.pill').count()) >= 1);

  await page.locator('.nav-btn:has-text("Settings")').click();
  await page.waitForSelector('.rank-input');
  check('settings shows the source ranking',
    (await page.locator('.rank-input').count()) >= 5);

  // The light theme was fully specified in CSS but unreachable — the setting existed
  // and nothing wrote to it. Check both that the control moves the document and that
  // the light tokens actually resolve to a light surface.
  await page.locator('#set-theme').selectOption('light');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light',
    null, { timeout: 5000 });
  const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const lightInk = await page.evaluate(() => getComputedStyle(document.body).color);
  const lum = c => { const [r, g, b] = c.match(/\d+/g).map(Number); return (r + g + b) / 3; };
  check('the light theme paints a light surface and dark ink',
    lum(lightBg) > 200 && lum(lightInk) < 80, `${lightBg} / ${lightInk}`);
  await page.locator('#set-theme').selectOption('dark');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark',
    null, { timeout: 5000 });
  const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('and dark goes back to a dark one', lum(darkBg) < 40, darkBg);

  // Hiding a tile must actually remove it from the dashboard.
  const toggles = page.locator('.metric-toggle');
  check('every metric has a visibility toggle',
    (await toggles.count()) >= 8, `got ${await toggles.count()}`);
  await page.locator('.metric-toggle[data-metric="distance_cycle"]').uncheck();
  await page.locator('.nav-btn:has-text("Home")').click();
  await page.waitForSelector('.metric-grid');
  const grid = await page.locator('.metric-grid').innerText();
  check('a hidden tile disappears from the dashboard', !/CYCLING/i.test(grid), grid.slice(0, 200));

  check('the dashboard has a heading of its own',
    (await page.locator('h1.period-label').innerText()).length > 0);

  // --- the two kinds of clearing ---
  // Deleting data must keep the setup; starting fresh must not. A single button that
  // did both would make redoing a bad import cost your goals as well.
  await page.locator('.nav-btn:has-text("Settings")').click();
  await page.waitForSelector('#reset');
  check('data deletion and a full reset are separate actions',
    (await page.locator('#wipe').count()) === 1 && (await page.locator('#reset').count()) === 1);
  const resetCopy = await page.locator('.card:has(#reset)').innerText();
  check('and the difference is spelled out',
    /keeps|kept/i.test(resetCopy) && /goals/i.test(resetCopy), resetCopy.slice(0, 260));

  // --- backup round trip ---
  // A backup that cannot be restored is worse than no backup, so this deletes
  // everything and brings it back rather than just checking a file downloads.
  await page.locator('.nav-btn:has-text("Settings")').click();
  await page.waitForSelector('#do-backup');
  const download = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.locator('#do-backup').click()
  ]).then(([d]) => d);
  const backupPath = path.join(os.tmpdir(), 'ledger-backup-' + Date.now() + '.json.gz');
  await download.saveAs(backupPath);
  check('a backup downloads, gzipped', fs.statSync(backupPath).size > 100,
    `${fs.statSync(backupPath).size} bytes`);

  // --- keyboard accessibility ---
  // The dialog guards a destructive action, so focus must land on Cancel rather than
  // on the button that deletes everything, and Escape must get out.
  await page.locator('#wipe').click();
  await page.waitForSelector('.dialog');
  const focused = await page.evaluate(() =>
    document.activeElement && document.activeElement.textContent.trim());
  check('a destructive dialog focuses Cancel, not Confirm', /cancel/i.test(focused || ''),
    `focus was on "${focused}"`);
  await page.keyboard.press('Escape');
  check('and Escape closes it', (await page.locator('.dialog').count()) === 0);

  // The version line is how someone tells a stale checkout from a current one, so it
  // has to be right in both directions: a source copy must not claim to be a build,
  // and a build must not claim to be a source copy.
  // What counts as a workout is a judgement, so it is configurable.
  check('workout types can be configured',
    (await page.locator('.workout-toggle').count()) >= 8);

  const version = await page.locator('#version-card').innerText();
  check(AGAINST_BUILD ? 'a build names its commit' : 'a source copy says it is one',
    AGAINST_BUILD ? /build [0-9a-f]{6,}/.test(version) : /development copy/.test(version),
    version.slice(0, 160));
  check('and it lists the screens so a stale copy is obvious',
    /Insights/.test(version) && /Year/.test(version), version.slice(0, 160));

  const skip = await page.locator('.skip-link').count();
  check('there is a skip link for keyboard users', skip === 1);

  await page.locator('#wipe').click();
  await page.waitForSelector('.dialog');
  await page.locator('.dialog button:has-text("Delete data")').click();
  await page.waitForFunction(
    () => /0 workouts/.test(document.body.innerText), null, { timeout: 15000 });
  check('deleting everything really empties it', true);

  await page.locator('.nav-btn:has-text("Data")').click();
  await page.waitForSelector('#dropzone');
  await page.locator('#file-input').setInputFiles(backupPath);
  await page.waitForSelector('#do-import', { timeout: 20000 });
  const restoreLabel = await page.locator('#do-import').innerText();
  check('a backup is recognised as one, not as an import',
    /restore/i.test(restoreLabel), restoreLabel);

  await page.locator('#do-import').click();
  await page.waitForSelector('.list-row', { timeout: 30000 });
  await page.locator('.nav-btn:has-text("Home")').click();
  await page.waitForSelector('.metric-grid');
  await page.locator('.segmented button:has-text("Year")').click();
  await page.waitForSelector('.metric-grid');
  await settled();
  const restored = await page.locator('#view-host').innerText();
  check('the data comes back', /All time/i.test(restored) && /km/.test(restored),
    restored.slice(0, 300));
  const afterRestore = restored;

  // Restoring the same backup again must be a no-op: it adds what is missing and
  // leaves what is already here alone, rather than overwriting newer values.
  await page.locator('.nav-btn:has-text("Data")').click();
  await page.waitForSelector('#dropzone');
  await page.locator('#file-input').setInputFiles(backupPath);
  await page.waitForSelector('#do-import', { timeout: 20000 });
  await page.locator('#do-import').click();
  // Wait for the restore's own toast rather than whichever is on screen — an earlier
  // one may still be fading.
  await page.waitForFunction(
    () => [...document.querySelectorAll('.toast')].some(t => /Restored/.test(t.textContent)),
    null, { timeout: 30000 });
  const secondToast = await page.evaluate(() =>
    [...document.querySelectorAll('.toast')].map(t => t.textContent.trim())
      .find(t => /Restored/.test(t)));
  check('restoring twice reports what was already there',
    /already here/.test(secondToast || ''), secondToast);

  await page.locator('.nav-btn:has-text("Home")').click();
  await page.waitForSelector('.metric-grid');
  await page.locator('.segmented button:has-text("Year")').click();
  await page.waitForSelector('.metric-grid');
  await settled();
  const afterSecond = await page.locator('#view-host').innerText();
  check('and changes nothing', afterSecond === afterRestore,
    'totals differed after a second restore');
  fs.unlinkSync(backupPath);

  if (AGAINST_BUILD) {
    // The built copy carries a real service worker with a generated precache list.
    // If it fails to register, the installed app simply will not work offline.
    const sw = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return reg ? { scope: reg.scope, active: !!(reg.active || reg.installing || reg.waiting) } : null;
    });
    check('the service worker registers', sw && sw.active, JSON.stringify(sw));
  }

  check('no console errors anywhere in that run', errors.length === 0, errors.join('\n    '));

  // The sync card must degrade gracefully where the broker is absent, rather than
  // offering a Connect button that could only fail.
  await page.locator('.nav-btn:has-text("Settings")').click();
  await page.waitForSelector('.card:has-text("Automatic sync")');
  const sync = await page.locator('.card:has-text("Automatic sync")').innerText();
  check('sync explains itself when the broker is not running',
    /deployed version/.test(sync) && !/Connect Google Health/.test(sync), sync.slice(0, 200));
} catch (err) {
  failures++;
  console.log(`  \x1b[31m✗ threw: ${err.message}\x1b[0m`);
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mall good\x1b[0m\n');
process.exit(failures ? 1 : 0);
