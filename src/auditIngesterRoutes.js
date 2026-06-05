// CP12.5 (2026-06-05): server-side file-access ingester intake handler per
// ratified ADR-0030 v1.1 Phase 1.5 + secops #7810 FULL CONCUR (all 7 OQs
// signed off + 8 safety preconditions canonical).
//
// Accepts batched file-access events from per-host plexus-audit-ingester
// daemons (Phase 1.5.D Rust + libbpf-rs eBPF substrate; not yet built).
// Substrate-agnostic shape — this intake handler doesn't care whether the
// daemon used eBPF, auditd, or any other source as long as the wire payload
// matches.
//
// Auth: enforceHostIngesterBinding middleware — token bound to specific
// host string per OQ#5. Host = the hostname string the daemon reports.
//
// Per-event payload shape:
//   {
//     occurred_at: ISO-8601 UTC,
//     uid: integer,
//     path: absolute path string,
//     access_mode: 'read' | 'write' | 'mkdir' | 'unlink' | 'chmod' | 'chown' | 'rename' | 'truncate',
//     bytes_in?: integer,
//     bytes_out?: integer,
//     content_digest?: 64-char hex (full sha256 per secops #7795 OQ#6;
//                       NULL above 256KB threshold or outside INCLUDE-list),
//     agent_id?: string,                  // uid_unique attribution
//     attribution_confidence?: 'uid_unique' | 'uid_shared',  // default 'uid_unique'
//     session_correlator?: string,        // process_class-prefixed per OQ#2
//                                          //   cc-agent:<session-id>
//                                          //   cc-agent-idle:<cwd-hash>
//                                          //   daemon:<systemd-unit>
//                                          //   cron:<job-name>
//                                          //   shell:<pid>
//                                          //   unknown:<pid>
//   }
//
// Batch envelope:
//   {
//     host: string,          // claimed host (must match binding)
//     events: [event, ...],  // up to MAX_BATCH per request
//     ingester_version?: string,  // for telemetry / cluster-upgrade tracking
//   }

const express = require('express');
const { insertAuditFileAccess } = require('./db');
const { enforceHostIngesterBinding } = require('./middleware/hostIngesterBinding');

const router = express.Router();

const MAX_BATCH = 500;
const VALID_ACCESS_MODES = new Set([
  'read', 'write', 'mkdir', 'unlink', 'chmod', 'chown', 'rename', 'truncate',
]);
const VALID_ATTRIBUTION_CONFIDENCES = new Set(['uid_unique', 'uid_shared']);

// Validate one event row. Returns null on success or an error string on failure.
function validateEvent(ev, idx) {
  if (!ev || typeof ev !== 'object') return `events[${idx}] is not an object`;
  if (typeof ev.uid !== 'number' || !Number.isInteger(ev.uid)) {
    return `events[${idx}].uid must be an integer`;
  }
  if (!ev.path || typeof ev.path !== 'string') {
    return `events[${idx}].path must be a non-empty string`;
  }
  if (!ev.access_mode || !VALID_ACCESS_MODES.has(ev.access_mode)) {
    return `events[${idx}].access_mode must be one of ${[...VALID_ACCESS_MODES].join('|')}`;
  }
  if (ev.attribution_confidence != null && !VALID_ATTRIBUTION_CONFIDENCES.has(ev.attribution_confidence)) {
    return `events[${idx}].attribution_confidence must be uid_unique|uid_shared`;
  }
  if (ev.bytes_in != null && (typeof ev.bytes_in !== 'number' || !Number.isInteger(ev.bytes_in) || ev.bytes_in < 0)) {
    return `events[${idx}].bytes_in must be a non-negative integer`;
  }
  if (ev.bytes_out != null && (typeof ev.bytes_out !== 'number' || !Number.isInteger(ev.bytes_out) || ev.bytes_out < 0)) {
    return `events[${idx}].bytes_out must be a non-negative integer`;
  }
  // content_digest: full sha256 hex (64 chars) per secops OQ#6 fold-in.
  // Per #7795: "Full sha256 only — NULL for files above threshold — NO partial hashes."
  if (ev.content_digest != null) {
    if (typeof ev.content_digest !== 'string' || !/^[0-9a-f]{64}$/.test(ev.content_digest)) {
      return `events[${idx}].content_digest must be 64-char lowercase hex sha256 or null (secops OQ#6: no partial hashes)`;
    }
  }
  if (ev.session_correlator != null && typeof ev.session_correlator !== 'string') {
    return `events[${idx}].session_correlator must be a string when present`;
  }
  if (ev.agent_id != null && typeof ev.agent_id !== 'string') {
    return `events[${idx}].agent_id must be a string when present`;
  }
  // occurred_at: optional; if present must be ISO-8601-ish (loose check;
  // db.js insertAuditFileAccess defaults to new Date().toISOString() if missing).
  if (ev.occurred_at != null && typeof ev.occurred_at !== 'string') {
    return `events[${idx}].occurred_at must be ISO-8601 string when present`;
  }
  return null;
}

// POST /api/v1/ingester/file-access — batched intake from per-host daemon.
// Per ADR-0030 §Phase 1.5 §5 implementation deliverable shape.
//
// Mounted at app.js AFTER the global auth middleware so req.auth is set;
// host-binding enforcement applies on top.
router.post('/file-access', (req, res) => {
  const body = req.body || {};
  const host = body.host;
  if (!host || typeof host !== 'string') {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'Request body must include `host` string identifying the source host.'
    });
  }

  // Host-binding auth: token must be bound to publish for this host.
  const bindingErr = enforceHostIngesterBinding(req, host);
  if (bindingErr) {
    return res.status(bindingErr.status).json(bindingErr.body);
  }

  if (!Array.isArray(body.events)) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'Request body must include `events` array.'
    });
  }
  if (body.events.length === 0) {
    return res.json({ ok: true, ingested: 0, host });
  }
  if (body.events.length > MAX_BATCH) {
    return res.status(400).json({
      error: 'ValidationError',
      message: `events array exceeds MAX_BATCH (${MAX_BATCH}); split into smaller batches`
    });
  }

  // Validate all rows BEFORE inserting any — atomic-batch semantics. Per-row
  // failure rejects the whole batch so the daemon can retry/inspect rather
  // than partial-insert + skip.
  for (let i = 0; i < body.events.length; i++) {
    const err = validateEvent(body.events[i], i);
    if (err) {
      return res.status(400).json({ error: 'ValidationError', message: err });
    }
  }

  // Insert each row via the CP12.1 shipped substrate helper.
  // Per-row failures here are server-side issues (DB write) and don't
  // partial-fail the batch — we surface the first error + 500.
  let ingested = 0;
  const inserted = [];
  try {
    for (const ev of body.events) {
      const r = insertAuditFileAccess({
        occurred_at: ev.occurred_at,
        agent_id: ev.agent_id || null,
        uid: ev.uid,
        path: ev.path,
        access_mode: ev.access_mode,
        bytes_in: ev.bytes_in != null ? ev.bytes_in : null,
        bytes_out: ev.bytes_out != null ? ev.bytes_out : null,
        content_digest: ev.content_digest || null,
        attribution_confidence: ev.attribution_confidence || 'uid_unique',
        session_correlator: ev.session_correlator || null,
      });
      inserted.push({ id: r.id, event_id: r.event_id });
      ingested += 1;
    }
  } catch (e) {
    return res.status(500).json({
      error: 'InternalError',
      message: `insert failed after ${ingested} successful rows: ${e.message}`,
      partial_ingested: ingested,
    });
  }

  res.json({
    ok: true,
    ingested,
    host,
    ingester_version: body.ingester_version || null,
    inserted_event_ids: inserted.map(r => r.event_id),
  });
});

module.exports = router;
