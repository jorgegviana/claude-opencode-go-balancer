'use strict';
// I/O glue shared by bin/balancer.cjs and bin/balancer-relay: gathers usage, decides, persists state.
const { loadConfig } = require('./config.cjs');
const { paths, readJson, writeJsonAtomic } = require('./state.cjs');
const { normalizeOpencode, normalizeClaude, getOpencodeUsage } = require('./usage.cjs');
const { providerScore, decide, earliest, logicalAgent, breakerKey } = require('./decide.cjs');
const R = require('./reactive.cjs');
const F = require('./free.cjs');
const C = require('./catalog.cjs');
const { checkSpend } = require('./spend.cjs');
const { runCanary } = require('./canary.cjs');
const fs = require('fs');
const cp = require('child_process');

// Default process runner: {status, stdout, stderr, timedOut}. No shell, stdin ignored.
function defaultExec(bin, args, o = {}) {
  const r = cp.spawnSync(bin, args, {
    cwd: o.cwd, env: o.env || process.env, encoding: 'utf8', killSignal: 'SIGKILL', timeout: o.timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', timedOut: !!(r.error && r.error.code === 'ETIMEDOUT') };
}

function makeCtx(env = process.env, over = {}) {
  const p = paths(env);
  return {
    cfg: loadConfig(env.BALANCER_CONFIG),
    paths: p,
    now: () => (env.BALANCER_NOW ? Number(env.BALANCER_NOW) : Date.now()),
    exec: defaultExec,
    opencodeBin: env.BALANCER_OPENCODE_BIN || 'opencode',
    fetchFn: (...a) => fetch(...a),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ...over,
  };
}

function loadState(ctx) {
  return readJson(ctx.paths.state) || {};
}

function saveState(ctx, state) {
  writeJsonAtomic(ctx.paths.state, state);
}

async function gather(ctx, state, { bypassCache = false } = {}) {
  const now = ctx.now();
  let opencode;
  let error = null;
  if (ctx.paths.usageFile) {
    opencode = normalizeOpencode(readJson(ctx.paths.usageFile), ctx.cfg, now);
  } else {
    const r = await getOpencodeUsage({
      fetchFn: ctx.fetchFn, authPath: ctx.paths.auth, cfg: ctx.cfg, now, cache: state.opencodeCache, bypassCache,
    });
    opencode = r.provider;
    error = r.error;
    if (r.cache) state.opencodeCache = r.cache;
  }
  const claudeState = readJson(ctx.paths.claude);
  const claude = normalizeClaude(claudeState, ctx.cfg, now);
  return { opencode, claude, error, claudeTs: claudeState && claudeState.ts };
}

// Usage scores with cooldown/probe/breaker state folded in. agent is optional (breaker is per agent).
function scoresFor(ctx, data, state, agent) {
  const now = ctx.now();
  const base = {
    opencode: providerScore(data.opencode, ctx.cfg, now),
    claude: providerScore(data.claude, ctx.cfg, now),
  };
  const key = agent ? breakerKey(logicalAgent(agent, ctx.cfg), ctx.cfg) : null;
  return R.applyReactive(base, state, { key, cfg: ctx.cfg, now });
}

// provider -> models map (or null on a failed read). Execs only for stale providers.
function loadCatalogs(ctx, state, providers, refresh = false) {
  const out = {};
  for (const provider of providers) {
    out[provider] = C.getCatalog({ exec: ctx.exec, bin: ctx.opencodeBin, cfg: ctx.cfg, state, provider, now: ctx.now(), refresh });
  }
  return out;
}

async function pick(ctx, agent, opts = {}) {
  const state = loadState(ctx);
  const logical = logicalAgent(agent, ctx.cfg);
  let freeNote = '';
  if (!opts.excludeFree && F.freeAgentAllowed(logical, ctx.cfg)) {
    const now0 = ctx.now();
    const catalogs = loadCatalogs(ctx, state, C.catalogsFor(ctx.cfg.free_lane.models.map(F.normalizeModel)));
    const spend = {};
    for (const [prov, guard] of Object.entries(ctx.cfg.free_lane.spend_guard || {})) {
      if (!(prov in catalogs)) continue; // no configured model for this provider
      spend[prov] = await checkSpend({ provider: prov, guard, fetchFn: ctx.fetchFn, authPath: ctx.paths.auth, cfg: ctx.cfg, state, now: now0 });
    }
    const f = F.pickFreeModel({ logical, cfg: ctx.cfg, state, catalogs, now: now0, spend });
    if (f.model) {
      // Claim a half-open breaker attempt for the model; usage is deliberately not read.
      R.breakerAllow(state, f.model, ctx.cfg, now0);
      saveState(ctx, state);
      return { verdict: 'free', model: f.model, balanced: false, reason: f.reason, error: null };
    }
    freeNote = f.reason;
  }
  const data = await gather(ctx, state);
  const now = ctx.now();
  const scores = scoresFor(ctx, data, state, agent);
  // The opencode lane's model for this agent: dropped while a successfully read catalog lacks it.
  let missingNote = '';
  const am = ctx.cfg.opencode.agent_models && ctx.cfg.opencode.agent_models[logical];
  if (am && ctx.cfg.catalog.check_agent_models) {
    const model = F.normalizeModel(am);
    const provider = model && model.split('/')[0];
    if (provider) {
      const cats = loadCatalogs(ctx, state, [provider]);
      if (!F.catalogHas(cats, model)) {
        const until = state.catalog[provider].ts + ctx.cfg.catalog.ttl_seconds * 1000;
        scores.opencode = { status: 'ineligible', headroom: null, eligibleAt: Math.max(scores.opencode.eligibleAt ?? 0, until) };
        missingNote = `${model} missing from catalog`;
      }
    }
  }
  const d = decide({
    agent, cfg: ctx.cfg, opencode: data.opencode, claude: data.claude, lastPick: state.lastPick, now, scores,
  });
  if (missingNote) d.reason = `${d.reason}; ${missingNote}`;
  // Claim the single probe / half-open attempt for the provider we are about to launch.
  if (d.verdict === 'opencode' || d.verdict === 'claude') {
    R.isProviderAvailable(state, d.verdict, ctx.cfg, now);
    if (d.verdict === 'opencode') R.breakerAllow(state, breakerKey(logicalAgent(agent, ctx.cfg), ctx.cfg), ctx.cfg, now);
  }
  if (d.balanced && (d.verdict === 'opencode' || d.verdict === 'claude')) state.lastPick = d.verdict;
  saveState(ctx, state);
  return { ...d, reason: freeNote ? `${d.reason}; ${freeNote}` : d.reason, error: data.error };
}

// Loops until any provider is eligible or unknown. Returns {ok, until}.
async function waitReset(ctx, { maxSeconds = 570, bypassCache = true } = {}) {
  let waited = 0;
  const budget = maxSeconds * 1000;
  for (;;) {
    const state = loadState(ctx);
    const data = await gather(ctx, state, { bypassCache });
    const scores = scoresFor(ctx, data, state);
    saveState(ctx, state);
    if (Object.values(scores).some((s) => s.status !== 'ineligible')) return { ok: true };
    const now = ctx.now();
    const until = earliest(scores) ?? now + ctx.cfg.wait_max_sleep_seconds * 1000;
    const remaining = budget - waited;
    if (remaining <= 0) return { ok: false, until };
    const ms = Math.max(1000, Math.min(until - now, ctx.cfg.wait_max_sleep_seconds * 1000, remaining));
    await ctx.sleep(ms);
    waited += ms;
  }
}

function readText(f) {
  try { return f ? fs.readFileSync(f, 'utf8') : ''; } catch { return ''; }
}

// Classify a finished run from its logs and update reactive state. Returns a one-line summary.
function recordRun(ctx, { provider, agent, model, logFile, errFile, extraFailure = false }) {
  const now = ctx.now();
  const state = loadState(ctx);
  const det = R.detectLimitError(readText(logFile) + '\n' + readText(errFile), ctx.cfg, now);
  const key = provider === 'free' ? model : breakerKey(logicalAgent(agent, ctx.cfg), ctx.cfg);
  let outcome = 'success';
  if (det && det.limit) outcome = 'limit';
  else if (det && det.modelGone) outcome = 'model_gone';
  else if (det || extraFailure) outcome = 'failure';
  R.recordOutcome(state, { provider, key, outcome, hint: det }, ctx.cfg, now);
  saveState(ctx, state);
  const iso = (ms) => new Date(ms).toISOString();
  const mc = state.modelCooldowns && state.modelCooldowns[key];
  if (provider === 'free') {
    const cd = (outcome === 'limit' || outcome === 'model_gone') && mc ? `; cooldown until ${iso(mc.until)}` : '';
    return `balancer: free ${key} ${outcome}${cd}`;
  }
  if (outcome === 'model_gone') return `balancer: ${provider} model_gone ${key}; cooldown until ${iso(mc.until)}`;
  if (outcome === 'limit') return `balancer: ${provider} limit; cooldown until ${iso(state.providers[provider].cooldownUntil)}`;
  return `balancer: ${provider} ${outcome}`;
}

// Run a canary per model sequentially and record {ok, ts, detail} in state.canary.
function runCanaries(ctx, models, { timeoutSeconds } = {}) {
  const state = loadState(ctx);
  const secs = timeoutSeconds || ctx.cfg.free_lane.canary_timeout_seconds;
  const results = [];
  for (const model of models) {
    const r = runCanary({ model, exec: ctx.exec, bin: ctx.opencodeBin, timeoutSeconds: secs });
    state.canary = state.canary || {};
    state.canary[model] = { ok: r.ok, ts: ctx.now(), detail: r.detail };
    saveState(ctx, state);
    results.push({ model, ...r });
  }
  return results;
}

module.exports = { loadCatalogs, runCanaries, recordRun, makeCtx, loadState, saveState, gather, scoresFor, pick, waitReset };
