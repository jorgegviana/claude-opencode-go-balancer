'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { defaults } = require('../lib/config.cjs');
const { normalizeOpencode, normalizeClaude, getOpencodeUsage } = require('../lib/usage.cjs');

const NOW = Date.parse('2026-11-17T12:00:00Z');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));
const cfg = defaults();

test('normalizeOpencode maps the verified response', () => {
  const p = normalizeOpencode(fx('opencode-ok.json'), cfg, NOW);
  assert.strictEqual(p.known, true);
  const by = Object.fromEntries(p.windows.map((w) => [w.name, w]));
  assert.strictEqual(by.rolling.used, 10);
  assert.strictEqual(by.rolling.lenMin, 300);
  assert.strictEqual(by.weekly.lenMin, 10080);
  assert.strictEqual(by.monthly.lenMin, 43200);
  assert.strictEqual(by.weekly.resetsAt, Date.parse('2026-11-23T00:00:00Z'));
});

test('normalizeOpencode: garbage -> unknown', () => {
  for (const bad of [null, undefined, 'x', {}, { usage: 5 }, { usage: {} }]) {
    assert.strictEqual(normalizeOpencode(bad, cfg, NOW).known, false);
  }
});

test('normalizeClaude: windows optional and past resets dropped', () => {
  const st = fx('claude-ok.json');
  const p = normalizeClaude(st, cfg, NOW);
  assert.strictEqual(p.known, true);
  assert.deepStrictEqual(p.windows.map((w) => w.name).sort(), ['five_hour', 'seven_day']);
  delete st.rate_limits.seven_day;
  assert.deepStrictEqual(normalizeClaude(st, cfg, NOW).windows.map((w) => w.name), ['five_hour']);
  st.rate_limits.five_hour.resets_at = Math.floor(NOW / 1000) - 10;
  assert.strictEqual(normalizeClaude(st, cfg, NOW).windows.length, 0);
});

test('normalizeClaude: missing state -> unknown', () => {
  assert.strictEqual(normalizeClaude(null, cfg, NOW).known, false);
  assert.strictEqual(normalizeClaude({}, cfg, NOW).known, false);
});

test('normalizeClaude: stale is unknown, but a future hard-stop window still blocks', () => {
  const stale = normalizeClaude(fx('claude-stale.json'), cfg, NOW);
  assert.strictEqual(stale.known, false);
  assert.strictEqual(stale.windows.length, 0);
  const blocked = normalizeClaude(fx('claude-stale-exhausted.json'), cfg, NOW);
  assert.strictEqual(blocked.known, false);
  assert.deepStrictEqual(blocked.windows.map((w) => w.name), ['five_hour']);
});

function auth(key) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'auth-')), 'auth.json');
  fs.writeFileSync(f, JSON.stringify({ 'opencode-go': { key } }));
  return f;
}
const okFetch = (calls) => async (url, init) => {
  calls.push({ url, init });
  return { ok: true, status: 200, json: async () => fx('opencode-ok.json') };
};

test('getOpencodeUsage sends Bearer + generic UA and caches', async () => {
  const calls = [];
  const authPath = auth('FAKE_KEY_FOR_TESTS');
  const r1 = await getOpencodeUsage({ fetchFn: okFetch(calls), authPath, cfg, now: NOW, cache: null });
  assert.strictEqual(r1.provider.known, true);
  assert.strictEqual(calls[0].url, 'https://opencode.ai/zen/go/v1/usage');
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer FAKE_KEY_FOR_TESTS');
  assert.strictEqual(calls[0].init.headers['User-Agent'], 'usage-balancer/1.0');
  const r2 = await getOpencodeUsage({ fetchFn: okFetch(calls), authPath, cfg, now: NOW + 30000, cache: r1.cache });
  assert.strictEqual(calls.length, 1, 'served from cache');
  await getOpencodeUsage({ fetchFn: okFetch(calls), authPath, cfg, now: NOW + 61000, cache: r1.cache });
  assert.strictEqual(calls.length, 2, 'cache expired');
  await getOpencodeUsage({ fetchFn: okFetch(calls), authPath, cfg, now: NOW + 1000, cache: r1.cache, bypassCache: true });
  assert.strictEqual(calls.length, 3, 'bypass');
  assert.ok(!JSON.stringify(r1.cache).includes('FAKE_KEY_FOR_TESTS'));
  assert.ok(!JSON.stringify(r2).includes('FAKE_KEY_FOR_TESTS'));
});

test('getOpencodeUsage failures -> unknown, error never contains the key', async () => {
  const key = 'FAKE_KEY_FOR_TESTS';
  const authPath = auth(key);
  const cases = {
    throws: async () => { throw new Error('boom Bearer ' + key); },
    non2xx: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    badjson: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json ' + key); } }),
    timeout: (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))),
  };
  for (const [name, fetchFn] of Object.entries(cases)) {
    const c = { ...cfg, fetch_timeout_ms: 30 };
    const r = await getOpencodeUsage({ fetchFn, authPath, cfg: c, now: NOW, cache: null });
    assert.strictEqual(r.provider.known, false, name);
    assert.ok(r.error && !r.error.includes(key), name + ': ' + r.error);
  }
});

test('getOpencodeUsage: missing auth -> unknown without calling fetch', async () => {
  let called = false;
  const r = await getOpencodeUsage({
    fetchFn: async () => { called = true; },
    authPath: '/nonexistent/auth.json', cfg, now: NOW, cache: null,
  });
  assert.strictEqual(called, false);
  assert.strictEqual(r.provider.known, false);
  assert.match(r.error, /auth/);
});
