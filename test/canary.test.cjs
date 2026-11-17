'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCanary } = require('../lib/canary.cjs');

const M = 'opencode/glm-5.3-flash-free';

function mk(write, res = { status: 0, stdout: '', stderr: '', timedOut: false }) {
  const seen = {};
  const exec = (bin, args, o) => {
    Object.assign(seen, { bin, args, o });
    if (write !== null) fs.writeFileSync(path.join(o.cwd, 'hello.txt'), write);
    return res;
  };
  return { exec, seen };
}

test('runCanary: fresh empty dir outside the repo, minimal args, removed afterwards', () => {
  const m = mk('ok\n');
  const r = runCanary({ model: M, exec: m.exec, bin: 'oc', timeoutSeconds: 30 });
  assert.strictEqual(r.ok, true);
  const { args, o } = m.seen;
  assert.ok(o.cwd.startsWith(fs.realpathSync(os.tmpdir())) || o.cwd.startsWith(os.tmpdir()));
  assert.ok(!path.resolve(o.cwd).startsWith(path.resolve(__dirname, '..')), 'not inside the repo');
  assert.strictEqual(args[0], 'run');
  assert.strictEqual(args[args.indexOf('--model') + 1], M);
  assert.strictEqual(args[args.indexOf('--dir') + 1], o.cwd);
  assert.strictEqual(args[args.indexOf('--format') + 1], 'json');
  assert.ok(!args.includes('-f') && !args.includes('--agent'));
  assert.strictEqual(o.env.TMPDIR, o.cwd);
  assert.strictEqual(o.timeoutMs, 30000);
  assert.ok(!fs.existsSync(o.cwd), 'temp dir removed');
});

test('runCanary: pass/fail matrix, dir always removed', () => {
  for (const [write, res, ok, re] of [
    ['ok', undefined, true, /./],
    ['nope', undefined, false, /wrong content/],
    [null, undefined, false, /hello\.txt/],
    [null, { status: null, stdout: '', stderr: '', timedOut: true }, false, /timeout/],
    ['okay', undefined, false, /wrong content/],
  ]) {
    const m = mk(write, res);
    const r = runCanary({ model: M, exec: m.exec, bin: 'oc', timeoutSeconds: 5 });
    assert.strictEqual(r.ok, ok, String(write));
    assert.match(r.detail, re);
    assert.ok(!fs.existsSync(m.seen.o.cwd));
  }
});

test('runCanary: throwing exec fails and cleans up', () => {
  let cwd;
  const exec = (b, a, o) => { cwd = o.cwd; throw new Error('boom'); };
  const r = runCanary({ model: M, exec, bin: 'oc', timeoutSeconds: 5 });
  assert.strictEqual(r.ok, false);
  assert.ok(!fs.existsSync(cwd));
});

test('canary failure detail surfaces an upstream 429', () => {
  const { runCanary } = require('../lib/canary.cjs');
  const exec = () => ({ status: 1, stdout: '{"type":"error","error":{"data":{"message":"model is temporarily rate-limited upstream. see https://x.y/z","statusCode":429}}}', stderr: '' });
  const r = runCanary({ model: 'a/b', exec, bin: 'x', timeoutSeconds: 5 });
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /upstream HTTP 429 - model is temporarily rate-limited upstream/);
  assert.ok(!/https?:/.test(r.detail));
});
