'use strict';
// Shared by fake-opencode / fake-claude: dump argv, optionally sleep, print fixture log lines.
const fs = require('fs');

module.exports = function run(defaultLines) {
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
