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
    private: row.private === 1,
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
    // v0.5.7.4 (CP6.10): daemon-process technical-detail fields for
    // the dedicated Runtime card view (split out of Identity).
    ['daemon_pid', 'INTEGER'],            // os.getpid() of daemon process
    ['daemon_version', 'TEXT'],           // yaklog-sub VERSION constant
    ['daemon_started_at', 'TEXT'],        // ISO-8601 of daemon __init__
    // v0.5.9 (2026-05-27) — runtime-execution-liveness dimension per parch
    // ratification #6684 (ADR-0027 scope) + aieng #6683 surface. Orthogonal
    // to daemon_state (which tracks yaklog-sub liveness, not runtime
    // ability to execute work). Example: gemini with daemon_state=up but
    // gemini-cli runtime in Google-API quota-exhaustion = runtime_state=
    // quota_exhausted + runtime_blocked_until=<reset ETA>.
    // Default 'active' preserves backcompat: existing rows + non-emitting
    // daemons read as active = no behavior change.
    ['runtime_state', 'TEXT'],            // 'active' | 'quota_exhausted' | 'error' | NULL→active
    ['runtime_blocked_until', 'TEXT'],    // ISO-8601 reset ETA when not-active; NULL otherwise
  ];
  for (const [colName, colType] of RUNTIME_META_COLUMNS) {
    if (!presenceColNames.has(colName)) {
      db.exec(`ALTER TABLE presence ADD COLUMN ${colName} ${colType}`);
    }
  }

  // ADR-0026 (2026-05-26): private flag for hard-DMs. Read-filter middleware
  // (src/middleware/dmFilter.js) gates visibility per ADR §"Fail-closed for
  // unbound bearers": bound agent → public + sender/mentions-match private;
  // ops-key → all + audit-log entry per private row; unbound → public-only
  // (fail-closed). Idempotent ADD COLUMN; existing rows default 0 (public).
  const messagesCols = db.pragma('table_info(messages)');
  if (!messagesCols.some((c) => c.name === 'private')) {
    db.exec(`ALTER TABLE messages ADD COLUMN private INTEGER NOT NULL DEFAULT 0`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_private ON messages(private)`);

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

  // CP10.3 (2026-06-02): per-agent activity timeline — distilled hook stream
  // from yaklog-sub daemon. Operator-facing structured trace of what each
  // agent has been doing. Allowlist-redacted at daemon-side (default-deny
  // on secrets); the server only stores what arrives. Trimmed to last 200
  // per agent on each insert to bound disk + render cost.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS agent_activity (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id     TEXT NOT NULL,
      ts           TEXT NOT NULL,
      event        TEXT NOT NULL,
      payload_json TEXT
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_activity_agent_id_desc ON agent_activity(agent_id, id DESC)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_activity_ts ON agent_activity(ts DESC)`).run();

  // CP11.1 (2026-06-04): cost-persistence Phase 1 substrate (PLAN-CP11 v2 §4).
  // Pre-staged pre-canonical per Jon-direct "do not stop until #cost has been
  // updated and ready for review" — additive only (no existing-table changes),
  // fully reversible (DROP TABLE), aligns with parch ADR-0029 ratify-drive
  // (yaklog-dev OQ CONCUR-all-10 at #7644; facts-provision at #7646). Once
  // ADR-0029 ratifies, schema becomes what canonical says; this pre-stage
  // lets parch empirically verify the design matches actual implementation.
  //
  // cost_daily — canonical financial history; daily granularity per dimension
  // tuple; UPSERT-idempotent via unique index. Includes 4 bizmodel-derived
  // operator-tagged dimension columns (cost_center / project_tag /
  // environment_tier / billable_flag) — empty string default, NOT auto-derived.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS cost_daily (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      date                  TEXT NOT NULL,
      agent_id              TEXT NOT NULL DEFAULT '',
      user_email            TEXT NOT NULL DEFAULT '',
      organization_id       TEXT NOT NULL DEFAULT '',
      model                 TEXT NOT NULL DEFAULT '',
      host                  TEXT NOT NULL DEFAULT '',
      cost_center           TEXT NOT NULL DEFAULT '',
      project_tag           TEXT NOT NULL DEFAULT '',
      environment_tier      TEXT NOT NULL DEFAULT '',
      billable_flag         INTEGER NOT NULL DEFAULT 0,
      tokens_input          INTEGER NOT NULL DEFAULT 0,
      tokens_output         INTEGER NOT NULL DEFAULT 0,
      tokens_cache_read     INTEGER NOT NULL DEFAULT 0,
      tokens_cache_creation INTEGER NOT NULL DEFAULT 0,
      cost_usd              REAL NOT NULL DEFAULT 0,
      source                TEXT NOT NULL DEFAULT 'prom',
      computed_at           TEXT NOT NULL
    )
  `).run();
  db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS uq_cost_daily ON cost_daily(
    date, agent_id, user_email, organization_id, model, host,
    cost_center, project_tag, environment_tier, billable_flag
  )`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_cost_daily_date ON cost_daily(date)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_cost_daily_agent_date ON cost_daily(agent_id, date)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_cost_daily_account_date ON cost_daily(user_email, date)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_cost_daily_cost_center_date ON cost_daily(cost_center, date)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_cost_daily_project_date ON cost_daily(project_tag, date)`).run();

  // cost_dimension_tags — operator-assigned tag mapping per agent_id.
  // Forward-propagates to NEW rollup rows (does NOT retroactively re-tag
  // historical cost_daily rows per bizmodel §Q2 audit-preservation discipline).
  db.prepare(`
    CREATE TABLE IF NOT EXISTS cost_dimension_tags (
      agent_id              TEXT PRIMARY KEY,
      cost_center           TEXT NOT NULL DEFAULT '',
      project_tag           TEXT NOT NULL DEFAULT '',
      environment_tier      TEXT NOT NULL DEFAULT '',
      billable_flag         INTEGER NOT NULL DEFAULT 0,
      updated_at            TEXT NOT NULL,
      updated_by            TEXT
    )
  `).run();

  // cost_budgets — per-cost-center envelopes (monthly + quarterly v1).
  // Empty cost_center allowed for cluster-wide envelope. Carry-over policy
  // operator-controlled. 3-tier threshold defaults (80% / 100% / 120%).
  db.prepare(`
    CREATE TABLE IF NOT EXISTS cost_budgets (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      cost_center           TEXT NOT NULL,
      period_kind           TEXT NOT NULL,
      period_anchor         TEXT NOT NULL,
      budget_usd            REAL NOT NULL,
      carry_over            TEXT NOT NULL DEFAULT 'strict',
      threshold_pct_warn    INTEGER NOT NULL DEFAULT 80,
      threshold_pct_at      INTEGER NOT NULL DEFAULT 100,
      threshold_pct_over    INTEGER NOT NULL DEFAULT 120,
      note                  TEXT,
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL,
      updated_by            TEXT
    )
  `).run();
  db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS uq_cost_budgets ON cost_budgets(cost_center, period_kind, period_anchor)`).run();

  // cost_reconciliation — append-only audit of operator invoice-tie-out events.
  // Never UPDATE; new reconciliation events insert new rows. Preserves history.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS cost_reconciliation (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      period_start          TEXT NOT NULL,
      period_end            TEXT NOT NULL,
      invoice_label         TEXT,
      invoice_total_usd     REAL NOT NULL,
      plexus_total_usd      REAL NOT NULL,
      delta_usd             REAL NOT NULL,
      delta_pct             REAL NOT NULL,
      concentration_json    TEXT,
      notes                 TEXT,
      reconciled_by         TEXT NOT NULL,
      reconciled_at         TEXT NOT NULL
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_recon_period ON cost_reconciliation(period_end DESC)`).run();

  return db;
}

function getDb() {
  return db || initializeDb();
}

function insertMessage({ channel, sender, body, metadata = null, isPrivate = false }) {
  const database = getDb();
  const mentions = parseMentions(body);
  const stmt = database.prepare(`
    INSERT INTO messages (channel, sender, body, metadata_json, mentions, private)
    VALUES (@channel, @sender, @body, @metadata_json, @mentions, @private)
  `);

  const result = stmt.run({
    channel,
    sender,
    body,
    metadata_json: metadata ? JSON.stringify(metadata) : null,
    mentions: JSON.stringify(mentions),
    private: isPrivate ? 1 : 0
  });

  const row = database
    .prepare('SELECT id, channel, sender, body, metadata_json, mentions, private, created_at, updated_at FROM messages WHERE id = ?')
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
      SELECT id, channel, sender, body, metadata_json, mentions, private, created_at, updated_at
      FROM messages
      ${whereSql}
      ORDER BY id DESC
      LIMIT @limit
    `)
    .all(params);

  return rows.reverse().map(toMessage);
}

function listMessagesAfter({ afterId, channel, channels, excludeSender, mentions }) {
  const database = getDb();
  const where = ['id > @afterId'];
  const params = { afterId };
  // v0.5.10: accept channels (array, set-membership) OR channel (singular, back-compat).
  // If both, union them. better-sqlite3 doesn't bind arrays — inline-build the
  // placeholder list with named params (@ch0, @ch1, ...). All entries already
  // CHANNEL_RE-validated upstream, so safe to use as param names.
  const channelSet = new Set();
  if (channel) channelSet.add(channel);
  if (Array.isArray(channels)) for (const c of channels) if (c) channelSet.add(c);
  if (channelSet.size > 0) {
    const placeholders = [];
    let i = 0;
    for (const c of channelSet) {
      const key = `ch${i++}`;
      placeholders.push(`@${key}`);
      params[key] = c;
    }
    where.push(`channel IN (${placeholders.join(', ')})`);
  }
  if (excludeSender) { where.push('sender != @excludeSender'); params.excludeSender = excludeSender; }
  const rows = database
    .prepare(`SELECT id, channel, sender, body, metadata_json, mentions, private, created_at, updated_at
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
    .prepare('SELECT id, channel, sender, body, metadata_json, mentions, private, created_at, updated_at FROM messages WHERE id = ?')
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

// ────────────────────────────────────────────────────────────────────────
// CP11.1 (2026-06-04): cost-persistence helpers (PLAN-CP11 v2 §4).
// Pre-staged pre-canonical per Jon-direct "do not stop until #cost has
// been updated and ready for review". UPSERT-idempotent semantics on
// cost_daily + cost_dimension_tags + cost_budgets. Append-only on
// cost_reconciliation. All helpers operate on the schema added in
// initializeDb() above; nothing in this block touches existing tables.
// ────────────────────────────────────────────────────────────────────────

// UPSERT a cost_daily row. Unique on (date, full dim-tuple); INSERT OR
// REPLACE preserves the auto-increment id-cycle but is acceptable for
// daily-rollup re-runs (id stability not load-bearing for cost_daily).
function upsertCostDaily(row) {
  if (!row || !row.date || typeof row.date !== 'string') {
    throw new Error('upsertCostDaily: row.date is required (YYYY-MM-DD)');
  }
  const database = getDb();
  const computed_at = row.computed_at || new Date().toISOString();
  database.prepare(`
    INSERT INTO cost_daily (
      date, agent_id, user_email, organization_id, model, host,
      cost_center, project_tag, environment_tier, billable_flag,
      tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation,
      cost_usd, source, computed_at
    ) VALUES (
      @date, @agent_id, @user_email, @organization_id, @model, @host,
      @cost_center, @project_tag, @environment_tier, @billable_flag,
      @tokens_input, @tokens_output, @tokens_cache_read, @tokens_cache_creation,
      @cost_usd, @source, @computed_at
    )
    ON CONFLICT (date, agent_id, user_email, organization_id, model, host,
                 cost_center, project_tag, environment_tier, billable_flag)
    DO UPDATE SET
      tokens_input          = excluded.tokens_input,
      tokens_output         = excluded.tokens_output,
      tokens_cache_read     = excluded.tokens_cache_read,
      tokens_cache_creation = excluded.tokens_cache_creation,
      cost_usd              = excluded.cost_usd,
      source                = excluded.source,
      computed_at           = excluded.computed_at
  `).run({
    date: row.date,
    agent_id: row.agent_id || '',
    user_email: row.user_email || '',
    organization_id: row.organization_id || '',
    model: row.model || '',
    host: row.host || '',
    cost_center: row.cost_center || '',
    project_tag: row.project_tag || '',
    environment_tier: row.environment_tier || '',
    billable_flag: row.billable_flag ? 1 : 0,
    tokens_input: Number.isInteger(row.tokens_input) ? row.tokens_input : 0,
    tokens_output: Number.isInteger(row.tokens_output) ? row.tokens_output : 0,
    tokens_cache_read: Number.isInteger(row.tokens_cache_read) ? row.tokens_cache_read : 0,
    tokens_cache_creation: Number.isInteger(row.tokens_cache_creation) ? row.tokens_cache_creation : 0,
    cost_usd: Number.isFinite(row.cost_usd) ? row.cost_usd : 0,
    source: row.source || 'prom',
    computed_at,
  });
}

// Query cost_daily rows by date range with optional dimension filter.
// Returns array of row objects (NOT aggregated; caller sums if needed).
function getCostByPeriod({ from, to, agent_id, user_email, cost_center, project_tag, environment_tier, model, billable_flag } = {}) {
  if (!from || !to) throw new Error('getCostByPeriod: from + to are required (YYYY-MM-DD)');
  const database = getDb();
  const where = ['date >= @from', 'date <= @to'];
  const params = { from, to };
  if (agent_id != null) { where.push('agent_id = @agent_id'); params.agent_id = agent_id; }
  if (user_email != null) { where.push('user_email = @user_email'); params.user_email = user_email; }
  if (cost_center != null) { where.push('cost_center = @cost_center'); params.cost_center = cost_center; }
  if (project_tag != null) { where.push('project_tag = @project_tag'); params.project_tag = project_tag; }
  if (environment_tier != null) { where.push('environment_tier = @environment_tier'); params.environment_tier = environment_tier; }
  if (model != null) { where.push('model = @model'); params.model = model; }
  if (billable_flag != null) { where.push('billable_flag = @billable_flag'); params.billable_flag = billable_flag ? 1 : 0; }
  return database
    .prepare(`SELECT * FROM cost_daily WHERE ${where.join(' AND ')} ORDER BY date ASC, id ASC`)
    .all(params);
}

// UPSERT a cost_dimension_tags row for an agent_id. Forward-propagates
// to NEW cost_daily rows (rollup job reads this table at write-time);
// does NOT retroactively re-tag historical rows.
function upsertCostDimensionTags(row) {
  if (!row || !row.agent_id) throw new Error('upsertCostDimensionTags: row.agent_id is required');
  const database = getDb();
  const updated_at = row.updated_at || new Date().toISOString();
  database.prepare(`
    INSERT INTO cost_dimension_tags (agent_id, cost_center, project_tag, environment_tier, billable_flag, updated_at, updated_by)
    VALUES (@agent_id, @cost_center, @project_tag, @environment_tier, @billable_flag, @updated_at, @updated_by)
    ON CONFLICT (agent_id) DO UPDATE SET
      cost_center      = excluded.cost_center,
      project_tag      = excluded.project_tag,
      environment_tier = excluded.environment_tier,
      billable_flag    = excluded.billable_flag,
      updated_at       = excluded.updated_at,
      updated_by       = excluded.updated_by
  `).run({
    agent_id: row.agent_id,
    cost_center: row.cost_center || '',
    project_tag: row.project_tag || '',
    environment_tier: row.environment_tier || '',
    billable_flag: row.billable_flag ? 1 : 0,
    updated_at,
    updated_by: row.updated_by || null,
  });
}

// Fetch tags for a specific agent_id (or all if agent_id omitted).
function getCostDimensionTags(agent_id) {
  const database = getDb();
  if (agent_id) {
    return database.prepare('SELECT * FROM cost_dimension_tags WHERE agent_id = ?').get(agent_id) || null;
  }
  return database.prepare('SELECT * FROM cost_dimension_tags ORDER BY agent_id').all();
}

// UPSERT a cost_budgets envelope.
function upsertCostBudget(row) {
  if (!row || row.cost_center == null || !row.period_kind || !row.period_anchor) {
    throw new Error('upsertCostBudget: cost_center + period_kind + period_anchor required');
  }
  const VALID_KINDS = new Set(['monthly', 'quarterly']);
  if (!VALID_KINDS.has(row.period_kind)) {
    throw new Error(`upsertCostBudget: period_kind must be one of ${[...VALID_KINDS].join(', ')}`);
  }
  if (!Number.isFinite(row.budget_usd) || row.budget_usd < 0) {
    throw new Error('upsertCostBudget: budget_usd must be non-negative finite');
  }
  const database = getDb();
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO cost_budgets (
      cost_center, period_kind, period_anchor, budget_usd,
      carry_over, threshold_pct_warn, threshold_pct_at, threshold_pct_over,
      note, created_at, updated_at, updated_by
    ) VALUES (
      @cost_center, @period_kind, @period_anchor, @budget_usd,
      @carry_over, @threshold_pct_warn, @threshold_pct_at, @threshold_pct_over,
      @note, @now, @now, @updated_by
    )
    ON CONFLICT (cost_center, period_kind, period_anchor) DO UPDATE SET
      budget_usd            = excluded.budget_usd,
      carry_over            = excluded.carry_over,
      threshold_pct_warn    = excluded.threshold_pct_warn,
      threshold_pct_at      = excluded.threshold_pct_at,
      threshold_pct_over    = excluded.threshold_pct_over,
      note                  = excluded.note,
      updated_at            = excluded.updated_at,
      updated_by            = excluded.updated_by
  `).run({
    cost_center: row.cost_center,
    period_kind: row.period_kind,
    period_anchor: row.period_anchor,
    budget_usd: row.budget_usd,
    carry_over: row.carry_over || 'strict',
    threshold_pct_warn: Number.isInteger(row.threshold_pct_warn) ? row.threshold_pct_warn : 80,
    threshold_pct_at: Number.isInteger(row.threshold_pct_at) ? row.threshold_pct_at : 100,
    threshold_pct_over: Number.isInteger(row.threshold_pct_over) ? row.threshold_pct_over : 120,
    note: row.note || null,
    now,
    updated_by: row.updated_by || null,
  });
}

// List budgets (optionally filtered).
function getCostBudgets({ cost_center, period_kind, period_anchor } = {}) {
  const database = getDb();
  const where = [];
  const params = {};
  if (cost_center != null) { where.push('cost_center = @cost_center'); params.cost_center = cost_center; }
  if (period_kind != null) { where.push('period_kind = @period_kind'); params.period_kind = period_kind; }
  if (period_anchor != null) { where.push('period_anchor = @period_anchor'); params.period_anchor = period_anchor; }
  const sql = where.length
    ? `SELECT * FROM cost_budgets WHERE ${where.join(' AND ')} ORDER BY cost_center, period_kind, period_anchor`
    : `SELECT * FROM cost_budgets ORDER BY cost_center, period_kind, period_anchor`;
  return database.prepare(sql).all(params);
}

// Insert a cost_reconciliation row (append-only).
function insertCostReconciliation(row) {
  if (!row || !row.period_start || !row.period_end || !row.reconciled_by) {
    throw new Error('insertCostReconciliation: period_start + period_end + reconciled_by required');
  }
  if (!Number.isFinite(row.invoice_total_usd) || !Number.isFinite(row.plexus_total_usd)) {
    throw new Error('insertCostReconciliation: invoice_total_usd + plexus_total_usd must be finite');
  }
  const database = getDb();
  const delta_usd = row.invoice_total_usd - row.plexus_total_usd;
  const delta_pct = row.plexus_total_usd !== 0
    ? (delta_usd / row.plexus_total_usd) * 100
    : (row.invoice_total_usd === 0 ? 0 : 100);
  const result = database.prepare(`
    INSERT INTO cost_reconciliation (
      period_start, period_end, invoice_label,
      invoice_total_usd, plexus_total_usd, delta_usd, delta_pct,
      concentration_json, notes, reconciled_by, reconciled_at
    ) VALUES (
      @period_start, @period_end, @invoice_label,
      @invoice_total_usd, @plexus_total_usd, @delta_usd, @delta_pct,
      @concentration_json, @notes, @reconciled_by, @reconciled_at
    )
  `).run({
    period_start: row.period_start,
    period_end: row.period_end,
    invoice_label: row.invoice_label || null,
    invoice_total_usd: row.invoice_total_usd,
    plexus_total_usd: row.plexus_total_usd,
    delta_usd,
    delta_pct,
    concentration_json: row.concentration_json ? (typeof row.concentration_json === 'string' ? row.concentration_json : JSON.stringify(row.concentration_json)) : null,
    notes: row.notes || null,
    reconciled_by: row.reconciled_by,
    reconciled_at: row.reconciled_at || new Date().toISOString(),
  });
  return { id: result.lastInsertRowid, delta_usd, delta_pct };
}

// List reconciliation rows (newest first).
function listCostReconciliations({ limit = 100 } = {}) {
  const database = getDb();
  return database.prepare('SELECT * FROM cost_reconciliation ORDER BY id DESC LIMIT ?').all(limit);
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

// CP8.5 (2026-05-27) — dashboard #6 admin surface needs a list-everything
// helper (per-status existing helper would force per-status loop on the
// browser side). Ordered newest-first since the surface is "what's pending
// my attention right now" + recent activity.
function listAllRegistrations(limit = 100) {
  const database = getDb();
  return database
    .prepare('SELECT * FROM registrations ORDER BY updated_at DESC LIMIT ?')
    .all(Math.min(Math.max(limit, 1), 500));
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
    compacting: 'online_compacting',
    // v0.5.9.4 (game-designer #6898 fix): stop_failure was unmapped, so the
    // deriveLabel fall-through returned 'offline' for an agent whose last
    // hook was StopFailure even though the daemon was alive + sticky-stateful.
    // Empirical: peer agents with last_hook=Stop stayed online_idle for
    // hours/days while game-designer's last_hook=StopFailure session showed
    // offline. Daemon-side is correct (stop_failure is intentionally sticky
    // per yaklog-sub _IN_FLIGHT_STATES); the gap was server-side label
    // derivation missing the entry. CSS for .status-stop_failure +
    // .label-stop_failure was already in dashboard.html (dead code until now).
    stop_failure: 'stop_failure'
  },
  down: { active: 'offline', idle: 'offline', unknown: 'offline', tool_running: 'offline', idle_between_tools: 'offline', compacting: 'offline', stop_failure: 'offline' }
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
  runtime_uid, runtime_gid, runtime_hostname, current_cwd,
  // v0.5.7.4 daemon-process detail (all optional; null when daemon < v0.5.7.4)
  daemon_pid, daemon_version, daemon_started_at,
  // v0.5.9 runtime-execution-liveness (per parch ratification #6684; ADR-0027
  // scope). Default 'active' preserves backcompat — legacy daemons omit →
  // null → dashboard treats as active.
  runtime_state, runtime_blocked_until
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
      runtime_uid, runtime_gid, runtime_hostname, current_cwd,
      daemon_pid, daemon_version, daemon_started_at,
      runtime_state, runtime_blocked_until
    )
    VALUES (
      @agent_id, @daemon_state, @session_state, @cursor_position, @lock_held,
      @sse_connected, @events_consumer_count, @last_heartbeat_at, @last_hook_at,
      @last_state_change_at,
      @current_model, @current_tool, @last_tool_name, @last_tool_status,
      @last_compaction_reason, @last_compaction_at, @last_stop_reason,
      @last_session_source, @subagent_active_count,
      @runtime_uid, @runtime_gid, @runtime_hostname, @current_cwd,
      @daemon_pid, @daemon_version, @daemon_started_at,
      @runtime_state, @runtime_blocked_until
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
      current_cwd = COALESCE(excluded.current_cwd, presence.current_cwd),
      -- v0.5.7.4: pid + started_at change on every daemon restart;
      -- raw-assign so they reflect the CURRENT daemon, not a stale prior
      -- one. version is a constant per daemon binary; same semantics.
      daemon_pid = excluded.daemon_pid,
      daemon_version = excluded.daemon_version,
      daemon_started_at = excluded.daemon_started_at,
      -- v0.5.9.1 runtime-execution-liveness: COALESCE to defend against
      -- daemon-clobber. The yaklog-sub daemon's normal /presence/event
      -- heartbeats (every 30s) DON'T include runtime_state → routes.js
      -- coerces undefined → null → without COALESCE the heartbeat would
      -- immediately wipe the runtime_state aieng's emit-side just set.
      -- Same pattern as current_model / last_tool_name accumulators.
      -- To clear on recovery: aieng's runtime explicitly emits
      -- runtime_state='active' (non-null → wins COALESCE). The stale
      -- runtime_blocked_until then becomes semantically inert (dashboard
      -- only renders countdown when runtime_state !== 'active'), so no
      -- explicit clear needed.
      runtime_state = COALESCE(excluded.runtime_state, presence.runtime_state),
      runtime_blocked_until = COALESCE(excluded.runtime_blocked_until, presence.runtime_blocked_until)
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
    current_cwd: current_cwd ?? null,
    daemon_pid: (daemon_pid == null) ? null : Number(daemon_pid),
    daemon_version: daemon_version ?? null,
    daemon_started_at: daemon_started_at ?? null,
    runtime_state: runtime_state ?? null,
    runtime_blocked_until: runtime_blocked_until ?? null
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
    current_cwd: row.current_cwd,
    // v0.5.7.4 daemon-process
    daemon_pid: row.daemon_pid,
    daemon_version: row.daemon_version,
    daemon_started_at: row.daemon_started_at,
    // v0.5.9 runtime-execution-liveness
    runtime_state: row.runtime_state,
    runtime_blocked_until: row.runtime_blocked_until
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
    current_cwd: row.current_cwd,
    // v0.5.7.4 daemon-process
    daemon_pid: row.daemon_pid,
    daemon_version: row.daemon_version,
    daemon_started_at: row.daemon_started_at,
    // v0.5.9 runtime-execution-liveness
    runtime_state: row.runtime_state,
    runtime_blocked_until: row.runtime_blocked_until
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

// ADR-side: explicit ops-key gated decommission removes a presence row +
// records a transition for the audit trail. Differs from expireStalePresence
// (which only flips daemon_state=down); intended for retired agents whose
// row should disappear from the dashboard rather than ghost as "offline".
// Returns the deleted row (for the API response) or null if absent.
// CP10.3: per-agent activity timeline helpers.
const ACTIVITY_PER_AGENT_CAP = 200;
function insertAgentActivity(agentId, entries) {
  if (!agentId || !Array.isArray(entries) || entries.length === 0) return 0;
  const database = getDb();
  const ins = database.prepare(
    'INSERT INTO agent_activity (agent_id, ts, event, payload_json) VALUES (?, ?, ?, ?)'
  );
  const tx = database.transaction((rows) => {
    let n = 0;
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const ts = typeof r.ts === 'string' && r.ts ? r.ts : new Date().toISOString();
      const event = typeof r.event === 'string' && r.event ? r.event.slice(0, 64) : 'unknown';
      // Server NEVER re-parses payload — daemon-side distillation is the
      // contract. We store whatever (already-redacted) JSON arrived as-is.
      const payload = (r.payload === undefined) ? null : JSON.stringify(r.payload);
      ins.run(agentId, ts, event, payload);
      n++;
    }
    // Trim to cap: delete oldest beyond ACTIVITY_PER_AGENT_CAP per agent.
    database.prepare(`
      DELETE FROM agent_activity
      WHERE agent_id = ?
        AND id NOT IN (
          SELECT id FROM agent_activity
          WHERE agent_id = ?
          ORDER BY id DESC
          LIMIT ?
        )
    `).run(agentId, agentId, ACTIVITY_PER_AGENT_CAP);
    return n;
  });
  return tx(entries);
}
function listAgentActivity(agentId, limit = 50) {
  if (!agentId) return [];
  const database = getDb();
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const rows = database
    .prepare('SELECT id, ts, event, payload_json FROM agent_activity WHERE agent_id = ? ORDER BY id DESC LIMIT ?')
    .all(agentId, lim);
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    event: r.event,
    payload: r.payload_json ? safeParse(r.payload_json) : null,
  }));
}
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

function deletePresenceRow(agentId, { reason = 'decommissioned', actor = null } = {}) {
  const database = getDb();
  const existing = database.prepare('SELECT * FROM presence WHERE agent_id = ?').get(agentId);
  if (!existing) return null;
  const recordTransition = database.prepare(
    'INSERT INTO presence_transitions (agent_id, from_label, to_label, occurred_at, reason) VALUES (?, ?, ?, ?, ?)'
  );
  const del = database.prepare('DELETE FROM presence WHERE agent_id = ?');
  const tx = database.transaction(() => {
    const fromLabel = deriveLabel(existing.daemon_state, existing.session_state, existing.events_consumer_count);
    const reasonStr = actor ? `${reason}:by=${actor}` : reason;
    recordTransition.run(agentId, fromLabel, '(decommissioned)', new Date().toISOString(), reasonStr);
    del.run(agentId);
  });
  tx();
  return existing;
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
  listAllRegistrations,
  updateRegistration,
  insertRegistrationEvent,
  listRegistrationEvents,
  expireStalePresence,
  deletePresenceRow,
  deriveLabel,
  // CP10.3: activity timeline
  insertAgentActivity,
  listAgentActivity,
  // CP11.1: cost-persistence (pre-staged for ADR-0029 Phase 1)
  upsertCostDaily,
  getCostByPeriod,
  upsertCostDimensionTags,
  getCostDimensionTags,
  upsertCostBudget,
  getCostBudgets,
  insertCostReconciliation,
  listCostReconciliations,
  closeDb,
  messageBus
};
