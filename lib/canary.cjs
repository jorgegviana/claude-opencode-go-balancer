'use strict';
// Free-model canary: a tiny file-creation task in a fresh empty temp dir (no project data, no
// attached files, no agent). Passes only when hello.txt contains exactly "ok".
const fs = require('fs');
const os = require('os');
const path = require('path');

const TASK = 'Create a file named hello.txt in the current directory containing exactly ok using your file tools. Do not run shell commands. Then print DONE.';

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
    if (text === null) return done(false, r.timedOut ? `timeout after ${timeoutSeconds}s` : `no hello.txt created (exit ${r.status})`);
    if (text.replace(/\n$/, '') !== 'ok') return done(false, 'hello.txt has wrong content');
    return done(true, 'hello.txt ok');
  } catch (e) {
    return done(false, 'exec failed: ' + String(e && e.message).replace(/\/\S*/g, '<path>').slice(0, 80));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runCanary, TASK };
