'use strict';
// Shared by fake-opencode / fake-claude: dump argv, optionally sleep, print fixture log lines.
const fs = require('fs');
const path = require('path');

module.exports = function run(defaultLines) {
  if (process.env.FAKE_CALL_LOG) fs.appendFileSync(process.env.FAKE_CALL_LOG, process.argv.slice(2).join(' ') + '\n');
  if (process.argv[2] === 'models') {
    // Catalog fake: print FAKE_MODELS_DIR/<provider>.txt; exit 1 when unavailable. Never dumps argv.
    const f = process.env.FAKE_MODELS_DIR && path.join(process.env.FAKE_MODELS_DIR, process.argv[3] + '.txt');
    if (!f || !fs.existsSync(f)) process.exit(1);
    process.stdout.write(fs.readFileSync(f, 'utf8'));
    return;
  }
  if (process.env.FAKE_WRITE_HELLO !== undefined) {
    const mi = process.argv.indexOf('--model');
    const want = process.env.FAKE_WRITE_HELLO_MODEL;
    if (mi >= 0 && (!want || process.argv[mi + 1] === want)) fs.writeFileSync(path.join(process.cwd(), 'hello.txt'), process.env.FAKE_WRITE_HELLO);
  }
  if (process.env.FAKE_ARGV_FILE) {
    fs.writeFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify({ argv: process.argv.slice(2), tmpdir: process.env.TMPDIR || null }));
  }
  const out = () => {
    const mi = process.argv.indexOf('--model');
    if (process.env.FAKE_FAIL_MODEL && mi >= 0 && process.argv[mi + 1] === process.env.FAKE_FAIL_MODEL) {
      if (process.env.FAKE_FAIL_LOG) process.stdout.write(fs.readFileSync(process.env.FAKE_FAIL_LOG, 'utf8'));
      return;
    }
    if (process.env.FAKE_LOG_FILE) process.stdout.write(fs.readFileSync(process.env.FAKE_LOG_FILE, 'utf8'));
    else process.stdout.write(defaultLines.join('\n') + '\n');
    if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR + '\n');
  };
  const ms = Number(process.env.FAKE_SLEEP_MS || 0);
  if (ms > 0) setTimeout(out, ms); else out();
};
