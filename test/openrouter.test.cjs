'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { defaults } = require('../lib/config.cjs');
const F = require('../lib/free.cjs');
const { checkSpend } = require('../lib/spend.cjs');
const { catalogsFor } = require('../lib/catalog.cjs');

const NOW = Date.parse('2026-11-17T12:00:00Z');
const PAID = 'openrouter/deepseek/deepseek-v4-flash';
const FREE = 'openrouter/google/gemma-4-31b-it:free';
const ok = { ok: true, ts: NOW - 1000, detail: '' };

function cfg(models) {
  const c = defaults();
  c.free_lane = { ...c.free_lane, enabled: true, agents: ['a'], models, spend_guard: { openrouter: { min_balance_usd: 5, cache_seconds: 300 } } };
  return c;
}
const cats = { openrouter: { [PAID]: { free: false }, [FREE]: { free: true } } };
const state = () => ({ canary: { [PAID]: ok, [FREE]: ok } });

test('normalizeModel accepts nested openrouter ids with :free', () => {
  assert.strictEqual(F.normalizeModel(FREE), FREE);
  assert.strictEqual(F.normalizeModel('openrouter/~z-ai/glm-flash-latest'), 'openrouter/~z-ai/glm-flash-latest');
  assert.deepStrictEqual(catalogsFor([FREE, PAID]), ['openrouter']);
});

test('isPaid: catalog decides, suffix only without a catalog', () => {
  assert.strictEqual(F.isPaid(cats, PAID), true);
  assert.strictEqual(F.isPaid(cats, FREE), false);
  assert.strictEqual(F.isPaid({}, FREE), false);
  assert.strictEqual(F.isPaid({}, PAID), true);
});

test('paid model needs an allowing spend guard; free model never does', () => {
  const c = cfg([PAID, FREE]);
  const base = { logical: 'a', cfg: c, state: state(), catalogs: cats, now: NOW };
  assert.strictEqual(F.pickFreeModel({ ...base, spend: { openrouter: { allowed: true, why: 'ok' } } }).model, PAID);
  const low = F.pickFreeModel({ ...base, spend: { openrouter: { allowed: false, why: 'balance $2.00 below floor $5' } } });
  assert.strictEqual(low.model, FREE);
  assert.match(low.reason || '', /./);
  const noGuard = F.pickFreeModel({ ...base, spend: {} });
  assert.strictEqual(noGuard.model, FREE);
  assert.strictEqual(F.pickFreeModel({ ...base, cfg: cfg([PAID]), spend: {} }).model, null);
});

function auth(withKey = true) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bal-')), 'auth.json');
  fs.writeFileSync(p, JSON.stringify(withKey ? { openrouter: { type: 'api', key: 'sk-or-SECRET' } } : {}));
  return p;
}
const resp = (data, okFlag = true) => async () => ({ ok: okFlag, status: okFlag ? 200 : 500, json: async () => ({ data }) });
const guard = { min_balance_usd: 5, cache_seconds: 300 };

test('checkSpend: balance above/below floor, cached, fail closed, key never leaks', async () => {
  const c = defaults();
  const st = {};
  let calls = 0;
  const f = async (...a) => { calls++; return resp({ total_credits: 40, total_usage: 7 })(...a); };
  let r = await checkSpend({ provider: 'openrouter', guard, fetchFn: f, authPath: auth(), cfg: c, state: st, now: NOW });
  assert.deepStrictEqual([r.allowed, r.balance], [true, 33]);
  await checkSpend({ provider: 'openrouter', guard, fetchFn: f, authPath: auth(), cfg: c, state: st, now: NOW + 1000 });
  assert.strictEqual(calls, 1);
  r = await checkSpend({ provider: 'openrouter', guard, fetchFn: resp({ total_credits: 10, total_usage: 7 }), authPath: auth(), cfg: c, state: {}, now: NOW });
  assert.strictEqual(r.allowed, false);
  r = await checkSpend({ provider: 'openrouter', guard, fetchFn: resp(null, false), authPath: auth(), cfg: c, state: {}, now: NOW });
  assert.strictEqual(r.allowed, false);
  r = await checkSpend({ provider: 'openrouter', guard, fetchFn: resp({}), authPath: auth(), cfg: c, state: {}, now: NOW });
  assert.strictEqual(r.allowed, false);
  r = await checkSpend({ provider: 'openrouter', guard, fetchFn: resp({}), authPath: auth(false), cfg: c, state: {}, now: NOW });
  assert.strictEqual(r.allowed, false);
  const bad = async () => { throw new Error('boom sk-or-SECRET'); };
  const s2 = {};
  r = await checkSpend({ provider: 'openrouter', guard, fetchFn: bad, authPath: auth(), cfg: c, state: s2, now: NOW });
  assert.strictEqual(r.allowed, false);
  assert.ok(!JSON.stringify([r, s2]).includes('sk-or-SECRET'));
  r = await checkSpend({ provider: 'openrouter', guard: {}, fetchFn: f, authPath: auth(), cfg: c, state: {}, now: NOW });
  assert.strictEqual(r.allowed, false);
});
