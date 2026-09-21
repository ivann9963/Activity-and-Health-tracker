// Build step for deployment.
//
// The app has no bundler and does not want one — the point of the plain-script layout
// is that what you edit is what runs. So this does the two things that genuinely
// cannot be done at edit time:
//
//   1. Collects the app's real asset list (parsed out of index.html, plus the worker
//      and everything it importScripts) and bakes it into the service worker, so the
//      precache manifest can never drift from what the page actually loads.
//   2. Stamps a build id, so a deploy invalidates the old cache instead of leaving
//      people on a stale copy forever.
//
// Output goes to _site/, which is what gets published. Tests, tooling and node_modules
// are not copied.
//
//   node tools/build.js [outDir]

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(ROOT, process.argv[2] || '_site');

// Files that are part of the app regardless of whether index.html mentions them.
const EXTRA_ASSETS = ['manifest.webmanifest', 'js/workers/import-worker.js'];

function buildId() {
  // The commit is the most honest version marker available; fall back to a timestamp
  // when building outside a checkout (or from a tarball, as CI sometimes does).
  try {
    return execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return 'dev-' + Date.now().toString(36);
  }
}

// Local src/href targets from index.html, in load order.
function assetsFromIndex(html) {
  const out = [];
  const re = /(?:src|href)="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const url = m[1];
    if (/^(https?:|data:|#|\/\/)/.test(url)) continue;
    out.push(url.replace(/^\.\//, ''));
  }
  return out;
}

// The import worker is fetched separately by the browser and pulls in its own
// dependencies, so those have to be cached too or an offline import fails halfway.
function workerImports(workerPath) {
  const src = fs.readFileSync(path.join(ROOT, workerPath), 'utf8');
  const block = /importScripts\(([\s\S]*?)\)/.exec(src);
  if (!block) return [];
  const dir = path.dirname(workerPath);
  return [...block[1].matchAll(/'([^']+)'/g)]
    .map(m => path.posix.normalize(path.posix.join(dir, m[1])));
}

function copyFile(rel) {
  const from = path.join(ROOT, rel);
  const to = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function main() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  const assets = ['index.html', ...assetsFromIndex(html), ...EXTRA_ASSETS,
                  ...workerImports('js/workers/import-worker.js')];
  // De-duplicate while keeping order, and drop anything that is not actually there —
  // a stale reference in index.html should not break the whole build.
  const seen = new Set();
  const files = [];
  for (const rel of assets) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!fs.existsSync(path.join(ROOT, rel))) {
      console.warn(`  ! referenced but missing, skipped: ${rel}`);
      continue;
    }
    files.push(rel);
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  for (const rel of files) copyFile(rel);

  // The service worker is generated rather than copied, so its precache list is
  // always exactly the files above.
  const id = buildId();
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8')
    .replace("'__BUILD_ID__'", JSON.stringify(id))
    .replace("'__PRECACHE__'", JSON.stringify(files.map(f => './' + f), null, 2));
  fs.writeFileSync(path.join(OUT, 'sw.js'), sw);

  // GitHub Pages runs Jekyll by default, which silently drops files and folders
  // beginning with an underscore. Nothing here starts with one today, but the failure
  // mode is a mysteriously missing file, so opt out explicitly.
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

  const domain = process.env.CUSTOM_DOMAIN;
  if (domain) fs.writeFileSync(path.join(OUT, 'CNAME'), domain + '\n');

  console.log(`built ${files.length + 1} files into ${path.relative(ROOT, OUT)}/ (build ${id})`);
  if (domain) console.log(`  custom domain: ${domain}`);
}

main();
