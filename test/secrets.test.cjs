'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCAN = path.join(__dirname, '..', 'scripts', 'scan-secrets.cjs');
const run = (dir, env = {}) =>
  spawnSync(process.execPath, [SCAN, dir], { encoding: 'utf8', env: { ...process.env, ...env } });

test('repo is clean', () => {
  const r = run(path.join(__dirname, '..'));
  assert.strictEqual(r.status, 0, r.stdout);
});

test('detects a planted sk- string without printing it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
  const planted = 'sk-' + 'a1B2'.repeat(6);
  fs.writeFileSync(path.join(dir, 'x.txt'), 'line1\nvalue = ' + planted + '\n');
  const r = run(dir);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /x\.txt:2 sk-token/);
  assert.ok(!r.stdout.includes(planted) && !r.stderr.includes(planted));
});

test('detects the real key value from auth.json without printing it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
  const auth = path.join(dir, 'auth.json');
  const fake = 'FAKE_KEY_FOR_TESTS_0123';
  fs.writeFileSync(auth, JSON.stringify({ 'opencode-go': { type: 'api', key: fake } }));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
  fs.writeFileSync(path.join(work, 'n.txt'), 'x ' + fake + '\n');
  const r = run(work, { BALANCER_OPENCODE_AUTH: auth });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /n\.txt:1 real-key-value/);
  assert.ok(!r.stdout.includes(fake));
});
