'use strict';
// Free-model canary: a tiny file-creation task in a fresh empty temp dir (no project data, no
// attached files, no agent). Passes only when hello.txt contains exactly "ok".
const fs = require('fs');
const os = require('os');
const path = require('path');

const TASK = 'Create a file named hello.txt in the current directory containing exactly ok using your file tools. Do not run shell commands. Then print DONE.';

// Surfaces an upstream API error (e.g. a 429 from a shared free pool) instead of a bare "no file".
function apiError(r) {
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const code = /"statusCode"\s*:\s*(\d{3})/.exec(out);
  const msg = /"message"\s*:\s*"([^"]{1,120})/.exec(out);
  if (!code && !msg) return '';
  const clean = (msg ? msg[1] : '').replace(/https?:\/\/\S*/g, '').replace(/\/\S*/g, '<path>').trim();
  return `: upstream ${code ? 'HTTP ' + code[1] : 'error'}${clean ? ' - ' + clean.slice(0, 80) : ''}`;
}

function runCanary({ model, exec, bin, timeoutSeconds, env = process.env }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balancer-canary-'));
  const t0 = Date.now();
  const done = (ok, detail) => ({ ok, detail, seconds: Math.round((Date.now() - t0) / 100) / 10 });
  try {
    const r = exec(bin, ['run', TASK, '--model', model, '--dir', dir, '--format', 'json'], {
      cwd: dir, env: { ...env, TMPDIR: dir }, timeoutMs: timeoutSeconds * 1000,
    });
    let text = null;
    try { text = fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8'); } catch { text = null; }
    if (text === null) return done(false, r.timedOut ? `timeout after ${timeoutSeconds}s` : `no hello.txt created (exit ${r.status})${apiError(r)}`);
    if (text.replace(/\n$/, '') !== 'ok') return done(false, 'hello.txt has wrong content');
    return done(true, 'hello.txt ok');
  } catch (e) {
    return done(false, 'exec failed: ' + String(e && e.message).replace(/\/\S*/g, '<path>').slice(0, 80));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runCanary, TASK };
