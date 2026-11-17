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
      model_gone_cooldown_seconds: 3600,
      model_gone_patterns: [
        'model[ _-]?not[ _-]?found', 'model_not_found', '\\b404\\b', 'model\\b[^\\n]{0,120}does not exist', 'retired',
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
