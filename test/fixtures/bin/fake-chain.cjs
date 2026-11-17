'use strict';
// Echoes the first 5 chars of stdin JSON field "tag", for statusline --chain tests.
let d = '';
process.stdin.on('data', (c) => (d += c));
process.stdin.on('end', () => {
  if (process.env.FAKE_CHAIN_FAIL) process.exit(3);
  let tag = '?';
  try { tag = JSON.parse(d).tag; } catch { /* ignore */ }
  console.log('chain:' + tag);
});
