'use strict';
// I/O glue shared by bin/balancer.cjs and bin/balancer-relay: gathers usage, decides, persists state.
const { loadConfig } = require('./config.cjs');
const { paths, readJson, writeJsonAtomic } = require('./state.cjs');
const { normalizeOpencode, normalizeClaude, getOpencodeUsage } = require('./usage.cjs');
const { providerScore, decide, earliest, logicalAgent, breakerKey } = require('./decide.cjs');
const R = require('./reactive.cjs');
const F = require('./free.cjs');
const fs = require('fs');

function makeCtx(env = process.env, over = {}) {
  const p = paths(env);
  return {
    cfg: loadConfig(env.BALANCER_CONFIG),
    paths: p,
    now: () => (env.BALANCER_NOW ? Number(env.BALANCER_NOW) : Date.now()),
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

async function pick(ctx, agent, opts = {}) {
  const state = loadState(ctx);
  const logical = logicalAgent(agent, ctx.cfg);
  let freeNote = '';
  if (!opts.excludeFree && F.freeAgentAllowed(logical, ctx.cfg)) {
    const now0 = ctx.now();
    const f = F.pickFreeModel({ logical, cfg: ctx.cfg, state, catalogs: {}, now: now0 });
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
  const d = decide({
    agent, cfg: ctx.cfg, opencode: data.opencode, claude: data.claude, lastPick: state.lastPick, now,
    scores: scoresFor(ctx, data, state, agent),
  });
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
  else if (det || extraFailure) outcome = 'failure';
  R.recordOutcome(state, { provider, key, outcome, hint: det }, ctx.cfg, now);
  saveState(ctx, state);
  if (outcome === 'limit') {
    return `balancer: ${provider} limit; cooldown until ${new Date(state.providers[provider].cooldownUntil).toISOString()}`;
  }
  return `balancer: ${provider} ${outcome}`;
}

module.exports = { recordRun, makeCtx, loadState, saveState, gather, scoresFor, pick, waitReset };
