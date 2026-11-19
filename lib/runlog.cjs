'use strict';
// What a finished run's own log says about its cost: tokens, dollars, duration, and (claude only)
// the rate-limit windows the API reported during the run. Pure; unknown lines are skipped.

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function parseRunLog(text) {
  let tokens = 0;
  let costUsd = 0;
  let durationMs = null;
  let limits = null;
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'step_finish' && e.part && e.part.tokens) {
      // opencode: one per model step. Cache reads are excluded: they are not new work.
      const t = e.part.tokens;
      tokens += n(t.input) + n(t.output) + n(t.reasoning);
      costUsd += n(e.part.cost);
    } else if (e.type === 'result' && e.usage) {
      // claude: totals for the whole run.
      tokens += n(e.usage.input_tokens) + n(e.usage.cache_creation_input_tokens) + n(e.usage.output_tokens);
      costUsd += n(e.total_cost_usd);
      if (typeof e.duration_ms === 'number') durationMs = e.duration_ms;
    } else if (e.type === 'rate_limit_event' && e.rate_limit_info && e.rate_limit_info.unifiedWindows) {
      const out = {};
      for (const name of ['five_hour', 'seven_day']) {
        const w = e.rate_limit_info.unifiedWindows[name];
        if (w && typeof w.utilization === 'number' && typeof w.resetsAt === 'number') {
          out[name] = { used_percentage: Math.round(w.utilization * 1000) / 10, resets_at: w.resetsAt };
        }
      }
      if (Object.keys(out).length) limits = out;
    }
  }
  return { tokens, costUsd, durationMs, limits };
}

module.exports = { parseRunLog };
