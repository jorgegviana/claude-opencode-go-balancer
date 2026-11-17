'use strict';
// Model catalog from `opencode models <provider> --verbose`, cached per provider in state.catalog.
// Everything fails open: an unreadable catalog never excludes a model.
const { catalogHas } = require('./free.cjs');

// Output is, per model, a header line `<provider>/<id>` followed by a pretty-printed JSON object.
// Returns {'provider/id': {free, status, toolcall}} or null when nothing parses.
function parseCatalog(text, provider) {
  const esc = provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(${esc}\\/\\S+)$`, 'gm');
  const heads = [];
  let m;
  const src = String(text || '');
  while ((m = re.exec(src))) heads.push({ id: m[1], start: m.index + m[0].length, at: m.index });
  if (!heads.length) return null;
  const out = {};
  for (let i = 0; i < heads.length; i++) {
    const body = src.slice(heads[i].start, i + 1 < heads.length ? heads[i + 1].at : src.length);
    let j;
    try { j = JSON.parse(body); } catch { return null; }
    if (!j || typeof j !== 'object') return null;
    const cost = j.cost || {};
    out[heads[i].id] = {
      free: cost.input === 0 && cost.output === 0,
      status: j.status || null,
      toolcall: !!(j.capabilities && j.capabilities.toolcall),
    };
  }
  return out;
}

const clip = (s) => String(s || '').replace(/\/\S*/g, '<path>').replace(/\s+/g, ' ').trim().slice(0, 120);

// Returns the models map, or null (unknown). Reads/updates state.catalog[provider].
function getCatalog({ exec, bin, cfg, state, provider, now, refresh = false }) {
  state.catalog = state.catalog || {};
  const c = state.catalog[provider];
  if (!refresh && c && now - c.ts < cfg.catalog.ttl_seconds * 1000) return c.ok ? c.models : null;
  let entry;
  try {
    const r = exec(bin, ['models', provider, '--verbose'], { timeoutMs: cfg.catalog.timeout_seconds * 1000 });
    const models = r.status === 0 && !r.timedOut ? parseCatalog(r.stdout, provider) : null;
    entry = models ? { ts: now, ok: true, models }
      : { ts: now, ok: false, error: r.timedOut ? 'timeout' : clip(r.stderr) || `unreadable (exit ${r.status})` };
  } catch (e) {
    entry = { ts: now, ok: false, error: clip(e && e.message) || 'exec failed' };
  }
  state.catalog[provider] = entry;
  return entry.ok ? entry.models : null;
}

const catalogsFor = (models) => [...new Set((models || [])
  .map((m) => (typeof m === 'string' && /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9~][\w.:~\/-]*$/.test(m) ? m.split('/')[0] : null))
  .filter(Boolean))];

// Cache-only view (no exec): provider -> models map or null.
function cachedCatalogs(state) {
  const out = {};
  for (const [p, c] of Object.entries(state.catalog || {})) out[p] = c && c.ok ? c.models : null;
  return out;
}

module.exports = { parseCatalog, getCatalog, catalogsFor, catalogHas, cachedCatalogs };
