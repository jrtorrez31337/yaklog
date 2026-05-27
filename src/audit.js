// DM audit log reader. ADR-0026 wrote the producer (writeAuditEntries in
// middleware/dmFilter.js); this is the matching consumer for the dashboard
// audit tab (item #2 of the dashboard-gap plan) + any future CLI/curl tooling.
//
// v1: simple full-read-and-filter against the NDJSON file. The audit log
// grows slowly (one entry per ops-key + dashboard-reveal read of a private
// row) and lives on the local filesystem. When/if it ever scales past
// tens-of-thousands of entries, swap to a daily-shard + index pattern.

const fs = require('fs');

const DEFAULT_PATH = process.env.YAKLOG_DM_AUDIT_LOG_PATH
  || '/var/log/yaklog/dm-audit.ndjson';

function readDmAuditLog({
  limit = 100,
  since = null,         // ISO-8601 lower bound (inclusive)
  until = null,         // ISO-8601 upper bound (inclusive)
  sender = null,
  recipient = null,     // matches if present in entry.recipients[]
  message_id = null,    // numeric
  ops_key_id = null,
  path = DEFAULT_PATH,
} = {}) {
  let contents;
  try {
    contents = fs.readFileSync(path, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return { entries: [], path, exists: false };
    throw err;
  }

  const entries = [];
  for (const line of contents.split('\n')) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines silently — audit-log integrity isn't v1 concern.
    }
  }

  const filtered = entries.filter((e) => {
    if (since && e.ts < since) return false;
    if (until && e.ts > until) return false;
    if (sender && e.sender !== sender) return false;
    if (recipient && !(Array.isArray(e.recipients) && e.recipients.includes(recipient))) return false;
    if (message_id != null && e.message_id !== Number(message_id)) return false;
    if (ops_key_id && e.ops_key_id !== ops_key_id) return false;
    return true;
  });

  // Newest-first
  filtered.reverse();
  return {
    entries: filtered.slice(0, Math.min(Math.max(limit, 0), 500)),
    total_matched: filtered.length,
    path,
    exists: true,
  };
}

module.exports = { readDmAuditLog, DEFAULT_PATH };
