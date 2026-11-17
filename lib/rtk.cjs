'use strict';
// Optional: show RTK token savings next to usage. Never throws; absent rtk -> null.
const { execFileSync } = require('node:child_process');

function formatRtkGain(data) {
  const s = data && data.summary;
  if (!s || !(s.total_commands > 0) || typeof s.total_saved !== 'number') return null;
  return `rtk: saved ${s.total_saved} tokens (${Number(s.avg_savings_pct).toFixed(1)}%) across ${s.total_commands} commands`;
}

function defaultExec() {
  return execFileSync(process.env.BALANCER_RTK_BIN || 'rtk', ['gain', '-f', 'json'],
    { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
}

function readRtkGain(exec = defaultExec) {
  try { return formatRtkGain(JSON.parse(exec())); } catch { return null; }
}

module.exports = { formatRtkGain, readRtkGain };
