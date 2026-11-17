'use strict';
// Reactive signals over a plain state object: cooldowns, single probe, per-model circuit breaker,
// limit-error detection. All time is injected (ms). Nothing here does I/O.

const rc = (cfg) => cfg.reactive;

// ---- detection ----

function parseHints(text, now) {
  const hints = {};
  const ra = /retry[-_ ]after\W+(\d+)/i.exec(text);
  if (ra) hints.retryAfterMs = Number(ra[1]) * 1000;
  const rs = /resets?_?at\W+(\d{4}-\d\d-\d\dT[\d:.]+Z?|\d{9,13})/i.exec(text);
  if (rs) {
    const v = /^\d+$/.test(rs[1]) ? (Number(rs[1]) < 1e12 ? Number(rs[1]) * 1000 : Number(rs[1])) : Date.parse(rs[1]);
    if (Number.isFinite(v) && v > now) hints.resetsAt = v;
  }
  return hints;
}

// Only error-shaped events and raw (non-JSON) lines are inspected, so a successful report that
// merely mentions "rate limit" is not a false positive. Returns null (clean), {limit:false},
// {limit:false, modelGone:true} (model retired or missing) or {limit:true,...hints}.
function detectLimitError(text, cfg, now) {
  const patterns = rc(cfg).limit_patterns.map((s) => new RegExp(s, 'i'));
  const errs = [];
  const raws = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { e = undefined; }
    if (!e || typeof e !== 'object') { raws.push(line); continue; }
    const isErr = e.type === 'error'
      || (e.type === 'result' && (e.is_error === true || String(e.subtype || '').startsWith('error')));
    if (isErr) errs.push(line);
  }
  const hay = [...errs, ...raws].join('\n');
  const gone = (rc(cfg).model_gone_patterns || []).map((x) => new RegExp(x, 'i'));
  if (gone.some((re) => re.test(hay))) return { limit: false, modelGone: true };
  if (patterns.some((re) => re.test(hay))) return { limit: true, ...parseHints(hay, now) };
  return errs.length ? { limit: false } : null;
}

// ---- provider cooldown + single probe ----

function entry(state, provider) {
  return state.providers && state.providers[provider];
}

function recordLimit(state, provider, hint, cfg, now) {
  state.providers = state.providers || {};
  const e = state.providers[provider] || {};
  e.hits = (e.hits || 0) + 1;
  const r = rc(cfg);
  const backoff = Math.min(r.backoff_initial_seconds * 2 ** (e.hits - 1), r.backoff_max_seconds) * 1000;
  let until = now + backoff;
  const h = hint || {};
  const hinted = h.resetsAt ?? (h.retryAfterMs != null ? now + h.retryAfterMs : null);
  if (hinted != null && hinted > now) until = Math.min(hinted, now + r.hint_max_seconds * 1000);
  e.cooldownUntil = until;
  e.probeInFlight = false;
  delete e.probeStartedAt;
  state.providers[provider] = e;
  return until;
}

// Per-model cooldown (state.modelCooldowns[key]). model_gone uses the fixed long cooldown; limit uses
// the same backoff/hint math as recordLimit on this model's own hit counter.
function recordModelCooldown(state, key, { reason, hint }, cfg, now) {
  state.modelCooldowns = state.modelCooldowns || {};
  const e = state.modelCooldowns[key] || { hits: 0 };
  e.hits = (e.hits || 0) + 1;
  const r = rc(cfg);
  let until;
  if (reason === 'model_gone') {
    until = now + r.model_gone_cooldown_seconds * 1000;
  } else {
    until = now + Math.min(r.backoff_initial_seconds * 2 ** (e.hits - 1), r.backoff_max_seconds) * 1000;
    const h = hint || {};
    const hinted = h.resetsAt ?? (h.retryAfterMs != null ? now + h.retryAfterMs : null);
    if (hinted != null && hinted > now) until = Math.min(hinted, now + r.hint_max_seconds * 1000);
  }
  e.until = until;
  e.reason = reason;
  state.modelCooldowns[key] = e;
  return until;
}

function recordSuccess(state, provider) {
  if (state.providers) delete state.providers[provider];
}

function recordFailure(state, provider) {
  const e = entry(state, provider);
  if (e) { e.probeInFlight = false; delete e.probeStartedAt; }
}

// Non-mutating: would a launch be allowed right now?
function peekProvider(state, provider, cfg, now) {
  const e = entry(state, provider);
  if (!e || e.cooldownUntil == null) return { available: true };
  if (now < e.cooldownUntil) return { available: false, until: e.cooldownUntil };
  if (e.probeInFlight) {
    const until = e.probeStartedAt + rc(cfg).probe_timeout_minutes * 60000;
    if (now < until) return { available: false, until };
  }
  return { available: true };
}

// Mutating: after a cooldown expires, the first caller gets the single probe.
function isProviderAvailable(state, provider, cfg, now) {
  const p = peekProvider(state, provider, cfg, now);
  if (!p.available) return p;
  const e = entry(state, provider);
  if (e && e.cooldownUntil != null) {
    e.probeInFlight = true;
    e.probeStartedAt = now;
    return { available: true, probe: true };
  }
  return p;
}

// ---- circuit breaker (per opencode model) ----

function breakerPeek(state, key, cfg, now) {
  const b = state.breakers && state.breakers[key];
  const r = rc(cfg);
  if (!b || (b.failures || 0) < r.breaker_failures) return { allowed: true };
  if (now < b.openUntil) return { allowed: false, until: b.openUntil };
  if (b.probing) {
    const until = b.probeStartedAt + r.probe_timeout_minutes * 60000;
    if (now < until) return { allowed: false, until };
  }
  return { allowed: true, halfOpen: true };
}

function breakerAllow(state, key, cfg, now) {
  const p = breakerPeek(state, key, cfg, now);
  if (p.allowed && p.halfOpen) {
    const b = state.breakers[key];
    b.probing = true;
    b.probeStartedAt = now;
  }
  return p;
}

function recordBreaker(state, key, ok, cfg, now) {
  state.breakers = state.breakers || {};
  if (ok) { delete state.breakers[key]; return; }
  const b = state.breakers[key] || { failures: 0 };
  b.failures += 1;
  b.probing = false;
  delete b.probeStartedAt;
  if (b.failures >= rc(cfg).breaker_failures) b.openUntil = now + rc(cfg).breaker_open_seconds * 1000;
  state.breakers[key] = b;
}

// ---- combined ----

function recordOutcome(state, { provider, key, outcome, hint }, cfg, now) {
  if (provider === 'free') {
    // The free lane is tracked per model only; it never touches state.providers.
    if (!key) return;
    if (outcome === 'success') {
      if (state.modelCooldowns) delete state.modelCooldowns[key];
      recordBreaker(state, key, true, cfg, now);
    } else if (outcome === 'limit' || outcome === 'model_gone') {
      recordModelCooldown(state, key, { reason: outcome, hint }, cfg, now);
    } else {
      recordBreaker(state, key, false, cfg, now);
    }
    return;
  }
  if (outcome === 'model_gone') {
    // Not a quota problem: cool only this model and release a held provider probe.
    if (key) recordModelCooldown(state, key, { reason: 'model_gone' }, cfg, now);
    recordFailure(state, provider);
    return;
  }
  if (outcome === 'success') {
    recordSuccess(state, provider);
    if (provider === 'opencode' && key) recordBreaker(state, key, true, cfg, now);
  } else if (outcome === 'limit') {
    recordLimit(state, provider, hint, cfg, now);
    if (state.breakers && state.breakers[key]) { state.breakers[key].probing = false; }
  } else {
    recordFailure(state, provider);
    if (provider === 'opencode' && key) recordBreaker(state, key, false, cfg, now);
  }
}

// Fold cooldown/probe/breaker state into per-provider scores.
function applyReactive(scores, state, { key, cfg, now }) {
  const out = {};
  for (const p of ['opencode', 'claude']) {
    let s = scores[p];
    let until = null;
    const pv = peekProvider(state, p, cfg, now);
    if (!pv.available) until = pv.until;
    if (p === 'opencode' && key) {
      const b = breakerPeek(state, key, cfg, now);
      if (!b.allowed) until = Math.max(until ?? 0, b.until);
      const mc = state.modelCooldowns && state.modelCooldowns[key];
      if (mc && mc.until > now) until = Math.max(until ?? 0, mc.until);
    }
    if (until != null) {
      s = { status: 'ineligible', headroom: null, eligibleAt: Math.max(s.eligibleAt ?? 0, until) };
    }
    out[p] = s;
  }
  return out;
}

module.exports = {
  detectLimitError, recordLimit, recordModelCooldown, recordSuccess, recordFailure, peekProvider, isProviderAvailable,
  breakerPeek, breakerAllow, recordBreaker, recordOutcome, applyReactive,
};
