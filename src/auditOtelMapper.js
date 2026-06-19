// Phase 0 Item B Tasks B.4 + B.6 — OTel log record -> audit_tool_invocation
// mapper. Per PLAN-ADR-0032-PHASE-0-CROSS-RUNTIME-TELEMETRY-PARITY.md
// section 2.2 schema mapping table.
//
// Reuses the existing CP12 audit_tool_invocation table from db.js:
//   event_id (NOT NULL), agent_id (NOT NULL), occurred_at, tool_name,
//   tool_phase (NOT NULL), status, status_detail, input_digest,
//   output_digest, subagent_type, source_event_id, payload_ref,
//   tombstone_at
//
// Adds the following columns additively (idempotent via dup-col catch):
//   runtime_class     ('codex'|'gemini'|'claude_code'|'ptah')
//   duration_ms       INTEGER
//   approval_state    TEXT
//   prompt_correlator TEXT (Gemini-only today)
//   tool_provenance   TEXT
//   session_correlator TEXT
//   span_id           TEXT (separate UNIQUE INDEX for idempotency)
//
// Discriminates on the OTel log record's event name:
//   codex.tool_result        -> tool_phase='PostToolUse', runtime_class='codex'
//   gemini_cli.tool_call     -> tool_phase='ToolCall',    runtime_class='gemini'
//
// Other event types are skipped (counted; not errored).

const crypto = require('crypto');
const { getDb } = require('./db');

function attr(rec, key) {
  if (!rec || !Array.isArray(rec.attributes)) return null;
  for (const a of rec.attributes) {
    if (a && a.key === key) {
      const v = a.value || {};
      return v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? null;
    }
  }
  return null;
}

function resAttr(resourceLogs, key) {
  if (!resourceLogs || !resourceLogs.resource) return null;
  const list = resourceLogs.resource.attributes;
  if (!Array.isArray(list)) return null;
  for (const a of list) {
    if (a && a.key === key) {
      const v = a.value || {};
      return v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? null;
    }
  }
  return null;
}

function eventName(rec) {
  return rec.name
    || attr(rec, 'event.name')
    || (rec.body && rec.body.stringValue)
    || null;
}

function toIso(ns) {
  if (ns == null) return new Date().toISOString();
  const n = typeof ns === 'string' ? Number(ns) : ns;
  if (!Number.isFinite(n)) return new Date().toISOString();
  return new Date(Math.floor(n / 1e6)).toISOString();
}

// Synthesize a stable event_id from inputs when OTel doesn't provide one.
function synthesizeEventId(runtimeClass, spanId, agentId, occurredAt) {
  if (spanId) return `${runtimeClass}:${spanId}`;
  const hash = crypto.createHash('sha256')
    .update(`${runtimeClass}|${agentId || 'unknown'}|${occurredAt}`)
    .digest('hex').slice(0, 16);
  return `${runtimeClass}:synth:${hash}`;
}

function normalizeSuccess(v) {
  if (v === true || v === 'true') return 'success';
  if (v === false || v === 'false') return 'failure';
  return null;
}

function mapCodexToolResult(rec, resourceLogs) {
  const occurredAt = toIso(rec.timeUnixNano);
  const spanId = rec.spanId || attr(rec, 'tool_call_id');
  const agentId = resAttr(resourceLogs, 'plexus.agent_id')
               || resAttr(resourceLogs, 'service.instance.id')
               || 'unknown';
  return {
    event_id: synthesizeEventId('codex', spanId, agentId, occurredAt),
    agent_id: agentId,
    occurred_at: occurredAt,
    tool_name: attr(rec, 'function_name') || attr(rec, 'tool.name') || 'unknown',
    tool_phase: 'PostToolUse',
    status: normalizeSuccess(attr(rec, 'success')),
    status_detail: null,
    runtime_class: 'codex',
    session_correlator: attr(rec, 'conversation.id') || attr(rec, 'session.id'),
    duration_ms: attr(rec, 'duration_ms'),
    approval_state: null,
    prompt_correlator: null,
    tool_provenance: 'native',
    span_id: spanId,
  };
}

function mapGeminiToolCall(rec, resourceLogs) {
  const occurredAt = toIso(rec.timeUnixNano);
  const spanId = rec.spanId || attr(rec, 'tool_call_id');
  const agentId = resAttr(resourceLogs, 'plexus.agent_id')
               || resAttr(resourceLogs, 'service.instance.id')
               || 'unknown';
  const decision = attr(rec, 'decision');
  const toolType = attr(rec, 'tool_type');
  const mcpServer = attr(rec, 'mcp_server_name');
  return {
    event_id: synthesizeEventId('gemini', spanId, agentId, occurredAt),
    agent_id: agentId,
    occurred_at: occurredAt,
    tool_name: attr(rec, 'function_name') || attr(rec, 'tool.name') || 'unknown',
    tool_phase: 'ToolCall',
    status: normalizeSuccess(attr(rec, 'success')),
    status_detail: null,
    runtime_class: 'gemini',
    session_correlator: attr(rec, 'gen_ai.conversation.id') || attr(rec, 'session.id'),
    duration_ms: attr(rec, 'duration_ms'),
    approval_state: typeof decision === 'string' ? decision : null,
    prompt_correlator: attr(rec, 'prompt_id'),
    tool_provenance: toolType === 'mcp' && mcpServer ? `mcp:${mcpServer}`
                  : toolType || 'native',
    span_id: spanId,
  };
}

function mapRecord(rec, resourceLogs) {
  const name = eventName(rec);
  if (!name) return null;
  if (name === 'codex.tool_result')     return mapCodexToolResult(rec, resourceLogs);
  if (name === 'gemini_cli.tool_call')  return mapGeminiToolCall(rec, resourceLogs);
  return null;
}

let schemaEnsured = false;
function ensureSchema(db) {
  if (schemaEnsured) return;
  // Additive ALTERs to the existing CP12 audit_tool_invocation table.
  const adds = [
    ['runtime_class', 'TEXT'],
    ['session_correlator', 'TEXT'],
    ['duration_ms', 'INTEGER'],
    ['approval_state', 'TEXT'],
    ['prompt_correlator', 'TEXT'],
    ['tool_provenance', 'TEXT'],
    ['span_id', 'TEXT'],
  ];
  for (const [col, type] of adds) {
    try { db.prepare(`ALTER TABLE audit_tool_invocation ADD COLUMN ${col} ${type}`).run(); }
    catch (e) { /* duplicate column — ignore */ }
  }
  try { db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_atinv_span_id ON audit_tool_invocation(span_id) WHERE span_id IS NOT NULL`).run(); } catch {}
  try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_atinv_runtime_occurred ON audit_tool_invocation(runtime_class, occurred_at DESC)`).run(); } catch {}
  try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_atinv_session ON audit_tool_invocation(session_correlator, occurred_at DESC)`).run(); } catch {}
  schemaEnsured = true;
}

function mapOtelLogRecords(resourceLogs) {
  const db = getDb();
  let ingested = 0;
  let skipped = 0;
  const errors = [];

  ensureSchema(db);

  // INSERT OR IGNORE relies on the partial UNIQUE INDEX on span_id (created
  // in ensureSchema). Sister-shape to ON CONFLICT, but works with partial
  // indices across SQLite versions. Rows with null span_id always insert
  // (partial WHERE excludes them from the uniqueness constraint).
  const insert = db.prepare(`
    INSERT OR IGNORE INTO audit_tool_invocation (
      event_id, agent_id, occurred_at, tool_name, tool_phase,
      status, status_detail,
      runtime_class, session_correlator, duration_ms,
      approval_state, prompt_correlator, tool_provenance, span_id
    ) VALUES (
      @event_id, @agent_id, @occurred_at, @tool_name, @tool_phase,
      @status, @status_detail,
      @runtime_class, @session_correlator, @duration_ms,
      @approval_state, @prompt_correlator, @tool_provenance, @span_id
    )
  `);

  for (const rl of (resourceLogs || [])) {
    if (!rl || !Array.isArray(rl.scopeLogs)) continue;
    for (const sl of rl.scopeLogs) {
      if (!sl || !Array.isArray(sl.logRecords)) continue;
      for (const rec of sl.logRecords) {
        try {
          const row = mapRecord(rec, rl);
          if (!row) { skipped++; continue; }
          const info = insert.run(row);
          if (info.changes > 0) ingested++;
          else skipped++;
        } catch (e) {
          errors.push({ message: e.message, eventName: eventName(rec) });
        }
      }
    }
  }

  return { ingested, skipped, errors };
}

module.exports = {
  mapOtelLogRecords,
  mapRecord,
  attr,
  resAttr,
  eventName,
  toIso,
  synthesizeEventId,
};
