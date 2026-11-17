#!/usr/bin/env node
'use strict';
// Secret scanner. Prints only "file:line rule", never the matched text or any key value.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RULES = [
  { name: 'sk-token', re: /sk-\w{20,}/ }, // scan-secrets: allow
  { name: 'bearer-token', re: /Bearer\s+[A-Za-z0-9._~+/-]{20,}/ }, // scan-secrets: allow
  { name: 'assigned-secret', re: /(key|token|secret)\w*["']?\s*[:=]\s*["'][A-Za-z0-9+/_-]{32,}["']/i }, // scan-secrets: allow
  { name: 'pem-private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ }, // scan-secrets: allow
];
const ALLOW = 'scan-secrets: allow';

function listFiles(root) {
  const r = spawnSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout) {
    return r.stdout.split('\n').filter(Boolean).map((f) => path.join(root, f));
  }
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(root);
  return out;
}

function collectKeys(node, acc) {
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'key' && typeof v === 'string' && v.length >= 8) acc.push(v);
    else collectKeys(v, acc);
  }
}

function realKeys(authPath) {
  try {
    const acc = [];
    collectKeys(JSON.parse(fs.readFileSync(authPath, 'utf8')), acc);
    return acc;
  } catch {
    return [];
  }
}

function scan(root, authPath) {
  const keys = realKeys(authPath);
  const hits = [];
  for (const file of listFiles(root)) {
    let text;
    try {
      const buf = fs.readFileSync(file);
      if (buf.includes(0)) continue;
      text = buf.toString('utf8');
    } catch {
      continue;
    }
    const rel = path.relative(root, file);
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (line.includes(ALLOW)) return;
      for (const rule of RULES) if (rule.re.test(line)) hits.push(`${rel}:${i + 1} ${rule.name}`);
      for (const k of keys) if (line.includes(k)) hits.push(`${rel}:${i + 1} real-key-value`);
    });
  }
  return hits;
}

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
  const authPath = process.env.BALANCER_OPENCODE_AUTH || path.join(os.homedir(), '.local/share/opencode/auth.json');
  const hits = scan(root, authPath);
  if (hits.length) {
    process.stdout.write(hits.join('\n') + '\nscan-secrets: FOUND ' + hits.length + ' potential secret(s)\n');
    process.exit(1);
  }
  process.stdout.write('scan-secrets: clean\n');
}

module.exports = { scan };
