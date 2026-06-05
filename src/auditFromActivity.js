// CP12.4 (2026-06-05): agent_activity → audit_tool_invocation DRY-augment ingester.
// Per ADR-0030 v1.1 OQ#8 CONCUR (yaklog-dev #7702): augment-not-DRY-only.
//
// Walks new agent_activity rows since last cursor; creates audit_tool_invocation
// rows for tool-invocation events (PreToolUse / PostToolUse / PostToolUseFailure /
// SubagentStart / SubagentStop). Skips non-tool events (SessionStart / Stop / etc).
//
// Cursor persistence in audit_ingester_cursor table — resumes across restarts.
// Same scheduling shape as costRollup (boot backfill + periodic ticker).
//
// Output side: insertAuditToolInvocation auto-computes hash-chain event_id;
// source_event_id FK back to agent_activity.id for drill-back.

const {
  getIngesterCursor,
  upsertIngesterCursor,
  scanAgentActivityForAudit,
  insertAuditToolInvocation,
  fullSha256,
} = require('./db');

const INGESTER_NAME = 'agent_activity_to_audit_tool_invocation';

// Map agent_activity.event → (tool_phase, default_status).
// PostToolUseFailure carries reason; the daemon currently emits status:'error'
// implicitly. Per CP12.1 schema, status_detail is truncated to ≤200 chars.
const EVENT_MAP = {
  PreToolUse:          { tool_phase: 'pre',     status: null },
  PostToolUse:         { tool_phase: 'post',    status: 'ok' },
  PostToolUseFailure:  { tool_phase: 'failure', status: 'error' },
  SubagentStart:       { tool_phase: 'pre',     status: null },
  SubagentStop:        { tool_phase: 'post',    status: 'ok' },
};

// Distill agent_activity row → audit_tool_invocation insertable.
// Per PLEXUS-FEATURES.md §4.4: payload_json shape varies by tool. Today most
// PreToolUse rows have null payload (daemon-side distillation TBD); we default
// tool_name='(unknown)' for those — Phase 2 daemon fix will populate tool_name
// + cmd/file/etc fields. Until then we still get audit_wired status from
// presence of the row.
function distillRow(row) {
  const mapping = EVENT_MAP[row.event];
  if (!mapping) return null;  // not a tool-invocation event class

  let payload = null;
  if (row.payload_json) {
    try { payload = JSON.parse(row.payload_json); } catch { payload = null; }
  }

  // Tool name extraction: payload.tool (CC daemon distillation) OR
  // payload.subagent_type (SubagentStart/Stop) OR fall back to '(unknown)'.
  let tool_name = '(unknown)';
  if (payload) {
    if (payload.tool) tool_name = String(payload.tool);
    else if (payload.subagent_type) tool_name = `subagent:${payload.subagent_type}`;
  }

  // Input digest from cmd/file/pattern/path/query/url-like fields.
  let input_digest = null;
  if (payload) {
    const inputParts = [];
    for (const key of ['cmd', 'file', 'pattern', 'path', 'query', 'url', 'desc']) {
      if (payload[key] != null) inputParts.push(`${key}=${payload[key]}`);
    }
    if (inputParts.length) input_digest = fullSha256(inputParts.join('|'));
  }

  // Status detail (failure phase only)
  let status_detail = null;
  if (mapping.tool_phase === 'failure' && payload) {
    if (payload.reason) status_detail = String(payload.reason).slice(0, 200);
    else if (payload.error) status_detail = String(payload.error).slice(0, 200);
  }

  return {
    agent_id:        row.agent_id,
    occurred_at:     row.ts,
    tool_name,
    tool_phase:      mapping.tool_phase,
    input_digest,
    output_digest:   null,   // agent_activity doesn't capture tool output today
    status:          (payload && payload.status) || mapping.status,
    status_detail,
    subagent_type:   payload ? payload.subagent_type || null : null,
    source_event_id: row.id,
  };
}

// Run one ingester tick: walk batches of agent_activity rows past the cursor
// + insertAuditToolInvocation each + advance cursor. Caps per-tick work to
// keep latency bounded; multiple ticks per scheduler interval drain backlog.
async function runIngesterTick({ maxRowsPerTick = 1000 } = {}) {
  const cursor = getIngesterCursor(INGESTER_NAME);
  const after_id = cursor ? cursor.last_source_id : 0;

  const batch = scanAgentActivityForAudit(after_id, Math.min(maxRowsPerTick, 500));
  if (batch.length === 0) {
    return { processed: 0, skipped: 0, after_id, advanced_to: after_id };
  }

  let processed = 0;
  let skipped = 0;
  let last_id = after_id;
  for (const row of batch) {
    last_id = row.id;
    const insertable = distillRow(row);
    if (!insertable) { skipped += 1; continue; }
    try {
      insertAuditToolInvocation(insertable);
      processed += 1;
    } catch (e) {
      // Don't let one bad row halt the ingester. Log + skip + advance cursor.
      console.error(`[auditFromActivity] row #${row.id} insert failed: ${e.message}`);
      skipped += 1;
    }
  }

  upsertIngesterCursor({
    ingester_name:  INGESTER_NAME,
    last_source_id: last_id,
    rows_ingested:  processed,
  });

  return { processed, skipped, after_id, advanced_to: last_id };
}

// Drain backlog: keep ticking until no more rows or hard cap hit.
// Used at boot to catch up + on-demand via ops endpoint.
async function drain({ maxIters = 50, maxRowsPerTick = 1000 } = {}) {
  let totalProcessed = 0;
  let totalSkipped = 0;
  let iter = 0;
  for (; iter < maxIters; iter++) {
    const r = await runIngesterTick({ maxRowsPerTick });
    totalProcessed += r.processed;
    totalSkipped += r.skipped;
    if (r.processed === 0 && r.skipped === 0) break;
    if (r.advanced_to === r.after_id) break;  // no advance — backstop
  }
  return { iterations: iter, totalProcessed, totalSkipped };
}

// Scheduled ingester ticker (default every 60s — fast enough to keep coverage-
// gap indicator fresh; slow enough to not thrash on quiet clusters).
let _tickerTimer = null;

function scheduleTicker(intervalMs = 60_000) {
  if (_tickerTimer) clearInterval(_tickerTimer);
  _tickerTimer = setInterval(() => {
    runIngesterTick().catch((e) => {
      console.error(`[auditFromActivity] tick error: ${e.message}`);
    });
  }, intervalMs);
}

function stopTicker() {
  if (_tickerTimer) {
    clearInterval(_tickerTimer);
    _tickerTimer = null;
  }
}

module.exports = {
  runIngesterTick,
  drain,
  scheduleTicker,
  stopTicker,
  INGESTER_NAME,
  // Test-injection
  _internal: { distillRow, EVENT_MAP },
};
