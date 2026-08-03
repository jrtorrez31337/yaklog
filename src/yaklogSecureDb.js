// CP14-X Yaklog Secure Store — separate-DB-file substrate-canon class.
// Per Jon-direct ratify #10171 + parch #10175 6-OQ arbitration: ORP authority-
// defining artifacts live in a SEPARATE SQLite file (NOT co-mingled with main
// yaklog.db) at /var/lib/yaklog/yaklog-secure.db. Sister-shape ADR-0030
// audit-by-construction canonical-isolation pattern at storage-tier per
// [[feedback_yaklog_secure_store_separate_db_file_substrate_canon_class_isolation]].
//
// This module owns:
//   - DB handle initialization (separate better-sqlite3 instance from src/db.js)
//   - Schema migration (orp + orp_version tables)
//   - Helper functions for upsertOrp + getOrp + listOrpVersions
//   - Schema validation via ajv (Q2 ratify; major pinned per
//     [[feedback_pin_major_version_for_schema_validation_deps_to_prevent_silent_drift_across_breaking_changes]])
//
// Transactional version-bump per secops Gate (1) condition A (#10172).

'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
// ajv/dist/2020 supports JSON Schema draft-2020-12 (the spec ptah-orp.schema.json
// declares via $schema). Default ajv import only supports draft-07.
const Ajv = require('ajv/dist/2020');

const DEFAULT_DB_PATH = process.env.YAKLOG_YAKLOG_SECURE_DB_PATH || '/data/yaklog-secure.db';
// ORP schema location per parch #10175 Q5 ratify: bind-mount path via
// existing /data/canonical mount (sister-shape <canonical-dir>:/data/canonical:ro
// in docker-compose.yml). ssw-devops Gate (2) install ensures schema file
// is present at this path (ferried into the canonical tree from agent-specs.git).
const DEFAULT_SCHEMA_PATH = process.env.YAKLOG_ORP_SCHEMA_PATH ||
  '/data/canonical/aieng/schemas/ptah-orp.schema.json';

let db = null;
let ajvValidator = null;

function initializeDb(opts = {}) {
  if (db) return db;
  const dbPath = opts.dbPath || DEFAULT_DB_PATH;
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  migrate();
  return db;
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orp (
      agent_id        TEXT PRIMARY KEY,
      orp_json        TEXT NOT NULL,
      version         INTEGER NOT NULL DEFAULT 1,
      schema_version  TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      updated_by      TEXT NOT NULL,
      notes           TEXT
    );

    CREATE TABLE IF NOT EXISTS orp_version (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id        TEXT NOT NULL,
      version         INTEGER NOT NULL,
      orp_json        TEXT NOT NULL,
      schema_version  TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      created_by      TEXT NOT NULL,
      notes           TEXT,
      UNIQUE(agent_id, version)
    );

    CREATE INDEX IF NOT EXISTS idx_orp_version_agent ON orp_version(agent_id, version DESC);
  `);

  // Operator-session Phase A per PLAN-OPERATOR-SESSION-SUBSTRATE v2 RATIFY
  // (Q13 admin §2.10): operator_records artifact-class lives in yaklog-secure.db
  // (sister-shape ORP canon-class isolation at storage-tier per
  // [[feedback_yaklog_secure_store_separate_db_file_substrate_canon_class_isolation]]).
  // Tracks operator-session lifecycle (provisioned → decommissioned). user_email
  // is Anthropic-account identity at audit-tier; per [[feedback_yaklog_identity_overlay_not_columns]]
  // NOT a default dashboard column — surfaces via popover only.
  db.exec(`
    CREATE TABLE IF NOT EXISTS operator_records (
      operator_id     TEXT PRIMARY KEY,
      user_email      TEXT,
      created_at      TEXT NOT NULL,
      created_by      TEXT NOT NULL,
      decommissioned_at TEXT,
      decommissioned_by TEXT,
      notes           TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_operator_records_active ON operator_records(decommissioned_at) WHERE decommissioned_at IS NULL;
  `);
}

function getDb() {
  return db || initializeDb();
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
  ajvValidator = null;
}

// ─── Schema validation (Q2 ratify: ajv pinned major) ────────────────────────
//
// Load ORP schema from bind-mount path. Cache compiled validator at
// module-tier; process restart picks up schema updates.

function loadSchema(schemaPath) {
  // Tests can inline a schema via env var to avoid filesystem dependency.
  if (process.env.YAKLOG_ORP_SCHEMA_INLINE) {
    return JSON.parse(process.env.YAKLOG_ORP_SCHEMA_INLINE);
  }
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`ORP schema not found at ${schemaPath}`);
  }
  const raw = fs.readFileSync(schemaPath, 'utf-8');
  return JSON.parse(raw);
}

function getValidator() {
  if (ajvValidator) return ajvValidator;
  const schema = loadSchema(DEFAULT_SCHEMA_PATH);
  const ajv = new Ajv({ allErrors: true, strict: false });
  ajvValidator = ajv.compile(schema);
  return ajvValidator;
}

function validateOrpJson(orpJson) {
  const validator = getValidator();
  const ok = validator(orpJson);
  if (ok) return { valid: true };
  return {
    valid: false,
    errors: validator.errors.map((e) => `${e.instancePath || '(root)'}: ${e.message}`),
  };
}

// ─── ORP CRUD with transactional version-bump (secops Gate (1) condition A) ─

function getOrp(agentId) {
  const row = getDb().prepare('SELECT * FROM orp WHERE agent_id = ?').get(agentId);
  if (!row) return null;
  return {
    agent_id: row.agent_id,
    orp_json: JSON.parse(row.orp_json),
    version: row.version,
    schema_version: row.schema_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    notes: row.notes,
    // updated_by intentionally NOT exposed in public read shape (ops-tier audit)
  };
}

function upsertOrp({ agentId, orpJson, schemaVersion, actor, notes }) {
  // Transactional per secops Gate (1) condition A: BEGIN/COMMIT wraps
  // version-read + history-insert + current-upsert atomically.
  const txn = getDb().transaction((aid, json, sv, act, nt) => {
    const jsonStr = typeof json === 'string' ? json : JSON.stringify(json);
    const current = getDb().prepare('SELECT version FROM orp WHERE agent_id = ?').get(aid);
    const nextVersion = (current?.version || 0) + 1;
    const now = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO orp_version (agent_id, version, orp_json, schema_version, created_at, created_by, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(aid, nextVersion, jsonStr, sv, now, act, nt || null);
    getDb().prepare(`
      INSERT INTO orp (agent_id, orp_json, version, schema_version, created_at, updated_at, updated_by, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        orp_json = excluded.orp_json,
        version = excluded.version,
        schema_version = excluded.schema_version,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by,
        notes = excluded.notes
    `).run(aid, jsonStr, nextVersion, sv, now, now, act, nt || null);
    return { agent_id: aid, version: nextVersion, updated_at: now, actor: act };
  });
  return txn(agentId, orpJson, schemaVersion, actor, notes);
}

function listOrpVersions(agentId, limit = 20) {
  const rows = getDb().prepare(`
    SELECT version, schema_version, created_at, created_by, notes
    FROM orp_version
    WHERE agent_id = ?
    ORDER BY version DESC
    LIMIT ?
  `).all(agentId, Math.min(limit, 100));
  return rows;
}

// ─── Operator-session record CRUD (Phase A per PLAN v2 §2.10) ───────────────

function upsertOperatorRecord({ operatorId, userEmail, actor, notes }) {
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO operator_records (operator_id, user_email, created_at, created_by, notes)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(operator_id) DO UPDATE SET
      user_email = excluded.user_email,
      notes = excluded.notes
  `).run(operatorId, userEmail || null, now, actor, notes || null);
  return { operator_id: operatorId, created_at: now };
}

function getOperatorRecord(operatorId) {
  return getDb().prepare('SELECT * FROM operator_records WHERE operator_id = ?').get(operatorId) || null;
}

function listOperatorRecords({ includeDecommissioned = false } = {}) {
  const sql = includeDecommissioned
    ? 'SELECT * FROM operator_records ORDER BY created_at DESC'
    : 'SELECT * FROM operator_records WHERE decommissioned_at IS NULL ORDER BY created_at DESC';
  return getDb().prepare(sql).all();
}

function decommissionOperatorRecord({ operatorId, actor, notes }) {
  const now = new Date().toISOString();
  const res = getDb().prepare(`
    UPDATE operator_records
    SET decommissioned_at = ?, decommissioned_by = ?, notes = COALESCE(?, notes)
    WHERE operator_id = ? AND decommissioned_at IS NULL
  `).run(now, actor, notes || null, operatorId);
  return { operator_id: operatorId, decommissioned_at: now, updated: res.changes };
}

module.exports = {
  initializeDb,
  getDb,
  closeDb,
  validateOrpJson,
  getOrp,
  upsertOrp,
  listOrpVersions,
  upsertOperatorRecord,
  getOperatorRecord,
  listOperatorRecords,
  decommissionOperatorRecord,
  _internal: { loadSchema, getValidator },
};
