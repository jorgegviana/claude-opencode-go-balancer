'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJsonAtomic } = require('../lib/state.cjs');
const { defaults } = require('../lib/config.cjs');

test('state files are written owner-only (0600)', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hard-'));
  const f = path.join(dir, 'state.json');
  writeJsonAtomic(f, { a: 1 });
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  writeJsonAtomic(f, { a: 2 });
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
});

test('default claude allow-list has no arbitrary-code or push entries', () => {
  const c = defaults().claude;
  for (const bad of ['Bash(node:*)', 'Bash(git:*)', 'Bash(*)', 'Bash']) assert.ok(!c.allowed_tools.includes(bad), bad);
  assert.deepStrictEqual(c.disallowed_tools, ['Bash(git push:*)']);
});

test('LICENSE exists and matches package.json license', () => {
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lic = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
  assert.strictEqual(pkg.license, 'MIT');
  assert.match(lic, /^MIT License/);
});
