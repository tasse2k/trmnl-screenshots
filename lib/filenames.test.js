'use strict';

// Regression guard for the run.js <-> screenshot.js filename contract.
//
// Production bug (run #14007, 2026-09-20): run.js passed OUTPUT_FILE as
// `{slug}-raw.png`, but screenshot.js appends `-raw` itself, so the file
// landed at `{slug}-raw-raw.png` while convert looked for `{slug}-raw.png`.
// Both cities failed after a successful screenshot.
//
// These tests derive the expectation from screenshot.js's ACTUAL source, so
// changing the derivation in either file without the other fails here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { screenshotPaths } = require('../run.js');
const SCREENSHOT_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'screenshot.js'), 'utf8');

/** Pull screenshot.js's own `outputFile.replace(/\.png$/, '<suffix>')` targets. */
function derivationsFromSource() {
  const found = {};
  const re = /const\s+(\w+)\s*=\s*outputFile\.replace\(\s*\/\\\.png\$\/\s*,\s*'([^']+)'\s*\)/g;
  let m;
  while ((m = re.exec(SCREENSHOT_SRC)) !== null) found[m[1]] = m[2];
  return found;
}

test('screenshot.js still derives its outputs from OUTPUT_FILE', () => {
  const d = derivationsFromSource();
  assert.ok(d.rawFile, 'screenshot.js should derive a rawFile from outputFile');
  assert.ok(d.metaFile, 'screenshot.js should derive a metaFile from outputFile');
});

test('run.js expects exactly the files screenshot.js writes', () => {
  const d = derivationsFromSource();
  const p = screenshotPaths('barcelona');
  assert.strictEqual(p.rawFile, p.outputFile.replace(/\.png$/, d.rawFile));
  assert.strictEqual(p.metaFile, p.outputFile.replace(/\.png$/, d.metaFile));
});

test('OUTPUT_FILE is the bare slug, never a pre-suffixed name', () => {
  const p = screenshotPaths('barcelona');
  assert.strictEqual(p.outputFile, 'barcelona.png');
  assert.ok(!p.outputFile.includes('-raw'),
    'passing an already-suffixed OUTPUT_FILE causes the -raw-raw bug');
});

test('no double suffix for any slug shape', () => {
  for (const slug of ['barcelona', 'blankenfelde', 'new-york', 'a']) {
    const p = screenshotPaths(slug);
    assert.ok(!p.rawFile.includes('-raw-raw'), `${slug}: double -raw suffix`);
    assert.strictEqual(p.rawFile, `${slug}-raw.png`);
    assert.strictEqual(p.metaFile, `${slug}-meta.json`);
  }
});

test('derived names never collide with the committed {slug}.png', () => {
  // screenshot.js must not clobber the fallback image the repo still serves.
  const p = screenshotPaths('barcelona');
  assert.notStrictEqual(p.rawFile, 'barcelona.png');
  assert.notStrictEqual(p.metaFile, 'barcelona.png');
  assert.ok(!SCREENSHOT_SRC.includes('writeFileSync(outputFile'),
    'screenshot.js must not write OUTPUT_FILE itself');
});
