#!/usr/bin/env node
'use strict';
// Claude Code statusLine command: records rate_limits for the balancer and prints a short line.
//   claude-usage-statusline.cjs [--chain <cmd> [args...]]
const { spawnSync } = require('child_process');
const { paths, writeJsonAtomic } = require('../lib/state.cjs');

const WINDOWS = ['five_hour', 'seven_day'];

function readStdin() {
  try { return require('fs').readFileSync(0, 'utf8'); } catch { return ''; }
}

function ourText(rl) {
  const parts = [];
  if (rl.five_hour) parts.push(`5h ${Math.round(rl.five_hour.used_percentage)}%`);
  if (rl.seven_day) parts.push(`7d ${Math.round(rl.seven_day.used_percentage)}%`);
  return parts.length ? `claude ${parts.join(' ')}` : 'claude usage n/a';
}

function pick(input) {
  const rl = {};
  const src = input && input.rate_limits;
  if (src && typeof src === 'object') {
    for (const w of WINDOWS) {
      const e = src[w];
      if (e && typeof e.used_percentage === 'number') {
        rl[w] = { used_percentage: e.used_percentage, resets_at: e.resets_at };
      }
    }
  }
  return rl;
}

function main(argv, env) {
  const raw = readStdin();
  let text = null;
  try {
    const input = JSON.parse(raw);
    const rl = pick(input);
    writeJsonAtomic(paths(env).claude, { ts: env.BALANCER_NOW ? Number(env.BALANCER_NOW) : Date.now(), rate_limits: rl });
    text = ourText(rl);
  } catch {
    text = null;
  }
  let chained = '';
  const ci = argv.indexOf('--chain');
  if (ci >= 0 && argv[ci + 1]) {
    const r = spawnSync(argv[ci + 1], argv.slice(ci + 2), { input: raw, encoding: 'utf8', timeout: 2000 });
    if (!r.error && r.status === 0) chained = String(r.stdout || '').replace(/\n+$/, '');
  }
  const out = [chained, text].filter(Boolean).join(' | ');
  if (out) process.stdout.write(out + '\n');
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2), process.env); } catch { process.exitCode = 0; }
}

module.exports = { main };
