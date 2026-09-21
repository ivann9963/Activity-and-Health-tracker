// Syntax-checks the Worker and its modules.
//
// They are ES modules that run on Cloudflare's runtime, so the unit tests never
// execute them and `node --check` refuses a .js file containing import statements.
// Copying each to a .mjs and checking that catches a typo at push time rather than on
// a live deploy, where the symptom is a 500 on the OAuth callback.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TARGETS = ['worker.js', 'worker'];

function collect(rel) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) return [];
  if (fs.statSync(full).isFile()) return full.endsWith('.js') ? [full] : [];
  return fs.readdirSync(full).flatMap(name => collect(path.join(rel, name)));
}

const files = TARGETS.flatMap(collect);
if (!files.length) {
  console.error('no Worker sources found — expected worker.js and worker/');
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-check-'));
let failed = 0;
for (const file of files) {
  const copy = path.join(tmp, path.basename(file) + '.mjs');
  fs.copyFileSync(file, copy);
  try {
    execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' });
    console.log(`  ok  ${path.relative(ROOT, file)}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${path.relative(ROOT, file)}\n${err.stderr ? err.stderr.toString() : err.message}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${files.length - failed}/${files.length} Worker sources parse`);
process.exit(failed ? 1 : 0);
