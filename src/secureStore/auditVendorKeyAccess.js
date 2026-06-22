// Task #138 Phase 2A audit-trail per secops #10237 Cond 5 + #10249 PASS.
// Every successful GET to /api/v1/secure-store/vendor-keys writes an audit row.
// Failed GETs also audit-logged (forensic-complete).
//
// Row shape (per PLAN-VENDOR-KEY-DELIVERY-SUBSTRATE.md §3.5):
//   (ts, agent_id, vendors_csv, outcome, source_ip)
// Never persists key value — only vendor NAMES + outcome.

'use strict';

const { getDb } = require('../db');

function ensureSchema() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_vendor_key_access (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          TEXT NOT NULL,
      agent_id    TEXT NOT NULL,
      vendors_csv TEXT NOT NULL DEFAULT '',
      outcome     TEXT NOT NULL,
      source_ip   TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_audit_vk_ts ON audit_vendor_key_access (ts);
    CREATE INDEX IF NOT EXISTS ix_audit_vk_agent ON audit_vendor_key_access (agent_id);
    CREATE INDEX IF NOT EXISTS ix_audit_vk_outcome ON audit_vendor_key_access (outcome);
  `);
}

function recordAccess({ agent_id, vendors_csv, outcome, source_ip }) {
  ensureSchema();
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO audit_vendor_key_access (ts, agent_id, vendors_csv, outcome, source_ip)
    VALUES (@ts, @agent_id, @vendors_csv, @outcome, @source_ip)
  `);
  return stmt.run({
    ts: new Date().toISOString(),
    agent_id: String(agent_id || ''),
    vendors_csv: String(vendors_csv || ''),
    outcome: String(outcome),
    source_ip: source_ip ? String(source_ip) : null,
  });
}

function _getRecentForTests(agentId, limit = 10) {
  ensureSchema();
  const db = getDb();
  return db.prepare(
    `SELECT * FROM audit_vendor_key_access WHERE agent_id = @agent_id ORDER BY ts DESC LIMIT ${Math.min(limit, 100)}`
  ).all({ agent_id: agentId });
}

module.exports = {
  ensureSchema,
  recordAccess,
  _getRecentForTests,
};
