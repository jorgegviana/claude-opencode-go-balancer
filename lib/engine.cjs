'use strict';
// I/O glue shared by bin/balancer.cjs and bin/balancer-relay: gathers usage, decides, persists state.
const { loadConfig } = require('./config.cjs');
const { paths, readJson, writeJsonAtomic, withLock } = require('./state.cjs');
const { normalizeOpencode, normalizeClaude, getOpencodeUsage } = require('./usage.cjs');
const { providerScore, decide, earliest, logicalAgent, breakerKey } = require('./decide.cjs');
const R = require('./reactive.cjs');
const F = require('./free.cjs');
const C = require('./catalog.cjs');
const { checkSpend } = require('./spend.cjs');
const { runCanary } = require('./canary.cjs');
const { logEvent } = require('./log.cjs');
const { parseRunLog } = require('./runlog.cjs');
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

// Locked read-modify-write of the state file. fn must be synchronous: all network and process
// I/O happens before, on a snapshot, so the lock is only held for the decision itself.
function mutate(ctx, fn) {
  return withLock(ctx.paths.state, () => {
    const state = loadState(ctx);
    const r = fn(state);
    saveState(ctx, state);
    return r;
  });
}

const newer = (a, b) => !!a && (!b || (a.ts || 0) >= (b.ts || 0));

// Copy the caches refreshed on a snapshot (usage, catalogs, balances) into the fresh state.
function mergeCaches(state, snap) {
  if (newer(snap.opencodeCache, state.opencodeCache)) state.opencodeCache = snap.opencodeCache;
  for (const k of ['catalog', 'spend']) {
    for (const [p, e] of Object.entries(snap[k] || {})) {
      state[k] = state[k] || {};
      if (newer(e, state[k][p])) state[k][p] = e;
    }
  }
}

function saveCaches(ctx, snap) {
  return mutate(ctx, (state) => mergeCaches(state, snap));
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

// Usage scores with in-flight runs, learned cost per run and cooldown/probe/breaker state folded in.
// agent is optional (breaker and model cooldown are per agent).
function scoresFor(ctx, data, state, agent) {
  const now = ctx.now();
  const logical = agent ? logicalAgent(agent, ctx.cfg) : '*';
  const o = (name) => ({
    name, inflight: R.countInflight(state, name, ctx.cfg, now), burn: state.burn && state.burn[name],
    agentTokens: R.avgTokens(state, name, logical),
  });
  const base = {
    opencode: providerScore(data.opencode, ctx.cfg, now, o('opencode')),
    claude: providerScore(data.claude, ctx.cfg, now, o('claude')),
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

const brief = (scores) => {
  const out = {};
  for (const [p, s] of Object.entries(scores || {})) {
    out[p] = { status: s.status, headroom: s.headroom == null ? null : Math.round(s.headroom * 10) / 10, runs: Number.isFinite(s.runs) ? Math.round(s.runs * 10) / 10 : null };
  }
  return out;
};

// opts: excludeFree, excludeProvider ('opencode' | 'claude': never pick it, used for escalation),
// dryRun (decide without claiming a probe, counting the run or writing anything).
async function pick(ctx, agent, opts = {}) {
  const snap = loadState(ctx);
  const logical = logicalAgent(agent, ctx.cfg);
  const commit = (fn) => {
    const run = (state) => { mergeCaches(state, snap); return fn(state); };
    return opts.dryRun ? run(loadState(ctx)) : mutate(ctx, run);
  };
  const note = (d) => { if (!opts.dryRun) logEvent(ctx, { event: 'pick', agent: logical, verdict: d.verdict, model: d.model, reason: d.reason, scores: brief(d.scores) }); };
  let freeNote = '';
  if (!opts.excludeFree && F.freeAgentAllowed(logical, ctx.cfg)) {
    const now0 = ctx.now();
    const fl = ctx.cfg.free_lane;
    const catalogs = loadCatalogs(ctx, snap, [...new Set([...C.catalogsFor(fl.models.map(F.normalizeModel)), ...(fl.discover ? fl.discover_providers : [])])]);
    const spend = {};
    for (const [prov, guard] of Object.entries(ctx.cfg.free_lane.spend_guard || {})) {
      if (!(prov in catalogs)) continue; // no configured model for this provider
      spend[prov] = await checkSpend({ provider: prov, guard, fetchFn: ctx.fetchFn, authPath: ctx.paths.auth, cfg: ctx.cfg, state: snap, now: now0 });
    }
    const f = commit((state) => {
      const r = F.pickFreeModel({ logical, cfg: ctx.cfg, state, catalogs, now: now0, spend });
      if (r.model) {
        // Claim a half-open breaker attempt for the model; usage is deliberately not read.
        R.breakerAllow(state, r.model, ctx.cfg, now0);
        state.freeLast = { ...(state.freeLast || {}), [r.model]: now0 };
      }
      return r;
    });
    if (f.model) {
      const d = { verdict: 'free', model: f.model, balanced: false, reason: f.reason, error: null };
      note(d);
      return d;
    }
    freeNote = f.reason;
  }
  const data = await gather(ctx, snap);
  const now = ctx.now();
  // The opencode lane's model for this agent: dropped while a successfully read catalog lacks it.
  let missing = null;
  const am = ctx.cfg.opencode.agent_models && ctx.cfg.opencode.agent_models[logical];
  if (am && ctx.cfg.catalog.check_agent_models) {
    const model = F.normalizeModel(am);
    const provider = model && model.split('/')[0];
    if (provider) {
      const cats = loadCatalogs(ctx, snap, [provider]);
      if (!F.catalogHas(cats, model)) missing = { model, until: snap.catalog[provider].ts + ctx.cfg.catalog.ttl_seconds * 1000 };
    }
  }
  const d = commit((state) => {
    const scores = scoresFor(ctx, data, state, agent);
    const block = (p, until) => { scores[p] = { status: 'ineligible', headroom: null, eligibleAt: until, runs: null }; };
    if (missing) block('opencode', Math.max(scores.opencode.eligibleAt ?? 0, missing.until));
    if (opts.excludeProvider && scores[opts.excludeProvider]) block(opts.excludeProvider, scores[opts.excludeProvider].eligibleAt);
    let r = decide({
      agent, cfg: ctx.cfg, opencode: data.opencode, claude: data.claude, lastPick: state.lastPick, now, scores,
    });
    if (missing) r.reason = `${r.reason}; ${missing.model} missing from catalog`;
    if (r.verdict === 'paygo') {
      if (R.paygoAllowed(state, ctx.cfg, now)) R.recordPaygo(state, now);
      else r = { ...r, verdict: 'wait', reason: `${r.reason}; paygo cap of ${ctx.cfg.paygo.max_runs_per_day} runs per day reached` };
    }
    if (r.verdict === 'opencode' || r.verdict === 'claude') {
      // Claim the single probe / half-open attempt for the provider we are about to launch.
      R.isProviderAvailable(state, r.verdict, ctx.cfg, now);
      if (r.verdict === 'opencode') R.breakerAllow(state, breakerKey(logical, ctx.cfg), ctx.cfg, now);
      // Count the run until it is recorded, with the usage it started at (to learn its cost).
      const used = {};
      for (const w of data[r.verdict].windows || []) used[w.name] = { used: w.used, resetsAt: w.resetsAt };
      R.addInflight(state, r.verdict, { agent: logical, used: data[r.verdict].known ? used : null }, ctx.cfg, now);
      if (r.balanced) state.lastPick = r.verdict;
    }
    return r;
  });
  const out = { ...d, reason: freeNote ? `${d.reason}; ${freeNote}` : d.reason, error: data.error };
  note(out);
  return out;
}

// Loops until any provider is eligible or unknown. Returns {ok, until}. With agent, that agent's
// breaker and model cooldown count too, so the result agrees with pick for it.
async function waitReset(ctx, { maxSeconds = 570, bypassCache = true, agent } = {}) {
  let waited = 0;
  const budget = maxSeconds * 1000;
  for (;;) {
    const snap = loadState(ctx);
    const data = await gather(ctx, snap, { bypassCache });
    const scores = mutate(ctx, (state) => { mergeCaches(state, snap); return scoresFor(ctx, data, state, agent); });
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

// How much each window grew since the run was picked, split between the runs that shared it.
function burnDeltas(entry, provider, usage, others) {
  const cur = usage && usage[provider];
  if (!entry || !entry.used || !cur || !cur.known) return null;
  const out = {};
  for (const w of cur.windows || []) {
    const then = entry.used[w.name];
    if (!then || Math.abs(then.resetsAt - w.resetsAt) > 60000) continue; // window rolled over
    const d = w.used - then.used;
    if (d >= 0) out[w.name] = d / (1 + others);
  }
  return Object.keys(out).length ? out : null;
}

// Classify a finished run from its logs and update reactive state. usage (optional, from gather)
// lets it learn what the run cost. Returns {summary, outcome, key}.
function recordRunDetailed(ctx, { provider, agent, model, logFile, errFile, extraFailure = false, usage = null }) {
  const now = ctx.now();
  const logical = logicalAgent(agent, ctx.cfg);
  const logText = readText(logFile);
  const cost = parseRunLog(logText);
  const det = R.detectLimitError(logText + '\n' + readText(errFile), ctx.cfg, now, { modelGone: provider !== 'claude' && provider !== 'paygo' });
  const key = provider === 'free' ? model : breakerKey(logical, ctx.cfg);
  let outcome = 'success';
  if (det && det.limit) outcome = 'limit';
  else if (det && det.modelGone) outcome = 'model_gone';
  else if (det || extraFailure) outcome = 'failure';
  const state = mutate(ctx, (st) => {
    R.recordOutcome(st, { provider, key, outcome, hint: det }, ctx.cfg, now);
    if (provider === 'opencode' || provider === 'claude') {
      const entry = R.takeInflight(st, provider, logical, ctx.cfg, now);
      const deltas = outcome === 'limit' ? null : burnDeltas(entry, provider, usage, R.countInflight(st, provider, ctx.cfg, now));
      if (deltas) R.recordBurn(st, provider, deltas, ctx.cfg, cost.tokens);
      if (outcome !== 'limit') R.recordTokens(st, provider, logical, cost.tokens, ctx.cfg);
    }
    // A real run that succeeded is better evidence than the canary task: keep the model fresh.
    if (provider === 'free' && outcome === 'success' && key && ctx.cfg.free_lane.renew_canary_on_success) {
      st.canary = st.canary || {};
      st.canary[key] = { ok: true, ts: now, detail: 'renewed by a successful run' };
    }
    return st;
  });
  logEvent(ctx, {
    event: 'outcome', provider, agent: logical, model: provider === 'free' ? model : undefined, outcome,
    tokens: cost.tokens || undefined, cost_usd: cost.costUsd || undefined, duration_ms: cost.durationMs ?? undefined,
  });
  const iso = (ms) => new Date(ms).toISOString();
  const mc = state.modelCooldowns && state.modelCooldowns[key];
  let summary = `balancer: ${provider} ${outcome}`;
  if (provider === 'free') {
    const cd = (outcome === 'limit' || outcome === 'model_gone') && mc ? `; cooldown until ${iso(mc.until)}` : '';
    summary = `balancer: free ${key} ${outcome}${cd}`;
  } else if (provider === 'paygo') {
    summary = `balancer: paygo ${outcome} (not counted against the subscription)`;
  } else if (outcome === 'model_gone') {
    summary = `balancer: ${provider} model_gone ${key}; cooldown until ${iso(mc.until)}`;
  } else if (outcome === 'limit') {
    summary = `balancer: ${provider} limit; cooldown until ${iso(state.providers[provider].cooldownUntil)}`;
  }
  return { summary, outcome, key };
}

const recordRun = (ctx, o) => recordRunDetailed(ctx, o).summary;

// A headless claude run reports the same rate-limit windows the statusline shows. Use them to keep
// the Claude usage file fresh when no interactive session is refreshing it. The event comes early in
// the run, so it is stamped with the run's start and never replaces newer statusline data.
function harvestClaudeUsage(ctx, logFile) {
  const cost = parseRunLog(readText(logFile));
  if (!cost.limits) return false;
  const ts = ctx.now() - (cost.durationMs || 0);
  const cur = readJson(ctx.paths.claude);
  if (cur && typeof cur.ts === 'number' && cur.ts >= ts) return false;
  writeJsonAtomic(ctx.paths.claude, { ts, rate_limits: cost.limits, source: 'run-log' });
  return true;
}

// The relay knows the process only after launching it: tie the in-flight entry to that pid, so it
// lasts exactly as long as the run.
function attachRun(ctx, { provider, agent, pid }) {
  if (provider !== 'opencode' && provider !== 'claude') return;
  mutate(ctx, (st) => { R.attachInflightPid(st, provider, logicalAgent(agent, ctx.cfg), pid); });
}

// The orchestrator's judgement of a finished run, for acceptance rates in `balancer stats`.
function recordVerdict(ctx, { provider, agent, model, verdict }) {
  logEvent(ctx, { event: 'verdict', provider, agent: logicalAgent(agent, ctx.cfg), model: model || undefined, verdict });
}

// A picked run that never started or was cancelled: give back its probe and in-flight slot
// without counting a failure.
function releaseRun(ctx, { provider, agent, model }) {
  const now = ctx.now();
  const logical = logicalAgent(agent || '', ctx.cfg);
  mutate(ctx, (st) => {
    const key = provider === 'free' ? model : breakerKey(logical, ctx.cfg);
    if (st.breakers && st.breakers[key]) { st.breakers[key].probing = false; delete st.breakers[key].probeStartedAt; }
    if (provider === 'opencode' || provider === 'claude') {
      R.recordFailure(st, provider);
      R.takeInflight(st, provider, logical, ctx.cfg, now);
    }
  });
}

// Run a canary per model sequentially and record {ok, ts, detail} in state.canary. The state is
// re-read under the lock for every result, so a long canary run never overwrites newer state.
function runCanaries(ctx, models, { timeoutSeconds } = {}) {
  const secs = timeoutSeconds || ctx.cfg.free_lane.canary_timeout_seconds;
  const results = [];
  for (const model of models) {
    const r = runCanary({ model, exec: ctx.exec, bin: ctx.opencodeBin, timeoutSeconds: secs });
    mutate(ctx, (state) => {
      state.canary = state.canary || {};
      state.canary[model] = { ok: r.ok, ts: ctx.now(), detail: r.detail };
    });
    results.push({ model, ...r });
  }
  return results;
}

module.exports = {
  loadCatalogs, runCanaries, recordRun, recordRunDetailed, releaseRun, harvestClaudeUsage, attachRun, recordVerdict, makeCtx, loadState, saveState, saveCaches, mutate,
  gather, scoresFor, pick, waitReset,
};
