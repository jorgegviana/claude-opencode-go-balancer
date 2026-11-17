#!/usr/bin/env node
'use strict';
const engine = require('../lib/engine.cjs');
const { readRtkGain } = require('../lib/rtk.cjs');

const iso = (ms) => new Date(ms).toISOString();

function fmtProvider(label, p, score, extra = '') {
  const out = [];
  const head = score.status === 'eligible' ? `eligible headroom ${score.headroom.toFixed(1)}`
    : score.status === 'ineligible' ? `ineligible until ${iso(score.eligibleAt)}` : 'unknown';
  out.push(`${label}: ${head}${extra}`);
  for (const w of p.windows) out.push(`  ${w.name} ${w.used}% resets ${iso(w.resetsAt)}`);
  return out.join('\n');
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
  const gain = readRtkGain();
  if (gain) lines.push(gain);
  try { engine.saveState(ctx, state); } catch { /* status is read-only in spirit */ }
  console.log(lines.join('\n'));
}

async function cmdPick(ctx, agent) {
  if (!agent) { console.error('usage: balancer pick <agent>'); return 2; }
  const d = await engine.pick(ctx, agent);
  const until = d.until ? ' ' + iso(d.until) : '';
  console.log(d.verdict === 'wait' ? `wait${until}` : d.verdict);
  console.error(`balancer: ${d.reason}`);
  return 0;
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
      console.error('usage: balancer status | pick <agent> | wait-reset [--max-seconds N] | record <provider> <agent> <log> [<err>]');
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
