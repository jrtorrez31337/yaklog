// CP12.2 (2026-06-04): ADR-0030 v1.1 §5.2 ops-key gated audit + governance
// mutation endpoints. Six surfaces mounted under /api/v1/ops/ by app.js.
//
//   PUT   /api/v1/ops/policy/rule
//   POST  /api/v1/ops/policy/rule/:id/ratify
//   POST  /api/v1/ops/policy/rule/:id/deprecate
//   PATCH /api/v1/ops/policy/violation/:id
//   POST  /api/v1/ops/audit/reconcile
//   POST  /api/v1/ops/audit/tombstone
//
// Auth: enforceOpsKey applied at router level — every route requires a
// Bearer matching YAKLOG_OPS_API_KEYS (separate from YAKLOG_API_KEYS per
// ADR-0025 §4b). Held by secops + ssw-devops + admin-agent only.
//
// Actor attribution: handlers compute `actor = sha256(bearer).slice(0,16)`
// and pass it into the db.js helpers (authored_by / ratified_by /
// disposition_by / reconciled_by / ops_key_sha256). The cost-route pattern
// in src/routes.js uses req.auth.opsKeyId which is precomputed by
// middleware/auth.js; we recompute locally so this router can also be
// mounted standalone (used by tests) without the upstream auth middleware.
//
// Tombstone helpers (tombstoneAuditPayload / tombstoneSubject) atomically
// produce a meta-audit row (audit_credential_change) per admin R2 fold —
// see db.js lines ~1481, ~1540. No need to emit meta-audit at this layer.

const express = require('express');
const crypto = require('crypto');
const { enforceOpsKey } = require('./middleware/opsKey');
const {
  upsertPolicyRule,
  ratifyPolicyRule,
  deprecatePolicyRule,
  disposePolicyViolation,
  insertAuditReconciliation,
  tombstoneAuditPayload,
  tombstoneSubject,
  processPermissionScan,
  insertAuditAttestation,
  ATTESTATION_CONTROL_AREAS,
  processChannelSubscriptionScan,
  RECONCILE_CLASS_VOCAB,
  // CP12.12 Phase 3 (A) external integrity anchor
  computeChainSnapshot,
  insertAuditAnchor,
  ANCHOR_SUBSTRATE_VOCAB,
  // CP16-prep WAL checkpoint maintenance per 2026-06-20 incident post-mortem
  getDb,
} = require('./db');

const router = express.Router();

// Router-level auth: every mutation here requires an ops-key. enforceOpsKey
// is itself idempotent (reads req.rawBearer if upstream masked Authorization).
router.use(enforceOpsKey);

// ─── helpers ────────────────────────────────────────────────────────────────

const SEVERITY_CLASSES = new Set(['info', 'warn', 'violation', 'critical']);
const DISPOSITIONS = new Set([
  'pending', 'acknowledged', 'remediated', 'accepted-with-rationale', 'suppressed',
]);
const TOMBSTONE_KINDS = new Set(['audit-payload', 'subject']);
// Mirror db.js ALLOWED set in tombstoneAuditPayload — keeps 400-vs-500
// boundary correct (validate at handler instead of letting helper throw 500).
const TOMBSTONE_TABLES = new Set(['audit_tool_invocation', 'audit_file_access']);

function extractBearer(req) {
  if (req.rawBearer) return req.rawBearer;
  const auth = req.headers['authorization'];
  if (!auth || typeof auth !== 'string') return null;
  const m = auth.match(/^Bearer\s+(.+)$/);
  return m ? m[1].trim() : null;
}

// Forensic actor: sha256-prefix of the presenting ops-key. Same shape
// secops uses elsewhere (16-char hex). NOT the rotation-key id; this is
// per-token. Lets audit trails attribute mutations to a key without
// surfacing the cleartext token in any column.
function computeActor(req) {
  const tok = extractBearer(req);
  // enforceOpsKey already ensured tok exists + is valid; computeActor is
  // only called downstream of that gate.
  return crypto.createHash('sha256').update(tok).digest('hex').slice(0, 16);
}

function badRequest(res, message) {
  return res.status(400).json({ error: 'ValidationError', message });
}
function notFound(res, message) {
  return res.status(404).json({ error: 'NotFound', message });
}
function conflict(res, message) {
  return res.status(409).json({ error: 'Conflict', message });
}
function internal(res, message) {
  // Safe summary only — never leak stack traces or SQL fragments past
  // the helper boundary. Helper error messages are curated (see db.js).
  return res.status(500).json({ error: 'InternalError', message });
}

// ─── 1. PUT /policy/rule (UPSERT) ───────────────────────────────────────────

router.put('/policy/rule', (req, res) => {
  const b = req.body || {};
  if (!b.rule_id || typeof b.rule_id !== 'string') {
    return badRequest(res, 'rule_id required (string)');
  }
  if (!b.name || !b.description || !b.applicability_json || !b.predicate_dsl || !b.severity_class) {
    return badRequest(res, 'name + description + applicability_json + predicate_dsl + severity_class required');
  }
  if (!SEVERITY_CLASSES.has(b.severity_class)) {
    return badRequest(res, `severity_class must be one of ${[...SEVERITY_CLASSES].join('|')}`);
  }
  if (b.status && !['draft', 'active', 'deprecated'].includes(b.status)) {
    return badRequest(res, 'status must be draft|active|deprecated');
  }
  const actor = computeActor(req);
  try {
    const result = upsertPolicyRule({
      rule_id: b.rule_id,
      name: b.name,
      description: b.description,
      applicability_json: b.applicability_json,
      predicate_dsl: b.predicate_dsl,
      severity_class: b.severity_class,
      status: b.status,
      authored_by: actor,
    });
    return res.json({ ok: true, ...result });
  } catch (e) {
    return internal(res, e.message);
  }
});

// ─── 2. POST /policy/rule/:id/ratify ────────────────────────────────────────

router.post('/policy/rule/:id/ratify', (req, res) => {
  const ruleId = req.params.id;
  const actor = computeActor(req);
  try {
    const result = ratifyPolicyRule(ruleId, actor);
    if (result.changed === 0) {
      return notFound(res, `policy_rule ${ruleId} not found`);
    }
    return res.json({ ok: true, ratified: true, rule_id: ruleId });
  } catch (e) {
    return internal(res, e.message);
  }
});

// ─── 3. POST /policy/rule/:id/deprecate ─────────────────────────────────────

router.post('/policy/rule/:id/deprecate', (req, res) => {
  const ruleId = req.params.id;
  try {
    const result = deprecatePolicyRule(ruleId);
    if (result.changed === 0) {
      return notFound(res, `policy_rule ${ruleId} not found`);
    }
    return res.json({ ok: true, deprecated: true, rule_id: ruleId });
  } catch (e) {
    return internal(res, e.message);
  }
});

// ─── 4. PATCH /policy/violation/:id ─────────────────────────────────────────

router.patch('/policy/violation/:id', (req, res) => {
  const violationId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(violationId) || violationId <= 0) {
    return badRequest(res, 'violation id must be a positive integer');
  }
  const b = req.body || {};
  if (!b.disposition || typeof b.disposition !== 'string') {
    return badRequest(res, 'disposition required');
  }
  if (!DISPOSITIONS.has(b.disposition)) {
    return badRequest(res, `disposition must be one of ${[...DISPOSITIONS].join('|')}`);
  }
  const actor = computeActor(req);
  try {
    const result = disposePolicyViolation(violationId, {
      disposition: b.disposition,
      disposition_by: actor,
      disposition_note: b.disposition_note,
    });
    if (result.changed === 0) {
      return notFound(res, `policy_violation ${violationId} not found`);
    }
    return res.json({ ok: true, changed: result.changed });
  } catch (e) {
    return internal(res, e.message);
  }
});

// ─── 5. POST /audit/reconcile ───────────────────────────────────────────────

router.post('/audit/reconcile', (req, res) => {
  const b = req.body || {};
  if (!b.period_start || !b.period_end || !b.external_system_label || !b.reconciler_agent_id) {
    return badRequest(res, 'period_start + period_end + external_system_label + reconciler_agent_id required');
  }
  if (!Number.isInteger(b.plexus_count) || !Number.isInteger(b.external_count)) {
    return badRequest(res, 'plexus_count + external_count must be integers');
  }
  // CP12.16: reconcile_class optional (defaults 'other' in helper); validate
  // at handler for the 400 vs 500 boundary discipline.
  if (b.reconcile_class && !RECONCILE_CLASS_VOCAB.has(b.reconcile_class)) {
    return badRequest(res, `reconcile_class must be one of ${[...RECONCILE_CLASS_VOCAB].join('|')}`);
  }
  const actor = computeActor(req);
  try {
    const result = insertAuditReconciliation({
      period_start: b.period_start,
      period_end: b.period_end,
      external_system_label: b.external_system_label,
      reconcile_class: b.reconcile_class,
      plexus_count: b.plexus_count,
      external_count: b.external_count,
      concentration_json: b.concentration_json,
      notes: b.notes,
      reconciler_agent_id: b.reconciler_agent_id,
      reconciled_by: actor,
    });
    return res.json({ ok: true, ...result });
  } catch (e) {
    return internal(res, e.message);
  }
});

// ─── 6. POST /audit/tombstone ───────────────────────────────────────────────
//
// Two-kinds discriminated union per ADR-0030 v1.1 §5.2:
//   kind=audit-payload → tombstoneAuditPayload({table_name, row_id, ...})
//   kind=subject       → tombstoneSubject({subject_hash, ...})
// reason REQUIRED for BOTH kinds (GDPR lawful-basis-class). The helper
// only enforces this on the subject path; we hoist the check up so
// audit-payload tombstones get the same scrutiny.

router.post('/audit/tombstone', (req, res) => {
  const b = req.body || {};
  if (!b.kind || !TOMBSTONE_KINDS.has(b.kind)) {
    return badRequest(res, `kind required, must be one of ${[...TOMBSTONE_KINDS].join('|')}`);
  }
  if (!b.reason || typeof b.reason !== 'string' || !b.reason.trim()) {
    return badRequest(res, 'reason required (GDPR lawful-basis-class)');
  }
  const actor = computeActor(req);

  if (b.kind === 'audit-payload') {
    if (!b.table_name || !TOMBSTONE_TABLES.has(b.table_name)) {
      return badRequest(res, `table_name must be one of ${[...TOMBSTONE_TABLES].join('|')}`);
    }
    if (!Number.isInteger(b.row_id) || b.row_id <= 0) {
      return badRequest(res, 'row_id must be a positive integer');
    }
    try {
      const result = tombstoneAuditPayload({
        table_name: b.table_name,
        row_id: b.row_id,
        ops_key_sha256: actor,
        reason: b.reason,
      });
      return res.json({ ok: true, kind: 'audit-payload', ...result });
    } catch (e) {
      const msg = e.message || '';
      if (/already tombstoned/i.test(msg)) return conflict(res, msg);
      if (/not found/i.test(msg))         return notFound(res, msg);
      return internal(res, msg);
    }
  }

  // kind === 'subject'
  if (!b.subject_hash || typeof b.subject_hash !== 'string') {
    return badRequest(res, 'subject_hash required (string)');
  }
  try {
    const result = tombstoneSubject({
      subject_hash: b.subject_hash,
      ops_key_sha256: actor,
      reason: b.reason,
    });
    return res.json({ ok: true, kind: 'subject', ...result });
  } catch (e) {
    const msg = e.message || '';
    // tombstoneSubject collapses "not found" and "already tombstoned" into
    // one error string (UPDATE WHERE tombstone_at IS NULL changes=0 path).
    // Treat as 409 since double-call is the more common operational case
    // and "not found" is a 4xx either way.
    if (/not found or already tombstoned/i.test(msg)) return conflict(res, msg);
    return internal(res, msg);
  }
});

// CP12.8 Phase 2 admin-R4 source-coverage: permission-change scan endpoint.
//
// Scanner script (scripts/permission-change-scanner.sh) runs on the host
// with filesystem visibility the container lacks; POSTs the discovered
// source-fingerprint set here. Server-side diff + emit + snapshot-persist
// is in processPermissionScan().
//
// Body: { sources: [{ source_class, source_path, agent_id, fingerprint }] }
// Response: { ok, first_scan, adds, modifies, removes, total_emitted }
router.post('/audit/permission-change/scan', (req, res) => {
  const actor = computeActor(req);
  const body = req.body || {};
  if (!Array.isArray(body.sources)) {
    return badRequest(res, 'sources array required');
  }
  if (body.sources.length > 10000) {
    return badRequest(res, 'sources array too large (max 10000 per scan)');
  }
  try {
    const result = processPermissionScan({
      sources: body.sources,
      actor,
      scan_at: body.scan_at || undefined,
    });
    return res.json({ ok: true, ...result });
  } catch (e) {
    return internal(res, e.message || 'permission-change scan failed');
  }
});

// CP12.10 Phase 3 governance-tier substrate (ADR-0030):
// Operator-authored attestation for SOC 2 CC1 / CC2 / CC9 areas. Each row
// represents a human review event (org-chart, comm-policy, risk-register).
// Lifts Attestation status tile from 3/6 substrate-wired → 6/6 once any row
// per area lands.
//
// Body: { control_area, attestation_class, attestation_text,
//         period_start?, period_end?, reference_url? }
// Response: { ok, event_id, id }
router.post('/audit/attestation', (req, res) => {
  const b = req.body || {};
  if (!b.control_area || typeof b.control_area !== 'string') {
    return badRequest(res, 'control_area required (string)');
  }
  if (!ATTESTATION_CONTROL_AREAS.has(b.control_area)) {
    return badRequest(res, `control_area must be one of ${[...ATTESTATION_CONTROL_AREAS].join('|')}`);
  }
  if (!b.attestation_class || typeof b.attestation_class !== 'string' || b.attestation_class.length > 80) {
    return badRequest(res, 'attestation_class required (string, max 80 chars)');
  }
  if (!b.attestation_text || typeof b.attestation_text !== 'string' || !b.attestation_text.trim()) {
    return badRequest(res, 'attestation_text required (non-empty string)');
  }
  if (b.attestation_text.length > 16384) {
    return badRequest(res, 'attestation_text too large (max 16384 chars)');
  }
  if (b.reference_url && (typeof b.reference_url !== 'string' || b.reference_url.length > 500)) {
    return badRequest(res, 'reference_url must be string ≤500 chars');
  }
  const actor = computeActor(req);
  try {
    const result = insertAuditAttestation({
      control_area: b.control_area,
      attestation_class: b.attestation_class,
      attestation_text: b.attestation_text,
      actor,
      period_start: b.period_start || null,
      period_end: b.period_end || null,
      reference_url: b.reference_url || null,
    });
    return res.json({ ok: true, ...result });
  } catch (e) {
    return internal(res, e.message || 'audit attestation insert failed');
  }
});

// CP12.15 Phase 2: channel-subscription change history scan.
// Scanner script (scripts/channel-subscription-scanner.sh) reads each
// per-user ~/.config/yaklog/channels CSV file + POSTs the parsed
// {agent_id, channels[]} list here. Server-side does diff + emit +
// snapshot-persist.
//
// Body: { subscriptions: [{agent_id, channels: [...], source_path?}] }
// Response: { ok, first_scan, subscribes, unsubscribes, total_emitted }
router.post('/audit/channel-subscription/scan', (req, res) => {
  const actor = computeActor(req);
  const body = req.body || {};
  if (!Array.isArray(body.subscriptions)) {
    return badRequest(res, 'subscriptions array required');
  }
  if (body.subscriptions.length > 10000) {
    return badRequest(res, 'subscriptions array too large (max 10000 per scan)');
  }
  try {
    const result = processChannelSubscriptionScan({
      subscriptions: body.subscriptions,
      actor,
      scan_at: body.scan_at || undefined,
    });
    return res.json({ ok: true, ...result });
  } catch (e) {
    return internal(res, e.message || 'channel-subscription scan failed');
  }
});

// ─── CP12.12 Phase 3 (A) external integrity anchor: 2 ops endpoints ────────
//
// Cron-driver flow:
//   1. GET /api/v1/ops/audit/anchor-snapshot
//      → returns current chain-high-water digest + event_id + table
//   2. (driver publishes digest to S3 Object Lock; receives anchor_uri)
//   3. POST /api/v1/ops/audit/anchor-record with {anchor_day, anchor_uri,
//      anchor_substrate, snapshot_fields...}
//      → server persists audit_anchor row
//
// Verify uses public read endpoints (per parch #7984 OQ-3.3 public access).

router.post('/audit/anchor-snapshot', (req, res) => {
  try {
    const snapshot = computeChainSnapshot();
    return res.json({ ok: true, ...snapshot });
  } catch (e) {
    return internal(res, e.message || 'chain snapshot computation failed');
  }
});

router.post('/audit/anchor-record', (req, res) => {
  const b = req.body || {};
  if (!b.anchor_day || !b.anchor_uri || !b.anchor_substrate
      || !b.chain_high_water_event_id || !b.chain_high_water_table || !b.digest_sha256) {
    return badRequest(res, 'anchor_day + anchor_uri + anchor_substrate + chain_high_water_event_id + chain_high_water_table + digest_sha256 required');
  }
  if (!ANCHOR_SUBSTRATE_VOCAB.has(b.anchor_substrate)) {
    return badRequest(res, `anchor_substrate must be one of ${[...ANCHOR_SUBSTRATE_VOCAB].join('|')}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.anchor_day)) {
    return badRequest(res, 'anchor_day must be YYYY-MM-DD');
  }
  const actor = computeActor(req);
  try {
    const result = insertAuditAnchor({
      anchor_day: b.anchor_day,
      chain_high_water_event_id: b.chain_high_water_event_id,
      chain_high_water_table: b.chain_high_water_table,
      digest_sha256: b.digest_sha256,
      anchor_substrate: b.anchor_substrate,
      anchor_uri: b.anchor_uri,
      published_at: b.published_at,
      published_by: actor,
    });
    return res.json({ ok: true, ...result });
  } catch (e) {
    const msg = e.message || 'audit anchor insert failed';
    if (/duplicate anchor/.test(msg)) return conflict(res, msg);
    if (/must be|required/.test(msg)) return badRequest(res, msg);
    return internal(res, msg);
  }
});

// ─── CP16-prep maintenance: WAL checkpoint ──────────────────────────────────
//
// POST /api/v1/ops/wal-checkpoint  body: {"mode": "TRUNCATE"|"PASSIVE"|"FULL"|"RESTART"}
//
// Per 2026-06-20T21:08-21:43Z incident post-mortem: unmaintained WAL grew
// to 4.2 MB and the next implicit checkpoint took 4 seconds while waiting
// for the writer lock — cascading into POST starvation and cluster-bus
// wedge. Hourly cron-driven explicit checkpoint via this endpoint keeps the
// WAL bounded and surfaces writer-contention via elapsed_ms gauge.
//
// Per [[feedback_writer_lock_contention_visible_via_checkpoint_elapsed_ms]]:
// elapsed_ms <100 = healthy; 1000-10000 = contended; >10000 = wedged.
//
// Modes per SQLite docs (https://www.sqlite.org/pragma.html#pragma_wal_checkpoint):
//   PASSIVE  — non-blocking; writes back what it can without waiting
//   FULL     — waits for writers to finish then writes back all frames
//   RESTART  — like FULL but also waits for readers to finish on old WAL
//   TRUNCATE — like RESTART but also truncates WAL file to zero bytes (default)
//
// TRUNCATE is the canonical maintenance mode (reclaims disk; sister-shape
// to what's documented in feedback_db_rebuild_safety: "PRAGMA wal_checkpoint(TRUNCATE)"
// is also called as part of online-backup discipline).
const VALID_CHECKPOINT_MODES = new Set(['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE']);

router.post('/wal-checkpoint', (req, res) => {
  const b = req.body || {};
  const mode = (b.mode || 'TRUNCATE').toUpperCase();
  if (!VALID_CHECKPOINT_MODES.has(mode)) {
    return badRequest(res, `mode must be one of ${[...VALID_CHECKPOINT_MODES].join('|')}`);
  }
  const actor = computeActor(req);
  const t0 = Date.now();
  try {
    // PRAGMA returns { busy: 0|1, log: <pages-in-WAL-at-start>, checkpointed: <pages-written-back> }
    const r = getDb().prepare(`PRAGMA wal_checkpoint(${mode})`).get();
    const elapsed_ms = Date.now() - t0;
    return res.json({
      ok: true,
      mode,
      busy: r.busy,
      log: r.log,
      checkpointed: r.checkpointed,
      elapsed_ms,
      actor,
    });
  } catch (e) {
    return internal(res, e.message);
  }
});

module.exports = router;
