const fs = require('fs');
const path = require('path');
const { resolveAllowedSenders } = require('./senderBinding');

// ADR-0026 read-filter: three-branch fail-closed visibility for private messages.
//
//   bound agent → keep row if row.private=0 OR row.sender in boundAgents OR
//                 any of row.mentions in boundAgents
//   ops-key     → keep all rows; emit audit entry per private row
//   unbound     → keep row if row.private=0 (PUBLIC ONLY; fail-closed on
//                 identity-unknown — never "filter-not-applicable → return all")
//
// applyDmVisibilityFilter is pure (no I/O); writeAuditEntries appends to the
// NDJSON audit log. Caller decides whether to write (typically: only for
// non-empty auditEntries from ops-key reads).

const AUDIT_LOG_PATH = process.env.YAKLOG_DM_AUDIT_LOG_PATH
  || '/var/log/yaklog/dm-audit.ndjson';

function applyDmVisibilityFilter(messages, req) {
  const isOpsKey = !!(req && req.auth && req.auth.opsKeyId);

  if (isOpsKey) {
    const auditEntries = [];
    for (const m of messages) {
      if (m.private) {
        auditEntries.push({
          ts: new Date().toISOString(),
          ops_key_id: req.auth.opsKeyId,
          requester_ip: req.ip || null,
          message_id: m.id,
          channel: m.channel,
          sender: m.sender,
          recipients: m.mentions || []
        });
      }
    }
    return { filtered: messages, auditEntries };
  }

  const { allowedSenders } = resolveAllowedSenders(req);

  if (allowedSenders && allowedSenders.size > 0) {
    const filtered = messages.filter((m) => {
      if (!m.private) return true;
      if (allowedSenders.has(m.sender)) return true;
      const mentions = m.mentions || [];
      for (const mention of mentions) {
        if (allowedSenders.has(mention)) return true;
      }
      return false;
    });
    return { filtered, auditEntries: [] };
  }

  // Unbound bearer (identity unknown): public only. Fail-closed.
  const filtered = messages.filter((m) => !m.private);
  return { filtered, auditEntries: [] };
}

function writeAuditEntries(entries) {
  if (!entries || entries.length === 0) return;
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(AUDIT_LOG_PATH, lines, { mode: 0o600 });
  } catch (err) {
    // Audit log write failure must NOT break the read — log it but allow the
    // response. Admin lane owns the perms/rotation discipline (ADR-0026
    // §"Admin ship-time action-items"); a transient write failure shouldn't
    // 500 an ops-key read. Log to stderr for operator visibility.
    console.error('[dm-audit] write failed:', err.message, 'path:', AUDIT_LOG_PATH);
  }
}

module.exports = {
  applyDmVisibilityFilter,
  writeAuditEntries,
  AUDIT_LOG_PATH
};
