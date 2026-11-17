'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { defaults } = require('../lib/config.cjs');
const { windowHeadroom, providerScore, decide } = require('../lib/decide.cjs');

const NOW = Date.parse('2026-11-17T12:00:00Z');
const MIN = 60000;
const cfg = defaults();
const approx = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} !~ ${b}`);

// window of 100 minutes ending at now + (100 - elapsed) minutes, so elapsed% == elapsed
const hr = (used, elapsed) => windowHeadroom(used, NOW + (100 - elapsed) * MIN, 100, NOW);

test('windowHeadroom formula', () => {
  approx(hr(20, 50), 80);
  approx(hr(60, 20), 0);
  approx(hr(0, 0), 100);
});

test('windowHeadroom: past reset -> null, far reset (skew) -> elapsed 0', () => {
  assert.strictEqual(windowHeadroom(10, NOW - 1, 100, NOW), null);
  assert.strictEqual(windowHeadroom(10, NOW, 100, NOW), null);
  approx(windowHeadroom(30, NOW + 500 * MIN, 100, NOW), 40); // (100-30) - max(0, 30-0)
});

const win = (name, used, minsToReset, lenMin) => ({ name, used, resetsAt: NOW + minsToReset * MIN, lenMin });
const prov = (...windows) => ({ known: true, windows });

test('providerScore: min over windows', () => {
  const s = providerScore(prov(win('weekly', 20, 5040, 10080), win('monthly', 10, 43200, 43200)), cfg, NOW);
  assert.strictEqual(s.status, 'eligible');
  approx(s.headroom, 80); // weekly 80, monthly (100-10)-10 = 80
  const t = providerScore(prov(win('weekly', 20, 5040, 10080), win('monthly', 5, 43200, 43200)), cfg, NOW);
  assert.strictEqual(t.headroom, 80); // min(80, 90)
});

test('providerScore: fresh data without windows -> 100', () => {
  const s = providerScore(prov(), cfg, NOW);
  assert.strictEqual(s.status, 'eligible');
  assert.strictEqual(s.headroom, 100);
});

test('providerScore: 89.9 eligible, 90 ineligible with eligibleAt', () => {
  assert.strictEqual(providerScore(prov(win('weekly', 89.9, 5040, 10080)), cfg, NOW).status, 'eligible');
  const s = providerScore(prov(win('weekly', 90, 5040, 10080), win('rolling', 95, 60, 300)), cfg, NOW);
  assert.strictEqual(s.status, 'ineligible');
  assert.strictEqual(s.eligibleAt, NOW + 5040 * MIN);
});

test('providerScore: use-it-or-lose-it bonus on 5h window within 30 min', () => {
  const base = providerScore(prov(win('rolling', 40, 31, 300)), cfg, NOW).headroom;
  const bonus = providerScore(prov(win('rolling', 40, 30, 300)), cfg, NOW).headroom;
  approx(bonus - base, cfg.use_it_or_lose_it_bonus + (hr2(40, 30) - hr2(40, 31)));
  const other = providerScore(prov(win('weekly', 40, 20, 10080)), cfg, NOW).headroom;
  const other2 = providerScore(prov(win('weekly', 40, 20, 10080)), cfg, NOW).headroom;
  assert.strictEqual(other, other2);
  function hr2(used, minsLeft) { return windowHeadroom(used, NOW + minsLeft * MIN, 300, NOW); }
});

test('providerScore: bonus only for five-hour windows, not weekly', () => {
  const s = providerScore(prov(win('weekly', 40, 20, 10080)), cfg, NOW);
  approx(s.headroom, windowHeadroom(40, NOW + 20 * MIN, 10080, NOW));
});

test('providerScore: unknown provider', () => {
  assert.strictEqual(providerScore({ known: false, windows: [] }, cfg, NOW).status, 'unknown');
});

test('providerScore: stale provider with hard-stop window stays ineligible', () => {
  const s = providerScore({ known: false, windows: [win('five_hour', 95, 120, 300)] }, cfg, NOW);
  assert.strictEqual(s.status, 'ineligible');
  assert.strictEqual(s.eligibleAt, NOW + 120 * MIN);
});

// ---- decide ----
const mk = (headroomUsed) => prov(win('weekly', headroomUsed, 5040, 10080)); // elapsed 50%
const dec = (o) => decide({ agent: 'go-worker', cfg, now: NOW, lastPick: undefined, ...o });

test('decide: strips prefix; pinned agents -> claude without touching lastPick', () => {
  const c = { ...cfg, lanes: { ...cfg.lanes, pinned_to_claude: ['gsd-planner'] } };
  const d = decide({ agent: 'go-gsd-planner', cfg: c, opencode: mk(10), claude: mk(10), lastPick: 'opencode', now: NOW });
  assert.strictEqual(d.verdict, 'claude');
  assert.strictEqual(d.balanced, false);
});

test('decide: non-balanced agents use default_lane', () => {
  const c = { ...cfg, lanes: { ...cfg.lanes, balanced_agents: ['other'], default_lane: 'opencode' } };
  const d = decide({ agent: 'go-worker', cfg: c, opencode: mk(80), claude: mk(0), now: NOW });
  assert.strictEqual(d.verdict, 'opencode');
  assert.strictEqual(d.balanced, false);
});

test('decide: higher headroom wins, hysteresis keeps lastPick unless margin > 10', () => {
  // used 10 -> headroom 90-... elapsed 50: (100-u)-max(0,u-50) = 100-u for u<=50
  assert.strictEqual(dec({ opencode: mk(20), claude: mk(10) }).verdict, 'claude');
  assert.strictEqual(dec({ opencode: mk(20), claude: mk(10), lastPick: 'opencode' }).verdict, 'opencode'); // diff 10 exactly
  assert.strictEqual(dec({ opencode: mk(21), claude: mk(10), lastPick: 'opencode' }).verdict, 'claude'); // diff 11
  assert.strictEqual(dec({ opencode: mk(10), claude: mk(20), lastPick: 'claude' }).verdict, 'claude');
  assert.strictEqual(dec({ opencode: mk(30), claude: mk(10), lastPick: 'opencode' }).verdict, 'claude');
  assert.strictEqual(dec({ opencode: mk(10), claude: mk(10) }).verdict, 'opencode'); // tie
  assert.strictEqual(dec({ opencode: mk(10), claude: mk(10) }).balanced, true);
});

test('decide: unknown handling', () => {
  const unk = { known: false, windows: [] };
  const ex = prov(win('weekly', 95, 100, 10080));
  assert.strictEqual(dec({ opencode: unk, claude: mk(10) }).verdict, 'claude');
  assert.strictEqual(dec({ opencode: mk(10), claude: unk }).verdict, 'opencode');
  assert.strictEqual(dec({ opencode: unk, claude: ex }).verdict, 'opencode');
  assert.strictEqual(dec({ opencode: ex, claude: unk }).verdict, 'claude');
  assert.strictEqual(dec({ opencode: unk, claude: unk }).verdict, 'opencode');
});

test('decide: both ineligible -> wait until earliest eligibleAt', () => {
  const a = prov(win('weekly', 95, 300, 10080));
  const b = prov(win('five_hour', 95, 120, 300));
  const d = dec({ opencode: a, claude: b });
  assert.strictEqual(d.verdict, 'wait');
  assert.strictEqual(d.until, NOW + 120 * MIN);
});
