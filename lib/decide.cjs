'use strict';
const { applyReactive, perRun } = require('./reactive.cjs');
const { hardStop } = require('./config.cjs');

const MIN = 60000;
const FIVE_HOUR = new Set(['rolling', 'five_hour']);

// (100 - used) - max(0, used - elapsed%). Null when the window already reset.
function windowHeadroom(used, resetsAt, windowLenMin, now) {
  const lenMs = windowLenMin * MIN;
  const remaining = resetsAt - now;
  if (remaining <= 0) return null;
  const elapsed = Math.min(100, Math.max(0, ((lenMs - remaining) / lenMs) * 100));
  return 100 - used - Math.max(0, used - elapsed);
}

// opts: {name, inflight, burn}. name selects the provider's reserve; inflight is the number of runs
// picked but not finished; burn is the learned usage per run (state.burn[name]).
// Returns {status, headroom, eligibleAt, runs}: runs is the estimated number of runs left before the
// hard stop, or null until enough runs were measured.
function providerScore(provider, cfg, now, opts = {}) {
  const stop = hardStop(cfg, opts.name);
  const live = (provider.windows || []).filter((w) => w.resetsAt > now);
  const blocked = live.filter((w) => w.used >= stop);
  if (blocked.length) {
    return { status: 'ineligible', headroom: null, eligibleAt: Math.max(...blocked.map((w) => w.resetsAt)), runs: null };
  }
  if (!provider.known) return { status: 'unknown', headroom: null, eligibleAt: null, runs: null };
  const inflight = opts.inflight || 0;
  const fallbackCost = (cfg.inflight && cfg.inflight.cost_points) || 0;
  let headroom = 100;
  let binding = null;
  let runs = live.length ? Infinity : null;
  for (const w of live) {
    const learned = perRun(opts.burn, w.name, cfg);
    // An unmeasured run is assumed to cost cost_points of a 5 h window, scaled down for longer windows.
    const cost = learned ?? fallbackCost * Math.min(1, 300 / w.lenMin);
    const h = windowHeadroom(w.used, w.resetsAt, w.lenMin, now) - inflight * cost;
    if (h < headroom) { headroom = h; binding = w; }
    if (runs !== null) runs = learned === null ? null : Math.min(runs, Math.max(0, h - (100 - stop)) / Math.max(learned, 0.05));
  }
  // Use it or lose it: only when the 5 h window is the one that limits this provider. Quota in a
  // longer window is not about to be lost, so it earns no bonus.
  const bonus = binding && FIVE_HOUR.has(binding.name) && binding.resetsAt - now <= cfg.use_it_or_lose_it_minutes * MIN
    ? cfg.use_it_or_lose_it_bonus : 0;
  return { status: 'eligible', headroom: headroom + bonus, eligibleAt: null, runs };
}

function logicalAgent(agent, cfg) {
  const p = cfg.lanes.opencode_agent_prefix;
  return p && agent.startsWith(p) ? agent.slice(p.length) : agent;
}

function breakerKey(logical, cfg) {
  return (cfg.opencode.agent_models && cfg.opencode.agent_models[logical]) || logical;
}

function isBalanced(logical, cfg) {
  const b = cfg.lanes.balanced_agents;
  return b === '*' || (Array.isArray(b) && b.includes(logical));
}

function earliest(scores) {
  const ts = Object.values(scores).map((s) => s.eligibleAt).filter((t) => Number.isFinite(t));
  return ts.length ? Math.min(...ts) : null;
}

// scores (optional) lets callers inject reactive adjustments; otherwise computed from usage.
function decide({ agent, cfg, opencode, claude, lastPick, now, scores, state }) {
  const logical = logicalAgent(agent, cfg);
  if (cfg.lanes.pinned_to_claude.includes(logical)) {
    return { verdict: 'claude', balanced: false, reason: `${logical} is pinned to claude` };
  }
  if (!isBalanced(logical, cfg)) {
    return { verdict: cfg.lanes.default_lane, balanced: false, reason: `${logical} is not balanced; default lane` };
  }
  let s = scores || {
    opencode: providerScore(opencode, cfg, now, { name: 'opencode' }),
    claude: providerScore(claude, cfg, now, { name: 'claude' }),
  };
  if (state) s = applyReactive(s, state, { key: breakerKey(logical, cfg), cfg, now });
  const o = s.opencode;
  const c = s.claude;
  const out = (verdict, reason, extra = {}) => ({ verdict, balanced: true, reason, scores: s, ...extra });

  if (o.status === 'ineligible' && c.status === 'ineligible') {
    const until = earliest(s);
    if (cfg.paygo && cfg.paygo.enabled && cfg.paygo.model) return out('paygo', 'both subscriptions limited; paygo enabled', { until });
    return out('wait', 'both subscriptions limited', { until });
  }
  // Soft pin: the first preferred provider that is not limited, without touching lastPick.
  const pref = cfg.lanes.preferences && cfg.lanes.preferences[logical];
  if (Array.isArray(pref) && pref.length) {
    const ok = pref.find((p) => s[p] && s[p].status === 'eligible') || pref.find((p) => s[p] && s[p].status === 'unknown');
    if (ok) return { ...out(ok, `${logical} prefers ${pref.join(' > ')}`), balanced: false };
  }
  if (o.status === 'eligible' && c.status === 'eligible') {
    // Percent of a window is not the same amount of work on both providers. Once both have a
    // measured cost per run, compare the runs left instead.
    const st = cfg.strategy || {};
    const byRuns = !!st.runs_remaining && Number.isFinite(o.runs) && Number.isFinite(c.runs);
    const val = (x) => (byRuns ? x.runs : x.headroom);
    const margin = byRuns ? st.hysteresis_runs : cfg.hysteresis_points;
    let pick = val(o) >= val(c) ? 'opencode' : 'claude';
    if (lastPick === 'opencode' || lastPick === 'claude') {
      const cur = s[lastPick];
      const other = s[lastPick === 'opencode' ? 'claude' : 'opencode'];
      pick = val(other) - val(cur) > margin ? (lastPick === 'opencode' ? 'claude' : 'opencode') : lastPick;
    }
    return out(pick, `${byRuns ? 'runs left' : 'headroom'} opencode ${val(o).toFixed(1)} vs claude ${val(c).toFixed(1)}`);
  }
  if (o.status === 'eligible') return out('opencode', `claude is ${c.status}`);
  if (c.status === 'eligible') return out('claude', `opencode is ${o.status}`);
  if (o.status === 'unknown' && c.status === 'unknown') return out(cfg.lanes.default_lane, 'both unknown; default lane');
  // one unknown, other ineligible: go with the unknown one
  return out(o.status === 'unknown' ? 'opencode' : 'claude', 'other provider is limited; trying the one with unknown usage');
}

module.exports = { windowHeadroom, providerScore, decide, logicalAgent, breakerKey, earliest };
