'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { defaults } = require('../lib/config.cjs');
const C = require('../lib/catalog.cjs');

const NOW = Date.parse('2026-11-17T12:00:00Z');
const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'models', n), 'utf8');
const cfg = defaults();

test('parseCatalog: keyed by provider/id with free/status/toolcall', () => {
  const m = C.parseCatalog(fx('opencode.txt'), 'opencode');
  assert.strictEqual(m['opencode/beam-free'].free, true);
  assert.strictEqual(m['opencode/premium-pro'].free, false);
  assert.strictEqual(m['opencode/big-pickle'].status, 'active');
  assert.strictEqual(m['opencode/big-pickle'].toolcall, true);
  assert.ok(!('opencode/minimax-m3.1-flash-free' in m));
  const go = C.parseCatalog(fx('opencode-go.txt'), 'opencode-go');
  assert.strictEqual(go['opencode-go/deepseek-v4-pro'].status, 'deprecated');
  assert.strictEqual(go['opencode-go/kimi-k2.7-code'].free, false);
});

test('parseCatalog: garbage or empty -> null', () => {
  assert.strictEqual(C.parseCatalog('', 'opencode'), null);
  assert.strictEqual(C.parseCatalog('Error: boom\nnope', 'opencode'), null);
  assert.strictEqual(C.parseCatalog('opencode/x\n{not json', 'opencode'), null);
});

function mkExec(result) {
  const calls = [];
  const exec = (bin, args, o) => { calls.push({ bin, args, o }); return typeof result === 'function' ? result() : result; };
  return { exec, calls };
}
const okRes = (t) => ({ status: 0, stdout: t, stderr: '', timedOut: false });

test('getCatalog: cache hit, stale refresh, refresh flag', () => {
  const state = {};
  const e = mkExec(okRes(fx('opencode.txt')));
  const a = C.getCatalog({ exec: e.exec, bin: 'oc', cfg, state, provider: 'opencode', now: NOW });
  assert.ok(a['opencode/beam-free']);
  assert.deepStrictEqual(e.calls[0].args, ['models', 'opencode', '--verbose']);
  assert.strictEqual(e.calls[0].o.timeoutMs, cfg.catalog.timeout_seconds * 1000);
  C.getCatalog({ exec: e.exec, bin: 'oc', cfg, state, provider: 'opencode', now: NOW + 599e3 });
  assert.strictEqual(e.calls.length, 1, 'fresh cache: no exec');
  C.getCatalog({ exec: e.exec, bin: 'oc', cfg, state, provider: 'opencode', now: NOW + 601e3 });
  assert.strictEqual(e.calls.length, 2, 'stale: exec once');
  C.getCatalog({ exec: e.exec, bin: 'oc', cfg, state, provider: 'opencode', now: NOW + 602e3, refresh: true });
  assert.strictEqual(e.calls.length, 3, 'refresh bypasses cache');
});

test('getCatalog: failures are fail-open and cached for the TTL', () => {
  for (const res of [{ status: 1, stdout: '', stderr: 'x', timedOut: false }, { status: null, stdout: '', stderr: '', timedOut: true }, okRes('garbage')]) {
    const state = {};
    const e = mkExec(res);
    assert.strictEqual(C.getCatalog({ exec: e.exec, bin: 'oc', cfg, state, provider: 'opencode', now: NOW }), null);
    assert.strictEqual(state.catalog.opencode.ok, false);
    assert.strictEqual(C.getCatalog({ exec: e.exec, bin: 'oc', cfg, state, provider: 'opencode', now: NOW + 5e3 }), null);
    assert.strictEqual(e.calls.length, 1, 'failure cached, no second exec in TTL');
  }
});

test('getCatalog: exec that throws is fail-open; error text has no paths', () => {
  const state = {};
  const exec = () => { throw new Error('spawn /some/home/dir/opencode ENOENT'); };
  assert.strictEqual(C.getCatalog({ exec, bin: 'oc', cfg, state, provider: 'opencode', now: NOW }), null);
  assert.ok(!/\//.test(state.catalog.opencode.error));
});

test('catalogsFor: unique provider prefixes', () => {
  assert.deepStrictEqual(C.catalogsFor(['opencode/a', 'opencode/b', 'opencode-go/c', 'bad']).sort(), ['opencode', 'opencode-go']);
});

test('catalogHas fail-open and cachedCatalogs', () => {
  assert.strictEqual(C.catalogHas({}, 'opencode/a'), true);
  assert.strictEqual(C.catalogHas({ opencode: {} }, 'opencode/a'), false);
  const state = { catalog: { opencode: { ts: NOW, ok: true, models: { 'opencode/a': {} } }, 'opencode-go': { ts: NOW, ok: false, error: 'x' } } };
  const cc = C.cachedCatalogs(state);
  assert.deepStrictEqual(Object.keys(cc.opencode), ['opencode/a']);
  assert.strictEqual(cc['opencode-go'], null);
});
