'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { formatRtkGain, readRtkGain } = require('../lib/rtk.cjs');

const sample = { summary: { total_commands: 8, total_saved: 5500, avg_savings_pct: 67.64 } };

test('formats saved tokens and percent', () => {
  assert.strictEqual(formatRtkGain(sample), 'rtk: saved 5500 tokens (67.6%) across 8 commands');
});
test('returns null for missing or malformed data', () => {
  assert.strictEqual(formatRtkGain(null), null);
  assert.strictEqual(formatRtkGain({}), null);
  assert.strictEqual(formatRtkGain({ summary: { total_commands: 0 } }), null);
});
test('readRtkGain parses injected exec output and tolerates failure', () => {
  assert.strictEqual(readRtkGain(() => JSON.stringify(sample)), formatRtkGain(sample));
  assert.strictEqual(readRtkGain(() => { throw new Error('ENOENT'); }), null);
  assert.strictEqual(readRtkGain(() => 'not json'), null);
});
