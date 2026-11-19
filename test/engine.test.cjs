'use strict';
// Engine-level behaviour: locked state updates, in-flight accounting, learned cost per run,
// per-provider reserve, soft preferences, paygo cap, config validation, decision log.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const E = require('../lib/engine.cjs');
const R = require('../lib/reactive.cjs');
const F = require('../lib/free.cjs');
const { defaults, loadConfig, defaultConfigPath, ConfigError } = require('../lib/config.cjs');
const { providerScore, decide } = require('../lib/decide.cjs');
const { withLock } = require('../lib/state.cjs');

const NOW = Date.parse('2026-11-17T12:00:00Z');
const H = 3600e3;
const BIN = path.join(__dirname, '..', 'bin', 'balancer.cjs');
const iso = (ms) => new Date(ms).toISOString();

// A context on temp files. usage: {opencode: {rolling, weekly}, claude: {five_hour, seven_day}} in percent.
function mk({ cfg = {}, state = {}, opencode = { rolling: 10, weekly: 10 }, claude = { five_hour: 10, seven_day: 10 }, over = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-'));
  const f = (n) => path.join(dir, n);
  fs.writeFileSync(f('cfg.json'), JSON.stringify(cfg));
  fs.writeFileSync(f('state.json'), JSON.stringify(state));
  const setUsage = (oc, cl) => {
    fs.writeFileSync(f('usage.json'), JSON.stringify({ usage: {
      rolling: { percent: oc.rolling, resetsAt: iso(NOW + 3 * H) }, weekly: { percent: oc.weekly, resetsAt: iso(NOW + 84 * H) },
    } }));
    if (cl) {
      fs.writeFileSync(f('claude.json'), JSON.stringify({ ts: NOW, rate_limits: {
        five_hour: { used_percentage: cl.five_hour, resets_at: (NOW + 3 * H) / 1000 }, seven_day: { used_percentage: cl.seven_day, resets_at: (NOW + 84 * H) / 1000 },
      } }));
    }
  };
  setUsage(opencode, claude);
  let sleeps = 0;
  const env = { BALANCER_CONFIG: f('cfg.json'), BALANCER_STATE: f('state.json'), BALANCER_CLAUDE_STATE: f('claude.json'),
    BALANCER_OPENCODE_USAGE_FILE: f('usage.json'), BALANCER_NOW: String(NOW) };
  const ctx = E.makeCtx(env, { sleep: async () => { sleeps += 1; }, ...over });
  return { ctx, dir, env, f, setUsage, sleeps: () => sleeps, state: () => JSON.parse(fs.readFileSync(f('state.json'), 'utf8')) };
}
const win = (name, used, minsToReset, lenMin) => ({ name, used, resetsAt: NOW + minsToReset * 60000, lenMin });

// ---- bugs ----
test('waitReset with an agent agrees with pick: no immediate "ok" while that agent must wait', async () => {
  const t = mk({ claude: { five_hour: 95, seven_day: 10 }, state: { modelCooldowns: { x: { hits: 1, until: NOW + H, reason: 'model_gone' } } } });
  assert.strictEqual((await E.pick(t.ctx, 'go-x', { dryRun: true })).verdict, 'wait');
  const r = await E.waitReset(t.ctx, { maxSeconds: 0, agent: 'go-x' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.until, NOW + H);
  assert.strictEqual((await E.waitReset(t.ctx, { maxSeconds: 0, agent: 'go-other' })).ok, true);
});

test('a claude run with a 404 in its output does not cool the opencode lane', async () => {
  const t = mk();
  fs.writeFileSync(t.f('run.jsonl'), '{"type":"result","subtype":"success","result":"done"}\n');
  fs.writeFileSync(t.f('run.err'), 'HTTP 404 Not Found\nmodel foo does not exist\n');
  const out = E.recordRun(t.ctx, { provider: 'claude', agent: 'go-x', logFile: t.f('run.jsonl'), errFile: t.f('run.err') });
  assert.strictEqual(out, 'balancer: claude success');
  assert.strictEqual(t.state().modelCooldowns, undefined);
  assert.strictEqual((await E.pick(t.ctx, 'go-x', { dryRun: true })).scores.opencode.status, 'eligible');
  assert.strictEqual(E.recordRun(t.ctx, { provider: 'opencode', agent: 'go-x', logFile: t.f('run.jsonl'), errFile: t.f('run.err') }),
    `balancer: opencode model_gone x; cooldown until ${iso(NOW + H)}`);
});

test('model-gone patterns need model or HTTP context: a bare 404 or "retired" is not enough', () => {
  const cfg = defaults();
  for (const t of ['npm warn 404 Not Found - GET registry', 'line 404 of the file', 'retired the old helper']) {
    assert.strictEqual(R.detectLimitError(t, cfg, NOW), null, t);
  }
  for (const t of ['HTTP 404 Not Found', '"statusCode": 404', 'the model x has been retired']) {
    assert.strictEqual(R.detectLimitError(t, cfg, NOW).modelGone, true, t);
  }
});

test('recordOutcome: paygo touches nothing; a claude limit leaves the opencode breaker alone', () => {
  const cfg = defaults();
  const st = { providers: { opencode: { hits: 2, cooldownUntil: NOW + H } }, breakers: { k: { failures: 3, openUntil: NOW - 1, probing: true } } };
  const before = JSON.stringify(st);
  for (const outcome of ['success', 'failure', 'limit', 'model_gone']) R.recordOutcome(st, { provider: 'paygo', key: 'k', outcome }, cfg, NOW);
  assert.strictEqual(JSON.stringify(st), before);
  R.recordOutcome(st, { provider: 'claude', key: 'k', outcome: 'limit' }, cfg, NOW);
  assert.strictEqual(st.breakers.k.probing, true);
});

test('use-it-or-lose-it bonus only when the 5 h window is the binding one', () => {
  const cfg = defaults();
  const weeklyBound = (mins) => providerScore({ known: true, windows: [win('five_hour', 10, mins, 300), win('seven_day', 85, 5040, 10080)] }, cfg, NOW).headroom;
  assert.strictEqual(weeklyBound(10), weeklyBound(120));
  const fiveBound = (mins) => providerScore({ known: true, windows: [win('five_hour', 60, mins, 300), win('seven_day', 5, 5040, 10080)] }, cfg, NOW).headroom;
  assert.ok(fiveBound(10) > 40 + cfg.use_it_or_lose_it_bonus - 1e-9);
});

// ---- state ----
test('withLock: takes over a stale lock, releases afterwards', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-'));
  const f = path.join(dir, 's.json');
  fs.writeFileSync(f + '.lock', '');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(f + '.lock', old, old);
  assert.strictEqual(withLock(f, () => 7), 7);
  assert.ok(!fs.existsSync(f + '.lock'));
  assert.throws(() => withLock(f, () => { throw new Error('x'); }));
  assert.ok(!fs.existsSync(f + '.lock'));
});

test('concurrent processes do not lose state updates', async () => {
  const t = mk();
  const N = 12;
  const script = `const E=require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'engine.cjs'))});const c=E.makeCtx();
    for(let i=0;i<10;i++)E.mutate(c,(s)=>{s.n=(s.n||0)+1;const t=Date.now();while(Date.now()-t<2);});`;
  await Promise.all(Array.from({ length: N }, () => new Promise((res, rej) => {
    const p = spawn(process.execPath, ['-e', script], { env: { ...process.env, ...t.env }, stdio: 'inherit' });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error('exit ' + c))));
  })));
  assert.strictEqual(t.state().n, N * 10);
});

test('runCanaries keeps state written by other processes while a canary runs', () => {
  const t = mk();
  const exec = (bin, args, o) => {
    // another process records a cooldown while this canary is running
    const s = JSON.parse(fs.readFileSync(t.f('state.json'), 'utf8'));
    s.providers = { opencode: { hits: 1, cooldownUntil: NOW + H } };
    fs.writeFileSync(t.f('state.json'), JSON.stringify(s));
    fs.writeFileSync(path.join(o.cwd, 'hello.txt'), 'ok');
    return { status: 0, stdout: '', stderr: '', timedOut: false };
  };
  const ctx = E.makeCtx(t.env, { exec });
  E.runCanaries(ctx, ['opencode/a-free', 'opencode/b-free']);
  const st = t.state();
  assert.strictEqual(st.providers.opencode.cooldownUntil, NOW + H);
  assert.ok(st.canary['opencode/a-free'].ok && st.canary['opencode/b-free'].ok);
});

test('pick --dry-run decides without writing state or the log', async () => {
  const t = mk();
  const before = fs.readFileSync(t.f('state.json'), 'utf8');
  const d = await E.pick(t.ctx, 'go-x', { dryRun: true });
  assert.match(d.verdict, /^(opencode|claude)$/);
  assert.strictEqual(fs.readFileSync(t.f('state.json'), 'utf8'), before);
  assert.ok(!fs.existsSync(t.f('balancer-log.jsonl')));
  const r = spawnSync(process.execPath, [BIN, 'pick', 'go-x', '--dry-run'], { encoding: 'utf8', env: { ...process.env, ...t.env } });
  assert.strictEqual(r.stdout.trim(), d.verdict);
  assert.strictEqual(fs.readFileSync(t.f('state.json'), 'utf8'), before);
});

// ---- strategy ----
test('claude keeps a reserve for the orchestrating session: hard stop at 80, opencode at 90', async () => {
  const cfg = defaults();
  const at = (name, used) => providerScore({ known: true, windows: [win(name === 'claude' ? 'five_hour' : 'rolling', used, 120, 300)] }, cfg, NOW, { name }).status;
  assert.strictEqual(at('claude', 79), 'eligible');
  assert.strictEqual(at('claude', 80), 'ineligible');
  assert.strictEqual(at('opencode', 89), 'eligible');
  assert.strictEqual(at('opencode', 90), 'ineligible');
  const t = mk({ claude: { five_hour: 85, seven_day: 10 }, opencode: { rolling: 85, weekly: 10 } });
  assert.strictEqual((await E.pick(t.ctx, 'go-x', { dryRun: true })).verdict, 'opencode');
  const none = mk({ cfg: { reserve_percent: { claude: 0 } }, claude: { five_hour: 85, seven_day: 10 }, opencode: { rolling: 95, weekly: 10 } });
  assert.strictEqual((await E.pick(none.ctx, 'go-x', { dryRun: true })).verdict, 'claude');
});

test('in-flight runs count against a provider until they are recorded', async () => {
  const cfg = defaults();
  const p = { known: true, windows: [win('rolling', 10, 150, 300)] };
  const base = providerScore(p, cfg, NOW).headroom;
  assert.strictEqual(providerScore(p, cfg, NOW, { inflight: 3 }).headroom, base - 3 * cfg.inflight.cost_points);
  // near-equal providers: a burst spreads instead of piling onto the first pick
  const t = mk({ cfg: { hysteresis_points: 0, reserve_percent: { claude: 0 } } });
  const seen = [];
  for (let i = 0; i < 4; i++) seen.push((await E.pick(t.ctx, 'go-x')).verdict);
  assert.deepStrictEqual(seen.filter((v) => v === 'opencode').length, 2, seen.join(','));
  assert.strictEqual(t.state().inflight.opencode.length + t.state().inflight.claude.length, 4);
  fs.writeFileSync(t.f('ok.jsonl'), '{"type":"text","part":{"messageID":"m","text":"done"}}\n');
  E.recordRun(t.ctx, { provider: 'opencode', agent: 'go-x', logFile: t.f('ok.jsonl') });
  assert.strictEqual(t.state().inflight.opencode.length, 1);
  // entries older than the ttl are ignored
  assert.strictEqual(R.countInflight({ inflight: { opencode: [{ ts: NOW - 31 * 60000 }, { ts: NOW - 60000 }] } }, 'opencode', cfg, NOW), 1);
});

test('the cost of a run is learned from the usage it added, then routing compares runs left', async () => {
  const t = mk({ cfg: { strategy: { min_samples: 2 }, reserve_percent: { claude: 0 }, lanes: { preferences: { oc: ['opencode'], cl: ['claude'] } } } });
  fs.writeFileSync(t.f('ok.jsonl'), '{"type":"text","part":{"messageID":"m","text":"done"}}\n');
  const usage = async () => E.gather(t.ctx, E.loadState(t.ctx));
  // opencode: 1 point per run of the 5 h window; claude: 8 points per run
  let oc = 10; let cl = 10;
  for (let i = 0; i < 2; i++) {
    t.setUsage({ rolling: oc, weekly: 10 }, { five_hour: cl, seven_day: 10 });
    await E.pick(t.ctx, 'go-oc');
    await E.pick(t.ctx, 'go-cl');
    oc += 1; cl += 8;
    t.setUsage({ rolling: oc, weekly: 10 }, { five_hour: cl, seven_day: 10 });
    E.recordRun(t.ctx, { provider: 'opencode', agent: 'go-oc', logFile: t.f('ok.jsonl'), usage: await usage() });
    E.recordRun(t.ctx, { provider: 'claude', agent: 'go-cl', logFile: t.f('ok.jsonl'), usage: await usage() });
  }
  const burn = t.state().burn;
  assert.strictEqual(burn.opencode.n, 2);
  assert.ok(Math.abs(R.perRun(burn.opencode, 'rolling', t.ctx.cfg) - 1) < 1e-9);
  assert.ok(Math.abs(R.perRun(burn.claude, 'five_hour', t.ctx.cfg) - 8) < 1e-9);
  assert.strictEqual(R.perRun(burn.opencode, 'rolling', defaults()), null, 'not used below min_samples');
  // claude has more percent headroom but far fewer runs left: opencode wins
  t.setUsage({ rolling: 40, weekly: 10 }, { five_hour: 20, seven_day: 10 });
  const d = await E.pick(t.ctx, 'go-worker', { dryRun: true });
  assert.ok(d.scores.claude.headroom > d.scores.opencode.headroom);
  assert.ok(d.scores.opencode.runs > d.scores.claude.runs);
  assert.strictEqual(d.verdict, 'opencode');
  assert.match(d.reason, /^runs left opencode/);
  const off = mk({ cfg: { strategy: { runs_remaining: false, min_samples: 2 }, reserve_percent: { claude: 0 } }, state: { burn }, opencode: { rolling: 40, weekly: 10 }, claude: { five_hour: 20, seven_day: 10 } });
  assert.strictEqual((await E.pick(off.ctx, 'go-worker', { dryRun: true })).verdict, 'claude');
});

test('lanes.preferences is a soft pin: first provider that is not limited, lastPick untouched', async () => {
  const cfg = { lanes: { preferences: { architect: ['claude', 'opencode'] } } };
  const a = mk({ cfg, claude: { five_hour: 60, seven_day: 10 }, state: { lastPick: 'opencode' } });
  const d = await E.pick(a.ctx, 'go-architect');
  assert.strictEqual(d.verdict, 'claude');
  assert.strictEqual(a.state().lastPick, 'opencode');
  const b = mk({ cfg, claude: { five_hour: 95, seven_day: 10 } });
  assert.strictEqual((await E.pick(b.ctx, 'go-architect', { dryRun: true })).verdict, 'opencode');
  const c = mk({ cfg, claude: { five_hour: 95, seven_day: 10 }, opencode: { rolling: 95, weekly: 10 } });
  assert.strictEqual((await E.pick(c.ctx, 'go-architect', { dryRun: true })).verdict, 'wait');
});

test('excludeProvider never returns that provider for a balanced agent', async () => {
  const t = mk();
  assert.strictEqual((await E.pick(t.ctx, 'go-x', { dryRun: true, excludeProvider: 'opencode' })).verdict, 'claude');
  assert.strictEqual((await E.pick(t.ctx, 'go-x', { dryRun: true, excludeProvider: 'claude' })).verdict, 'opencode');
});

test('paygo is capped per rolling day', async () => {
  const t = mk({ cfg: { paygo: { enabled: true, model: 'opencode/x', max_runs_per_day: 2 } }, claude: { five_hour: 95, seven_day: 10 }, opencode: { rolling: 95, weekly: 10 } });
  assert.strictEqual((await E.pick(t.ctx, 'go-x')).verdict, 'paygo');
  assert.strictEqual((await E.pick(t.ctx, 'go-x', { dryRun: true })).verdict, 'paygo');
  assert.strictEqual((await E.pick(t.ctx, 'go-x')).verdict, 'paygo');
  const d = await E.pick(t.ctx, 'go-x');
  assert.strictEqual(d.verdict, 'wait');
  assert.match(d.reason, /paygo cap of 2 runs per day reached/);
  assert.strictEqual(R.paygoAllowed({ paygo: { runs: [NOW - 25 * H, NOW - 26 * H] } }, t.ctx.cfg, NOW), true);
  assert.strictEqual(R.paygoAllowed({ paygo: { runs: [NOW, NOW, NOW] } }, { paygo: { max_runs_per_day: null } }, NOW), true);
});

// ---- free lane ----
test('free lane: deprecated or tool-less catalog entries are skipped; rotate uses the least recent', () => {
  const cfg = defaults();
  const [A, B] = ['opencode/a-free', 'opencode/b-free'];
  cfg.free_lane = { ...cfg.free_lane, enabled: true, agents: ['w'], models: [A, B] };
  const ok = { ok: true, ts: NOW - H, detail: '' };
  const pick = (catalogs, state = {}) => F.pickFreeModel({ logical: 'w', cfg, state: { canary: { [A]: ok, [B]: ok }, ...state }, catalogs, now: NOW }).model;
  const e = (o = {}) => ({ free: true, status: 'active', toolcall: true, ...o });
  assert.strictEqual(pick({ opencode: { [A]: e(), [B]: e() } }), A);
  assert.strictEqual(pick({ opencode: { [A]: e({ status: 'deprecated' }), [B]: e() } }), B);
  assert.strictEqual(pick({ opencode: { [A]: e({ toolcall: false }), [B]: e() } }), B);
  cfg.free_lane.require_toolcall = false;
  assert.strictEqual(pick({ opencode: { [A]: e({ toolcall: false }), [B]: e() } }), A);
  assert.strictEqual(pick({}, { freeLast: { [A]: NOW - 10 } }), A, 'config order without rotate');
  cfg.free_lane.rotate = true;
  assert.strictEqual(pick({}, { freeLast: { [A]: NOW - 10 } }), B);
  assert.strictEqual(pick({}, { freeLast: { [A]: NOW - 10, [B]: NOW - 5 } }), A);
});

// ---- config ----
test('config: missing file is defaults; malformed or invalid files throw', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const w = (n, text) => { const f = path.join(dir, n); fs.writeFileSync(f, text); return f; };
  assert.deepStrictEqual(loadConfig(path.join(dir, 'none.json')), defaults());
  assert.throws(() => loadConfig(w('a.json', '{ nope')), ConfigError);
  assert.throws(() => loadConfig(w('b.json', '[]')), /top level must be an object/);
  assert.throws(() => loadConfig(w('c.json', '{"lanes":{"pinned_to_claude":"planner"}}')), /lanes\.pinned_to_claude must be an array of strings/);
  assert.throws(() => loadConfig(w('d.json', '{"lanes":{"default_lane":"free"}}')), /default_lane/);
  assert.throws(() => loadConfig(w('e.json', '{"reactive":{"limit_patterns":["("]}}')), /limit_patterns/);
  assert.throws(() => loadConfig(w('f.json', '{"lanes":{"escalate_on":["always"]}}')), /escalate_on/);
  assert.throws(() => loadConfig(w('g.json', '{"lanes":{"preferences":{"x":["gpt"]}}}')), /preferences/);
  assert.strictEqual(loadConfig(w('h.json', '{"_comment":"x","lanes":{"pinned_to_claude":["p"]}}')).lanes.pinned_to_claude[0], 'p');
  const r = spawnSync(process.execPath, [BIN, 'pick', 'go-x'], { encoding: 'utf8', env: { ...process.env, BALANCER_CONFIG: path.join(dir, 'a.json'), BALANCER_STATE: path.join(dir, 's.json') } });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /invalid JSON/);
});

test('the shipped config file and the example config match the built-in defaults / validate', () => {
  assert.deepStrictEqual(loadConfig(defaultConfigPath()), defaults());
  assert.ok(loadConfig(path.join(__dirname, '..', 'examples', 'godotrpg', 'routing.balancer.json')).lanes.pinned_to_claude.length > 0);
});

// ---- decision log ----
test('picks and outcomes are logged; stats summarises them', async () => {
  const t = mk({ cfg: { lanes: { preferences: { a: ['opencode'], b: ['claude'] } } } });
  fs.writeFileSync(t.f('ok.jsonl'), '{"type":"text","part":{"messageID":"m","text":"done"}}\n');
  fs.writeFileSync(t.f('bad.jsonl'), '{"type":"error","error":{"name":"Boom"}}\n');
  await E.pick(t.ctx, 'go-a');
  await E.pick(t.ctx, 'go-a');
  await E.pick(t.ctx, 'go-b');
  E.recordRun(t.ctx, { provider: 'opencode', agent: 'go-a', logFile: t.f('ok.jsonl') });
  E.recordRun(t.ctx, { provider: 'opencode', agent: 'go-a', logFile: t.f('bad.jsonl') });
  E.recordRun(t.ctx, { provider: 'claude', agent: 'go-b', logFile: t.f('ok.jsonl') });
  const lines = fs.readFileSync(t.f('balancer-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(lines.length, 6);
  assert.deepStrictEqual(Object.keys(lines[0]).sort(), ['agent', 'event', 'reason', 'scores', 'ts', 'verdict']);
  assert.strictEqual(fs.statSync(t.f('balancer-log.jsonl')).mode & 0o777, 0o600);
  const r = spawnSync(process.execPath, [BIN, 'stats'], { encoding: 'utf8', env: { ...process.env, ...t.env } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, / {2}opencode: 2 picks, 1 success, 1 failure, 0 limit, 0 model_gone \(50% success\)/);
  assert.match(r.stdout, / {2}a @ opencode: 2 picks/);
  assert.match(r.stdout, / {2}b @ claude: 1 picks, 1 success/);
  const off = mk({ cfg: { log: { enabled: false } } });
  await E.pick(off.ctx, 'go-a');
  assert.ok(!fs.existsSync(off.f('balancer-log.jsonl')));
});

// ---- run-log data ----
const { parseRunLog } = require('../lib/runlog.cjs');
const CLAUDE_LOG = [
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.22,"resetsAt":1795090800},"seven_day":{"utilization":0.155,"resetsAt":1795100400}}}}',
  '{"type":"result","subtype":"success","is_error":false,"result":"done ok","duration_ms":60000,"total_cost_usd":0.11,"usage":{"input_tokens":6,"cache_creation_input_tokens":24000,"cache_read_input_tokens":70000,"output_tokens":594}}',
].join('\n') + '\n';
const OC_LOG = [
  '{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":18754,"input":18533,"output":77,"reasoning":144,"cache":{"write":0,"read":900}},"cost":0}}',
  '{"type":"step_finish","part":{"type":"step-finish","tokens":{"input":1000,"output":246,"reasoning":0},"cost":0.002}}',
  '{"type":"text","part":{"messageID":"m","text":"done ok"}}',
].join('\n') + '\n';

test('parseRunLog: tokens, cost, duration and claude rate-limit windows', () => {
  const c = parseRunLog(CLAUDE_LOG);
  assert.strictEqual(c.tokens, 24600, 'cache reads are not counted');
  assert.strictEqual(c.costUsd, 0.11);
  assert.strictEqual(c.durationMs, 60000);
  assert.deepStrictEqual(c.limits, { five_hour: { used_percentage: 22, resets_at: 1795090800 }, seven_day: { used_percentage: 15.5, resets_at: 1795100400 } });
  const o = parseRunLog(OC_LOG);
  assert.strictEqual(o.tokens, 18754 + 1246);
  assert.strictEqual(o.limits, null);
  assert.deepStrictEqual(parseRunLog('garbage\n{"type":"text"}\n'), { tokens: 0, costUsd: 0, durationMs: null, limits: null });
});

test('harvestClaudeUsage refreshes stale Claude usage from a run log, never newer statusline data', () => {
  const t = mk();
  fs.writeFileSync(t.f('c.jsonl'), CLAUDE_LOG);
  assert.strictEqual(E.harvestClaudeUsage(t.ctx, t.f('c.jsonl')), false, 'statusline data from NOW is newer than the run start');
  fs.writeFileSync(t.f('claude.json'), JSON.stringify({ ts: NOW - 2 * H, rate_limits: {} }));
  assert.strictEqual(E.harvestClaudeUsage(t.ctx, t.f('c.jsonl')), true);
  const s = JSON.parse(fs.readFileSync(t.f('claude.json'), 'utf8'));
  assert.strictEqual(s.ts, NOW - 60000, 'stamped with the start of the run');
  assert.strictEqual(s.rate_limits.five_hour.used_percentage, 22);
  fs.writeFileSync(t.f('o.jsonl'), OC_LOG);
  assert.strictEqual(E.harvestClaudeUsage(t.ctx, t.f('o.jsonl')), false);
});

test('in-flight entries with a pid live as long as the process, not the ttl', () => {
  const cfg = defaults();
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const st = { inflight: { opencode: [
    { ts: NOW - 5 * H, agent: 'a', pid: process.pid }, // long run, still alive
    { ts: NOW - 60000, agent: 'b', pid: dead },        // process gone
    { ts: NOW - 60000, agent: 'c' },                   // not launched yet, inside the ttl
    { ts: NOW - 2 * H, agent: 'd' },                   // never launched, expired
  ] } };
  assert.strictEqual(R.countInflight(st, 'opencode', cfg, NOW), 2);
  assert.strictEqual(R.attachInflightPid(st, 'opencode', 'c', process.pid), true);
  assert.strictEqual(st.inflight.opencode[2].pid, process.pid);
  assert.strictEqual(R.attachInflightPid(st, 'opencode', 'zzz', 1), false);
});

test('cost per run: unmoved windows are not trusted; tokens scale the estimate per agent', async () => {
  const cfg = { ...defaults(), strategy: { ...defaults().strategy, min_samples: 2 } };
  const st = {};
  // 10 small runs of 20k tokens that moved the 5 h window by 2 points in total, the weekly by nothing
  for (let i = 0; i < 10; i++) R.recordBurn(st, 'opencode', { rolling: i % 5 === 0 ? 1 : 0, weekly: 0 }, { strategy: { burn_decay: 1 } }, 20000);
  const b = st.burn.opencode;
  assert.strictEqual(R.perRun(b, 'weekly', cfg), 0, 'measured, but it never moved');
  assert.ok(Math.abs(R.perRun(b, 'rolling', cfg) - 0.2) < 1e-9);
  assert.ok(Math.abs(R.perRun(b, 'rolling', cfg, 200000) - 2) < 1e-9, 'an agent that uses 10x the tokens costs 10x');
  assert.strictEqual(R.perRun(b, 'monthly', cfg), null);
  const p = { known: true, windows: [win('rolling', 10, 150, 300), win('weekly', 10, 5040, 10080)] };
  const small = providerScore(p, cfg, NOW, { name: 'opencode', burn: b }).runs;
  const big = providerScore(p, cfg, NOW, { name: 'opencode', burn: b, agentTokens: 200000 }).runs;
  assert.ok(Math.abs(small - 400) < 1e-6 && Math.abs(big - 40) < 1e-6, `${small} ${big}`);
  const flat = { n: 10, windows: { rolling: { delta: 0, runs: 10, tokens: 1 }, weekly: { delta: 0, runs: 10, tokens: 1 } } };
  assert.strictEqual(providerScore(p, cfg, NOW, { name: 'opencode', burn: flat }).runs, null, 'nothing moved: stay on percent');
  const flatDecay = { strategy: { burn_decay: 1 } };
  R.recordTokens(st, 'opencode', 'big', 200000, flatDecay);
  R.recordTokens(st, 'opencode', 'small', 20000, flatDecay);
  assert.strictEqual(R.avgTokens(st, 'opencode', 'big'), 200000);
  assert.strictEqual(R.avgTokens(st, 'opencode', 'unseen'), 110000, 'unknown agents use the provider average');
  assert.strictEqual(R.avgTokens(st, 'claude', 'big'), 0);
});

test('recordRun stores tokens per agent and logs them', () => {
  const t = mk();
  fs.writeFileSync(t.f('o.jsonl'), OC_LOG);
  E.recordRun(t.ctx, { provider: 'opencode', agent: 'go-w', logFile: t.f('o.jsonl') });
  assert.strictEqual(R.avgTokens(t.state(), 'opencode', 'w'), 20000);
  const ev = fs.readFileSync(t.f('balancer-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
  assert.strictEqual(ev.tokens, 20000);
  assert.strictEqual(ev.cost_usd, 0.002);
});

test('free_lane.discover adds free, active, tool-capable catalog models after the configured ones', () => {
  const cfg = defaults();
  cfg.free_lane = { ...cfg.free_lane, models: ['opencode/b-free'] };
  const cats = { opencode: {
    'opencode/a-free': { free: true, status: 'active', toolcall: true },
    'opencode/b-free': { free: true, status: 'active', toolcall: true },
    'opencode/paid': { free: false, status: 'active', toolcall: true },
    'opencode/old-free': { free: true, status: 'deprecated', toolcall: true },
    'opencode/chat-free': { free: true, status: 'active', toolcall: false },
  }, openrouter: { 'openrouter/x:free': { free: true, status: 'active', toolcall: true } } };
  assert.deepStrictEqual(F.freeCandidates(cfg, cats), ['opencode/b-free']);
  cfg.free_lane.discover = true;
  assert.deepStrictEqual(F.freeCandidates(cfg, cats), ['opencode/b-free', 'opencode/a-free']);
  assert.deepStrictEqual(F.freeCandidates(cfg, { opencode: null }), ['opencode/b-free'], 'no catalog, nothing discovered');
});
