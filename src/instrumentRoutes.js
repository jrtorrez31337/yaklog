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
const { getDb } = require('./db');

const router = express.Router();

const TEXTFILE_DIR = process.env.YAKLOG_TEXTFILE_DIR || '/var/lib/yaklog/textfile';
const USER_PROMPTS_PATH = path.join(TEXTFILE_DIR, 'user-prompts.prom');
const BROWSER_PERF_PATH = path.join(TEXTFILE_DIR, 'browser-perf.prom');

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
  body += '# HELP yaklog_user_prompt_total Cumulative UserPromptSubmit events per agent.\n';
  body += '# TYPE yaklog_user_prompt_total counter\n';
  for (const [key, e] of counters) {
    const [agent_id, session_id, has_tool_calls] = key.split('|');
    body += `yaklog_user_prompt_total{agent_id="${escapeLabel(agent_id)}",session_id="${escapeLabel(session_id)}",has_tool_calls="${has_tool_calls}"} ${e.count}\n`;
  }
  body += '# HELP yaklog_user_prompt_char_length_sum Cumulative prompt char-length per agent.\n';
  body += '# TYPE yaklog_user_prompt_char_length_sum counter\n';
  for (const [key, e] of counters) {
    const [agent_id, session_id, has_tool_calls] = key.split('|');
    body += `yaklog_user_prompt_char_length_sum{agent_id="${escapeLabel(agent_id)}",session_id="${escapeLabel(session_id)}",has_tool_calls="${has_tool_calls}"} ${e.char_sum}\n`;
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
  // Defense per secops #10703 non-blocking flag: counterKey uses | as
  // internal delimiter. Reject pipe-containing agent_id/session_id to
  // prevent key split corruption + metric line malformation.
  if (agent_id.includes('|') || (typeof session_id === 'string' && session_id.includes('|'))) {
    return res.status(400).json({ error: 'BadRequest', message: 'agent_id and session_id must not contain | character' });
  }
  bumpCounter(agent_id, session_id, !!has_tool_calls, prompt_char_length);
  writeTextfileAtomic();
  return res.status(201).json({ ok: true });
});

// ──────────────────────────────────────────────────────────────────────
// CP16 Pillar 0 Phase B per parch ratify #10691: browser-perf endpoint
// + per-callsite P50/P95/P99 rollup tick → /var/lib/yaklog/textfile/
// browser-perf.prom. Empirical baseline for Pillars 3-5 prioritization.
// Q3 ratify: 60s tick interval. Q4 ratify: in-process tick (not systemd).
// ──────────────────────────────────────────────────────────────────────

const CALLSITE_RE = /^[A-Za-z0-9_.:/-]{1,80}$/;

function insertMeasurements(rows, recordedAt) {
  const stmt = getDb().prepare(`
    INSERT INTO browser_perf_measurement
      (ts_unix_ms, session_id, agent_id, callsite, duration_ms, n_rows, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMany = getDb().transaction((batch) => {
    for (const r of batch) {
      stmt.run(r.ts_unix_ms, r.session_id || null, r.agent_id || null,
               r.callsite, r.duration_ms, (typeof r.n_rows === 'number' ? r.n_rows : null),
               recordedAt);
    }
  });
  insertMany(rows);
}

// POST /browser-perf — batched ingest:
//   { measurements: [{ ts_unix_ms, callsite, duration_ms, session_id?, agent_id?, n_rows? }, ...] }
router.post('/browser-perf', (req, res) => {
  const { measurements } = req.body || {};
  if (!Array.isArray(measurements) || measurements.length === 0) {
    return res.status(400).json({ error: 'BadRequest', message: 'measurements (non-empty array) required' });
  }
  if (measurements.length > 500) {
    return res.status(400).json({ error: 'BadRequest', message: 'measurements batch capped at 500' });
  }
  for (let i = 0; i < measurements.length; i++) {
    const m = measurements[i];
    if (!m || typeof m !== 'object') {
      return res.status(400).json({ error: 'BadRequest', message: `measurements[${i}] must be an object` });
    }
    if (typeof m.ts_unix_ms !== 'number' || m.ts_unix_ms <= 0) {
      return res.status(400).json({ error: 'BadRequest', message: `measurements[${i}].ts_unix_ms must be positive number` });
    }
    if (typeof m.callsite !== 'string' || !CALLSITE_RE.test(m.callsite)) {
      return res.status(400).json({ error: 'BadRequest', message: `measurements[${i}].callsite must match ${CALLSITE_RE}` });
    }
    if (typeof m.duration_ms !== 'number' || m.duration_ms < 0) {
      return res.status(400).json({ error: 'BadRequest', message: `measurements[${i}].duration_ms must be non-negative number` });
    }
  }
  insertMeasurements(measurements, new Date().toISOString());
  return res.status(201).json({ ok: true, inserted: measurements.length });
});

// Per-callsite P50/P95/P99 over the last <windowMs>ms. Pure SQL aggregation;
// returns a Map<callsite, {p50, p95, p99, count}>. Sister-shape outputRatios.
function rollupCallsites(windowMs = 60 * 60 * 1000) {
  const sinceMs = Date.now() - windowMs;
  const rows = getDb().prepare(`
    SELECT callsite, duration_ms FROM browser_perf_measurement
    WHERE ts_unix_ms >= ?
  `).all(sinceMs);
  const byCallsite = new Map();
  for (const r of rows) {
    if (!byCallsite.has(r.callsite)) byCallsite.set(r.callsite, []);
    byCallsite.get(r.callsite).push(r.duration_ms);
  }
  const out = new Map();
  for (const [cs, durs] of byCallsite) {
    durs.sort((a, b) => a - b);
    const p = (q) => durs[Math.min(durs.length - 1, Math.floor(durs.length * q))];
    out.set(cs, { p50: p(0.50), p95: p(0.95), p99: p(0.99), count: durs.length });
  }
  return out;
}

function renderBrowserPerfTextfile() {
  const stats = rollupCallsites();
  let body = '';
  body += '# HELP yaklog_browser_perf_p50_seconds P50 browser callsite duration (last 1h).\n';
  body += '# TYPE yaklog_browser_perf_p50_seconds gauge\n';
  for (const [cs, s] of stats) body += `yaklog_browser_perf_p50_seconds{callsite="${escapeLabel(cs)}"} ${(s.p50 / 1000).toFixed(6)}\n`;
  body += '# HELP yaklog_browser_perf_p95_seconds P95 browser callsite duration (last 1h).\n';
  body += '# TYPE yaklog_browser_perf_p95_seconds gauge\n';
  for (const [cs, s] of stats) body += `yaklog_browser_perf_p95_seconds{callsite="${escapeLabel(cs)}"} ${(s.p95 / 1000).toFixed(6)}\n`;
  body += '# HELP yaklog_browser_perf_p99_seconds P99 browser callsite duration (last 1h).\n';
  body += '# TYPE yaklog_browser_perf_p99_seconds gauge\n';
  for (const [cs, s] of stats) body += `yaklog_browser_perf_p99_seconds{callsite="${escapeLabel(cs)}"} ${(s.p99 / 1000).toFixed(6)}\n`;
  body += '# HELP yaklog_browser_perf_count Number of measurements per callsite (last 1h).\n';
  body += '# TYPE yaklog_browser_perf_count gauge\n';
  for (const [cs, s] of stats) body += `yaklog_browser_perf_count{callsite="${escapeLabel(cs)}"} ${s.count}\n`;
  return body;
}

function writeBrowserPerfTextfile() {
  const tmp = BROWSER_PERF_PATH + '.tmp';
  try {
    fs.mkdirSync(TEXTFILE_DIR, { recursive: true });
    fs.writeFileSync(tmp, renderBrowserPerfTextfile(), { mode: 0o644 });
    fs.renameSync(tmp, BROWSER_PERF_PATH);
    return true;
  } catch (err) {
    console.error('instrumentRoutes: browser-perf textfile write failed:', err.message);
    return false;
  }
}

// Q4 ratify: in-process tick at 60s. Started on first non-test require.
let _rollupTimer = null;
function startBrowserPerfRollupTick(intervalMs = 60_000) {
  if (_rollupTimer) return;
  // Initial write 1s after startup so first scrape has data.
  setTimeout(writeBrowserPerfTextfile, 1000).unref();
  _rollupTimer = setInterval(writeBrowserPerfTextfile, intervalMs);
  _rollupTimer.unref();
}
function stopBrowserPerfRollupTick() {
  if (_rollupTimer) { clearInterval(_rollupTimer); _rollupTimer = null; }
}

// Auto-start the tick unless under NODE_ENV=test (tests drive writes directly).
if (process.env.NODE_ENV !== 'test') {
  startBrowserPerfRollupTick();
}

// Test helpers — reset in-process state between test cases.
router.__resetForTest = () => { counters.clear(); };
router.__renderTextfile = renderTextfile;
router.__counterCount = () => counters.size;
router.__rollupCallsites = rollupCallsites;
router.__renderBrowserPerfTextfile = renderBrowserPerfTextfile;
router.__writeBrowserPerfTextfile = writeBrowserPerfTextfile;
router.__startBrowserPerfRollupTick = startBrowserPerfRollupTick;
router.__stopBrowserPerfRollupTick = stopBrowserPerfRollupTick;

module.exports = router;
