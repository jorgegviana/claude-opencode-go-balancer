'use strict';
// I/O glue shared by bin/balancer.cjs and bin/balancer-relay: gathers usage, decides, persists state.
const { loadConfig } = require('./config.cjs');
const { paths, readJson, writeJsonAtomic } = require('./state.cjs');
const { normalizeOpencode, normalizeClaude, getOpencodeUsage } = require('./usage.cjs');
const { providerScore, decide, earliest } = require('./decide.cjs');

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

function scoresFor(ctx, data, state) {
  const now = ctx.now();
  return {
    opencode: providerScore(data.opencode, ctx.cfg, now),
    claude: providerScore(data.claude, ctx.cfg, now),
  };
}

async function pick(ctx, agent) {
  const state = loadState(ctx);
  const data = await gather(ctx, state);
  const now = ctx.now();
  const d = decide({
    agent, cfg: ctx.cfg, opencode: data.opencode, claude: data.claude, lastPick: state.lastPick, now,
    scores: scoresFor(ctx, data, state),
  });
  if (d.balanced && (d.verdict === 'opencode' || d.verdict === 'claude')) state.lastPick = d.verdict;
  saveState(ctx, state);
  return { ...d, error: data.error };
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

module.exports = { makeCtx, loadState, saveState, gather, scoresFor, pick, waitReset };
