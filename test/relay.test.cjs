'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { extractReport } = require('../lib/report.cjs');

const RELAY = path.join(__dirname, '..', 'bin', 'balancer-relay');
const FX = path.join(__dirname, 'fixtures');
const NOW = Date.parse('2026-11-17T12:00:00Z');
const AGENT = 'go-gsd-executor';

// ---- extractReport ----
test('extractReport: opencode format', () => {
  const r = extractReport([
    '{"type":"text","part":{"messageID":"a","text":"first"}}',
    '{"type":"text","part":{"messageID":"b","text":"sec"}}',
    '{"type":"text","part":{"messageID":"b","text":"ond"}}',
    '{"type":"error","error":{"name":"Boom"}}',
    '{"type":"tool_use","part":{"state":{"input":{"command":"ls   -la"}}}}',
    'garbage line',
  ]);
  assert.strictEqual(r.report, 'second');
  assert.strictEqual(r.errors.length, 1);
  assert.deepStrictEqual(r.commands, ['ls -la']);
});

test('extractReport: claude stream-json result, fallback, errors', () => {
  const a = extractReport([
    '{"type":"assistant","message":{"content":[{"type":"text","text":"working"},{"type":"tool_use","input":{"command":"git status"}}]}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"final answer"}',
  ]);
  assert.strictEqual(a.report, 'final answer');
  assert.deepStrictEqual(a.commands, ['git status']);
  const b = extractReport(['{"type":"assistant","message":{"content":[{"type":"text","text":"only assistant"}]}}']);
  assert.strictEqual(b.report, 'only assistant');
  const c = extractReport(['{"type":"result","subtype":"error_max_turns","is_error":true,"result":"too long"}']);
  assert.strictEqual(c.report, null);
  assert.strictEqual(c.errors.length, 1);
  assert.deepStrictEqual(extractReport([]), { report: null, errors: [], commands: [] });
});

// ---- relay harness ----
function mkRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-')));
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  g('commit', '-q', '--allow-empty', '-m', 'init');
  const prompt = path.join(dir, 'task.md');
  fs.writeFileSync(prompt, 'do the thing\n');
  return { dir, prompt };
}

function env(dir, extra = {}) {
  return {
    ...process.env,
    BALANCER_CONFIG: path.join(dir, 'none.json'),
    BALANCER_STATE: path.join(dir, 'balancer-state.json'),
    BALANCER_CLAUDE_STATE: path.join(dir, 'no-claude-state.json'),
    BALANCER_OPENCODE_USAGE_FILE: path.join(FX, 'opencode-ok.json'),
    BALANCER_OPENCODE_AUTH: path.join(FX, 'auth-fake.json'),
    BALANCER_OPENCODE_BIN: path.join(FX, 'bin', 'fake-opencode'),
    BALANCER_CLAUDE_BIN: path.join(FX, 'bin', 'fake-claude'),
    BALANCER_NOW: String(NOW),
    BALANCER_RELAY_WAIT_SECONDS: '20',
    FAKE_ARGV_FILE: path.join(dir, 'argv.json'),
    ...extra,
  };
}

const relay = (args, dir, e) => spawnSync(process.execPath, [RELAY, ...args], { cwd: dir, encoding: 'utf8', env: e });
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const lastLine = (s) => s.trimEnd().split('\n').pop();

test('start/wait with opencode', () => {
  const { dir, prompt } = mkRepo();
  const e = env(dir);
  const s = relay(['start', AGENT, prompt], dir, e);
  assert.strictEqual(s.status, 0, s.stdout + s.stderr);
  assert.match(s.stdout, new RegExp(`^started pid \\d+ agent=${AGENT} provider=opencode\\n`));
  assert.strictEqual(fs.readFileSync(prompt + '.provider', 'utf8').trim(), 'opencode');
  assert.match(fs.readFileSync(prompt + '.pid', 'utf8'), /^\d+\s*$/);
  assert.ok(fs.existsSync(prompt + '.base'));
  const w = relay(['wait', prompt], dir, e);
  assert.strictEqual(w.status, 0, w.stdout + w.stderr);
  assert.match(w.stdout, /^DONE\n/);
  assert.match(w.stdout, /----- FINAL REPORT -----\nFAKE OPENCODE REPORT/);
  assert.match(w.stdout, /----- ORCHESTRATOR CHECK \(repo state, measured by the relay\) -----/);
  assert.match(w.stdout, /commits since launch \(.*\.\.HEAD\):\n {2}\(none\)/);
  assert.strictEqual(lastLine(w.stdout), `relay: opencode (log: ${prompt}.jsonl)`);
  const a = readJson(path.join(dir, 'argv.json'));
  assert.deepStrictEqual(a.argv.slice(0, 1), ['run']);
  assert.ok(a.argv.includes('--agent') && a.argv[a.argv.indexOf('--agent') + 1] === AGENT);
  assert.ok(a.argv.includes('json') && a.argv.includes('-f') && a.argv.includes(prompt));
  assert.strictEqual(a.tmpdir, path.join(dir, 'build', 'tmp'));
  assert.match(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\.opencode-relay\/$/m);
});

test('wait reports RUNNING while the provider is still alive, then DONE', () => {
  const { dir, prompt } = mkRepo();
  const e = env(dir, { FAKE_SLEEP_MS: '2500' });
  relay(['start', AGENT, prompt], dir, e);
  const r1 = relay(['wait', prompt], dir, { ...e, BALANCER_RELAY_WAIT_SECONDS: '1' });
  assert.strictEqual(r1.stdout.trim(), 'RUNNING');
  const r2 = relay(['wait', prompt], dir, e);
  assert.match(r2.stdout, /^DONE\n/);
});

test('start/wait with claude: acceptEdits + allow-list, never --agent', () => {
  const { dir, prompt } = mkRepo();
  const e = env(dir, { BALANCER_CLAUDE_STATE: path.join(FX, 'claude-high.json') });
  const s = relay(['start', AGENT, prompt], dir, e);
  assert.match(s.stdout, /provider=claude/);
  const w = relay(['wait', prompt], dir, e);
  assert.match(w.stdout, /----- FINAL REPORT -----\nFAKE CLAUDE REPORT/);
  assert.match(lastLine(w.stdout), /^relay: claude/);
  const argv = readJson(path.join(dir, 'argv.json')).argv;
  assert.strictEqual(argv[0], '-p');
  assert.ok(argv.some((a) => a.includes(prompt)), 'message names the prompt path');
  assert.ok(!argv.includes('--agent'));
  assert.strictEqual(argv[argv.indexOf('--permission-mode') + 1], 'acceptEdits');
  const i = argv.indexOf('--allowedTools');
  const allowed = [];
  for (let k = i + 1; k < argv.length && !argv[k].startsWith('--'); k++) allowed.push(argv[k]);
  assert.ok(allowed.includes('Read') && allowed.includes('Edit') && allowed.includes('Write'));
  assert.ok(allowed.includes('Bash(git commit:*)') && allowed.includes('Bash(node --test:*)'));
  assert.ok(!allowed.includes('Bash(node:*)'), 'node:* would allow node -e arbitrary code');
  assert.ok(!allowed.includes('Bash(git:*)'), 'git:* would allow git push');
  const j = argv.indexOf('--disallowedTools');
  assert.ok(j >= 0 && argv[j + 1] === 'Bash(git push:*)', 'git push is explicitly denied');
  assert.ok(argv.includes('stream-json') && argv.includes('--verbose'));
  assert.ok(!argv.includes('bypassPermissions'));
});

test('claude.agent_prompt_dir supplies --append-system-prompt without frontmatter', () => {
  const { dir, prompt } = mkRepo();
  const agents = path.join(dir, 'agents');
  fs.mkdirSync(agents);
  fs.writeFileSync(path.join(agents, 'gsd-executor.md'), '---\nname: x\n---\nBODY TEXT\n');
  const cfg = path.join(dir, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ claude: { agent_prompt_dir: agents }, lanes: { pinned_to_claude: ['gsd-executor'] } }));
  const e = env(dir, { BALANCER_CONFIG: cfg });
  relay(['start', AGENT, prompt], dir, e);
  relay(['wait', prompt], dir, e);
  const argv = readJson(path.join(dir, 'argv.json')).argv;
  const v = argv[argv.indexOf('--append-system-prompt') + 1];
  assert.match(v, /BODY TEXT/);
  assert.ok(!/name: x/.test(v));
  assert.ok(!argv.includes('--agent'));
});

test('pinned agent goes to claude even when claude usage is unknown', () => {
  const { dir, prompt } = mkRepo();
  const cfg = path.join(dir, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ lanes: { pinned_to_claude: ['gsd-executor'] } }));
  const s = relay(['start', AGENT, prompt], dir, env(dir, { BALANCER_CONFIG: cfg }));
  assert.match(s.stdout, /provider=claude/);
});

test('balancer failure falls back to plain opencode', () => {
  const { dir, prompt } = mkRepo();
  const badState = path.join(dir, 'state-is-a-dir');
  fs.mkdirSync(badState);
  const e = env(dir, { BALANCER_STATE: badState, BALANCER_CLAUDE_STATE: path.join(FX, 'claude-high.json') });
  const s = relay(['start', AGENT, prompt], dir, e);
  assert.strictEqual(s.status, 0, s.stderr);
  assert.match(s.stdout, /provider=opencode/);
  const w = relay(['wait', prompt], dir, e);
  assert.match(w.stdout, /^DONE\n/);
  assert.match(lastLine(w.stdout), /^relay: opencode/);
});

test('balancer failure keeps a pinned agent on claude', () => {
  const { dir, prompt } = mkRepo();
  const badState = path.join(dir, 'state-is-a-dir');
  fs.mkdirSync(badState);
  const cfg = path.join(dir, 'pin.json');
  fs.writeFileSync(cfg, JSON.stringify({ lanes: { pinned_to_claude: ['gsd-executor'] } }));
  const s = relay(['start', AGENT, prompt], dir, env(dir, { BALANCER_STATE: badState, BALANCER_CONFIG: cfg }));
  assert.strictEqual(s.status, 0, s.stderr);
  assert.match(s.stdout, /provider=claude/);
  assert.match(s.stderr, /balancer failed .*using claude/);
});

test('both limited: deferred start, RUNNING while waiting', () => {
  const { dir, prompt } = mkRepo();
  const e = env(dir, {
    BALANCER_OPENCODE_USAGE_FILE: path.join(FX, 'opencode-exhausted.json'),
    BALANCER_CLAUDE_STATE: path.join(FX, 'claude-exhausted.json'),
  });
  const s = relay(['start', AGENT, prompt], dir, e);
  assert.strictEqual(s.status, 0, s.stderr);
  const until = new Date(NOW + 2 * 3600e3).toISOString();
  assert.match(s.stdout, new RegExp(`relay: both subscriptions limited, deferred until ${until}`));
  const w = relay(['wait', prompt], dir, { ...e, BALANCER_RELAY_WAIT_SECONDS: '1' });
  assert.strictEqual(w.stdout.trim(), 'RUNNING');
  process.kill(Number(fs.readFileSync(prompt + '.pid', 'utf8')), 'SIGTERM');
});

test('deferred worker resumes after the cooldown and runs the provider', () => {
  const { dir, prompt } = mkRepo();
  const real = Date.now();
  const stateFile = path.join(dir, 'balancer-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    providers: { opencode: { hits: 1, cooldownUntil: real + 1500 }, claude: { hits: 1, cooldownUntil: real + 1500 } },
  }));
  const e = env(dir, { BALANCER_OPENCODE_USAGE_FILE: path.join(dir, 'missing.json') });
  delete e.BALANCER_NOW;
  const s = relay(['start', AGENT, prompt], dir, e);
  assert.match(s.stdout, /deferred until/);
  const w = relay(['wait', prompt], dir, e);
  assert.match(w.stdout, /^DONE\n/);
  assert.match(w.stdout, /FAKE OPENCODE REPORT/);
  assert.match(lastLine(w.stdout), /^relay: opencode/);
});

test('missing report -> no-report with salvage block', () => {
  const { dir, prompt } = mkRepo();
  const e = env(dir, { FAKE_LOG_FILE: path.join(FX, 'logs', 'empty.jsonl') });
  relay(['start', AGENT, prompt], dir, e);
  const w = relay(['wait', prompt], dir, e);
  assert.match(w.stdout, /relay-failure: no-report/);
  assert.match(w.stdout, /----- LAST TOOL COMMANDS \(salvage\) -----\n {2}\(none recorded\)/);
});

test('usage errors', () => {
  const { dir, prompt } = mkRepo();
  const e = env(dir);
  const empty = path.join(dir, 'empty.md');
  fs.writeFileSync(empty, '');
  const a = relay(['start', AGENT, empty], dir, e);
  assert.strictEqual(a.status, 2);
  assert.match(a.stdout, /relay-failure: prompt file missing or empty/);
  const b = relay([], dir, e);
  assert.strictEqual(b.status, 2);
  assert.match(b.stdout, /usage: balancer-relay start <agent> <prompt-file> \| wait <prompt-file>/);
  const c = relay(['wait', path.join(dir, 'nope.md')], dir, e);
  assert.strictEqual(c.status, 2);
  assert.match(c.stdout, /relay-failure: no pid file/);
  const d = relay(['start', AGENT, prompt], dir, { ...e, BALANCER_OPENCODE_BIN: '/nonexistent/opencode' });
  assert.strictEqual(d.status, 2);
  assert.match(d.stdout, /relay-failure: .* not on PATH/);
});

function cfgFile(dir, obj) {
  const f = path.join(dir, 'cfg.json');
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}

test('wait records a limit error: opencode goes into cooldown (escalation off)', () => {
  const { dir, prompt } = mkRepo();
  const e = env(dir, { FAKE_LOG_FILE: path.join(FX, 'logs', 'opencode-limit.jsonl'), BALANCER_CONFIG: cfgFile(dir, { lanes: { escalate_on: [] } }) });
  relay(['start', AGENT, prompt], dir, e);
  const w = relay(['wait', prompt], dir, e);
  assert.match(w.stdout, /balancer: opencode limit; cooldown until/);
  const st = readJson(path.join(dir, 'balancer-state.json'));
  assert.strictEqual(st.providers.opencode.cooldownUntil, NOW + 120 * 1000);
  assert.match(lastLine(w.stdout), /^relay: opencode/);
});

test('wait called again after DONE replays the outcome instead of recording it twice', () => {
  const { dir, prompt } = mkRepo();
  const e = env(dir, { FAKE_LOG_FILE: path.join(FX, 'logs', 'opencode-limit.jsonl'), BALANCER_CONFIG: cfgFile(dir, { lanes: { escalate_on: [] } }) });
  relay(['start', AGENT, prompt], dir, e);
  const w1 = relay(['wait', prompt], dir, e);
  const w2 = relay(['wait', prompt], dir, e);
  const w3 = relay(['wait', prompt], dir, e);
  const line = (w) => w.stdout.split('\n').find((l) => l.startsWith('balancer: '));
  assert.strictEqual(line(w2), line(w1));
  assert.strictEqual(line(w3), line(w1));
  const st = readJson(path.join(dir, 'balancer-state.json'));
  assert.strictEqual(st.providers.opencode.hits, 1);
  assert.strictEqual(st.providers.opencode.cooldownUntil, NOW + 120 * 1000);
});

test('opencode run that dies on a limit is re-run once on claude', () => {
  const { dir, prompt } = mkRepo();
  const lim = path.join(FX, 'logs', 'opencode-limit.jsonl');
  // Only fake-opencode reads FAKE_OPENCODE_LOG_FILE, so the claude re-run produces a normal report.
  const e = env(dir, { FAKE_OPENCODE_LOG_FILE: lim });
  relay(['start', AGENT, prompt], dir, e);
  const w = relay(['wait', prompt], dir, e);
  assert.strictEqual(w.status, 0, w.stdout + w.stderr);
  assert.match(w.stdout, /FAKE CLAUDE REPORT/);
  assert.match(w.stdout, /relay: escalated from opencode \(gsd-executor: limit\) to claude\n/);
  assert.strictEqual(lastLine(w.stdout), `relay: claude (log: ${prompt}.jsonl)`);
  assert.ok(fs.existsSync(prompt + '.opencode.jsonl'));
  const st = readJson(path.join(dir, 'balancer-state.json'));
  assert.strictEqual(st.providers.opencode.cooldownUntil, NOW + 120 * 1000, 'the limit is still recorded');
  assert.strictEqual(st.providers.opencode.hits, 1);
});

test('a pinned agent is never escalated away from claude', () => {
  const { dir, prompt } = mkRepo();
  const e = env(dir, {
    FAKE_LOG_FILE: path.join(FX, 'logs', 'claude-limit.jsonl'),
    BALANCER_CONFIG: cfgFile(dir, { lanes: { pinned_to_claude: ['gsd-executor'] } }),
  });
  relay(['start', AGENT, prompt], dir, e);
  const w = relay(['wait', prompt], dir, e);
  assert.ok(!/escalated/.test(w.stdout));
  assert.match(w.stdout, /balancer: claude limit/);
  assert.strictEqual(lastLine(w.stdout), `relay: claude (log: ${prompt}.jsonl)`);
});

const EXHAUSTED = { BALANCER_OPENCODE_USAGE_FILE: path.join(FX, 'opencode-exhausted.json'), BALANCER_CLAUDE_STATE: path.join(FX, 'claude-exhausted.json') };

test('paygo run is recorded as paygo and leaves the Go cooldown alone; daily cap defers', () => {
  const { dir, prompt } = mkRepo();
  const stateFile = path.join(dir, 'balancer-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ providers: { opencode: { hits: 3, cooldownUntil: NOW + 3600e3 } } }));
  const e = env(dir, { ...EXHAUSTED, BALANCER_CONFIG: cfgFile(dir, { paygo: { enabled: true, model: 'opencode/premium-pro', max_runs_per_day: 1 } }) });
  const s = relay(['start', AGENT, prompt], dir, e);
  assert.match(s.stdout, /provider=opencode \(paygo\)/);
  const w = relay(['wait', prompt], dir, e);
  assert.match(w.stdout, /FAKE OPENCODE REPORT/);
  assert.match(w.stdout, /balancer: paygo success/);
  assert.strictEqual(lastLine(w.stdout), `relay: paygo (log: ${prompt}.jsonl)`);
  const st = readJson(stateFile);
  assert.deepStrictEqual(st.providers.opencode, { hits: 3, cooldownUntil: NOW + 3600e3 });
  assert.strictEqual(st.breakers, undefined);
  assert.strictEqual(st.paygo.runs.length, 1);
  const s2 = relay(['start', AGENT, prompt], dir, e);
  assert.match(s2.stdout, /provider=deferred/, 'second paygo run of the day is over the cap');
  relay(['cancel', prompt], dir, e);
});

test('a run longer than relay.max_run_minutes is killed and reported', () => {
  const { dir, prompt } = mkRepo();
  const e = env(dir, { FAKE_SLEEP_MS: '20000', BALANCER_CONFIG: cfgFile(dir, { relay: { max_run_minutes: 0.01 } }) });
  relay(['start', AGENT, prompt], dir, e);
  const pid = Number(fs.readFileSync(prompt + '.pid', 'utf8'));
  const t0 = Date.now();
  const w = relay(['wait', prompt], dir, e);
  assert.ok(Date.now() - t0 < 10000, 'did not wait for the provider to finish');
  assert.match(w.stdout, /^DONE\nrelay-failure: timeout after 0\.01 min/);
  assert.match(w.stdout, /balancer: opencode failure/);
  assert.throws(() => process.kill(pid, 0));
});

test('cancel stops the run and counts nothing against the provider', () => {
  const { dir, prompt } = mkRepo();
  const e = env(dir, { FAKE_SLEEP_MS: '20000' });
  relay(['start', AGENT, prompt], dir, e);
  const pid = Number(fs.readFileSync(prompt + '.pid', 'utf8'));
  assert.strictEqual(readJson(path.join(dir, 'balancer-state.json')).inflight.opencode.length, 1);
  const c = relay(['cancel', prompt], dir, e);
  assert.strictEqual(c.stdout.trim(), `cancelled pid ${pid}`);
  assert.throws(() => process.kill(pid, 0));
  const w = relay(['wait', prompt], dir, e);
  assert.match(w.stdout, /^DONE\n/);
  assert.match(w.stdout, /balancer: cancelled \(not recorded\)/);
  const st = readJson(path.join(dir, 'balancer-state.json'));
  assert.strictEqual(st.breakers, undefined);
  assert.strictEqual(st.inflight.opencode.length, 0);
  assert.strictEqual(relay(['cancel', prompt], dir, e).stdout.trim(), `relay: not running (pid ${pid})`);
});

test('the relay keeps its own files out of git status and tells an escalated run about the first attempt', () => {
  const { dir, prompt } = mkRepo();
  const e = env(dir, { FAKE_OPENCODE_LOG_FILE: path.join(FX, 'logs', 'opencode-limit.jsonl'), FAKE_ARGV_FILE: '' });
  const first = path.join(dir, 'argv-first.json');
  relay(['start', AGENT, prompt], dir, { ...e, FAKE_ARGV_FILE: first });
  assert.match(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\/task\.md\.\*$/m);
  const second = path.join(dir, 'argv-second.json');
  const w = relay(['wait', prompt], dir, { ...e, FAKE_ARGV_FILE: second });
  assert.match(w.stdout, /escalated from opencode/);
  assert.ok(!readJson(first).argv.join(' ').includes('earlier attempt'), 'the first run is not told about a retry');
  assert.match(readJson(second).argv.join(' '), /earlier attempt at this task on another provider ended without a report/);
  const check = w.stdout.split('ORCHESTRATOR CHECK')[1];
  assert.ok(!/\?\? task\.md\./.test(check), check);
  assert.match(check, /\?\? task\.md\n/, 'the prompt itself is still shown');
});

test('verdict feeds acceptance into stats; relay.wrap_command prefixes the provider command', () => {
  const { dir, prompt } = mkRepo();
  const e = env(dir, { BALANCER_CONFIG: cfgFile(dir, { relay: { wrap_command: ['env', 'LEAK_TEST_API_KEY={root}'] } }) });
  assert.strictEqual(relay(['verdict', prompt, 'accept'], dir, e).status, 2, 'no run yet');
  relay(['start', AGENT, prompt], dir, e);
  relay(['wait', prompt], dir, e);
  assert.strictEqual(readJson(path.join(dir, 'argv.json')).leak, dir, 'ran through the wrapper, {root} expanded');
  assert.strictEqual(relay(['verdict', prompt, 'maybe'], dir, e).status, 2);
  assert.strictEqual(relay(['verdict', prompt, 'reject'], dir, e).stdout.trim(), 'relay: recorded reject for opencode');
  relay(['verdict', prompt, 'accept'], dir, e);
  const st = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'balancer.cjs'), 'stats'], { encoding: 'utf8', env: e });
  assert.match(st.stdout, /gsd-executor @ opencode: 1 picks, 1 success, .*accepted 1\/2/);
});

test('evidence warning: "took a look" is not verification output', () => {
  const { dir, prompt } = mkRepo();
  const log = path.join(dir, 'weak.jsonl');
  fs.writeFileSync(log, '{"type":"text","part":{"messageID":"m","text":"I took a look and booked the change."}}\n');
  relay(['start', AGENT, prompt], dir, env(dir, { FAKE_LOG_FILE: log }));
  assert.match(relay(['wait', prompt], dir, env(dir, { FAKE_LOG_FILE: log })).stdout, /relay-warning: report contains no verification output/);
});

test('a malformed config stops the relay instead of silently dropping pinning', () => {
  const { dir, prompt } = mkRepo();
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ "lanes": { "pinned_to_claude": ["gsd-executor"] }, }');
  const s = relay(['start', AGENT, prompt], dir, env(dir, { BALANCER_CONFIG: bad }));
  assert.strictEqual(s.status, 1);
  assert.match(s.stdout, /relay-failure: config .*invalid JSON/);
  assert.ok(!fs.existsSync(prompt + '.pid'));
});

// ---- free lane ----
const FREE_M = 'opencode/glm-5.3-flash-free';
function freeEnv(dir, extra = {}, free = {}) {
  const cfg = path.join(dir, 'free-cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ free_lane: { enabled: true, agents: ['gsd-executor'], models: [FREE_M], ...free } }));
  const st = path.join(dir, 'balancer-state.json');
  if (!fs.existsSync(st)) {
    fs.writeFileSync(st, JSON.stringify({ canary: { [FREE_M]: { ok: true, ts: NOW - 3600e3, detail: '' } } }));
  }
  return env(dir, { BALANCER_CONFIG: cfg, ...extra });
}

test('free: start/wait runs opencode with --model, records the model only', () => {
  const { dir, prompt } = mkRepo();
  const e = freeEnv(dir);
  const s = relay(['start', AGENT, prompt], dir, e);
  assert.strictEqual(s.status, 0, s.stdout + s.stderr);
  assert.strictEqual(s.stdout.split('\n')[0], `started pid ${fs.readFileSync(prompt + '.pid', 'utf8').trim()} agent=${AGENT} provider=free model=${FREE_M}`);
  assert.strictEqual(fs.readFileSync(prompt + '.provider', 'utf8').trim(), 'free');
  assert.strictEqual(fs.readFileSync(prompt + '.model', 'utf8').trim(), FREE_M);
  const w = relay(['wait', prompt], dir, e);
  assert.match(w.stdout, /^DONE\n/);
  assert.match(w.stdout, /----- FINAL REPORT -----\nFAKE OPENCODE REPORT/);
  assert.strictEqual(lastLine(w.stdout), `relay: free (log: ${prompt}.jsonl)`);
  const a = readJson(path.join(dir, 'argv.json'));
  assert.strictEqual(a.argv[0], 'run');
  assert.strictEqual(a.argv[a.argv.indexOf('--agent') + 1], AGENT);
  assert.strictEqual(a.argv[a.argv.indexOf('--model') + 1], FREE_M);
  assert.strictEqual(a.tmpdir, path.join(dir, 'build', 'tmp'));
  const st = readJson(path.join(dir, 'balancer-state.json'));
  assert.strictEqual(st.providers, undefined);
  assert.strictEqual(st.canary[FREE_M].ts, NOW, 'a successful run renews the canary');
});

test('free runs do not inherit secret-looking environment variables; other lanes do', () => {
  const a = mkRepo();
  const fe = freeEnv(a.dir, { LEAK_TEST_API_KEY: 'x1' });
  relay(['start', AGENT, a.prompt], a.dir, fe);
  relay(['wait', a.prompt], a.dir, fe);
  assert.strictEqual(readJson(path.join(a.dir, 'argv.json')).leak, null);
  const b = mkRepo();
  const oe = env(b.dir, { LEAK_TEST_API_KEY: 'x1' });
  relay(['start', AGENT, b.prompt], b.dir, oe);
  relay(['wait', b.prompt], b.dir, oe);
  assert.strictEqual(readJson(path.join(b.dir, 'argv.json')).leak, 'x1');
});

test('free: failed free run escalates exactly once to the normal lanes', () => {
  const { dir, prompt } = mkRepo();
  const e = freeEnv(dir, { FAKE_FAIL_MODEL: FREE_M });
  const s = relay(['start', AGENT, prompt], dir, e);
  assert.match(s.stdout, /provider=free/);
  const w = relay(['wait', prompt], dir, e);
  assert.strictEqual(w.status, 0, w.stdout + w.stderr);
  assert.match(w.stdout, /^DONE\n/);
  assert.match(w.stdout, /FAKE OPENCODE REPORT/);
  assert.match(w.stdout, new RegExp(`relay: escalated from free \\(${FREE_M}: failure\\) to opencode\n`));
  assert.strictEqual(lastLine(w.stdout), `relay: opencode (log: ${prompt}.jsonl)`);
  assert.ok(!readJson(path.join(dir, 'argv.json')).argv.includes('--model'));
  assert.ok(fs.existsSync(prompt + '.free.jsonl') && fs.existsSync(prompt + '.free.err'));
  assert.ok(fs.existsSync(prompt + '.escalated'));
  const st = readJson(path.join(dir, 'balancer-state.json'));
  assert.strictEqual(st.breakers[FREE_M].failures, 1);
});

test('free: no second escalation when .escalated exists or escalate_on_failure is false', () => {
  for (const mode of ['sidecar', 'flag']) {
    const { dir, prompt } = mkRepo();
    const e = freeEnv(dir, { FAKE_FAIL_MODEL: FREE_M }, mode === 'flag' ? { escalate_on_failure: false } : {});
    relay(['start', AGENT, prompt], dir, e);
    if (mode === 'sidecar') fs.writeFileSync(prompt + '.escalated', 'x\n');
    const w = relay(['wait', prompt], dir, e);
    assert.match(w.stdout, /relay-failure: no-report/, mode);
    assert.strictEqual(lastLine(w.stdout), `relay: free (log: ${prompt}.jsonl)`, mode);
    assert.ok(!/escalated from free/.test(w.stdout), mode);
    assert.ok(!fs.existsSync(prompt + '.free.jsonl'), mode);
    const st = readJson(path.join(dir, 'balancer-state.json'));
    assert.strictEqual(st.breakers[FREE_M].failures, 1, mode);
  }
});

test('free: model_gone run is cooled for an hour and escalates', () => {
  const { dir, prompt } = mkRepo();
  const e = freeEnv(dir, { FAKE_FAIL_MODEL: FREE_M, FAKE_FAIL_LOG: path.join(FX, 'logs', 'opencode-failure.jsonl') });
  relay(['start', AGENT, prompt], dir, e);
  const w = relay(['wait', prompt], dir, e);
  assert.match(w.stdout, new RegExp(`escalated from free \\(${FREE_M}: model_gone\\)`));
  const st = readJson(path.join(dir, 'balancer-state.json'));
  assert.strictEqual(st.modelCooldowns[FREE_M].until, NOW + 3600 * 1000);
  assert.strictEqual(st.providers && st.providers.opencode && st.providers.opencode.cooldownUntil, undefined);
});
