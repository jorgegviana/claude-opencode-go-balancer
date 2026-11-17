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

function paths(env = process.env) {
  const home = os.homedir();
  return {
    state: expandHome(env.BALANCER_STATE || path.join(home, '.claude', 'balancer-state.json')),
    claude: expandHome(env.BALANCER_CLAUDE_STATE || path.join(home, '.claude', 'usage-state.json')),
    auth: expandHome(env.BALANCER_OPENCODE_AUTH || path.join(home, '.local', 'share', 'opencode', 'auth.json')),
    usageFile: env.BALANCER_OPENCODE_USAGE_FILE ? expandHome(env.BALANCER_OPENCODE_USAGE_FILE) : null,
  };
}

module.exports = { expandHome, readJson, writeJsonAtomic, paths };
