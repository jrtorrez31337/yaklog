// Phase 0 Item B (ADR-0032 cross-runtime telemetry parity) —
// OTel collector → audit_tool_invocation ingester. Per PLAN-ADR-0032-
// PHASE-0-CROSS-RUNTIME-TELEMETRY-PARITY.md §2.2 architecture (collector-
// intermediated) + §3 Task B.2-B.6 mapper implementation.
//
// Accepts OTLP/HTTP log batches forwarded from the plexus-otel-collector's
// new `logs/audit` pipeline (filter codex.* + gemini_cli.* → otlphttp
// exporter targeting this endpoint). Maps `codex.tool_result` +
// `gemini_cli.tool_call` log records into audit_tool_invocation rows.
//
// Auth: ops-key gated per feedback_secrets_no_yaklog. Collector posts with
// a Bearer from YAKLOG_OPS_API_KEYS; mounted under enforceOpsKey middleware.
//
// Idempotency: dedup by span_id (or synthetic key when absent) ON CONFLICT
// IGNORE — OTel collector may retry on transient failures; multiple posts
// of the same span should not duplicate rows.
//
// Empty-body handling: POST with `resourceLogs: []` returns 200 +
// ingested_count=0. Collector heartbeats may send empty batches.

const express = require('express');
const { enforceOpsKey } = require('./middleware/opsKey');
const { mapOtelLogRecords } = require('./auditOtelMapper');

const router = express.Router();

// All routes here are ops-key gated.
router.use(enforceOpsKey);

router.post('/otel', (req, res) => {
  const body = req.body || {};
  const resourceLogs = Array.isArray(body.resourceLogs) ? body.resourceLogs : [];

  let ingestedCount = 0;
  let skippedCount = 0;
  const errors = [];

  try {
    const result = mapOtelLogRecords(resourceLogs);
    ingestedCount = result.ingested;
    skippedCount = result.skipped;
    if (result.errors && result.errors.length) errors.push(...result.errors);
  } catch (e) {
    console.error('[audit-otel-ingest] mapper error:', e.message);
    return res.status(500).json({
      error: 'IngestError',
      message: e.message,
    });
  }

  return res.json({
    ingested_count: ingestedCount,
    skipped_count: skippedCount,
    errors: errors.slice(0, 20),   // cap to avoid huge response on broken batches
  });
});

module.exports = router;
