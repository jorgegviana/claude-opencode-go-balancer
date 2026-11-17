'use strict';
const { applyReactive } = require('./reactive.cjs');

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

function providerScore(provider, cfg, now) {
  const live = (provider.windows || []).filter((w) => w.resetsAt > now);
  const blocked = live.filter((w) => w.used >= cfg.hard_stop_percent);
  if (blocked.length) {
    return { status: 'ineligible', headroom: null, eligibleAt: Math.max(...blocked.map((w) => w.resetsAt)) };
  }
  if (!provider.known) return { status: 'unknown', headroom: null, eligibleAt: null };
  let headroom = 100;
  let bonus = 0;
  for (const w of live) {
    headroom = Math.min(headroom, windowHeadroom(w.used, w.resetsAt, w.lenMin, now));
    if (FIVE_HOUR.has(w.name) && w.resetsAt - now <= cfg.use_it_or_lose_it_minutes * MIN) {
      bonus = cfg.use_it_or_lose_it_bonus;
    }
  }
  return { status: 'eligible', headroom: headroom + bonus, eligibleAt: null };
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
  let s = scores || { opencode: providerScore(opencode, cfg, now), claude: providerScore(claude, cfg, now) };
  if (state) s = applyReactive(s, state, { key: breakerKey(logical, cfg), cfg, now });
  const o = s.opencode;
  const c = s.claude;
  const out = (verdict, reason, extra = {}) => ({ verdict, balanced: true, reason, scores: s, ...extra });

  if (o.status === 'ineligible' && c.status === 'ineligible') {
    const until = earliest(s);
    if (cfg.paygo && cfg.paygo.enabled && cfg.paygo.model) return out('paygo', 'both subscriptions limited; paygo enabled', { until });
    return out('wait', 'both subscriptions limited', { until });
  }
  if (o.status === 'eligible' && c.status === 'eligible') {
    let pick = o.headroom >= c.headroom ? 'opencode' : 'claude';
    if (lastPick === 'opencode' || lastPick === 'claude') {
      const cur = s[lastPick];
      const other = s[lastPick === 'opencode' ? 'claude' : 'opencode'];
      pick = other.headroom - cur.headroom > cfg.hysteresis_points ? (lastPick === 'opencode' ? 'claude' : 'opencode') : lastPick;
    }
    return out(pick, `headroom opencode ${o.headroom.toFixed(1)} vs claude ${c.headroom.toFixed(1)}`);
  }
  if (o.status === 'eligible') return out('opencode', `claude is ${c.status}`);
  if (c.status === 'eligible') return out('claude', `opencode is ${o.status}`);
  if (o.status === 'unknown' && c.status === 'unknown') return out(cfg.lanes.default_lane, 'both unknown; default lane');
  // one unknown, other ineligible: go with the unknown one
  return out(o.status === 'unknown' ? 'opencode' : 'claude', 'other provider is limited; trying the one with unknown usage');
}

module.exports = { windowHeadroom, providerScore, decide, logicalAgent, breakerKey, earliest };
