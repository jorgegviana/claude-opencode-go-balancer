'use strict';
// Append-only decision log (JSONL, 0600): one line per pick and per recorded outcome. It exists so
// the routing can be measured (`balancer stats`). Logging never throws and never holds secrets.
const fs = require('fs');
const path = require('path');

function logEvent(ctx, event) {
  const l = ctx.cfg.log;
  if (!l || !l.enabled || !ctx.paths.log) return;
  try {
    const file = ctx.paths.log;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > l.max_bytes) fs.renameSync(file, file + '.1');
    } catch { /* no log yet */ }
    fs.appendFileSync(file, JSON.stringify({ ts: ctx.now(), ...event }) + '\n', { mode: 0o600 });
  } catch { /* best effort */ }
}

function readLog(file) {
  const out = [];
  for (const f of [file + '.1', file]) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return out;
}

// Per provider and per agent+provider outcome counts.
function summarize(events) {
  const providers = {};
  const agents = {};
  const bump = (o, k, f) => { o[k] = o[k] || { picks: 0, success: 0, failure: 0, limit: 0, model_gone: 0 }; o[k][f] += 1; };
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    const p = e.provider || e.verdict;
    if (!p) continue;
    if (e.event === 'pick') { bump(providers, p, 'picks'); if (e.agent) bump(agents, `${e.agent} @ ${p}`, 'picks'); }
    if (e.event === 'outcome' && ['success', 'failure', 'limit', 'model_gone'].includes(e.outcome)) {
      bump(providers, p, e.outcome);
      if (e.agent) bump(agents, `${e.agent} @ ${p}`, e.outcome);
    }
  }
  return { providers, agents };
}

module.exports = { logEvent, readLog, summarize };
