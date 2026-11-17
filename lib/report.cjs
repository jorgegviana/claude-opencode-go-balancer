'use strict';
// Extract the final report, errors and tool commands from opencode JSON or claude stream-json logs.
// Format is detected per line; unknown or malformed lines are skipped.

const clip = (s, n) => String(s).replace(/\s+/g, ' ').slice(-n);

function extractReport(lines) {
  const texts = new Map();
  let lastId = null;
  let result = null;
  let assistantText = null;
  const errors = [];
  const commands = [];
  for (const l of lines) {
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'text' && e.part && e.part.text) {
      const id = e.part.messageID;
      texts.set(id, (texts.get(id) || '') + e.part.text);
      lastId = id;
    } else if (e.type === 'error') {
      errors.push(JSON.stringify(e.error ?? e).slice(0, 800));
    } else if (e.type === 'result') {
      if (e.is_error === true || String(e.subtype || '').startsWith('error')) {
        errors.push(JSON.stringify({ subtype: e.subtype, result: e.result }).slice(0, 800));
      } else if (typeof e.result === 'string' && e.result) {
        result = e.result;
      }
    } else if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
      for (const c of e.message.content) {
        if (c && c.type === 'text' && c.text) assistantText = c.text;
        if (c && c.type === 'tool_use' && c.input && typeof c.input.command === 'string') {
          commands.push(clip(c.input.command, 160));
        }
      }
    }
    const cmd = e.part && e.part.state && e.part.state.input && e.part.state.input.command;
    if (typeof cmd === 'string') commands.push(clip(cmd, 160));
  }
  const report = result ?? (lastId !== null ? texts.get(lastId) : null) ?? assistantText ?? null;
  return { report, errors, commands };
}

module.exports = { extractReport };
