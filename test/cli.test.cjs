'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'balancer.cjs');
const FX = path.join(__dirname, 'fixtures');
const NOW = Date.parse('2026-11-17T12:00:00Z');

function run(args, { oc = 'opencode-ok.json', cl = 'claude-ok.json', env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BALANCER_CONFIG: path.join(dir, 'missing.json'),
      BALANCER_STATE: path.join(dir, 'state.json'),
      BALANCER_CLAUDE_STATE: cl ? path.join(FX, cl) : path.join(dir, 'none.json'),
      BALANCER_OPENCODE_USAGE_FILE: path.join(FX, oc),
      BALANCER_OPENCODE_AUTH: path.join(FX, 'auth-fake.json'),
      BALANCER_NOW: String(NOW),
      ...env,
    },
  });
  return r;
}

test('pick: claude has more headroom -> claude on line 1', () => {
  const r = run(['pick', 'go-worker'], { cl: 'claude-high.json' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.split('\n')[0], 'claude');
  assert.ok(r.stderr.length > 0, 'reason on stderr');
});

test('pick: close headroom, no lastPick -> tie goes to opencode lane by headroom', () => {
  const r = run(['pick', 'go-worker']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout.split('\n')[0], /^(opencode|claude)$/);
});

test('pick: pinned agent -> claude', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const cfg = path.join(dir, 'c.json');
  fs.writeFileSync(cfg, JSON.stringify({ lanes: { pinned_to_claude: ['gsd-planner'] } }));
  const r = run(['pick', 'go-gsd-planner'], { cl: 'claude-ok.json', env: { BALANCER_CONFIG: cfg } });
  assert.strictEqual(r.stdout.split('\n')[0], 'claude');
});

test('pick: both exhausted -> wait <ISO>', () => {
  const r = run(['pick', 'go-worker'], { oc: 'opencode-exhausted.json', cl: 'claude-exhausted.json' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout.split('\n')[0], /^wait \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.strictEqual(r.stdout.split('\n')[0], 'wait ' + new Date(NOW + 2 * 3600e3).toISOString());
});

test('pick: unknown claude (no state file) -> opencode', () => {
  const r = run(['pick', 'go-worker'], { cl: null });
  assert.strictEqual(r.stdout.split('\n')[0], 'opencode');
});

test('pick persists lastPick (hysteresis across calls)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
  const state = path.join(dir, 'state.json');
  const r1 = run(['pick', 'go-worker'], { cl: 'claude-high.json', env: { BALANCER_STATE: state } });
  assert.strictEqual(r1.stdout.split('\n')[0], 'claude');
  assert.strictEqual(JSON.parse(fs.readFileSync(state, 'utf8')).lastPick, 'claude');
});

test('status lists windows and never the key', () => {
  const r = run(['status']);
  assert.strictEqual(r.status, 0, r.stderr);
  for (const w of ['rolling', 'weekly', 'monthly', 'five_hour', 'seven_day']) assert.match(r.stdout, new RegExp(w));
  assert.match(r.stdout, /resets 2026-/);
  assert.ok(!r.stdout.includes('FAKE_KEY_FOR_TESTS') && !r.stderr.includes('FAKE_KEY_FOR_TESTS'));
});

test('wait-reset --max-seconds 0: exits 75 when exhausted, 0 when eligible', () => {
  const ex = run(['wait-reset', '--max-seconds', '0'], { oc: 'opencode-exhausted.json', cl: 'claude-exhausted.json' });
  assert.strictEqual(ex.status, 75);
  assert.match(ex.stdout, /balancer: still waiting until 2026-/);
  const ok = run(['wait-reset', '--max-seconds', '0']);
  assert.strictEqual(ok.status, 0);
});

test('unknown command exits 2', () => {
  assert.strictEqual(run(['bogus']).status, 2);
  assert.strictEqual(run([]).status, 2);
});

// ---- free lane ----
const FREE_M = 'opencode/glm-5.3-flash-free';
function freeSetup({ enabled = true, agents = ['gsd-executor'], canary = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'free-'));
  const cfg = path.join(dir, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ free_lane: { enabled, agents, models: [FREE_M] } }));
  const state = path.join(dir, 'state.json');
  if (canary) fs.writeFileSync(state, JSON.stringify({ canary: { [FREE_M]: { ok: true, ts: NOW - 3600e3, detail: '' } } }));
  return { dir, cfg, state, env: { BALANCER_CONFIG: cfg, BALANCER_STATE: state } };
}

test('free: pick prints "free <model>" even with the usage file missing; lastPick untouched', () => {
  const s = freeSetup();
  const r = run(['pick', 'go-gsd-executor'], { env: { ...s.env, BALANCER_OPENCODE_USAGE_FILE: path.join(s.dir, 'missing.json') } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.split('\n')[0], 'free ' + FREE_M);
  assert.strictEqual(JSON.parse(fs.readFileSync(s.state, 'utf8')).lastPick, undefined);
});

test('free: disabled, unlisted agent or no canary -> existing verdicts', () => {
  for (const [opts, agent] of [[{ enabled: false }, 'go-gsd-executor'], [{}, 'go-worker'], [{ canary: false }, 'go-gsd-executor']]) {
    const s = freeSetup(opts);
    const r = run(['pick', agent], { cl: 'claude-high.json', env: s.env });
    assert.match(r.stdout.split('\n')[0], /^(opencode|claude)$/, JSON.stringify(opts));
  }
});

test('free: pinned agent never goes free', () => {
  const s = freeSetup();
  fs.writeFileSync(s.cfg, JSON.stringify({ lanes: { pinned_to_claude: ['gsd-executor'] }, free_lane: { enabled: true, agents: ['gsd-executor'], models: [FREE_M] } }));
  const r = run(['pick', 'go-gsd-executor'], { env: s.env });
  assert.strictEqual(r.stdout.split('\n')[0], 'claude');
});

// ---- catalog, canary, models, status ----
const FAKE_OC = path.join(FX, 'bin', 'fake-opencode');
const MODELS_DIR = path.join(FX, 'models');
function ocEnv(dir, extra = {}) {
  return { BALANCER_OPENCODE_BIN: FAKE_OC, FAKE_MODELS_DIR: MODELS_DIR, FAKE_CALL_LOG: path.join(dir, 'calls.log'), ...extra };
}
const calls = (dir) => { try { return fs.readFileSync(path.join(dir, 'calls.log'), 'utf8'); } catch { return ''; } };
const MISSING = 'opencode/minimax-m3.1-flash-free';

function twoFree(extra = {}) {
  const s = freeSetup();
  fs.writeFileSync(s.cfg, JSON.stringify({ free_lane: { enabled: true, agents: ['gsd-executor'], models: [MISSING, FREE_M] }, ...extra }));
  fs.writeFileSync(s.state, JSON.stringify({ canary: {
    [MISSING]: { ok: true, ts: NOW - 3600e3, detail: '' }, [FREE_M]: { ok: true, ts: NOW - 3600e3, detail: '' },
  } }));
  return s;
}

test('catalog: free model missing from the catalog is skipped', () => {
  const s = twoFree();
  const r = run(['pick', 'go-gsd-executor'], { env: { ...s.env, ...ocEnv(s.dir) } });
  assert.strictEqual(r.stdout.split('\n')[0], 'free ' + FREE_M);
  assert.match(calls(s.dir), /^models opencode --verbose$/m);
});

test('catalog: failed read is fail-open and cached (no second exec in the TTL)', () => {
  const s = twoFree();
  const e = { ...s.env, ...ocEnv(s.dir, { FAKE_MODELS_DIR: path.join(s.dir, 'nope') }) };
  assert.strictEqual(run(['pick', 'go-gsd-executor'], { env: e }).stdout.split('\n')[0], 'free ' + MISSING);
  assert.strictEqual(run(['pick', 'go-gsd-executor'], { env: e }).stdout.split('\n')[0], 'free ' + MISSING);
  assert.strictEqual(calls(s.dir).trim().split('\n').length, 1);
});

test('catalog: opencode-lane agent model missing from its catalog -> claude, reason names it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-'));
  const cfg = path.join(dir, 'c.json');
  fs.writeFileSync(cfg, JSON.stringify({ opencode: { agent_models: { worker: 'opencode-go/gone-model', other: 'opencode-go/glm-5.3' } } }));
  const e = ocEnv(dir, { BALANCER_CONFIG: cfg });
  const r = run(['pick', 'go-worker'], { cl: 'claude-ok.json', env: e });
  assert.strictEqual(r.stdout.split('\n')[0], 'claude');
  assert.match(r.stderr, /opencode-go\/gone-model/);
  const ok = run(['pick', 'go-other'], { cl: 'claude-ok.json', env: { ...e, BALANCER_STATE: path.join(dir, 's2.json') } });
  assert.match(ok.stdout.split('\n')[0], /^(opencode|claude)$/);
  assert.ok(!/glm-5\.3/.test(ok.stderr));
});

test('catalog: default config never execs opencode on pick', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-'));
  const r = run(['pick', 'go-worker'], { env: ocEnv(dir) });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(calls(dir), '');
});

test('canary: PASS/FAIL lines, exit 1, state.canary stored with BALANCER_NOW', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-'));
  const state = path.join(dir, 'state.json');
  const r = run(['canary', 'opencode/a-free', 'opencode/b-free'], {
    env: ocEnv(dir, { BALANCER_STATE: state, FAKE_WRITE_HELLO: 'ok', FAKE_WRITE_HELLO_MODEL: 'opencode/a-free' }),
  });
  assert.strictEqual(r.status, 1, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.strictEqual(lines[0], 'canary opencode/a-free: PASS');
  assert.match(lines[1], /^canary opencode\/b-free: FAIL \(.+\)$/);
  const st = JSON.parse(fs.readFileSync(state, 'utf8'));
  assert.strictEqual(st.canary['opencode/a-free'].ok, true);
  assert.strictEqual(st.canary['opencode/a-free'].ts, NOW);
  assert.strictEqual(st.canary['opencode/b-free'].ok, false);
});

test('canary: no args runs all free_lane.models; invalid names exit 2; --timeout parsed', () => {
  const s = twoFree();
  const e = { ...s.env, ...ocEnv(s.dir, { FAKE_WRITE_HELLO: 'ok' }) };
  const r = run(['canary', '--timeout', '7'], { env: e });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`canary ${MISSING}: PASS`));
  assert.match(r.stdout, new RegExp(`canary ${FREE_M}: PASS`));
  assert.strictEqual(run(['canary', '-rf'], { env: e }).status, 2);
  assert.strictEqual(run(['canary', 'a b'], { env: e }).status, 2);
  assert.strictEqual(run(['canary', '--timeout', 'x', 'glm-5.3-flash-free'], { env: e }).status, 2);
});

test('models: lists missing configured models and unconfigured free models', () => {
  const s = twoFree({ opencode: { agent_models: { worker: 'opencode-go/gone-model' } } });
  const r = run(['models'], { env: { ...s.env, ...ocEnv(s.dir) } });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`${MISSING} \\(free_lane\\.models\\)`));
  assert.match(r.stdout, /opencode-go\/gone-model \(opencode\.agent_models\.worker\)/);
  assert.match(r.stdout, /opencode\/beam-free/);
  assert.match(r.stdout, /opencode\/deepseek-v4\.1-flash-free/);
  assert.ok(!/free, not configured:[^\n]*glm-5\.3-flash-free/.test(r.stdout));
  assert.ok(!/premium-pro/.test(r.stdout.split('free, not configured')[1] || ''), 'paid models are not listed as free');
});

test('models: exit 1 when a catalog is unavailable; --refresh bypasses the cache', () => {
  const s = twoFree();
  const bad = run(['models'], { env: { ...s.env, ...ocEnv(s.dir, { FAKE_MODELS_DIR: path.join(s.dir, 'nope') }) } });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stdout, /unavailable/);
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-'));
  const e = { ...s.env, ...ocEnv(d2), BALANCER_STATE: path.join(d2, 'st.json') };
  run(['models'], { env: e });
  run(['models'], { env: e });
  assert.strictEqual(calls(d2).trim().split('\n').length, 1, 'cached');
  run(['models', '--refresh'], { env: e });
  assert.strictEqual(calls(d2).trim().split('\n').length, 2);
});

test('status: free lane section from cached state only', () => {
  const s = twoFree();
  fs.writeFileSync(s.state, JSON.stringify({
    canary: { [FREE_M]: { ok: false, ts: NOW - 3 * 3600e3, detail: 'no hello.txt created' } },
    modelCooldowns: { [MISSING]: { until: NOW + 3600e3, hits: 1, reason: 'model_gone' } },
    catalog: { opencode: { ts: NOW - 180e3, ok: true, models: { [FREE_M]: {} } } },
  }));
  const r = run(['status'], { env: { ...s.env, ...ocEnv(s.dir) } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /free lane: enabled \(agents: gsd-executor\)/);
  assert.match(r.stdout, new RegExp(`${FREE_M}: canary FAIL`));
  assert.match(r.stdout, new RegExp(`${MISSING}: no canary.*cooldown until 2026-11-17T13:00:00\\.000Z.*missing from catalog`));
  assert.match(r.stdout, /catalog: opencode 3m old, 1 models/);
  assert.strictEqual(calls(s.dir), '', 'status never execs');
  const off = run(['status']);
  assert.match(off.stdout, /free lane: disabled/);
});
