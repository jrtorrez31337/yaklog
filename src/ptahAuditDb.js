// Task #137 Per-Ptah-Agent Audit File substrate per parch #10266 ratify.
// ADR-0037 candidate. Sister-shape canon to CP14-X plexusSecureDb.js at
// per-class-canon-isolation tier, extended HERE to per-agent granularity
// per parch #10266 Q1 ratify (per-agent file vs single shared).
//
// Storage canon (per parch #10266 Q4 ratify): structured columns
// (cost/tokens/model/tool/timing for cross-agent aggregate indexing) +
// context_json blob (Ptah-specific evolution; opaque to substrate).
//
// File location: /data/ptah-audit-<agent_id>.db (one SQLite file per Ptah agent;
// extends [[feedback_plexus_secure_store_separate_db_file_substrate_canon_class_isolation]]
// from per-class to per-agent tier).
//
// Lifecycle (per parch #10266 Q2 ratify): file created at /register time for
// agents with explicit runtime_class='ptah' (per Q3 ratify). Lazy-init on
// first audit POST also supported as defense-in-depth (in case /register
// hook missed it).
//
// Ingestion auth (per parch #10266 Q7 ratify): per-agent bearer (Ptah self-POST
// its own audit trail) + ops-key (operator/admin-tier write); both auth
// modes accepted.
//
// Per parch #10266 Q9: backup discipline = cadence-based daily
// (sister-shape yaklog.db.bak-* pattern; ssw-devops Gate (2) install).
//
// WAL checkpoint cron extension per Q6 ratify: ssw-devops cron whitelist
// regex pattern `ptah-audit-<agent_id>` (validated via AGENT_ID_RE at
// checkpoint request tier).

'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DEFAULT_DB_DIR = process.env.YAKLOG_PTAH_AUDIT_DB_DIR || '/data';
const DB_FILENAME_PREFIX = 'ptah-audit-';
const DB_FILENAME_SUFFIX = '.db';

// Sister-shape AGENT_ID_RE in src/routes.js (and ptah-* namespace bound
// per parch #10266 /register sub-OQ Option (c)). Validates input before
// constructing filesystem path — defense against path-injection.
const AGENT_ID_RE = /^[a-zA-Z0-9._:@/-]{1,64}$/;
// Per /register sub-OQ Option (c) trusted-runtime bootstrap WITH SCOPED
// `ptah-*` namespace bounds: bootstrap secret mints ONLY ptah-* agent_ids.
// This module's helpers also reject non-ptah-* for defense-in-depth.
const PTAH_AGENT_ID_RE = /^ptah-[a-zA-Z0-9._:@/-]{1,59}$/;

// One DB handle per agent_id, cached after first open.
const dbHandles = new Map();

function pathFor(agentId) {
  if (!AGENT_ID_RE.test(agentId)) {
    throw new Error('agent_id fails AGENT_ID_RE validation');
  }
  if (!PTAH_AGENT_ID_RE.test(agentId)) {
    throw new Error('agent_id must match ptah-* namespace per /register sub-OQ Option (c)');
  }
  // Allow / in agent_id but never let it construct a directory traversal.
  // Replace / with _ + explicit prefix/suffix discipline.
  const safeName = DB_FILENAME_PREFIX + agentId.replace(/[/]/g, '_') + DB_FILENAME_SUFFIX;
  return path.join(DEFAULT_DB_DIR, safeName);
}

function ensureSchema(db) {
  // Structured columns per Q4 ratify: cost_usd_micros / tokens_*  / model /
  // tool_name / tool_status / elapsed_ms for cross-agent aggregate indexing.
  // context_json blob: Ptah-specific evolution (opaque to substrate).
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_event (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id            TEXT NOT NULL,
      occurred_at         TEXT NOT NULL,
      received_at         TEXT NOT NULL,
      event_kind          TEXT NOT NULL,
      tool_name           TEXT,
      tool_status         TEXT,
      model               TEXT,
      cost_usd_micros     INTEGER NOT NULL DEFAULT 0,
      tokens_input        INTEGER NOT NULL DEFAULT 0,
      tokens_output       INTEGER NOT NULL DEFAULT 0,
      tokens_cache_read   INTEGER NOT NULL DEFAULT 0,
      tokens_cache_write  INTEGER NOT NULL DEFAULT 0,
      elapsed_ms          INTEGER,
      auth_mode           TEXT NOT NULL,
      context_json        TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_event_event_id
      ON audit_event (event_id);
    CREATE INDEX IF NOT EXISTS ix_audit_event_occurred_at
      ON audit_event (occurred_at);
    CREATE INDEX IF NOT EXISTS ix_audit_event_event_kind
      ON audit_event (event_kind);
    CREATE INDEX IF NOT EXISTS ix_audit_event_tool_name
      ON audit_event (tool_name);
    CREATE INDEX IF NOT EXISTS ix_audit_event_model
      ON audit_event (model);
  `);
}

function getDb(agentId) {
  if (dbHandles.has(agentId)) return dbHandles.get(agentId);
  const dbPath = pathFor(agentId);
  // Ensure parent dir exists (idempotent; container-level mount canon).
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);
  dbHandles.set(agentId, db);
  return db;
}

function listPtahDbs() {
  // Used by ssw-devops WAL cron + backup cron (Q6 + Q9 ratify).
  // Discovers all currently-existing per-Ptah-agent DB files.
  if (!fs.existsSync(DEFAULT_DB_DIR)) return [];
  return fs.readdirSync(DEFAULT_DB_DIR)
    .filter(f => f.startsWith(DB_FILENAME_PREFIX) && f.endsWith(DB_FILENAME_SUFFIX))
    .map(f => {
      const agentId = f.slice(DB_FILENAME_PREFIX.length, -DB_FILENAME_SUFFIX.length).replace(/_/g, '/');
      return { agentId, path: path.join(DEFAULT_DB_DIR, f) };
    });
}

function provisionForAgent(agentId) {
  // Called by /register handler when runtime_class='ptah' (Q2 + Q3 ratify):
  // pre-create the file + schema at registration time so first POST has
  // clean latency. Idempotent (no-op if file already exists with schema).
  return getDb(agentId);
}

function insertEvent(agentId, event) {
  const db = getDb(agentId);
  const stmt = db.prepare(`
    INSERT INTO audit_event (
      event_id, occurred_at, received_at, event_kind,
      tool_name, tool_status, model,
      cost_usd_micros, tokens_input, tokens_output,
      tokens_cache_read, tokens_cache_write,
      elapsed_ms, auth_mode, context_json
    ) VALUES (
      @event_id, @occurred_at, @received_at, @event_kind,
      @tool_name, @tool_status, @model,
      @cost_usd_micros, @tokens_input, @tokens_output,
      @tokens_cache_read, @tokens_cache_write,
      @elapsed_ms, @auth_mode, @context_json
    )
  `);
  const row = {
    event_id: String(event.event_id),
    occurred_at: String(event.occurred_at),
    received_at: new Date().toISOString(),
    event_kind: String(event.event_kind),
    tool_name: event.tool_name == null ? null : String(event.tool_name),
    tool_status: event.tool_status == null ? null : String(event.tool_status),
    model: event.model == null ? null : String(event.model),
    cost_usd_micros: Number(event.cost_usd_micros) || 0,
    tokens_input: Number(event.tokens_input) || 0,
    tokens_output: Number(event.tokens_output) || 0,
    tokens_cache_read: Number(event.tokens_cache_read) || 0,
    tokens_cache_write: Number(event.tokens_cache_write) || 0,
    elapsed_ms: event.elapsed_ms == null ? null : Number(event.elapsed_ms),
    auth_mode: String(event.auth_mode),
    context_json: event.context_json == null
      ? null
      : (typeof event.context_json === 'string'
          ? event.context_json
          : JSON.stringify(event.context_json)),
  };
  return stmt.run(row);
}

function getEventsForAgent(agentId, opts = {}) {
  const db = getDb(agentId);
  const limit = Math.min(Number(opts.limit) || 100, 1000);
  const where = [];
  const params = {};
  if (opts.from) { where.push('occurred_at >= @from'); params.from = opts.from; }
  if (opts.to)   { where.push('occurred_at <= @to');   params.to   = opts.to; }
  if (opts.event_kind) { where.push('event_kind = @event_kind'); params.event_kind = opts.event_kind; }
  const sql = `SELECT * FROM audit_event ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY occurred_at DESC LIMIT ${limit}`;
  return db.prepare(sql).all(params);
}

function unionAllEvents(opts = {}) {
  // Cross-agent aggregate per Q5 ratify (UNION-ALL initial at small N;
  // roll-up forward-track when N>50 OR query latency surfaces).
  const dbs = listPtahDbs();
  if (dbs.length === 0) return [];
  const limit = Math.min(Number(opts.limit) || 100, 1000);
  const merged = [];
  for (const { agentId } of dbs) {
    const events = getEventsForAgent(agentId, { ...opts, limit });
    for (const e of events) {
      merged.push({ ...e, agent_id: agentId });
    }
  }
  merged.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));
  return merged.slice(0, limit);
}

function closeAll() {
  for (const db of dbHandles.values()) {
    try { db.close(); } catch {}
  }
  dbHandles.clear();
}

module.exports = {
  AGENT_ID_RE,
  PTAH_AGENT_ID_RE,
  pathFor,
  getDb,
  listPtahDbs,
  provisionForAgent,
  insertEvent,
  getEventsForAgent,
  unionAllEvents,
  closeAll,
};
