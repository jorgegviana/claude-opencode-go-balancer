'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'claude-usage-statusline.cjs');
const CHAIN = path.join(__dirname, 'fixtures', 'bin', 'fake-chain.cjs');
const NOW = Date.parse('2026-11-17T12:00:00Z');

function run(input, args = [], env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const state = path.join(dir, 'usage-state.json');
  const r = spawnSync(process.execPath, [BIN, ...args], {
    input, encoding: 'utf8',
    env: { ...process.env, BALANCER_CLAUDE_STATE: state, BALANCER_NOW: String(NOW), ...env },
  });
  return { r, state };
}

test('writes state atomically and prints a short line', () => {
  const input = JSON.stringify({
    tag: 'x',
    rate_limits: {
      five_hour: { used_percentage: 41.6, resets_at: 1795000000 },
      seven_day: { used_percentage: 10, resets_at: 1795500000 },
      other: { used_percentage: 1 },
    },
  });
  const { r, state } = run(input);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, 'claude 5h 42% 7d 10%\n');
  const s = JSON.parse(fs.readFileSync(state, 'utf8'));
  assert.strictEqual(s.ts, NOW);
  assert.deepStrictEqual(Object.keys(s.rate_limits).sort(), ['five_hour', 'seven_day']);
  assert.strictEqual(s.rate_limits.five_hour.resets_at, 1795000000);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(state)), ['usage-state.json'], 'no tmp leftovers');
});

test('no rate_limits -> empty state, "claude usage n/a"', () => {
  const { r, state } = run(JSON.stringify({ tag: 'x' }));
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, 'claude usage n/a\n');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(state, 'utf8')).rate_limits, {});
});

test('single window prints only that window', () => {
  const { r } = run(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 7, resets_at: 1795000000 } } }));
  assert.strictEqual(r.stdout, 'claude 5h 7%\n');
});

test('invalid JSON -> exit 0, state untouched', () => {
  const { r, state } = run('not json{');
  assert.strictEqual(r.status, 0);
  assert.ok(!fs.existsSync(state));
});

test('--chain pipes stdin to the command and appends our text', () => {
  const input = JSON.stringify({ tag: 'abc', rate_limits: { five_hour: { used_percentage: 5, resets_at: 1795000000 } } });
  const { r } = run(input, ['--chain', process.execPath, CHAIN]);
  assert.strictEqual(r.stdout, 'chain:abc | claude 5h 5%\n');
});

test('--chain failure still prints our text', () => {
  const input = JSON.stringify({ tag: 'abc', rate_limits: { five_hour: { used_percentage: 5, resets_at: 1795000000 } } });
  const { r } = run(input, ['--chain', process.execPath, CHAIN], { FAKE_CHAIN_FAIL: '1' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, 'claude 5h 5%\n');
  const missing = run(input, ['--chain', '/nonexistent/cmd']);
  assert.strictEqual(missing.r.stdout, 'claude 5h 5%\n');
});
