#!/usr/bin/env node
'use strict';
const engine = require('../lib/engine.cjs');
const { readRtkGain } = require('../lib/rtk.cjs');
const { normalizeModel, freeModelStatus } = require('../lib/free.cjs');
const { cachedCatalogs, catalogsFor } = require('../lib/catalog.cjs');

const iso = (ms) => new Date(ms).toISOString();

function fmtProvider(label, p, score, extra = '') {
  const out = [];
  const head = score.status === 'eligible' ? `eligible headroom ${score.headroom.toFixed(1)}`
    : score.status === 'ineligible' ? `ineligible until ${iso(score.eligibleAt)}` : 'unknown';
  out.push(`${label}: ${head}${extra}`);
  for (const w of p.windows) out.push(`  ${w.name} ${w.used}% resets ${iso(w.resetsAt)}`);
  return out.join('\n');
}

function age(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 120 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

function freeLines(ctx, state, now) {
  const f = ctx.cfg.free_lane;
  const lines = [f.enabled ? `free lane: enabled (agents: ${(f.agents || []).join(', ') || 'none'})` : 'free lane: disabled'];
  const catalogs = cachedCatalogs(state);
  for (const raw of f.models || []) {
    const model = normalizeModel(raw);
    if (!model) continue;
    const c = state.canary && state.canary[model];
    const parts = [c ? `canary ${c.ok ? 'PASS' : `FAIL (${c.detail || 'no detail'})`} ${age(now - c.ts)} ago` : 'no canary'];
    const st = freeModelStatus(model, { cfg: ctx.cfg, state, catalogs, now });
    const cd = state.modelCooldowns && state.modelCooldowns[model];
    if (cd && cd.until > now) parts.push(`cooldown until ${iso(cd.until)}`);
    if (st.why === 'breaker open') parts.push(`breaker open until ${iso(st.until)}`);
    if (model.split('/')[0] in catalogs && catalogs[model.split('/')[0]] && !(model in catalogs[model.split('/')[0]])) parts.push('missing from catalog');
    lines.push(`  ${model}: ${parts.join(', ')}`);
  }
  const provs = new Set([...Object.keys(state.catalog || {}), ...catalogsFor((f.models || []).map(normalizeModel))]);
  const cats = [...provs].map((p) => {
    const e = state.catalog && state.catalog[p];
    if (!e) return `${p} not loaded`;
    return e.ok ? `${p} ${age(now - e.ts)} old, ${Object.keys(e.models).length} models` : `${p} unavailable (${age(now - e.ts)} old)`;
  });
  lines.push(`catalog: ${cats.join('; ') || 'not loaded'}`);
  return lines;
}

async function cmdStatus(ctx) {
  const state = engine.loadState(ctx);
  const data = await engine.gather(ctx, state);
  const scores = engine.scoresFor(ctx, data, state);
  const now = ctx.now();
  const lines = [fmtProvider('opencode-go', data.opencode, scores.opencode, data.error ? ` (${data.error})` : '')];
  const age = data.claudeTs ? ` (data age ${Math.round((now - data.claudeTs) / 60000)}m)` : ' (no statusline data yet)';
  lines.push(fmtProvider('claude', data.claude, scores.claude, age));
  lines.push(`last pick: ${state.lastPick || 'none'}`);
  lines.push(...freeLines(ctx, state, now));
  const gain = readRtkGain();
  if (gain) lines.push(gain);
  try { engine.saveState(ctx, state); } catch { /* status is read-only in spirit */ }
  console.log(lines.join('\n'));
}

async function cmdPick(ctx, agent) {
  if (!agent) { console.error('usage: balancer pick <agent>'); return 2; }
  const d = await engine.pick(ctx, agent);
  const until = d.until ? ' ' + iso(d.until) : '';
  console.log(d.verdict === 'wait' ? `wait${until}` : d.verdict === 'free' ? `free ${d.model}` : d.verdict);
  console.error(`balancer: ${d.reason}`);
  return 0;
}

function cmdCanary(ctx, args) {
  const names = [];
  let timeoutSeconds;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--timeout') {
      timeoutSeconds = Number(args[++i]);
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) { console.error('balancer: invalid --timeout'); return 2; }
    } else {
      const m = normalizeModel(args[i]);
      if (!m) { console.error(`balancer: invalid model name: ${String(args[i]).slice(0, 60)}`); return 2; }
      names.push(m);
    }
  }
  const models = names.length ? names : (ctx.cfg.free_lane.models || []).map(normalizeModel).filter(Boolean);
  let failed = 0;
  for (const r of engine.runCanaries(ctx, models, { timeoutSeconds })) {
    if (r.ok) console.log(`canary ${r.model}: PASS`);
    else { failed++; console.log(`canary ${r.model}: FAIL (${r.detail})`); }
  }
  return failed ? 1 : 0;
}

function cmdModels(ctx, args) {
  const refresh = args.includes('--refresh');
  const state = engine.loadState(ctx);
  const cfg = ctx.cfg;
  const configured = []; // [model, where]
  for (const m of cfg.free_lane.models || []) { const n = normalizeModel(m); if (n) configured.push([n, 'free_lane.models']); }
  for (const [agent, m] of Object.entries(cfg.opencode.agent_models || {})) {
    const n = normalizeModel(m);
    if (n) configured.push([n, `opencode.agent_models.${agent}`]);
  }
  const providers = [...new Set(['opencode', ...catalogsFor(configured.map(([m]) => m))])];
  const cats = engine.loadCatalogs(ctx, state, providers, refresh);
  engine.saveState(ctx, state);
  let unavailable = 0;
  for (const p of providers) {
    if (cats[p]) console.log(`catalog ${p}: ${Object.keys(cats[p]).length} models`);
    else { unavailable++; console.log(`catalog ${p}: unavailable (${(state.catalog[p] && state.catalog[p].error) || 'unknown'})`); }
  }
  const missing = configured.filter(([m]) => cats[m.split('/')[0]] && !(m in cats[m.split('/')[0]]));
  console.log('configured but missing from catalog:' + (missing.length ? '' : ' none'));
  for (const [m, where] of missing) console.log(`  ${m} (${where})`);
  const have = new Set(configured.filter(([, w]) => w === 'free_lane.models').map(([m]) => m));
  const extra = [];
  for (const p of providers) {
    for (const [id, e] of Object.entries(cats[p] || {})) if (e.free && !have.has(id)) extra.push(id);
  }
  console.log('free, not configured:' + (extra.length ? '' : ' none'));
  for (const id of extra) console.log(`  ${id}`);
  return unavailable ? 1 : 0;
}

async function cmdWaitReset(ctx, args) {
  const i = args.indexOf('--max-seconds');
  const maxSeconds = i >= 0 ? Number(args[i + 1]) : 570;
  if (!Number.isFinite(maxSeconds)) { console.error('usage: balancer wait-reset [--max-seconds N]'); return 2; }
  const r = await engine.waitReset(ctx, { maxSeconds });
  if (r.ok) return 0;
  console.log(`balancer: still waiting until ${iso(r.until)}`);
  return 75;
}

async function main(argv, env = process.env) {
  const [cmd, ...rest] = argv;
  const ctx = engine.makeCtx(env);
  switch (cmd) {
    case 'status': await cmdStatus(ctx); return 0;
    case 'pick': return cmdPick(ctx, rest[0]);
    case 'wait-reset': return cmdWaitReset(ctx, rest);
    case 'canary': return cmdCanary(ctx, rest);
    case 'models': return cmdModels(ctx, rest);
    case 'record': {
      const [provider, agent, logFile, errFile] = rest;
      if (!['opencode', 'claude'].includes(provider) || !agent || !logFile) {
        console.error('usage: balancer record <opencode|claude> <agent> <log-file> [<err-file>]');
        return 2;
      }
      console.log(engine.recordRun(ctx, { provider, agent, logFile, errFile }));
      return 0;
    }
    default:
      console.error('usage: balancer status | pick <agent> | wait-reset [--max-seconds N] | record <provider> <agent> <log> [<err>] | canary [model...] [--timeout N] | models [--refresh]');
      return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => {
    console.error('balancer: error: ' + String(e && e.message).slice(0, 200));
    process.exit(1);
  });
}

module.exports = { main };
