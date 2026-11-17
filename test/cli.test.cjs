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
