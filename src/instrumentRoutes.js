// CP16 Pillar 0 Phase A per PLAN-CP16-PILLAR-0-AMENDMENT + parch ratify #10691.
//
// POST /api/v1/instrument/user-prompt — accepts UserPromptSubmit metadata
// from emit-hook-event.sh (per-agent CC hook) and emits a Prometheus textfile
// at $YAKLOG_TEXTFILE_DIR/user-prompts.prom. node_exporter (added in same
// cycle via ssw-devops Gate 2) scrapes the textfile dir; Prom scrapes
// node_exporter.
//
// Per parch #10691 Q1 ratify: metadata-only. Canonical metadata set:
//   - timestamp (unix) — captured by Prom scrape, NOT a label
//   - agent_id (label)
//   - session_id (label; bounded cardinality per cluster lifetime)
//   - prompt_char_length (counter sum)
//   - has_tool_calls (label; boolean)
//
// Per parch #10691 Q2: ts_unix NOT in labels (Prom scrape timestamp is canonical).
//
// Per secops #10690: drop the first-200-chars lean. Prompts contain credential
// fragments + PII + business-confidential framing. Metadata-only is the
// substrate-defense canon-coherent shape.

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const TEXTFILE_DIR = process.env.YAKLOG_TEXTFILE_DIR || '/var/lib/yaklog/textfile';
const USER_PROMPTS_PATH = path.join(TEXTFILE_DIR, 'user-prompts.prom');

// In-process counter map. Key = "agent_id|session_id|has_tool_calls".
// Cardinality bounded by (active agents × sessions-per-agent-lifetime × 2);
// session_id grows over cluster lifetime but is bounded (~1000s over years).
const counters = new Map();

function counterKey(agentId, sessionId, hasToolCalls) {
  return `${agentId}|${sessionId || ''}|${hasToolCalls ? 'true' : 'false'}`;
}

function bumpCounter(agentId, sessionId, hasToolCalls, charLength) {
  const key = counterKey(agentId, sessionId, hasToolCalls);
  const e = counters.get(key) || { count: 0, char_sum: 0 };
  e.count += 1;
  e.char_sum += charLength;
  counters.set(key, e);
}

function escapeLabel(v) {
  // Prom label value escape: backslash + double-quote + newline
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function renderTextfile() {
  let body = '';
  body += '# HELP plexus_user_prompt_total Cumulative UserPromptSubmit events per agent.\n';
  body += '# TYPE plexus_user_prompt_total counter\n';
  for (const [key, e] of counters) {
    const [agent_id, session_id, has_tool_calls] = key.split('|');
    body += `plexus_user_prompt_total{agent_id="${escapeLabel(agent_id)}",session_id="${escapeLabel(session_id)}",has_tool_calls="${has_tool_calls}"} ${e.count}\n`;
  }
  body += '# HELP plexus_user_prompt_char_length_sum Cumulative prompt char-length per agent.\n';
  body += '# TYPE plexus_user_prompt_char_length_sum counter\n';
  for (const [key, e] of counters) {
    const [agent_id, session_id, has_tool_calls] = key.split('|');
    body += `plexus_user_prompt_char_length_sum{agent_id="${escapeLabel(agent_id)}",session_id="${escapeLabel(session_id)}",has_tool_calls="${has_tool_calls}"} ${e.char_sum}\n`;
  }
  return body;
}

function writeTextfileAtomic() {
  // Atomic write per Prom textfile canon: write .tmp then rename.
  // node_exporter must never read a half-written file.
  const tmp = USER_PROMPTS_PATH + '.tmp';
  try {
    fs.mkdirSync(TEXTFILE_DIR, { recursive: true });
    fs.writeFileSync(tmp, renderTextfile(), { mode: 0o644 });
    fs.renameSync(tmp, USER_PROMPTS_PATH);
    return true;
  } catch (err) {
    // Don't propagate textfile write failures to the endpoint response —
    // metric emission is best-effort; substrate-honest log + continue.
    console.error('instrumentRoutes: textfile write failed:', err.message);
    return false;
  }
}

// POST /user-prompt — body shape per Q1 ratify:
//   { agent_id: string, session_id?: string, prompt_char_length: number, has_tool_calls?: boolean }
router.post('/user-prompt', (req, res) => {
  const { agent_id, session_id, prompt_char_length, has_tool_calls } = req.body || {};
  if (!agent_id || typeof agent_id !== 'string') {
    return res.status(400).json({ error: 'BadRequest', message: 'agent_id (string) required' });
  }
  if (typeof prompt_char_length !== 'number' || prompt_char_length < 0) {
    return res.status(400).json({ error: 'BadRequest', message: 'prompt_char_length (non-negative number) required' });
  }
  bumpCounter(agent_id, session_id, !!has_tool_calls, prompt_char_length);
  writeTextfileAtomic();
  return res.status(201).json({ ok: true });
});

// Test helpers — reset in-process state between test cases.
router.__resetForTest = () => { counters.clear(); };
router.__renderTextfile = renderTextfile;
router.__counterCount = () => counters.size;

module.exports = router;
