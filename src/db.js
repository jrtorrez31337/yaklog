const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { EventEmitter } = require('node:events');

const config = require('./config');
const { parseMentions } = require('./mentions');

const messageBus = new EventEmitter();
messageBus.setMaxListeners(0);

let db;

function parseMetadata(raw) {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseMentionsField(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toMessage(row) {
  return {
    id: row.id,
    seq: row.id,
    channel: row.channel,
    sender: row.sender,
    body: row.body,
    metadata: parseMetadata(row.metadata_json),
    mentions: parseMentionsField(row.mentions),
    created_at: row.created_at,
    updated_at: row.updated_at || null
  };
}

function initializeDb() {
  if (db) {
    return db;
  }

  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      sender TEXT NOT NULL,
      body TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel, id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  `);

  try {
    db.exec(`ALTER TABLE messages ADD COLUMN updated_at TEXT`);
  } catch (err) {
    if (!err.message.includes('duplicate column')) {
      throw err;
    }
  }

  try {
    db.exec(`ALTER TABLE messages ADD COLUMN mentions TEXT`);
  } catch (err) {
    if (!err.message.includes('duplicate column')) {
      throw err;
    }
  }

  const rowsToBackfill = db
    .prepare('SELECT id, body FROM messages WHERE mentions IS NULL')
    .all();
  if (rowsToBackfill.length > 0) {
    const updateBackfill = db.prepare('UPDATE messages SET mentions = ? WHERE id = ?');
    const runBackfill = db.transaction((rows) => {
      for (const row of rows) {
        updateBackfill.run(JSON.stringify(parseMentions(row.body)), row.id);
      }
    });
    runBackfill(rowsToBackfill);
  }

  db.prepare(`
    CREATE TABLE IF NOT EXISTS presence (
      agent_id              TEXT PRIMARY KEY,
      daemon_state          TEXT NOT NULL CHECK (daemon_state IN ('up','down')),
      session_state         TEXT NOT NULL CHECK (session_state IN ('active','idle','unknown','tool_running','idle_between_tools')),
      cursor_position       INTEGER,
      lock_held             INTEGER NOT NULL DEFAULT 0,
      sse_connected         INTEGER NOT NULL DEFAULT 0,
      last_heartbeat_at     TEXT NOT NULL,
      last_hook_at          TEXT,
      last_state_change_at  TEXT NOT NULL
    )
  `).run();

  // v0.5.6 migration: add events_consumer_count column + drop session_state
  // CHECK constraint (to allow new "compacting" state without further migrations).
  // Per yaklog #5061 + Jon-direct #5452 + daemon-side #5453 cohort cutover plan.
  const presenceCols = db.pragma('table_info(presence)');
  const hasEventsConsumerCount = presenceCols.some((c) => c.name === 'events_consumer_count');
  const sessionStateColInfo = presenceCols.find((c) => c.name === 'session_state');
  const needsCheckDrop = sessionStateColInfo && (
    db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='presence'").get()?.sql || ''
  ).includes("session_state         TEXT NOT NULL CHECK");

  if (!hasEventsConsumerCount || needsCheckDrop) {
    db.exec(`
      ALTER TABLE presence RENAME TO presence_v055;
      CREATE TABLE presence (
        agent_id              TEXT PRIMARY KEY,
        daemon_state          TEXT NOT NULL CHECK (daemon_state IN ('up','down')),
        session_state         TEXT NOT NULL,
        cursor_position       INTEGER,
        lock_held             INTEGER NOT NULL DEFAULT 0,
        sse_connected         INTEGER NOT NULL DEFAULT 0,
        events_consumer_count INTEGER,
        last_heartbeat_at     TEXT NOT NULL,
        last_hook_at          TEXT,
        last_state_change_at  TEXT NOT NULL
      );
      INSERT INTO presence (agent_id, daemon_state, session_state, cursor_position, lock_held, sse_connected, last_heartbeat_at, last_hook_at, last_state_change_at)
        SELECT agent_id, daemon_state, session_state, cursor_position, lock_held, sse_connected, last_heartbeat_at, last_hook_at, last_state_change_at FROM presence_v055;
      DROP TABLE presence_v055;
    `);
  }

  // v0.5.7 migration: idempotent ADD COLUMN for runtime-meta fields per
  // Plexus enterprise dashboard ask (Jon-direct 2026-05-24). Pre-v0.5.7
  // daemons send NULL for these; v0.5.7+ daemons distill from CC stdin
  // payload (model, current tool, tool errors, compaction trigger, stop
  // reason, subagent activity). 9 fields total. SQLite ADD COLUMN is
  // idempotent via the hasCol pattern (no table-rebuild needed; no
  // existing-row migration needed -- new columns default to NULL).
  const presenceColsV057 = db.pragma('table_info(presence)');
  const presenceColNames = new Set(presenceColsV057.map((c) => c.name));
  const RUNTIME_META_COLUMNS = [
    ['current_model', 'TEXT'],
    ['current_tool', 'TEXT'],
    ['last_tool_name', 'TEXT'],
    ['last_tool_status', 'TEXT'],         // 'ok'|'error'|NULL
    ['last_compaction_reason', 'TEXT'],   // 'manual'|'auto'|NULL
    ['last_compaction_at', 'TEXT'],       // ISO-8601 or NULL
    ['last_stop_reason', 'TEXT'],         // 'natural'|'failure'|NULL
    ['last_session_source', 'TEXT'],      // 'startup'|'resume'|'clear'|'compact'|NULL
    ['subagent_active_count', 'INTEGER'], // running count; floor 0
    // v0.5.7.3 (2026-05-25): runtime-environment fields for AgentCard
    // Environment view (CP6.8). Captured by yaklog-sub at daemon start
    // (uid/gid/hostname) + from CC SessionStart payload (cwd).
    ['runtime_uid', 'INTEGER'],           // os.getuid() of daemon process
    ['runtime_gid', 'INTEGER'],           // os.getgid() of daemon process
    ['runtime_hostname', 'TEXT'],         // socket.gethostname()
    ['current_cwd', 'TEXT'],              // CC SessionStart.payload.cwd
  ];
  for (const [colName, colType] of RUNTIME_META_COLUMNS) {
    if (!presenceColNames.has(colName)) {
      db.exec(`ALTER TABLE presence ADD COLUMN ${colName} ${colType}`);
    }
  }
  db.prepare(`
    CREATE TABLE IF NOT EXISTS presence_transitions (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id              TEXT NOT NULL,
      from_label            TEXT,
      to_label              TEXT NOT NULL,
      occurred_at           TEXT NOT NULL,
      reason                TEXT
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_transitions_agent_time ON presence_transitions(agent_id, occurred_at DESC)`).run();

  // Agent /register endpoint state machine per ADR-0025 (committed
  // 2026-05-19 at parch@devel:~/adr/0025-yaklog-register-endpoint-agent-
  // registration-state-machine.md) + ferry-canon (agent-specs.git@1c6cd00).
  // State machine: NEW → SUBMITTED → PARCH_REVIEW → JON_RATIFY →
  // APPROVED_PENDING_FERRY → FERRIED → PENDING_ACTIVATION → ACTIVE; or
  // REJECTED/REVOKED terminal.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS registrations (
      registration_id          TEXT PRIMARY KEY,
      agent_id                 TEXT NOT NULL,
      status                   TEXT NOT NULL,
      registrant_pubkey        TEXT NOT NULL,
      registrant_token_hash    TEXT,
      minted_token_hash        TEXT,
      ciphertext_b64           TEXT,
      justification_json       TEXT,
      submission_json          TEXT NOT NULL,
      ratified_by              TEXT,
      ratified_at              TEXT,
      ferried_by               TEXT,
      ferried_at               TEXT,
      activated_at             TEXT,
      revoked_at               TEXT,
      revoked_reason           TEXT,
      rejected_reason          TEXT,
      created_at               TEXT NOT NULL,
      updated_at               TEXT NOT NULL
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_registrations_agent_status ON registrations(agent_id, status)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_registrations_status ON registrations(status)`).run();
  // v0.5.6 → wave-2 migration: ensure minted_token_hash column exists on
  // pre-wave-2 registrations table (wave-1 created the table without it).
  const regCols = db.pragma('table_info(registrations)');
  if (!regCols.some((c) => c.name === 'minted_token_hash')) {
    db.exec(`ALTER TABLE registrations ADD COLUMN minted_token_hash TEXT`);
  }
  // Index for auth-middleware dual-source lookup (sha256 hex hash; unique
  // among ACTIVE entries — terminal/non-ACTIVE entries excluded by status
  // filter in the lookup query).
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_registrations_minted_token_hash ON registrations(minted_token_hash) WHERE minted_token_hash IS NOT NULL`).run();

  // Append-only audit-event log per admin-agent #5391 Layer-1 schema
  // (CRDB→SQLite translated per yaklog-dev #5392/#5436). sha256-prefix-only
  // invariant: NEVER store full token / full pubkey / full ciphertext —
  // only 16-char hex prefixes for forensic correlation.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS registration_events (
      event_id                          TEXT PRIMARY KEY,
      registration_id                   TEXT NOT NULL,
      agent_id                          TEXT NOT NULL,
      ts                                TEXT NOT NULL,
      event_type                        TEXT NOT NULL,
      actor                             TEXT NOT NULL,
      ciphertext_sha256_prefix          TEXT,
      token_sha256_prefix               TEXT,
      registrant_pubkey_sha256_prefix   TEXT,
      metadata_json                     TEXT
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_reg_events_registration ON registration_events(registration_id, ts DESC)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_reg_events_agent ON registration_events(agent_id, ts DESC)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_reg_events_type ON registration_events(event_type, ts DESC)`).run();

  return db;
}

function getDb() {
  return db || initializeDb();
}

function insertMessage({ channel, sender, body, metadata = null }) {
  const database = getDb();
  const mentions = parseMentions(body);
  const stmt = database.prepare(`
    INSERT INTO messages (channel, sender, body, metadata_json, mentions)
    VALUES (@channel, @sender, @body, @metadata_json, @mentions)
  `);

  const result = stmt.run({
    channel,
    sender,
    body,
    metadata_json: metadata ? JSON.stringify(metadata) : null,
    mentions: JSON.stringify(mentions)
  });

  const row = database
    .prepare('SELECT id, channel, sender, body, metadata_json, mentions, created_at, updated_at FROM messages WHERE id = ?')
    .get(result.lastInsertRowid);

  const message = toMessage(row);
  messageBus.emit('message', message);
  return message;
}

function listMessages({ channel, limit = 50, afterId = null, beforeId = null }) {
  const database = getDb();
  const where = [];
  const params = { limit };

  if (channel) {
    where.push('channel = @channel');
    params.channel = channel;
  }

  if (afterId !== null) {
    where.push('id > @afterId');
    params.afterId = afterId;
  }

  if (beforeId !== null) {
    where.push('id < @beforeId');
    params.beforeId = beforeId;
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = database
    .prepare(`
      SELECT id, channel, sender, body, metadata_json, mentions, created_at, updated_at
      FROM messages
      ${whereSql}
      ORDER BY id DESC
      LIMIT @limit
    `)
    .all(params);

  return rows.reverse().map(toMessage);
}

function listMessagesAfter({ afterId, channel, excludeSender, mentions }) {
  const database = getDb();
  const where = ['id > @afterId'];
  const params = { afterId };
  if (channel) { where.push('channel = @channel'); params.channel = channel; }
  if (excludeSender) { where.push('sender != @excludeSender'); params.excludeSender = excludeSender; }
  const rows = database
    .prepare(`SELECT id, channel, sender, body, metadata_json, mentions, created_at, updated_at
              FROM messages
              WHERE ${where.join(' AND ')}
              ORDER BY id ASC`)
    .all(params);
  const filtered = rows.map(toMessage).filter((m) => {
    if (!mentions || mentions.length === 0) return true;
    const msgMentions = m.mentions || [];
    return mentions.some((mention) => msgMentions.includes(mention));
  });
  return filtered;
}

function listChannels(limit = 100) {
  const database = getDb();
  return database
    .prepare(`
      SELECT
        channel,
        COUNT(*) AS message_count,
        MAX(id) AS latest_id,
        MAX(created_at) AS last_message_at
      FROM messages
      GROUP BY channel
      ORDER BY latest_id DESC
      LIMIT ?
    `)
    .all(limit);
}

function getGlobalHwm() {
  const database = getDb();
  const row = database.prepare('SELECT MAX(id) AS hwm FROM messages').get();
  return row && row.hwm ? row.hwm : 0;
}

function getMessage(id) {
  const database = getDb();
  const row = database
    .prepare('SELECT id, channel, sender, body, metadata_json, mentions, created_at, updated_at FROM messages WHERE id = ?')
    .get(id);
  return row ? toMessage(row) : null;
}

function updateMessage(id, { body, metadata } = {}) {
  const database = getDb();
  const sets = [];
  const params = { id };

  if (body !== undefined) {
    sets.push('body = @body');
    params.body = body;
    sets.push('mentions = @mentions');
    params.mentions = JSON.stringify(parseMentions(body));
  }

  if (metadata !== undefined) {
    sets.push('metadata_json = @metadata_json');
    params.metadata_json = metadata ? JSON.stringify(metadata) : null;
  }

  if (sets.length === 0) {
    return null;
  }

  sets.push("updated_at = datetime('now')");

  const result = database
    .prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = @id`)
    .run(params);

  if (result.changes === 0) {
    return null;
  }

  return getMessage(id);
}

function deleteMessage(id) {
  const database = getDb();
  const result = database.prepare('DELETE FROM messages WHERE id = ?').run(id);
  return result.changes > 0;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// ============================================================================
// /register state machine (ADR-0025 + ferry-canon)
// ============================================================================

function insertRegistration({ registration_id, agent_id, registrant_pubkey, registrant_token_hash, submission_json }) {
  const database = getDb();
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO registrations (
      registration_id, agent_id, status, registrant_pubkey,
      registrant_token_hash, submission_json, created_at, updated_at
    )
    VALUES (@registration_id, @agent_id, 'SUBMITTED', @registrant_pubkey,
            @registrant_token_hash, @submission_json, @now, @now)
  `).run({ registration_id, agent_id, registrant_pubkey, registrant_token_hash, submission_json, now });
  return getRegistration(registration_id);
}

function getRegistration(registration_id) {
  const database = getDb();
  return database.prepare('SELECT * FROM registrations WHERE registration_id = ?').get(registration_id) || null;
}

function getRegistrationByAgent(agent_id) {
  // Returns the most recent NON-terminal registration for this agent,
  // or null. ADR §Defaults+invariants: same agent_id can have ≤1
  // non-terminal registration at a time.
  const database = getDb();
  return database.prepare(`
    SELECT * FROM registrations
    WHERE agent_id = ?
      AND status IN ('SUBMITTED','PARCH_REVIEW','JON_RATIFY','APPROVED_PENDING_FERRY','FERRIED','PENDING_ACTIVATION')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(agent_id) || null;
}

// Dual-source auth-middleware support per Jon-direct 2026-05-19 DB-lookup
// architecture. Returns the ACTIVE registration row matching a sha256 hash,
// or null. Auth caller MUST sha256(token-from-Bearer) before calling.
function getActiveRegistrationByMintedTokenHash(token_hash) {
  const database = getDb();
  return database.prepare(`
    SELECT * FROM registrations
    WHERE status = 'ACTIVE' AND minted_token_hash = ?
  `).get(token_hash) || null;
}

function listRegistrationsByStatus(status) {
  const database = getDb();
  return database.prepare('SELECT * FROM registrations WHERE status = ? ORDER BY created_at ASC').all(status);
}

function updateRegistration(registration_id, fields) {
  // Generic update: merges allowed fields. Caller is responsible for
  // state-machine legality (route handlers enforce per-transition rules).
  const database = getDb();
  const now = new Date().toISOString();
  const allowed = new Set([
    'status', 'justification_json', 'ciphertext_b64',
    'registrant_token_hash', 'minted_token_hash',
    'ratified_by', 'ratified_at',
    'ferried_by', 'ferried_at',
    'activated_at', 'revoked_at', 'revoked_reason', 'rejected_reason'
  ]);
  const sets = [];
  const params = { registration_id, now };
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.has(k)) continue;
    sets.push(`${k} = @${k}`);
    params[k] = v;
  }
  if (sets.length === 0) return getRegistration(registration_id);
  sets.push('updated_at = @now');
  const result = database.prepare(
    `UPDATE registrations SET ${sets.join(', ')} WHERE registration_id = @registration_id`
  ).run(params);
  if (result.changes === 0) return null;
  return getRegistration(registration_id);
}

function insertRegistrationEvent({ registration_id, agent_id, event_type, actor,
                                    ciphertext_sha256_prefix, token_sha256_prefix,
                                    registrant_pubkey_sha256_prefix, metadata }) {
  // sha256-prefix-only invariant per admin #5391. NEVER full secrets here.
  const database = getDb();
  const now = new Date().toISOString();
  const event_id = require('crypto').randomUUID();
  database.prepare(`
    INSERT INTO registration_events (
      event_id, registration_id, agent_id, ts, event_type, actor,
      ciphertext_sha256_prefix, token_sha256_prefix, registrant_pubkey_sha256_prefix,
      metadata_json
    )
    VALUES (@event_id, @registration_id, @agent_id, @ts, @event_type, @actor,
            @ciphertext_sha256_prefix, @token_sha256_prefix, @registrant_pubkey_sha256_prefix,
            @metadata_json)
  `).run({
    event_id, registration_id, agent_id, ts: now, event_type, actor,
    ciphertext_sha256_prefix: ciphertext_sha256_prefix ?? null,
    token_sha256_prefix: token_sha256_prefix ?? null,
    registrant_pubkey_sha256_prefix: registrant_pubkey_sha256_prefix ?? null,
    metadata_json: metadata ? JSON.stringify(metadata) : null
  });
  return event_id;
}

function listRegistrationEvents(registration_id) {
  const database = getDb();
  return database.prepare(
    'SELECT * FROM registration_events WHERE registration_id = ? ORDER BY ts ASC'
  ).all(registration_id);
}

const PRESENCE_LABELS = {
  up: {
    active: 'online',
    idle: 'online_idle',
    unknown: 'stalled',
    tool_running: 'online_tool_running',
    idle_between_tools: 'online_idle_between_tools',
    compacting: 'online_compacting'
  },
  down: { active: 'offline', idle: 'offline', unknown: 'offline', tool_running: 'offline', idle_between_tools: 'offline', compacting: 'offline' }
};

// v0.5.6: daemon_only label per yaklog #5061 + Jon-direct #5452.
// v0.5.7.2 (2026-05-25): only short-circuit to daemon_only when
// session_state is 'unknown'. Pre-fix the short-circuit OVERRODE an
// active session_state (tool_running / idle_between_tools / compacting /
// active / idle), causing actively-working agents to display as
// "daemon_only" if their events.ndjson Monitor was dead (= conflated
// two orthogonal health signals: message-stream consumption vs hook-
// driven session activity). Now: if session_state is known-active,
// honor it. The Monitor-dead signal (events_consumer_count===0) is
// still surfaced separately via the dashboard's Monitor pill.
//
// Daemon up + zero non-self consumers of events.ndjson = substrate
// alive but no client process is consuming the stream. Distinct from
// 'stalled' (which means consumer>0 + session_state=unknown — actual
// wedge candidate). Pre-v0.5.6 daemons that don't send the field
// (events_consumer_count IS NULL) fall back to v0.5.5 derivation.
function deriveLabel(daemon_state, session_state, events_consumer_count) {
  if (daemon_state === 'up' && events_consumer_count === 0 && session_state === 'unknown') {
    return 'daemon_only';
  }
  return (PRESENCE_LABELS[daemon_state] || {})[session_state] || 'offline';
}

function upsertPresence({
  agent_id, daemon_state, session_state, cursor_position, lock_held,
  sse_connected, last_hook_at, reason, events_consumer_count,
  // v0.5.7 runtime-meta (all optional; null when daemon < v0.5.7)
  current_model, current_tool, last_tool_name, last_tool_status,
  last_compaction_reason, last_compaction_at, last_stop_reason,
  last_session_source, subagent_active_count,
  // v0.5.7.3 runtime-environment (all optional; null when daemon < v0.5.7.3)
  runtime_uid, runtime_gid, runtime_hostname, current_cwd
}) {
  const database = getDb();
  const now = new Date().toISOString();
  const newLabel = deriveLabel(daemon_state, session_state, events_consumer_count);

  const existing = database.prepare('SELECT * FROM presence WHERE agent_id = ?').get(agent_id);
  const oldLabel = existing ? deriveLabel(existing.daemon_state, existing.session_state, existing.events_consumer_count) : null;
  // v0.5.6: transition fires when label changes (covers events_consumer_count
  // crossing 0 → 1 or 1 → 0 producing daemon_only ↔ online transitions).
  const stateChanged = !existing
    || existing.daemon_state !== daemon_state
    || existing.session_state !== session_state
    || oldLabel !== newLabel;

  const last_state_change_at = stateChanged ? now : (existing ? existing.last_state_change_at : now);

  const stmt = database.prepare(`
    INSERT INTO presence (
      agent_id, daemon_state, session_state, cursor_position, lock_held,
      sse_connected, events_consumer_count, last_heartbeat_at, last_hook_at,
      last_state_change_at,
      current_model, current_tool, last_tool_name, last_tool_status,
      last_compaction_reason, last_compaction_at, last_stop_reason,
      last_session_source, subagent_active_count,
      runtime_uid, runtime_gid, runtime_hostname, current_cwd
    )
    VALUES (
      @agent_id, @daemon_state, @session_state, @cursor_position, @lock_held,
      @sse_connected, @events_consumer_count, @last_heartbeat_at, @last_hook_at,
      @last_state_change_at,
      @current_model, @current_tool, @last_tool_name, @last_tool_status,
      @last_compaction_reason, @last_compaction_at, @last_stop_reason,
      @last_session_source, @subagent_active_count,
      @runtime_uid, @runtime_gid, @runtime_hostname, @current_cwd
    )
    ON CONFLICT(agent_id) DO UPDATE SET
      daemon_state = excluded.daemon_state,
      session_state = excluded.session_state,
      cursor_position = excluded.cursor_position,
      lock_held = excluded.lock_held,
      sse_connected = excluded.sse_connected,
      events_consumer_count = excluded.events_consumer_count,
      last_heartbeat_at = excluded.last_heartbeat_at,
      last_hook_at = COALESCE(excluded.last_hook_at, presence.last_hook_at),
      last_state_change_at = excluded.last_state_change_at,
      -- v0.5.7 runtime-meta: COALESCE so pre-v0.5.7 daemon heartbeats (which
      -- omit these fields → null) don't clobber previously-captured meta from
      -- a v0.5.7 daemon. Means: once a v0.5.7 daemon populates current_model
      -- etc., a subsequent rollback to v0.5.6 won't wipe the dashboard.
      -- v0.5.7 daemon explicitly sends null when it WANTS to clear (e.g.,
      -- current_tool=null after PostToolUse) — that won't propagate under
      -- COALESCE; so for clear-style fields we use raw assignment. Mixed
      -- strategy: COALESCE for accumulators, raw for clearables.
      current_model = COALESCE(excluded.current_model, presence.current_model),
      current_tool = excluded.current_tool,
      last_tool_name = COALESCE(excluded.last_tool_name, presence.last_tool_name),
      last_tool_status = COALESCE(excluded.last_tool_status, presence.last_tool_status),
      last_compaction_reason = COALESCE(excluded.last_compaction_reason, presence.last_compaction_reason),
      last_compaction_at = COALESCE(excluded.last_compaction_at, presence.last_compaction_at),
      last_stop_reason = COALESCE(excluded.last_stop_reason, presence.last_stop_reason),
      last_session_source = COALESCE(excluded.last_session_source, presence.last_session_source),
      subagent_active_count = COALESCE(excluded.subagent_active_count, presence.subagent_active_count),
      -- v0.5.7.3 runtime-env: COALESCE so a v0.5.7.2 daemon heartbeat
      -- doesn't clobber a previously-captured uid/gid/hostname from a
      -- v0.5.7.3 daemon. cwd is "current" — use raw assign so a session-end
      -- (cwd=null) clears it cleanly.
      runtime_uid = COALESCE(excluded.runtime_uid, presence.runtime_uid),
      runtime_gid = COALESCE(excluded.runtime_gid, presence.runtime_gid),
      runtime_hostname = COALESCE(excluded.runtime_hostname, presence.runtime_hostname),
      current_cwd = COALESCE(excluded.current_cwd, presence.current_cwd)
  `);
  stmt.run({
    agent_id,
    daemon_state,
    session_state,
    cursor_position: cursor_position ?? null,
    lock_held: lock_held ? 1 : 0,
    sse_connected: sse_connected ? 1 : 0,
    events_consumer_count: events_consumer_count ?? null,
    last_heartbeat_at: now,
    last_hook_at: last_hook_at ?? null,
    last_state_change_at,
    current_model: current_model ?? null,
    current_tool: current_tool ?? null,
    last_tool_name: last_tool_name ?? null,
    last_tool_status: last_tool_status ?? null,
    last_compaction_reason: last_compaction_reason ?? null,
    last_compaction_at: last_compaction_at ?? null,
    last_stop_reason: last_stop_reason ?? null,
    last_session_source: last_session_source ?? null,
    subagent_active_count: (subagent_active_count == null) ? null : Number(subagent_active_count),
    runtime_uid: (runtime_uid == null) ? null : Number(runtime_uid),
    runtime_gid: (runtime_gid == null) ? null : Number(runtime_gid),
    runtime_hostname: runtime_hostname ?? null,
    current_cwd: current_cwd ?? null
  });

  if (stateChanged) {
    database.prepare('INSERT INTO presence_transitions (agent_id, from_label, to_label, occurred_at, reason) VALUES (?, ?, ?, ?, ?)')
      .run(agent_id, oldLabel, newLabel, now, reason ?? null);
  }
  return getPresenceByAgent(agent_id);
}

function getPresenceByAgent(agent_id) {
  const database = getDb();
  const row = database.prepare('SELECT * FROM presence WHERE agent_id = ?').get(agent_id);
  if (!row) return null;
  return {
    agent_id: row.agent_id,
    daemon_state: row.daemon_state,
    session_state: row.session_state,
    label: deriveLabel(row.daemon_state, row.session_state, row.events_consumer_count),
    cursor_position: row.cursor_position,
    lock_held: !!row.lock_held,
    sse_connected: !!row.sse_connected,
    events_consumer_count: row.events_consumer_count,
    last_heartbeat_at: row.last_heartbeat_at,
    last_hook_at: row.last_hook_at,
    last_state_change_at: row.last_state_change_at,
    // v0.5.7 runtime-meta
    current_model: row.current_model,
    current_tool: row.current_tool,
    last_tool_name: row.last_tool_name,
    last_tool_status: row.last_tool_status,
    last_compaction_reason: row.last_compaction_reason,
    last_compaction_at: row.last_compaction_at,
    last_stop_reason: row.last_stop_reason,
    last_session_source: row.last_session_source,
    subagent_active_count: row.subagent_active_count,
    // v0.5.7.3 runtime-env
    runtime_uid: row.runtime_uid,
    runtime_gid: row.runtime_gid,
    runtime_hostname: row.runtime_hostname,
    current_cwd: row.current_cwd
  };
}

function listPresence() {
  const database = getDb();
  const rows = database.prepare('SELECT * FROM presence ORDER BY agent_id ASC').all();
  return rows.map((row) => ({
    agent_id: row.agent_id,
    daemon_state: row.daemon_state,
    session_state: row.session_state,
    label: deriveLabel(row.daemon_state, row.session_state, row.events_consumer_count),
    cursor_position: row.cursor_position,
    lock_held: !!row.lock_held,
    sse_connected: !!row.sse_connected,
    events_consumer_count: row.events_consumer_count,
    last_heartbeat_at: row.last_heartbeat_at,
    last_hook_at: row.last_hook_at,
    last_state_change_at: row.last_state_change_at,
    // v0.5.7 runtime-meta
    current_model: row.current_model,
    current_tool: row.current_tool,
    last_tool_name: row.last_tool_name,
    last_tool_status: row.last_tool_status,
    last_compaction_reason: row.last_compaction_reason,
    last_compaction_at: row.last_compaction_at,
    last_stop_reason: row.last_stop_reason,
    last_session_source: row.last_session_source,
    subagent_active_count: row.subagent_active_count,
    // v0.5.7.3 runtime-env
    runtime_uid: row.runtime_uid,
    runtime_gid: row.runtime_gid,
    runtime_hostname: row.runtime_hostname,
    current_cwd: row.current_cwd
  }));
}

function listPresenceTransitions(agent_id, limit = 50) {
  const database = getDb();
  const rows = database
    .prepare('SELECT id, from_label, to_label, occurred_at, reason FROM presence_transitions WHERE agent_id = ? ORDER BY occurred_at DESC LIMIT ?')
    .all(agent_id, limit);
  return rows;
}

function expireStalePresence(ttlSeconds) {
  const database = getDb();
  const cutoffIso = new Date(Date.now() - ttlSeconds * 1000).toISOString();
  const stale = database
    .prepare(`SELECT agent_id, daemon_state, session_state, events_consumer_count FROM presence WHERE daemon_state = 'up' AND last_heartbeat_at < ?`)
    .all(cutoffIso);
  if (stale.length === 0) return [];
  const now = new Date().toISOString();
  const flipDaemon = database.prepare(`UPDATE presence SET daemon_state = 'down', last_state_change_at = ? WHERE agent_id = ?`);
  const recordTransition = database.prepare('INSERT INTO presence_transitions (agent_id, from_label, to_label, occurred_at, reason) VALUES (?, ?, ?, ?, ?)');
  const tx = database.transaction((rows) => {
    for (const row of rows) {
      const fromLabel = deriveLabel(row.daemon_state, row.session_state, row.events_consumer_count);
      const toLabel = deriveLabel('down', row.session_state, row.events_consumer_count);
      flipDaemon.run(now, row.agent_id);
      recordTransition.run(row.agent_id, fromLabel, toLabel, now, `ttl_expired_${ttlSeconds}s`);
    }
  });
  tx(stale);
  return stale.map((r) => r.agent_id);
}

module.exports = {
  initializeDb,
  insertMessage,
  listMessages,
  listMessagesAfter,
  listChannels,
  getMessage,
  updateMessage,
  deleteMessage,
  upsertPresence,
  getPresenceByAgent,
  listPresence,
  listPresenceTransitions,
  getGlobalHwm,
  // /register state machine (ADR-0025 + ferry-canon)
  insertRegistration,
  getRegistration,
  getRegistrationByAgent,
  getActiveRegistrationByMintedTokenHash,
  listRegistrationsByStatus,
  updateRegistration,
  insertRegistrationEvent,
  listRegistrationEvents,
  expireStalePresence,
  deriveLabel,
  closeDb,
  messageBus
};
