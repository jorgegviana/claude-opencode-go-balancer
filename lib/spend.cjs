'use strict';
// Prepaid-credit guard for paid free-lane models. Only OpenRouter exposes a balance endpoint today.
// The key is read at runtime from opencode's auth.json and is never stored or logged.
const { fetchJson, readKey, sanitize } = require('./usage.cjs');

const URLS = { openrouter: 'https://openrouter.ai/api/v1/credits' };

// Returns {allowed, why, balance}. Fails closed: unknown balance means not allowed.
async function checkSpend({ provider, guard, fetchFn, authPath, cfg, state, now }) {
  const floor = Number(guard && guard.min_balance_usd);
  if (!URLS[provider] || !Number.isFinite(floor)) return { allowed: false, why: 'no usable guard config', balance: null };
  state.spend = state.spend || {};
  const ttl = (Number(guard.cache_seconds) || 300) * 1000;
  let e = state.spend[provider];
  if (!e || !(now >= e.ts) || now - e.ts >= ttl) {
    const key = readKey(authPath, provider);
    if (!key) {
      e = { ts: now, ok: false, error: `no ${provider} key in auth file` };
    } else {
      try {
        const raw = await fetchJson(fetchFn, URLS[provider], key, cfg.fetch_timeout_ms);
        const d = raw && raw.data;
        const bal = d && Number.isFinite(d.total_credits) && Number.isFinite(d.total_usage) ? d.total_credits - d.total_usage : null;
        e = bal === null ? { ts: now, ok: false, error: 'unrecognized credits response' } : { ts: now, ok: true, balance: bal };
      } catch (err) {
        e = { ts: now, ok: false, error: 'credits fetch failed: ' + sanitize(err && err.message, key) };
      }
    }
    state.spend[provider] = e;
  }
  if (!e.ok) return { allowed: false, why: e.error, balance: null };
  const ok = e.balance >= floor;
  return { allowed: ok, why: ok ? 'ok' : `balance $${e.balance.toFixed(2)} below floor $${floor}`, balance: e.balance };
}

module.exports = { checkSpend };
