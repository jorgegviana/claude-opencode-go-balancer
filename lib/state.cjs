'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function expandHome(p) {
  if (typeof p === 'string' && (p === '~' || p.startsWith('~/'))) return path.join(os.homedir(), p.slice(1));
  return p;
}

// Returns the parsed JSON object, or null when missing, unreadable or malformed.
function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

// Atomic: write <file>.<pid>.tmp in the same directory, then rename over the target.
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Cross-process mutex around read-modify-write of a state file: <file>.lock created with O_EXCL.
// It never blocks the caller for long: a lock older than staleMs is taken over, and after waitMs
// the function runs unlocked (last-writer-wins, the pre-lock behaviour) rather than failing.
function withLock(file, fn, { waitMs = 5000, staleMs = 15000 } = {}) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + waitMs;
  let held = false;
  for (;;) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.closeSync(fs.openSync(lock, 'wx', 0o600));
      held = true;
      break;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') break;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) { fs.unlinkSync(lock); continue; }
      } catch { continue; }
      if (Date.now() >= deadline) break;
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    if (held) { try { fs.unlinkSync(lock); } catch { /* ignore */ } }
  }
}

function paths(env = process.env) {
  const home = os.homedir();
  const state = expandHome(env.BALANCER_STATE || path.join(home, '.claude', 'balancer-state.json'));
  return {
    log: expandHome(env.BALANCER_LOG || path.join(path.dirname(state), 'balancer-log.jsonl')),
    state,
    claude: expandHome(env.BALANCER_CLAUDE_STATE || path.join(home, '.claude', 'usage-state.json')),
    auth: expandHome(env.BALANCER_OPENCODE_AUTH || path.join(home, '.local', 'share', 'opencode', 'auth.json')),
    usageFile: env.BALANCER_OPENCODE_USAGE_FILE ? expandHome(env.BALANCER_OPENCODE_USAGE_FILE) : null,
  };
}

module.exports = { expandHome, readJson, writeJsonAtomic, withLock, paths };
