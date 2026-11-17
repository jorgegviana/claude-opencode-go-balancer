'use strict';
const fs = require('fs');
const path = require('path');

function defaults() {
  return {
    hard_stop_percent: 90,
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
    },
    reactive: {
      backoff_initial_seconds: 30,
      backoff_max_seconds: 900,
      hint_max_seconds: 86400,
      probe_timeout_minutes: 15,
      breaker_failures: 3,
      breaker_open_seconds: 30,
      limit_patterns: ['\\b429\\b', 'GoUsageLimitError', 'usage limit', 'rate[ _-]?limit', 'limit reached'],
    },
    claude: {
      model: 'sonnet',
      effort: 'medium',
      permission_mode: 'acceptEdits',
      allowed_tools: ['Bash(git:*)', 'Bash(node:*)', 'Read', 'Write', 'Edit'],
      agent_prompt_dir: null,
    },
    opencode: { agent_models: {} },
    paygo: { enabled: false, model: null },
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

// A missing or unreadable file means defaults; it never throws.
function loadConfig(file) {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(file || defaultConfigPath(), 'utf8'));
  } catch {
    user = {};
  }
  return deepMerge(defaults(), isObj(user) ? user : {});
}

module.exports = { defaults, deepMerge, loadConfig, defaultConfigPath };
