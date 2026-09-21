// Browser smoke test: serves the app, drives the real UI in Chromium, and fails on
// any console error. Unit tests cannot catch a script that does not load or a handler
// wired to a missing element, which is exactly what this is for.
//
//   node tests/ui-smoke.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + '/..';
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
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

try {
  console.log('\n\x1b[1mUI smoke test\x1b[0m');
  await page.goto(base, { waitUntil: 'networkidle' });

  const tabs = await page.locator('.nav-btn').allTextContents();
  check('the tab bar carries only the three primary screens', tabs.length === 3,
    `got ${JSON.stringify(tabs)}`);
  check('reconciliation is not one of them', !tabs.join(' ').includes('Duplicates'));
  check('the empty state invites an import',
    await page.locator('.empty-state').isVisible());

  await page.locator('button:has-text("Add your data")').click();
  // Views render asynchronously (they read from IndexedDB first), so wait rather
  // than asserting on whatever happens to be on screen this millisecond.
  await page.waitForSelector('#dropzone', { state: 'visible' });
  check('the call to action reaches the Data screen', true);

  // Feed the real fixture through the real file input.
  await page.locator('#file-input').setInputFiles(path.join(ROOT, 'tests/fixtures/apple-export.xml'));
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
  check('all-time totals are shown', /All time/.test(home));

  await page.locator('.segmented button:has-text("Year")').click();
  await page.waitForSelector('.metric-grid');

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

  check('no console errors anywhere in that run', errors.length === 0, errors.join('\n    '));
} catch (err) {
  failures++;
  console.log(`  \x1b[31m✗ threw: ${err.message}\x1b[0m`);
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mall good\x1b[0m\n');
process.exit(failures ? 1 : 0);
