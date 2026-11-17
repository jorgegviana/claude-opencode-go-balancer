'use strict';
// Pure free-lane selection. No I/O; time is injected (ms).
const { breakerPeek } = require('./reactive.cjs');

const PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DAY = 86400000;

// 'provider/id' or a bare id (gets the opencode/ prefix). Null when invalid, so a model string can
// never become a CLI flag or a path escape.
function normalizeModel(m) {
  if (typeof m !== 'string') return null;
  const parts = m.includes('/') ? m.split('/') : ['opencode', m];
  if (parts.length !== 2) return null;
  if (!parts.every((p) => PART.test(p) && !p.includes('..'))) return null;
  return parts.join('/');
}

function freeAgentAllowed(logical, cfg) {
  const f = cfg.free_lane;
  if (!f || !f.enabled || !Array.isArray(f.agents) || !f.agents.includes(logical)) return false;
  return !(cfg.lanes.pinned_to_claude || []).includes(logical);
}

// Fail open: an absent or unreadable catalog never excludes a model.
function catalogHas(catalogs, model) {
  const c = catalogs && catalogs[String(model).split('/')[0]];
  if (!c) return true;
  return Object.prototype.hasOwnProperty.call(c, model);
}

function freeModelStatus(model, { cfg, state, catalogs, now }) {
  const c = state.canary && state.canary[model];
  if (!c) return { ready: false, why: 'no canary' };
  if (!c.ok) return { ready: false, why: 'canary failed' };
  if (now - c.ts > cfg.free_lane.canary_ttl_days * DAY) return { ready: false, why: 'canary expired' };
  const cd = state.modelCooldowns && state.modelCooldowns[model];
  if (cd && cd.until > now) return { ready: false, why: 'cooldown', until: cd.until };
  const b = breakerPeek(state, model, cfg, now);
  if (!b.allowed) return { ready: false, why: 'breaker open', until: b.until };
  if (!catalogHas(catalogs, model)) return { ready: false, why: 'missing from catalog' };
  return { ready: true, why: 'ready' };
}

function pickFreeModel({ logical, cfg, state, catalogs, now }) {
  if (!freeAgentAllowed(logical, cfg)) return { model: null, reason: 'free lane not enabled for this agent' };
  const why = [];
  for (const raw of cfg.free_lane.models || []) {
    const model = normalizeModel(raw);
    if (!model) continue;
    const s = freeModelStatus(model, { cfg, state, catalogs, now });
    if (s.ready) return { model, reason: `free lane: ${model} canary ok` };
    why.push(`${model} ${s.why}`);
  }
  return { model: null, reason: `free lane skipped (${why.join('; ') || 'no models configured'})` };
}

module.exports = { normalizeModel, freeAgentAllowed, freeModelStatus, pickFreeModel, catalogHas };
