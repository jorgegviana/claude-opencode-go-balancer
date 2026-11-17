'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { defaults } = require('../lib/config.cjs');
const R = require('../lib/reactive.cjs');
const { decide } = require('../lib/decide.cjs');

const NOW = Date.parse('2026-11-17T12:00:00Z');
const S = 1000;
const cfg = defaults();
const log = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'logs', n), 'utf8');

test('detectLimitError: limit logs, with hints', () => {
  const a = R.detectLimitError(log('opencode-limit.jsonl'), cfg, NOW);
  assert.strictEqual(a.limit, true);
  assert.strictEqual(a.retryAfterMs, 120 * S);
  const b = R.detectLimitError(log('claude-limit.jsonl'), cfg, NOW);
  assert.strictEqual(b.limit, true);
  assert.strictEqual(b.resetsAt, Date.parse('2026-11-17T15:00:00Z'));
});

test('detectLimitError: raw 429 / usage limit text, case-insensitive', () => {
  for (const t of ['HTTP 429 Too Many Requests', 'Rate_Limit exceeded', 'You hit the USAGE LIMIT', 'rate limit']) {
    assert.strictEqual(R.detectLimitError(t, cfg, NOW).limit, true, t);
  }
});

test('detectLimitError: plain failure -> {limit:false}, success -> null (no false positive on report text)', () => {
  assert.deepStrictEqual(R.detectLimitError(log('opencode-crash.jsonl'), cfg, NOW), { limit: false });
  assert.strictEqual(R.detectLimitError(log('opencode-success.jsonl'), cfg, NOW), null);
  assert.strictEqual(R.detectLimitError(log('claude-success.jsonl'), cfg, NOW), null);
  assert.strictEqual(R.detectLimitError('', cfg, NOW), null);
});

test('backoff sequence 30s,60s,120s ... capped at 15 min', () => {
  const st = {};
  const seq = [];
  for (let i = 0; i < 8; i++) {
    R.recordLimit(st, 'opencode', {}, cfg, NOW);
    seq.push((st.providers.opencode.cooldownUntil - NOW) / S);
  }
  assert.deepStrictEqual(seq, [30, 60, 120, 240, 480, 900, 900, 900]);
});

test('recordLimit honours hints', () => {
  const st = {};
  R.recordLimit(st, 'claude', { retryAfterMs: 45 * S }, cfg, NOW);
  assert.strictEqual(st.providers.claude.cooldownUntil, NOW + 45 * S);
  R.recordLimit(st, 'claude', { resetsAt: NOW + 600 * S }, cfg, NOW);
  assert.strictEqual(st.providers.claude.cooldownUntil, NOW + 600 * S);
});

test('cooldown, single probe, success clears', () => {
  const st = {};
  assert.strictEqual(R.isProviderAvailable(st, 'opencode', cfg, NOW).available, true);
  R.recordLimit(st, 'opencode', {}, cfg, NOW);
  const cool = R.isProviderAvailable(st, 'opencode', cfg, NOW + 10 * S);
  assert.deepStrictEqual([cool.available, cool.until], [false, NOW + 30 * S]);
  const t = NOW + 31 * S;
  assert.strictEqual(R.isProviderAvailable(st, 'opencode', cfg, t).available, true, 'first call after expiry = probe');
  assert.strictEqual(R.isProviderAvailable(st, 'opencode', cfg, t + S).available, false, 'probe in flight');
  assert.strictEqual(R.isProviderAvailable(st, 'opencode', cfg, t + 2 * S).available, false);
  R.recordSuccess(st, 'opencode');
  assert.strictEqual(R.isProviderAvailable(st, 'opencode', cfg, t + 3 * S).available, true);
  assert.strictEqual(R.isProviderAvailable(st, 'opencode', cfg, t + 4 * S).available, true, 'no probe needed once healthy');
});

test('peekProvider does not grant the probe', () => {
  const st = {};
  R.recordLimit(st, 'opencode', {}, cfg, NOW);
  const t = NOW + 31 * S;
  assert.strictEqual(R.peekProvider(st, 'opencode', cfg, t).available, true);
  assert.strictEqual(R.peekProvider(st, 'opencode', cfg, t).available, true);
  assert.strictEqual(R.isProviderAvailable(st, 'opencode', cfg, t).available, true);
  assert.strictEqual(R.peekProvider(st, 'opencode', cfg, t).available, false);
});

test('limit during probe re-cools with next backoff step', () => {
  const st = {};
  R.recordLimit(st, 'opencode', {}, cfg, NOW);
  const t = NOW + 31 * S;
  R.isProviderAvailable(st, 'opencode', cfg, t);
  R.recordLimit(st, 'opencode', {}, cfg, t);
  assert.strictEqual(st.providers.opencode.cooldownUntil, t + 60 * S);
  assert.strictEqual(R.isProviderAvailable(st, 'opencode', cfg, t + 61 * S).available, true);
});

test('probe stuck longer than probe_timeout_minutes is released', () => {
  const st = {};
  R.recordLimit(st, 'opencode', {}, cfg, NOW);
  const t = NOW + 31 * S;
  R.isProviderAvailable(st, 'opencode', cfg, t);
  assert.strictEqual(R.isProviderAvailable(st, 'opencode', cfg, t + 14 * 60 * S).available, false);
  assert.strictEqual(R.isProviderAvailable(st, 'opencode', cfg, t + 15 * 60 * S + S).available, true);
});

test('non-limit failure releases the probe', () => {
  const st = {};
  R.recordLimit(st, 'claude', {}, cfg, NOW);
  const t = NOW + 31 * S;
  R.isProviderAvailable(st, 'claude', cfg, t);
  R.recordFailure(st, 'claude');
  assert.strictEqual(R.peekProvider(st, 'claude', cfg, t + S).available, true);
});

test('circuit breaker: 3 failures open 30s, half-open single attempt, success closes', () => {
  const st = {};
  const k = 'gsd-executor';
  assert.strictEqual(R.breakerAllow(st, k, cfg, NOW).allowed, true);
  R.recordBreaker(st, k, false, cfg, NOW);
  R.recordBreaker(st, k, false, cfg, NOW);
  assert.strictEqual(R.breakerAllow(st, k, cfg, NOW).allowed, true, 'still closed after 2');
  R.recordBreaker(st, k, false, cfg, NOW);
  const open = R.breakerAllow(st, k, cfg, NOW + 10 * S);
  assert.deepStrictEqual([open.allowed, open.until], [false, NOW + 30 * S]);
  assert.strictEqual(R.breakerAllow(st, k, cfg, NOW + 31 * S).allowed, true, 'half-open attempt');
  assert.strictEqual(R.breakerAllow(st, k, cfg, NOW + 32 * S).allowed, false, 'only one half-open attempt');
  R.recordBreaker(st, k, false, cfg, NOW + 33 * S);
  assert.strictEqual(R.breakerAllow(st, k, cfg, NOW + 40 * S).allowed, false, 're-opened');
  assert.strictEqual(R.breakerAllow(st, k, cfg, NOW + 64 * S).allowed, true);
  R.recordBreaker(st, k, true, cfg, NOW + 65 * S);
  assert.strictEqual(R.breakerAllow(st, k, cfg, NOW + 66 * S).allowed, true);
  assert.strictEqual(st.breakers[k], undefined, 'closed and reset');
});

test('success resets the breaker failure count', () => {
  const st = {};
  R.recordBreaker(st, 'k', false, cfg, NOW);
  R.recordBreaker(st, 'k', false, cfg, NOW);
  R.recordBreaker(st, 'k', true, cfg, NOW);
  R.recordBreaker(st, 'k', false, cfg, NOW);
  assert.strictEqual(R.breakerAllow(st, 'k', cfg, NOW).allowed, true);
});

test('recordOutcome: opencode failure feeds breaker, limit feeds cooldown, success clears both', () => {
  const st = {};
  for (let i = 0; i < 3; i++) R.recordOutcome(st, { provider: 'opencode', key: 'a', outcome: 'failure' }, cfg, NOW);
  assert.strictEqual(R.breakerPeek(st, 'a', cfg, NOW + S).allowed, false);
  R.recordOutcome(st, { provider: 'opencode', key: 'a', outcome: 'limit', hint: {} }, cfg, NOW);
  assert.strictEqual(R.peekProvider(st, 'opencode', cfg, NOW + S).available, false);
  R.recordOutcome(st, { provider: 'opencode', key: 'a', outcome: 'success' }, cfg, NOW);
  assert.strictEqual(R.peekProvider(st, 'opencode', cfg, NOW + S).available, true);
  assert.strictEqual(R.breakerPeek(st, 'a', cfg, NOW + S).allowed, true);
});

// ---- decide integration ----
const MIN = 60000;
const prov = (used) => ({ known: true, windows: [{ name: 'weekly', used, resetsAt: NOW + 5040 * MIN, lenMin: 10080 }] });
const dec = (o) => decide({ agent: 'go-gsd-executor', cfg, now: NOW, opencode: prov(10), claude: prov(10), ...o });

test('decide: provider in cooldown is ineligible', () => {
  const st = {};
  R.recordLimit(st, 'claude', {}, cfg, NOW);
  const d = dec({ state: st });
  assert.strictEqual(d.verdict, 'opencode');
  assert.strictEqual(d.scores.claude.eligibleAt, NOW + 30 * S);
});

test('decide: open breaker blocks opencode for that agent only', () => {
  const st = {};
  for (let i = 0; i < 3; i++) R.recordBreaker(st, 'gsd-executor', false, cfg, NOW);
  assert.strictEqual(dec({ state: st }).verdict, 'claude');
  assert.notStrictEqual(dec({ state: st, agent: 'go-gsd-verifier' }).verdict, 'wait');
  const d = dec({ state: st, agent: 'go-gsd-verifier', opencode: prov(10), claude: prov(30) });
  assert.strictEqual(d.verdict, 'opencode');
});

test('decide: breaker key uses configured opencode model', () => {
  const c = { ...cfg, opencode: { agent_models: { 'gsd-executor': 'opencode-go/kimi' } } };
  const st = {};
  for (let i = 0; i < 3; i++) R.recordBreaker(st, 'opencode-go/kimi', false, cfg, NOW);
  assert.strictEqual(dec({ state: st, cfg: c }).verdict, 'claude');
});

test('decide: both limited -> wait at earliest cooldown, paygo only when enabled', () => {
  const st = {};
  R.recordLimit(st, 'opencode', {}, cfg, NOW);
  R.recordLimit(st, 'claude', { retryAfterMs: 100 * S }, cfg, NOW);
  const w = dec({ state: st });
  assert.strictEqual(w.verdict, 'wait');
  assert.strictEqual(w.until, NOW + 30 * S);
  const c = { ...cfg, paygo: { enabled: true, model: 'opencode/some-model' } };
  assert.strictEqual(dec({ state: st, cfg: c }).verdict, 'paygo');
  const c2 = { ...cfg, paygo: { enabled: true, model: null } };
  assert.strictEqual(dec({ state: st, cfg: c2 }).verdict, 'wait');
});

test('decide: cooldown merges with usage hard-stop eligibleAt', () => {
  const st = {};
  R.recordLimit(st, 'opencode', {}, cfg, NOW);
  const d = dec({ state: st, claude: prov(95) });
  assert.strictEqual(d.verdict, 'wait');
  assert.strictEqual(d.until, NOW + 30 * S);
});

// ---- CLI record ----
const BIN = path.join(__dirname, '..', 'bin', 'balancer.cjs');
function rec(args, statePath) {
  return spawnSync(process.execPath, [BIN, 'record', ...args], {
    encoding: 'utf8',
    env: { ...process.env, BALANCER_STATE: statePath, BALANCER_NOW: String(NOW), BALANCER_CONFIG: '/nonexistent.json' },
  });
}

test('CLI record: limit log -> cooldown persisted; success clears', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  const sp = path.join(dir, 'state.json');
  const fxl = (n) => path.join(__dirname, 'fixtures', 'logs', n);
  const r = rec(['opencode', 'go-gsd-executor', fxl('opencode-limit.jsonl')], sp);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^balancer: opencode limit; cooldown until 2026-11-17T12:02:00\.000Z\n$/);
  assert.strictEqual(JSON.parse(fs.readFileSync(sp, 'utf8')).providers.opencode.cooldownUntil, NOW + 120 * S);
  const ok = rec(['opencode', 'go-gsd-executor', fxl('opencode-success.jsonl')], sp);
  assert.match(ok.stdout, /success/);
  assert.strictEqual(JSON.parse(fs.readFileSync(sp, 'utf8')).providers.opencode, undefined);
  const f = rec(['opencode', 'go-gsd-executor', fxl('opencode-crash.jsonl')], sp);
  assert.match(f.stdout, /failure/);
  assert.strictEqual(JSON.parse(fs.readFileSync(sp, 'utf8')).breakers['gsd-executor'].failures, 1);
});

test('CLI record: usage error -> exit 2', () => {
  assert.strictEqual(rec([], '/tmp/x-nonexistent-state.json').status, 2);
});

// ---- MODEL_GONE and the free lane ----
test('detectLimitError: model gone patterns', () => {
  assert.deepStrictEqual(R.detectLimitError(log('opencode-failure.jsonl'), cfg, NOW), { limit: false, modelGone: true });
  for (const t of ['Error: model_not_found', 'HTTP 404 Not Found', 'model foo does not exist', 'this model has been retired']) {
    assert.strictEqual(R.detectLimitError(t, cfg, NOW).modelGone, true, t);
  }
  assert.strictEqual(R.detectLimitError('file src/x.gd does not exist', cfg, NOW), null, 'no "model" on the line');
  assert.strictEqual(R.detectLimitError(log('opencode-limit.jsonl'), cfg, NOW).limit, true);
});

test('recordOutcome model_gone: per-model cooldown 3600 s, provider untouched', () => {
  const st = { providers: { opencode: { hits: 0, cooldownUntil: NOW - 1, probeInFlight: true, probeStartedAt: NOW - 5 } } };
  R.recordOutcome(st, { provider: 'opencode', key: 'm1', outcome: 'model_gone' }, cfg, NOW);
  assert.strictEqual(st.modelCooldowns.m1.until, NOW + 3600 * S);
  assert.strictEqual(st.modelCooldowns.m1.reason, 'model_gone');
  assert.strictEqual(st.providers.opencode.probeInFlight, false);
  assert.strictEqual(st.providers.opencode.cooldownUntil, NOW - 1);
  assert.strictEqual(st.breakers, undefined);
});

test('applyReactive: model cooldown makes opencode ineligible only for that key', () => {
  const st = { modelCooldowns: { m1: { until: NOW + 3600 * S } } };
  const base = { opencode: { status: 'eligible', headroom: 50, eligibleAt: null }, claude: { status: 'eligible', headroom: 40, eligibleAt: null } };
  const a = R.applyReactive(base, st, { key: 'm1', cfg, now: NOW });
  assert.strictEqual(a.opencode.status, 'ineligible');
  assert.strictEqual(a.opencode.eligibleAt, NOW + 3600 * S);
  assert.strictEqual(R.applyReactive(base, st, { key: 'm2', cfg, now: NOW }).opencode.status, 'eligible');
});

test('free provider: limit/model_gone/failure touch only the model', () => {
  const m = 'opencode/x-free';
  const st = {};
  R.recordOutcome(st, { provider: 'free', key: m, outcome: 'limit', hint: { retryAfterMs: 120 * S } }, cfg, NOW);
  assert.strictEqual(st.modelCooldowns[m].until, NOW + 120 * S);
  assert.strictEqual(st.modelCooldowns[m].reason, 'limit');
  R.recordOutcome(st, { provider: 'free', key: m, outcome: 'limit', hint: {} }, cfg, NOW);
  assert.strictEqual(st.modelCooldowns[m].until, NOW + 60 * S, 'second hit uses backoff formula');
  R.recordOutcome(st, { provider: 'free', key: m, outcome: 'model_gone' }, cfg, NOW);
  assert.strictEqual(st.modelCooldowns[m].until, NOW + 3600 * S);
  R.recordOutcome(st, { provider: 'free', key: m, outcome: 'failure' }, cfg, NOW);
  assert.strictEqual(st.breakers[m].failures, 1);
  assert.strictEqual(st.providers, undefined);
  R.recordOutcome(st, { provider: 'free', key: m, outcome: 'success' }, cfg, NOW);
  assert.strictEqual(st.modelCooldowns[m], undefined);
  assert.strictEqual(st.breakers[m], undefined);
  assert.strictEqual(st.providers, undefined);
});

test('CLI record: model_gone summary and state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  const sp = path.join(dir, 'state.json');
  const r = rec(['opencode', 'go-gsd-executor', path.join(__dirname, 'fixtures', 'logs', 'opencode-failure.jsonl')], sp);
  assert.strictEqual(r.stdout, `balancer: opencode model_gone gsd-executor; cooldown until ${new Date(NOW + 3600 * S).toISOString()}\n`);
  const st = JSON.parse(fs.readFileSync(sp, 'utf8'));
  assert.strictEqual(st.modelCooldowns['gsd-executor'].until, NOW + 3600 * S);
  assert.strictEqual(st.providers && st.providers.opencode && st.providers.opencode.cooldownUntil, undefined);
});
