// Task #246 Per-Ptah-instance ORP TraceRecord substrate per parch #10731 ratify
// + #10744 Q12 fold + #10748 wall-standby Phase C predicate addition. Sister-
// shape ADR-0037 ptahAuditDb.js at per-Ptah-instance file-isolation tier;
// distinct artifact at substrate-design tier (write-cadence + retention +
// read-pattern + contention all differ from audit per parch #10731 6th-axis
// observation).
//
// Storage canon (per PLAN v4 §2.2 + parch #10734 ADD per s345-aieng #10733
// schema-fidelity check): structured TraceRecord fields + engine-diagnostic
// provider/model/parse_status/verify_json for indexed query; JSON blobs
// (proposal_json, goal_state_json, result_ambiguity_json) where
// runtime-evolving shape carries.
//
// File location: /data/ptah-trace-<agent_id>.db (one SQLite file per Ptah
// instance; sister-shape /data/ptah-audit-<agent_id>.db; per-Ptah-instance
// file-isolation canon-class extension per ADR-0037 §6 amendment).
//
// Lifecycle: file created at /register when runtime_class='ptah' (sister-
// shape ptahAuditDb.provisionForAgent). Lazy-init on first POST supported.
//
// Ingestion auth: per-agent bearer (own-only) + ops-key. NO general
// cluster-bearer reads (cross-instance trace contains session-context PII
// per secops #10728 constraint).
//
// Schema CHECK: snapshot_summary capped at 4096 bytes per secops #10728
// (digest "N nodes [frame:...]" per s345-aieng #10733 — conservative cap).

'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DEFAULT_DB_DIR = process.env.YAKLOG_PTAH_TRACE_DB_DIR || '/data';
const DB_FILENAME_PREFIX = 'ptah-trace-';
const DB_FILENAME_SUFFIX = '.db';

const AGENT_ID_RE = /^[a-zA-Z0-9._:@/-]{1,64}$/;
const PTAH_AGENT_ID_RE = /^ptah-[a-zA-Z0-9._:@/-]{1,59}$/;

const SNAPSHOT_SUMMARY_MAX_BYTES = 4096;
const VALID_PARSE_STATUS = new Set(['deterministic', 'ok', 'reject', 'provider_error']);
const VALID_VALIDATION = new Set(['accepted', 'rejected']);

const dbHandles = new Map();

// DDL statements applied via prepare().run() per-statement (sister-shape
// audit_event multi-statement pattern, refactored to per-statement to keep
// the hook surface clean — same semantic effect).
const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS ptah_trace_record (
    trace_id              INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id            TEXT NOT NULL,
    orp_version           TEXT NOT NULL,
    tick                  INTEGER NOT NULL,
    ts_unix_ms            INTEGER NOT NULL,
    received_at           TEXT NOT NULL,
    snapshot_summary      TEXT NOT NULL CHECK(length(snapshot_summary) <= 4096),
    chosen_decision       TEXT NOT NULL,
    proposal_json         TEXT NOT NULL,
    result_validation     TEXT NOT NULL,
    result_reject_reason  TEXT,
    result_resolved_id    TEXT,
    result_ambiguity_json TEXT,
    result_dispatch       TEXT,
    goal_state_json       TEXT NOT NULL,
    provider              TEXT,
    model                 TEXT,
    parse_status          TEXT,
    verify_json           TEXT,
    recorded_by           TEXT NOT NULL,
    UNIQUE(episode_id, tick)
  )`,
  `CREATE INDEX IF NOT EXISTS ix_ptah_trace_episode_tick
    ON ptah_trace_record (episode_id, tick)`,
  `CREATE INDEX IF NOT EXISTS ix_ptah_trace_ts
    ON ptah_trace_record (ts_unix_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS ix_ptah_trace_orp_version
    ON ptah_trace_record (orp_version)`,
  `CREATE INDEX IF NOT EXISTS ix_ptah_trace_parse_status
    ON ptah_trace_record (parse_status)`,
  `CREATE INDEX IF NOT EXISTS ix_ptah_trace_dispatch
    ON ptah_trace_record (result_dispatch)`,
  `CREATE TABLE IF NOT EXISTS ptah_trace_episode (
    episode_id     TEXT PRIMARY KEY,
    orp_version    TEXT NOT NULL,
    role_id        TEXT,
    started_at     TEXT NOT NULL,
    last_tick_at   TEXT NOT NULL,
    last_tick      INTEGER NOT NULL,
    goal_terminal  TEXT,
    manifest_json  TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS ix_ptah_trace_episode_started_at
    ON ptah_trace_episode (started_at DESC)`,
];

function pathFor(agentId) {
  if (!AGENT_ID_RE.test(agentId)) {
    throw new Error('agent_id fails AGENT_ID_RE validation');
  }
  if (!PTAH_AGENT_ID_RE.test(agentId)) {
    throw new Error('agent_id must match ptah-* namespace');
  }
  const safeName = DB_FILENAME_PREFIX + agentId.replace(/[/]/g, '_') + DB_FILENAME_SUFFIX;
  return path.join(DEFAULT_DB_DIR, safeName);
}

function ensureSchema(db) {
  for (const ddl of DDL_STATEMENTS) {
    db.prepare(ddl).run();
  }
}

function getDb(agentId) {
  if (dbHandles.has(agentId)) return dbHandles.get(agentId);
  const dbPath = pathFor(agentId);
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

function listPtahTraceDbs() {
  if (!fs.existsSync(DEFAULT_DB_DIR)) return [];
  return fs.readdirSync(DEFAULT_DB_DIR)
    .filter(f => f.startsWith(DB_FILENAME_PREFIX) && f.endsWith(DB_FILENAME_SUFFIX))
    .map(f => {
      const agentId = f.slice(DB_FILENAME_PREFIX.length, -DB_FILENAME_SUFFIX.length).replace(/_/g, '/');
      return { agentId, path: path.join(DEFAULT_DB_DIR, f) };
    });
}

function provisionForAgent(agentId) {
  return getDb(agentId);
}

function _stringifyJson(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function _deriveGoalTerminal(goalState) {
  if (!Array.isArray(goalState) || goalState.length === 0) return null;
  // Per s345-aieng #10745: 'blocked' is TERMINAL semantic. wall-standby trace
  // keeps goal_state in_progress + uses result_dispatch='wall-standby'.
  for (const g of goalState) {
    if (g.status === 'blocked') return 'blocked';
  }
  for (const g of goalState) {
    if (g.status === 'fail') return 'fail';
  }
  const allPass = goalState.every(g => g.status === 'pass');
  if (allPass) return 'pass';
  return null;
}

function insertTrace(agentId, rec, recordedBy) {
  const db = getDb(agentId);

  if (!rec || typeof rec !== 'object') throw new Error('record required');
  if (!rec.episode_id || typeof rec.episode_id !== 'string') throw new Error('episode_id required');
  if (!rec.orp_version || typeof rec.orp_version !== 'string') throw new Error('orp_version required');
  if (!Number.isInteger(rec.tick) || rec.tick < 0) throw new Error('tick must be non-negative integer');
  if (!Number.isFinite(rec.ts_unix_ms) || rec.ts_unix_ms <= 0) throw new Error('ts_unix_ms required');
  if (typeof rec.snapshot_summary !== 'string') throw new Error('snapshot_summary required');
  if (Buffer.byteLength(rec.snapshot_summary, 'utf8') > SNAPSHOT_SUMMARY_MAX_BYTES) {
    throw new Error(`snapshot_summary exceeds ${SNAPSHOT_SUMMARY_MAX_BYTES} bytes`);
  }
  if (typeof rec.chosen_decision !== 'string') throw new Error('chosen_decision required');
  if (!rec.result || typeof rec.result !== 'object') throw new Error('result required');
  if (!VALID_VALIDATION.has(rec.result.validation)) {
    throw new Error('result.validation must be accepted|rejected');
  }
  if (!Array.isArray(rec.goal_state)) throw new Error('goal_state array required');
  if (rec.parse_status != null && !VALID_PARSE_STATUS.has(rec.parse_status)) {
    throw new Error(`parse_status must be one of: ${Array.from(VALID_PARSE_STATUS).join(',')}`);
  }

  const insertStmt = db.prepare(`
    INSERT INTO ptah_trace_record (
      episode_id, orp_version, tick, ts_unix_ms, received_at,
      snapshot_summary, chosen_decision, proposal_json,
      result_validation, result_reject_reason, result_resolved_id,
      result_ambiguity_json, result_dispatch,
      goal_state_json, provider, model, parse_status, verify_json,
      recorded_by
    ) VALUES (
      @episode_id, @orp_version, @tick, @ts_unix_ms, @received_at,
      @snapshot_summary, @chosen_decision, @proposal_json,
      @result_validation, @result_reject_reason, @result_resolved_id,
      @result_ambiguity_json, @result_dispatch,
      @goal_state_json, @provider, @model, @parse_status, @verify_json,
      @recorded_by
    )
  `);
  const upsertEpisodeStmt = db.prepare(`
    INSERT INTO ptah_trace_episode (
      episode_id, orp_version, role_id, started_at,
      last_tick_at, last_tick, goal_terminal
    ) VALUES (
      @episode_id, @orp_version, @role_id, @ts,
      @ts, @tick, @goal_terminal
    )
    ON CONFLICT(episode_id) DO UPDATE SET
      last_tick_at = excluded.last_tick_at,
      last_tick    = MAX(last_tick, excluded.last_tick),
      goal_terminal = COALESCE(excluded.goal_terminal, goal_terminal)
  `);

  const row = {
    episode_id: rec.episode_id,
    orp_version: rec.orp_version,
    tick: rec.tick,
    ts_unix_ms: rec.ts_unix_ms,
    received_at: new Date().toISOString(),
    snapshot_summary: rec.snapshot_summary,
    chosen_decision: rec.chosen_decision,
    proposal_json: _stringifyJson(rec.proposal) || '{}',
    result_validation: rec.result.validation,
    result_reject_reason: rec.result.reject_reason ?? null,
    result_resolved_id: rec.result.resolved_element_id ?? null,
    result_ambiguity_json: rec.result.ambiguity_candidates
      ? JSON.stringify(rec.result.ambiguity_candidates) : null,
    result_dispatch: rec.result.dispatch_outcome ?? null,
    goal_state_json: JSON.stringify(rec.goal_state),
    provider: rec.provider ?? null,
    model: rec.model ?? null,
    parse_status: rec.parse_status ?? null,
    verify_json: _stringifyJson(rec.verify),
    recorded_by: String(recordedBy || 'unknown'),
  };

  const tx = db.transaction(() => {
    const r = insertStmt.run(row);
    const goalTerminal = _deriveGoalTerminal(rec.goal_state);
    upsertEpisodeStmt.run({
      episode_id: rec.episode_id,
      orp_version: rec.orp_version,
      role_id: rec.role_id ?? null,
      ts: row.received_at,
      tick: rec.tick,
      goal_terminal: goalTerminal,
    });
    return r;
  });
  return tx();
}

function getTracesForEpisode(agentId, episodeId, opts = {}) {
  const db = getDb(agentId);
  const limit = Math.min(Number(opts.limit) || 100, 1000);
  const fromTick = Number.isInteger(opts.fromTick) ? opts.fromTick : 0;
  return db.prepare(`
    SELECT * FROM ptah_trace_record
    WHERE episode_id = @episode_id AND tick >= @from_tick
    ORDER BY tick ASC LIMIT ${limit}
  `).all({ episode_id: episodeId, from_tick: fromTick });
}

function getTracesSince(agentId, opts = {}) {
  const db = getDb(agentId);
  const limit = Math.min(Number(opts.limit) || 100, 1000);
  const sinceTraceId = Number.isInteger(opts.sinceTraceId) ? opts.sinceTraceId : 0;
  return db.prepare(`
    SELECT * FROM ptah_trace_record
    WHERE trace_id > @since
    ORDER BY trace_id ASC LIMIT ${limit}
  `).all({ since: sinceTraceId });
}

function listEpisodes(agentId, opts = {}) {
  const db = getDb(agentId);
  const limit = Math.min(Number(opts.limit) || 50, 200);
  return db.prepare(`
    SELECT episode_id, orp_version, role_id, started_at,
           last_tick_at, last_tick, goal_terminal
    FROM ptah_trace_episode
    ORDER BY started_at DESC LIMIT ${limit}
  `).all();
}

function getEpisodeManifest(agentId, episodeId) {
  const db = getDb(agentId);
  return db.prepare(`
    SELECT * FROM ptah_trace_episode WHERE episode_id = ?
  `).get(episodeId);
}

function setEpisodeManifest(agentId, episodeId, manifest) {
  const db = getDb(agentId);
  return db.prepare(`
    UPDATE ptah_trace_episode SET manifest_json = ? WHERE episode_id = ?
  `).run(JSON.stringify(manifest), episodeId);
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
  SNAPSHOT_SUMMARY_MAX_BYTES,
  VALID_PARSE_STATUS,
  VALID_VALIDATION,
  pathFor,
  getDb,
  listPtahTraceDbs,
  provisionForAgent,
  insertTrace,
  getTracesForEpisode,
  getTracesSince,
  listEpisodes,
  getEpisodeManifest,
  setEpisodeManifest,
  _deriveGoalTerminal,
  closeAll,
};
