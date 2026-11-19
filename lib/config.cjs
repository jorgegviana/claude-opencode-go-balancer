'use strict';
const fs = require('fs');
const path = require('path');

function defaults() {
  return {
    hard_stop_percent: 90,
    // Points kept back per provider: its hard stop is hard_stop_percent - reserve. Claude's reserve
    // leaves room for the interactive session that orchestrates the workers on the same quota.
    reserve_percent: { claude: 10, opencode: 0 },
    hysteresis_points: 10,
    use_it_or_lose_it_minutes: 30,
    use_it_or_lose_it_bonus: 15,
    stale_minutes: 15,
    usage_cache_seconds: 60,
    fetch_timeout_ms: 4000,
    wait_max_sleep_seconds: 300,
    windows_minutes: { rolling: 300, weekly: 10080, monthly: 43200, five_hour: 300, seven_day: 10080 },
    lanes: {
      opencode_agent_prefix: 'go-',
      pinned_to_claude: [],
      balanced_agents: '*',
      default_lane: 'opencode',
      // logical agent -> ordered providers; the first one that is not limited wins (soft pin).
      preferences: {},
      // Outcomes of a run without a report that are re-run once on the other subscription.
      escalate_on: ['limit', 'model_gone'],
    },
    // Runs picked but not yet recorded count against a provider until they finish.
    inflight: { ttl_minutes: 30, cost_points: 2 },
    // Learned usage per run; once both providers have min_samples the comparison is in runs left.
    strategy: { runs_remaining: true, min_samples: 5, hysteresis_runs: 2, burn_decay: 0.9 },
    reactive: {
      backoff_initial_seconds: 30,
      backoff_max_seconds: 900,
      hint_max_seconds: 86400,
      probe_timeout_minutes: 15,
      breaker_failures: 3,
      breaker_open_seconds: 30,
      limit_patterns: ['\\b429\\b', 'GoUsageLimitError', 'usage limit', 'rate[ _-]?limit', 'limit reached'],
      model_gone_cooldown_seconds: 3600,
      model_gone_patterns: [
        'model[ _-]?not[ _-]?found', 'model_not_found', '\\b(HTTP|status(Code)?)\\W{0,3}404\\b',
        'model\\b[^\\n]{0,120}does not exist', 'model\\b[^\\n]{0,120}retired',
      ],
    },
    free_lane: {
      enabled: false,
      models: [
        'opencode/deepseek-v4.1-flash-free', 'opencode/glm-5.3-flash-free', 'opencode/mimo-v2.6-flash-free',
        'opencode/minimax-m3.1-flash-free', 'opencode/longcat-2.5-free', 'opencode/hy4-flash-free',
        'opencode/big-pickle',
      ],
      agents: [],
      canary_ttl_days: 7,
      canary_timeout_seconds: 300,
      escalate_on_failure: true,
      renew_canary_on_success: true,
      require_toolcall: true,
      rotate: false,
      // provider -> {min_balance_usd, cache_seconds}. Paid models are only picked for guarded providers.
      spend_guard: {},
    },
    catalog: { ttl_seconds: 600, timeout_seconds: 20, check_agent_models: true },
    claude: {
      model: 'sonnet',
      effort: 'medium',
      permission_mode: 'acceptEdits',
      allowed_tools: [
        'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git add:*)', 'Bash(git commit:*)',
        'Bash(node --test:*)', 'Bash(npm test:*)', 'Read', 'Write', 'Edit',
      ],
      disallowed_tools: ['Bash(git push:*)'],
      agent_prompt_dir: null,
    },
    opencode: { agent_models: {} },
    paygo: { enabled: false, model: null, max_runs_per_day: 10 },
    relay: {
      max_run_minutes: 180,
      // Free-lane runs get an environment without variables whose name matches these (case-insensitive).
      scrub_env_free: true,
      env_scrub_patterns: ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'CREDENTIAL'],
      env_keep: [],
    },
    log: { enabled: true, max_bytes: 5242880 },
  };
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

function defaultConfigPath() {
  return path.join(__dirname, '..', 'config', 'balancer.config.json');
}

class ConfigError extends Error {}

const PROVIDERS = ['opencode', 'claude'];
const OUTCOMES = ['limit', 'model_gone', 'failure'];
const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const regexes = (v) => strings(v) && v.every((x) => { try { new RegExp(x); return true; } catch { return false; } });
const num = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

// Returns a list of problems (empty when the merged config is usable).
function validate(c) {
  const bad = [];
  const need = (ok, what) => { if (!ok) bad.push(what); };
  for (const k of ['hard_stop_percent', 'hysteresis_points', 'use_it_or_lose_it_minutes', 'use_it_or_lose_it_bonus',
    'stale_minutes', 'usage_cache_seconds', 'fetch_timeout_ms', 'wait_max_sleep_seconds']) need(num(c[k]), `${k} must be a number >= 0`);
  need(isObj(c.reserve_percent) && Object.values(c.reserve_percent).every(num), 'reserve_percent must map providers to numbers');
  const l = c.lanes;
  need(isObj(l), 'lanes must be an object');
  if (isObj(l)) {
    need(typeof l.opencode_agent_prefix === 'string', 'lanes.opencode_agent_prefix must be a string');
    need(strings(l.pinned_to_claude), 'lanes.pinned_to_claude must be an array of strings');
    need(l.balanced_agents === '*' || strings(l.balanced_agents), 'lanes.balanced_agents must be "*" or an array of strings');
    need(PROVIDERS.includes(l.default_lane), 'lanes.default_lane must be "opencode" or "claude"');
    need(isObj(l.preferences) && Object.values(l.preferences).every((v) => strings(v) && v.length && v.every((p) => PROVIDERS.includes(p))),
      'lanes.preferences must map agents to a list of "opencode"/"claude"');
    need(strings(l.escalate_on) && l.escalate_on.every((o) => OUTCOMES.includes(o)), `lanes.escalate_on entries must be one of ${OUTCOMES.join(', ')}`);
  }
  const r = c.reactive;
  need(isObj(r) && regexes(r.limit_patterns), 'reactive.limit_patterns must be valid regular expressions');
  need(isObj(r) && regexes(r.model_gone_patterns), 'reactive.model_gone_patterns must be valid regular expressions');
  const f = c.free_lane;
  need(isObj(f) && typeof f.enabled === 'boolean', 'free_lane.enabled must be true or false');
  need(isObj(f) && strings(f.agents), 'free_lane.agents must be an array of strings');
  need(isObj(f) && strings(f.models), 'free_lane.models must be an array of strings');
  need(isObj(f) && isObj(f.spend_guard), 'free_lane.spend_guard must be an object');
  need(isObj(c.claude) && strings(c.claude.allowed_tools), 'claude.allowed_tools must be an array of strings');
  need(isObj(c.claude) && strings(c.claude.disallowed_tools || []), 'claude.disallowed_tools must be an array of strings');
  need(isObj(c.opencode) && isObj(c.opencode.agent_models), 'opencode.agent_models must be an object');
  need(isObj(c.paygo) && typeof c.paygo.enabled === 'boolean', 'paygo.enabled must be true or false');
  need(isObj(c.paygo) && (c.paygo.max_runs_per_day === null || num(c.paygo.max_runs_per_day)), 'paygo.max_runs_per_day must be a number or null');
  need(isObj(c.relay) && num(c.relay.max_run_minutes), 'relay.max_run_minutes must be a number >= 0');
  need(isObj(c.relay) && regexes(c.relay.env_scrub_patterns) && strings(c.relay.env_keep), 'relay.env_scrub_patterns / env_keep must be arrays of strings');
  need(isObj(c.inflight) && num(c.inflight.ttl_minutes) && num(c.inflight.cost_points), 'inflight.ttl_minutes / cost_points must be numbers');
  need(isObj(c.strategy) && num(c.strategy.min_samples) && num(c.strategy.hysteresis_runs) && num(c.strategy.burn_decay), 'strategy values must be numbers');
  return bad;
}

// A missing file means defaults. A file that exists but is malformed or invalid throws ConfigError:
// silently falling back to defaults would drop pinning and privacy settings.
function loadConfig(file) {
  const f = file || defaultConfigPath();
  let text = null;
  try {
    text = fs.readFileSync(f, 'utf8');
  } catch (e) {
    if (e && e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw new ConfigError(`config ${f}: cannot read (${e.code || 'error'})`);
  }
  let user = {};
  if (text !== null) {
    try { user = JSON.parse(text); } catch (e) { throw new ConfigError(`config ${f}: invalid JSON (${String(e && e.message).slice(0, 80)})`); }
    if (!isObj(user)) throw new ConfigError(`config ${f}: top level must be an object`);
  }
  const cfg = deepMerge(defaults(), user);
  const bad = validate(cfg);
  if (bad.length) throw new ConfigError(`config ${f}: ${bad.slice(0, 3).join('; ')}`);
  return cfg;
}

// Usage percent at which a provider stops taking runs.
function hardStop(cfg, provider) {
  const r = cfg.reserve_percent && provider ? Number(cfg.reserve_percent[provider]) || 0 : 0;
  return cfg.hard_stop_percent - r;
}

module.exports = { defaults, deepMerge, loadConfig, defaultConfigPath, validate, hardStop, ConfigError };
