'use strict';
const fs = require('fs');

const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const UNKNOWN = Object.freeze({ known: false, windows: [] });

function win(name, used, resetsAt, cfg) {
  const lenMin = cfg.windows_minutes[name];
  if (typeof used !== 'number' || !Number.isFinite(used) || !Number.isFinite(resetsAt) || !lenMin) return null;
  return { name, used, resetsAt, lenMin };
}

function finish(all, now) {
  if (!all.length) return { known: false, windows: [] };
  return { known: true, windows: all.filter((w) => w.resetsAt > now) };
}

function normalizeOpencode(resp, cfg, now) {
  const u = resp && typeof resp === 'object' ? resp.usage : null;
  if (!u || typeof u !== 'object') return { ...UNKNOWN };
  const all = [];
  for (const name of ['rolling', 'weekly', 'monthly']) {
    const e = u[name];
    if (!e || typeof e !== 'object') continue;
    const w = win(name, e.percent, Date.parse(e.resetsAt), cfg);
    if (w) all.push(w);
  }
  return finish(all, now);
}

function toMs(sec) {
  if (typeof sec !== 'number') return NaN;
  return sec < 1e12 ? sec * 1000 : sec;
}

function normalizeClaude(state, cfg, now) {
  const rl = state && typeof state === 'object' ? state.rate_limits : null;
  if (!rl || typeof rl !== 'object') return { ...UNKNOWN };
  const all = [];
  for (const name of ['five_hour', 'seven_day']) {
    const e = rl[name];
    if (!e || typeof e !== 'object') continue;
    const w = win(name, e.used_percentage, toMs(e.resets_at), cfg);
    if (w) all.push(w);
  }
  const live = finish(all, now);
  const fresh = typeof state.ts === 'number' && now - state.ts <= cfg.stale_minutes * 60000;
  if (fresh) return live;
  // Stale: unknown, except future hard-stop windows still block until their reset.
  return { known: false, windows: live.windows.filter((w) => w.used >= cfg.hard_stop_percent) };
}

function readKey(authPath, provider = 'opencode-go') {
  try {
    const k = JSON.parse(fs.readFileSync(authPath, 'utf8'))[provider].key;
    return typeof k === 'string' && k ? k : null;
  } catch {
    return null;
  }
}

function sanitize(msg, key) {
  let s = String(msg);
  if (key) s = s.split(key).join('[redacted]');
  return s.replace(/Bearer\s+\S+/g, 'Bearer [redacted]').slice(0, 200);
}

async function fetchJson(fetchFn, url, key, timeoutMs) {
  const ac = new AbortController();
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => { ac.abort(); rej(new Error('timeout')); }, timeoutMs);
  });
  try {
    const res = await Promise.race([
      fetchFn(url, {
        method: 'GET',
        signal: ac.signal,
        headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'usage-balancer/1.0', Accept: 'application/json' },
      }),
      timeout,
    ]);
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'none'}`);
    return await Promise.race([res.json(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Returns {provider, error, cache}. The key lives only in a local variable used for the header.
async function getOpencodeUsage({ fetchFn, authPath, cfg, now, cache, bypassCache }) {
  if (!bypassCache && cache && cache.raw && now >= cache.ts && now - cache.ts < cfg.usage_cache_seconds * 1000) {
    return { provider: normalizeOpencode(cache.raw, cfg, now), error: null, cache };
  }
  const key = readKey(authPath);
  if (!key) return { provider: { ...UNKNOWN }, error: 'no opencode-go key in auth file', cache };
  try {
    const raw = await fetchJson(fetchFn, USAGE_URL, key, cfg.fetch_timeout_ms);
    const provider = normalizeOpencode(raw, cfg, now);
    if (!provider.known) return { provider, error: 'unrecognized usage response', cache };
    return { provider, error: null, cache: { ts: now, raw } };
  } catch (e) {
    return { provider: { ...UNKNOWN }, error: 'usage fetch failed: ' + sanitize(e && e.message, key), cache };
  }
}

module.exports = { fetchJson, readKey, sanitize, USAGE_URL, normalizeOpencode, normalizeClaude, getOpencodeUsage };
