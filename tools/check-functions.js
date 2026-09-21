// Syntax-checks the Cloudflare Pages Functions.
//
// They are ES modules that run on Cloudflare's runtime, so the unit tests never
// execute them and `node --check` refuses a .js file containing import statements.
// Copying each to a .mjs and checking that catches a typo here at push time rather
// than on a live deploy, where the symptom is a 500 on the OAuth callback.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', 'functions');

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.isFile() && e.name.endsWith('.js') ? [full] : [];
  });
}

const files = walk(ROOT);
if (!files.length) {
  console.log('no Pages Functions to check');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-check-'));
let failed = 0;
for (const file of files) {
  const copy = path.join(tmp, path.basename(file) + '.mjs');
  fs.copyFileSync(file, copy);
  try {
    execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' });
    console.log(`  ok  ${path.relative(path.join(__dirname, '..'), file)}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${file}\n${err.stderr ? err.stderr.toString() : err.message}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${files.length - failed}/${files.length} functions parse`);
process.exit(failed ? 1 : 0);
