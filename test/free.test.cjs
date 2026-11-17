'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { defaults, loadConfig } = require('../lib/config.cjs');
const F = require('../lib/free.cjs');

const NOW = Date.parse('2026-11-17T12:00:00Z');
const H = 3600e3;
const M1 = 'opencode/glm-5.3-flash-free';
const M2 = 'opencode/mimo-v2.6-flash-free';

function cfgWith(free = {}, extra = {}) {
  const c = defaults();
  c.free_lane = { ...c.free_lane, enabled: true, agents: ['gsd-executor'], models: [M1, M2], ...free };
  Object.assign(c, extra);
  return c;
}
const ok = (ts = NOW - H) => ({ ok: true, ts, detail: '' });

test('config: free_lane defaults, consumer-shaped config stays disabled', () => {
  const d = defaults().free_lane;
  assert.strictEqual(d.enabled, false);
  assert.strictEqual(d.models.length, 7);
  assert.deepStrictEqual(d.agents, []);
  assert.strictEqual(d.canary_ttl_days, 7);
  assert.strictEqual(d.canary_timeout_seconds, 300);
  assert.strictEqual(d.escalate_on_failure, true);
  assert.strictEqual(loadConfig('/nonexistent/none.json').free_lane.enabled, false);
});

test('normalizeModel', () => {
  assert.strictEqual(F.normalizeModel('glm-5.3-flash-free'), 'opencode/glm-5.3-flash-free');
  assert.strictEqual(F.normalizeModel('opencode/x-free'), 'opencode/x-free');
  for (const bad of ['-rf', '', 'a b', 'opencode/../x', 'opencode/-x', null, 'a/b/c/d/e', 'a/b/../c', 'openrouter/x/-y']) {
    assert.strictEqual(F.normalizeModel(bad), null, String(bad));
  }
});

test('freeAgentAllowed: enabled, listed, pin wins', () => {
  assert.strictEqual(F.freeAgentAllowed('gsd-executor', cfgWith()), true);
  assert.strictEqual(F.freeAgentAllowed('gsd-executor', cfgWith({ enabled: false })), false);
  assert.strictEqual(F.freeAgentAllowed('other', cfgWith()), false);
  assert.strictEqual(F.freeAgentAllowed('gsd-executor', cfgWith({}, { lanes: { ...defaults().lanes, pinned_to_claude: ['gsd-executor'] } })), false);
});

test('pickFreeModel: first canary-passed model in config order', () => {
  const state = { canary: { [M1]: ok(), [M2]: ok() } };
  const r = F.pickFreeModel({ logical: 'gsd-executor', cfg: cfgWith(), state, catalogs: {}, now: NOW });
  assert.strictEqual(r.model, M1);
});

test('pickFreeModel: skip reasons, falling through in order', () => {
  const cfg = cfgWith();
  const pick = (state, catalogs = {}) => F.pickFreeModel({ logical: 'gsd-executor', cfg, state, catalogs, now: NOW });
  assert.strictEqual(pick({}).model, null);
  assert.match(pick({}).reason, /no canary/);
  assert.strictEqual(pick({ canary: { [M1]: { ok: false, ts: NOW - H }, [M2]: ok() } }).model, M2);
  assert.strictEqual(pick({ canary: { [M1]: ok(NOW - 8 * 24 * H), [M2]: ok() } }).model, M2);
  assert.strictEqual(pick({ canary: { [M1]: ok(), [M2]: ok() }, modelCooldowns: { [M1]: { until: NOW + 1000 } } }).model, M2);
  assert.strictEqual(pick({ canary: { [M1]: ok(), [M2]: ok() }, modelCooldowns: { [M1]: { until: NOW - 1 } } }).model, M1);
  const open = { [M1]: { failures: 3, openUntil: NOW + 5000 } };
  assert.strictEqual(pick({ canary: { [M1]: ok(), [M2]: ok() }, breakers: open }).model, M2);
  const cat = { opencode: { [M2]: { free: true } } };
  assert.strictEqual(pick({ canary: { [M1]: ok(), [M2]: ok() } }, cat).model, M2);
  assert.strictEqual(pick({ canary: { [M1]: ok(), [M2]: ok() } }, { opencode: null }).model, M1);
});

test('pickFreeModel: invalid configured entries skipped; not allowed agent gets no model', () => {
  const cfg = cfgWith({ models: ['-rf', M2] });
  const r = F.pickFreeModel({ logical: 'gsd-executor', cfg, state: { canary: { [M2]: ok() } }, catalogs: {}, now: NOW });
  assert.strictEqual(r.model, M2);
  const n = F.pickFreeModel({ logical: 'zzz', cfg, state: { canary: { [M2]: ok() } }, catalogs: {}, now: NOW });
  assert.strictEqual(n.model, null);
});

test('catalogHas is fail-open', () => {
  assert.strictEqual(F.catalogHas({}, M1), true);
  assert.strictEqual(F.catalogHas({ opencode: null }, M1), true);
  assert.strictEqual(F.catalogHas({ opencode: {} }, M1), false);
  assert.strictEqual(F.catalogHas({ opencode: { [M1]: {} } }, M1), true);
});
