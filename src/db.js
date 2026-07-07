const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
    // CP12.x.4 (2026-06-13): SSE-silent-dead detection per sleuth #8532 +
    // admin #8534/#8536 forensics. last_cursor_advance_at tracks when the
    // daemon's SSE-derived cursor_position last incremented; combined with
    // last_heartbeat_at this surfaces the "process alive, stream silent"
    // failure mode that left sleuth's events.ndjson frozen for ~21h between
    // my v0.5.53 restart (induced) and v0.5.54 restart (recovered).
    // Server-side derived sse_stream_stale flag fires when heartbeat is
    // fresh AND cursor hasn't advanced AND cluster traffic is flowing.
    ['last_cursor_advance_at', 'TEXT'],   // ISO-8601 of last cursor_position increment; NULL pre-CP12.x.4
    // CP14.1 (2026-06-13): runtime-class field per Jon-direct via admin #8521.
    // Distinguishes CC vs Codex vs Gemini at dashboard + Prom query level.
    // Prior state: serve-time-enriched at /presence/public via runtimeOf()
    // lookup in src/agentRuntimes.js; not Prom-queryable, not analytics-surface.
    // Now: schema column populated at upsert via runtimeOf() server-side
    // (source-of-truth stays in agentRuntimes.js REGISTRY; column is cached
    // representation). Future Layer 2 will allow daemon-reported override
    // when emitters supply OTEL_RESOURCE_ATTRIBUTES service.name.
    // Values: 'claude_code' | 'codex' | 'gemini' (per VALID_RUNTIMES set).
    ['runtime', 'TEXT'],                  // CP14.1: runtime-class column
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

  // ADR-0026 v2 Phase A: messages tombstone canon per parch #10375 Jon-direct +
  // yaklog-dev #10385 substrate-design. Sister-shape canon to CP12.12.1
  // audit-tombstone (POST /api/v1/ops/audit/tombstone). Closes the bus-DB
  // plaintext receipt-window discipline gap for DM credential-delivery
  // substrate per parch #10375 Q2 (b)+ lean: persist + canonical-tombstone-
  // on-encrypt. Body redacted to sentinel '[REDACTED]'; audit metadata
  // (sender/recipient/mentions/ts) preserved for ops-audit trail.
  if (!messagesCols.some((c) => c.name === 'tombstone_at')) {
    db.exec(`ALTER TABLE messages ADD COLUMN tombstone_at TEXT`);
  }
  if (!messagesCols.some((c) => c.name === 'tombstone_reason')) {
    db.exec(`ALTER TABLE messages ADD COLUMN tombstone_reason TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_tombstone ON messages(tombstone_at) WHERE tombstone_at IS NOT NULL`);

  // Operator-session substrate Phase A per PLAN-OPERATOR-SESSION-SUBSTRATE v2
  // RATIFIED by parch #10382 + Jon-direct #10404. session_class column on
  // presence (Q2 RATIFY: explicit field SERVER-ENFORCED from binding tier per
  // secops Block-1); decommissioned_at column (Q10 RATIFY: 6-step offboarding
  // checklist commit-canon; secops Block-2 + admin #10365 multi-host-atomic).
  // Sister-shape canon to runtime_class column (CP12.x.3) at session-tier.
  const presenceColsOpA = db.pragma('table_info(presence)');
  if (!presenceColsOpA.some((c) => c.name === 'session_class')) {
    db.exec(`ALTER TABLE presence ADD COLUMN session_class TEXT NOT NULL DEFAULT 'agent'`);
  }
  if (!presenceColsOpA.some((c) => c.name === 'decommissioned_at')) {
    db.exec(`ALTER TABLE presence ADD COLUMN decommissioned_at TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_presence_session_class ON presence(session_class)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_presence_decommissioned ON presence(decommissioned_at) WHERE decommissioned_at IS NOT NULL`);

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

  // CP16 Pillar 0 Phase B per PLAN-CP16-PILLAR-0-AMENDMENT + parch ratify
  // #10691. browser_perf_measurement stores per-callsite browser timing
  // ingested via POST /api/v1/instrument/browser-perf. In-process tick
  // rolls these up to /var/lib/yaklog/textfile/browser-perf.prom for
  // node_exporter scrape (added via ssw-devops Gate 2 topology change).
  db.prepare(`
    CREATE TABLE IF NOT EXISTS browser_perf_measurement (
      measurement_id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_unix_ms     INTEGER NOT NULL,
      session_id     TEXT,
      agent_id       TEXT,
      callsite       TEXT NOT NULL,
      duration_ms    REAL NOT NULL,
      n_rows         INTEGER,
      recorded_at    TEXT NOT NULL
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_browser_perf_callsite_ts ON browser_perf_measurement(callsite, ts_unix_ms DESC)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_browser_perf_ts ON browser_perf_measurement(ts_unix_ms DESC)`).run();

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

  // CP11.x.2 (2026-06-13): vendor column for per-vendor cost rollup per
  // Jon-direct ("cost per vendor as well as total cost visualizations").
  // Derived from model identifier at insert via vendorOf(model). Values:
  // 'Anthropic' | 'OpenAI' | 'Google' | 'Other'. Idempotent ADD COLUMN.
  // Backfill of existing rows happens immediately after — single UPDATE
  // statement against the model column using SQL CASE.
  const costDailyCols = new Set(db.pragma('table_info(cost_daily)').map((c) => c.name));
  if (!costDailyCols.has('vendor')) {
    db.exec(`ALTER TABLE cost_daily ADD COLUMN vendor TEXT NOT NULL DEFAULT ''`);
    db.exec(`
      UPDATE cost_daily SET vendor = CASE
        WHEN model LIKE 'claude-%'                                 THEN 'Anthropic'
        WHEN model LIKE 'gemini-%'                                 THEN 'Google'
        WHEN model LIKE 'gpt-%' OR model LIKE 'codex-%'
             OR model LIKE 'o1-%' OR model LIKE 'o2-%'
             OR model LIKE 'o3-%' OR model LIKE 'o4-%'             THEN 'OpenAI'
        ELSE 'Other'
      END
      WHERE vendor = ''
    `);
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_cost_daily_vendor_date ON cost_daily(vendor, date)`).run();
  }

  // Operator-session cost-attribution canon per Q6 RATIFY + bizmodel #10367:
  // actor_class column on cost_daily (default 'agent' preserves existing
  // headline ratios; slicer-toggle UI surfaces operator-class separately at
  // Effort-tab Phase B). Sister-shape runtime_class/vendor dim-additive canon
  // (CP11.x.2 + CP12.x.3). Placed after cost_daily CREATE + after vendor ADD
  // so this migration sees the table; sister-shape to vendor ALTER pattern.
  if (!costDailyCols.has('actor_class')) {
    db.exec(`ALTER TABLE cost_daily ADD COLUMN actor_class TEXT NOT NULL DEFAULT 'agent'`);
    costDailyCols.add('actor_class');
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cost_daily_actor_class ON cost_daily(actor_class)`);

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

  // ─────────────────────────────────────────────────────────────────────────
  // CP12.1 (2026-06-04): ADR-0030 v1.1 RATIFIED audit + governance substrate.
  // 9 new tables per ADR-0030 §Schema (folds bizmodel #7697 OQ#4 amendment,
  // secops #7696 Finding 2, admin #7698 R3+R5). Atomic-tombstone discipline
  // per admin R2; hash-chain formula per admin R2; ops-key sha256-prefix
  // forensic markers per ADR-0026 + ADR-0025 precedent; subject_directory
  // hash-at-ingestion per bizmodel OQ#4 amendment (severs cleartext
  // correlation; right-to-be-forgotten is single-row deletion).
  // ─────────────────────────────────────────────────────────────────────────

  // audit_tool_invocation — incident-response-load-bearing.
  // Ingester populates from agent_activity (DRY-augment per OQ#8); adds
  // forensic chain-of-custody hashes (full 64-char sha256 per secops R3 fold).
  db.prepare(`
    CREATE TABLE IF NOT EXISTS audit_tool_invocation (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id        TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      occurred_at     TEXT NOT NULL,
      tool_name       TEXT NOT NULL,
      tool_phase      TEXT NOT NULL,
      input_digest    TEXT,
      output_digest   TEXT,
      status          TEXT,
      status_detail   TEXT,
      subagent_type   TEXT,
      source_event_id INTEGER,
      payload_ref     TEXT,
      tombstone_at    TEXT
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_ti_agent_time ON audit_tool_invocation(agent_id, occurred_at)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_ti_tool_time ON audit_tool_invocation(tool_name, occurred_at)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_ti_event_id ON audit_tool_invocation(event_id)`).run();
  // CP16 Phase 2 today-live perf (sister-shape idx_audit_cc_time + idx_audit_csc_time
  // + idx_audit_attest_time). Standalone idx_occurred_at needed because composite
  // indexes (agent_id, occurred_at) + (tool_name, occurred_at) can't directly serve
  // date-range COUNT(*) without a leading-column predicate. ssw-devops #11030 empirical:
  // mtd response 2.0-2.6s even with full rollup hit — today-live path dominated by
  // 7 areas × ~2 classes × ~3.6k tool_invocation rows full-scan per request.
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_ti_time ON audit_tool_invocation(occurred_at)`).run();

  // audit_file_access — Phase 1 schema only (ingester is Phase 1.5 substrate-
  // coord with ssw-devops + secops per OQ#2 fold). Includes admin R5 + secops
  // Finding 1 fold: attribution_confidence + session_correlator columns
  // handle jon-uid co-residency without false-attribution.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS audit_file_access (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id               TEXT NOT NULL,
      occurred_at            TEXT NOT NULL,
      agent_id               TEXT,
      uid                    INTEGER NOT NULL,
      path                   TEXT NOT NULL,
      access_mode            TEXT NOT NULL,
      bytes_in               INTEGER,
      bytes_out              INTEGER,
      content_digest         TEXT,
      attribution_confidence TEXT NOT NULL DEFAULT 'uid_unique',
      session_correlator     TEXT,
      payload_ref            TEXT,
      tombstone_at           TEXT
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_fa_agent_time ON audit_file_access(agent_id, occurred_at)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_fa_path_time ON audit_file_access(path, occurred_at)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_fa_event_id ON audit_file_access(event_id)`).run();
  // CP16 Phase 2 today-live perf sister-shape audit_tool_invocation idx_occurred_at fill.
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_fa_time ON audit_file_access(occurred_at)`).run();

  // audit_credential_change — token rotation events; ops-key changes; sha256-
  // prefix only (never the secret per secrets-discipline-no-yaklog).
  db.prepare(`
    CREATE TABLE IF NOT EXISTS audit_credential_change (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id         TEXT NOT NULL,
      occurred_at      TEXT NOT NULL,
      credential_class TEXT NOT NULL,
      agent_id         TEXT,
      change_type      TEXT NOT NULL,
      actor            TEXT NOT NULL,
      prior_digest     TEXT,
      new_digest       TEXT,
      reason           TEXT
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_cc_time ON audit_credential_change(occurred_at)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_cc_class_time ON audit_credential_change(credential_class, occurred_at)`).run();

  // CP12.7 Phase B: credential_state_snapshot persists the last-seen
  // fingerprint set of YAKLOG_API_KEYS + YAKLOG_TOKEN_BINDINGS +
  // YAKLOG_HOST_INGESTER_BINDINGS across boots. At app startup, the
  // env-diff detector compares current env to this snapshot + emits
  // audit_credential_change rows for each diff (mint/revoke/bind/unbind).
  // Single-row table (id=1); snapshot_json holds the JSON-serialized
  // {api_keys:[sha[:16]], token_bindings:[agent:sha[:16]], host_bindings:[host:sha[:16]]} shape.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS credential_state_snapshot (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      snapshot_json TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    )
  `).run();

  // CP12.8 Phase 2 admin-R4 source-coverage: permission_state_snapshot
  // persists the last-seen fingerprint set of filesystem-resident
  // permission sources (settings.local.json per agent, agent-specs.git
  // HEAD, systemd overrides, ~/.ssh/authorized_keys, ~/.config/gh/hosts.yml).
  // The scanner script (scripts/permission-change-scanner.sh) runs on the
  // host (has filesystem visibility the container lacks), computes sha256[:16]
  // per source path, POSTs to /api/v1/ops/audit/permission-change/scan;
  // server does the diff + emit + snapshot-persist logic.
  // snapshot_json shape: { sources: [{ source_class, source_path, agent_id, fingerprint }] }
  db.prepare(`
    CREATE TABLE IF NOT EXISTS permission_state_snapshot (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      snapshot_json TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    )
  `).run();

  // audit_permission_change — settings.local.json + agent-specs.git +
  // systemd overrides + ~/.ssh/authorized_keys + gh hosts (Phase 2 source-
  // coverage per admin R4 fold).
  db.prepare(`
    CREATE TABLE IF NOT EXISTS audit_permission_change (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id     TEXT NOT NULL,
      occurred_at  TEXT NOT NULL,
      agent_id     TEXT NOT NULL,
      change_type  TEXT NOT NULL,
      rule_text    TEXT NOT NULL,
      actor        TEXT NOT NULL,
      source_path  TEXT,
      reason       TEXT
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_pc_agent_time ON audit_permission_change(agent_id, occurred_at)`).run();
  // CP16 Phase 2 today-live perf sister-shape fill — standalone date-range idx.
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_pc_time ON audit_permission_change(occurred_at)`).run();

  // policy_rule — policy-as-code substrate. Sandboxed DSL evaluator per
  // secops R1 fold (100ms / 1MB / no fs-net-proc); expansion is ADR-
  // amendment-gated. current_version bumps on each rule body change.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS policy_rule (
      rule_id            TEXT PRIMARY KEY,
      name               TEXT NOT NULL,
      description        TEXT NOT NULL,
      applicability_json TEXT NOT NULL,
      predicate_dsl      TEXT NOT NULL,
      severity_class     TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'draft',
      authored_by        TEXT NOT NULL,
      authored_at        TEXT NOT NULL,
      ratified_by        TEXT,
      ratified_at        TEXT,
      current_version    INTEGER NOT NULL DEFAULT 1
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_policy_rule_status ON policy_rule(status)`).run();

  // policy_violation — enforcement-observation log. Each evaluation match
  // produces an event. disposition lifecycle: pending → acknowledged |
  // remediated | accepted-with-rationale | suppressed.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS policy_violation (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id             TEXT NOT NULL,
      rule_id              TEXT NOT NULL,
      rule_version         INTEGER NOT NULL,
      occurred_at          TEXT NOT NULL,
      agent_id             TEXT,
      matched_object_class TEXT NOT NULL,
      matched_object_ref   TEXT NOT NULL,
      match_detail_json    TEXT,
      disposition          TEXT NOT NULL DEFAULT 'pending',
      disposition_by       TEXT,
      disposition_at       TEXT,
      disposition_note     TEXT
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_policy_violation_rule_time ON policy_violation(rule_id, occurred_at)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_policy_violation_agent_time ON policy_violation(agent_id, occurred_at)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_policy_violation_disposition ON policy_violation(disposition)`).run();

  // audit_reconciliation — mirror of cost_reconciliation. admin R3 fold adds
  // reconciler_agent_id (stable identity across ops-key rotations) — keeps
  // reconciled_by as pure forensic ops-key-at-time marker.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS audit_reconciliation (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      period_start          TEXT NOT NULL,
      period_end            TEXT NOT NULL,
      external_system_label TEXT NOT NULL,
      plexus_count          INTEGER NOT NULL,
      external_count        INTEGER NOT NULL,
      delta_count           INTEGER NOT NULL,
      delta_pct             REAL NOT NULL,
      concentration_json    TEXT,
      notes                 TEXT,
      reconciler_agent_id   TEXT NOT NULL,
      reconciled_by         TEXT NOT NULL,
      reconciled_at         TEXT NOT NULL
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_recon_period ON audit_reconciliation(period_end DESC)`).run();

  // CP12.16 Phase 2: reconcile_class column for GRC vocab discipline. Safe
  // ADD COLUMN with DEFAULT so prior rows default to 'other'. Idempotent
  // re-run via PRAGMA check; SQLite has no "ADD COLUMN IF NOT EXISTS".
  const reconColInfo = db.prepare(`PRAGMA table_info(audit_reconciliation)`).all();
  if (!reconColInfo.some(c => c.name === 'reconcile_class')) {
    db.prepare(`ALTER TABLE audit_reconciliation ADD COLUMN reconcile_class TEXT NOT NULL DEFAULT 'other'`).run();
  }
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_recon_class_period ON audit_reconciliation(reconcile_class, period_end DESC)`).run();

  // audit_payload_store — separate deletable-payload store per secops R/
  // Finding 2 fold. payload_ref UUID is the FK from audit tables. Atomic
  // deletion in tombstone transaction per admin R2 fold.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS audit_payload_store (
      payload_ref  TEXT PRIMARY KEY,
      payload      BLOB,
      created_at   TEXT NOT NULL
    )
  `).run();

  // subject_directory — GDPR DSAR hash-at-ingestion pattern per bizmodel
  // #7697 OQ#4 amendment. Single place cleartext user_email lives; tombstone
  // is single-row deletion (severs correlation; audit tables retain
  // subject_hash; hash-chain integrity preserved). Avoids compounding-PII
  // problem (1 row vs 7 tables per DSAR/right-to-be-forgotten).
  db.prepare(`
    CREATE TABLE IF NOT EXISTS subject_directory (
      subject_hash         TEXT PRIMARY KEY,
      user_email_cleartext TEXT,
      created_at           TEXT NOT NULL,
      tombstone_at         TEXT,
      tombstone_reason     TEXT,
      tombstone_by         TEXT
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_subject_directory_tombstone ON subject_directory(tombstone_at)`).run();

  // CP12.4 (2026-06-05): audit_ingester_cursor — last-processed cursor per
  // ingester. Lets the agent_activity → audit_tool_invocation DRY-augment
  // ingester (per ADR-0030 OQ#8 CONCUR) resume across server restarts
  // without reprocessing the same source rows. Key = ingester name.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS audit_ingester_cursor (
      ingester_name    TEXT PRIMARY KEY,
      last_source_id   INTEGER NOT NULL,
      last_run_at      TEXT NOT NULL,
      rows_ingested    INTEGER NOT NULL DEFAULT 0
    )
  `).run();

  // CP12.15 (2026-06-07): audit_channel_subscription_change — per-user
  // channel subscription history (Phase 2). Source: per-user
  // ~/.config/yaklog/channels CSV file. change_type ∈ subscribe|unsubscribe.
  // Each row is atomic: one channel added/removed per scan-with-diff.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS audit_channel_subscription_change (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id      TEXT NOT NULL,
      occurred_at   TEXT NOT NULL,
      agent_id      TEXT NOT NULL,
      change_type   TEXT NOT NULL,
      channel_name  TEXT NOT NULL,
      actor         TEXT NOT NULL,
      source_path   TEXT,
      reason        TEXT
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_csc_time ON audit_channel_subscription_change(occurred_at)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_csc_agent_time ON audit_channel_subscription_change(agent_id, occurred_at)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_csc_channel_time ON audit_channel_subscription_change(channel_name, occurred_at)`).run();

  // CP12.15: channel_subscription_snapshot — single-row baseline mirror.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS channel_subscription_snapshot (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      snapshot_json TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    )
  `).run();

  // Task #223 v1 (2026-07-01): agent_channel_subscription — per-agent
  // CANONICAL-AUTHORITY channel subscription list. Written by admin via
  // POST /api/v1/register/:id/channels; read by daemon ServerChannelPuller.
  // Distinct from CP12.15 audit_channel_subscription_change (LOG tier);
  // this is AUTHORITY tier per PLAN-PLEXUS-ADMIN-CHANNEL-SUBSCRIPTION.
  // Empty rows for agent_id = no server-canonical filter (daemon writes
  // empty file → ChannelWatcher no-filter mode; subscribe-to-all).
  db.prepare(`
    CREATE TABLE IF NOT EXISTS agent_channel_subscription (
      agent_id      TEXT NOT NULL,
      channel       TEXT NOT NULL,
      subscribed_at TEXT NOT NULL,
      subscribed_by TEXT NOT NULL,
      PRIMARY KEY (agent_id, channel)
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_channel_subscription_agent ON agent_channel_subscription(agent_id)`).run();

  // CP12.12 (2026-06-07): audit_anchor — Phase 3 (A) external integrity
  // anchor per parch #7984 4-OQ ratify. Each row records a published daily
  // hash digest anchored to an external append-only substrate (S3 Object
  // Lock baseline; dual-publish forward-track per OQ-3.4). Anchor format
  // is substrate-portable plain-text: (anchor_day, digest_sha256,
  // chain_high_water_event_id, chain_high_water_table). If substrate
  // changes later, only the wrappers change — no data migration.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS audit_anchor (
      id                         INTEGER PRIMARY KEY AUTOINCREMENT,
      anchor_day                 TEXT NOT NULL,
      chain_high_water_event_id  TEXT NOT NULL,
      chain_high_water_table     TEXT NOT NULL,
      digest_sha256              TEXT NOT NULL,
      anchor_substrate           TEXT NOT NULL,
      anchor_uri                 TEXT NOT NULL,
      published_at               TEXT NOT NULL,
      published_by               TEXT NOT NULL,
      UNIQUE(anchor_day, anchor_substrate)
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_anchor_day ON audit_anchor(anchor_day DESC)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_anchor_substrate_day ON audit_anchor(anchor_substrate, anchor_day DESC)`).run();

  // CP12.10 (2026-06-07): audit_attestation — governance-tier substrate
  // for SOC 2 CC1 (Control Environment) / CC2 (Communication & Information)
  // / CC9 (Risk Mitigation). Phase 3 of ADR-0030. Distinct from event-stream
  // audit tables: no machine-emitted rows — each row is a human/ops-key
  // action attesting that a control area was reviewed for a defined period
  // (org-chart review, comm-policy refresh, risk-register review). Lifts
  // Attestation status tile from 3/6 substrate-wired → 6/6.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS audit_attestation (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id           TEXT NOT NULL,
      occurred_at        TEXT NOT NULL,
      control_area       TEXT NOT NULL,
      attestation_class  TEXT NOT NULL,
      attestation_text   TEXT NOT NULL,
      actor              TEXT NOT NULL,
      period_start       TEXT,
      period_end         TEXT,
      reference_url      TEXT
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_attest_area_time ON audit_attestation(control_area, occurred_at DESC)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_attest_time ON audit_attestation(occurred_at)`).run();

  // CP16 Pillar audit-rollup substrate (2026-06-26) per PLAN-CP16-PILLAR-
  // AUDIT-ROLLUP-SUBSTRATE.md. Sister-shape cost_daily canon: pre-aggregate
  // daily rows feed the by-control-area + by-object-class + by-agent endpoint
  // family at <100ms p99 cold-cache. Source tables (audit_*) remain
  // authoritative; rollup is pure pre-computation. Driver: src/auditRollup.js
  // hourly cron rolls up COMPLETE days only (date < today_utc); current-day
  // partial stays in live-query path per §5 two-tier read pattern.
  //
  // No PII (aggregate COUNT rows only — no agent identifiers in by-control-
  // area / by-object-class; agent_id at by-agent tier is internal identifier
  // not user PII per secops #10856 disposition). Idempotent UPSERT.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS audit_daily_by_control_area (
      occurred_date     TEXT NOT NULL,            -- 'YYYY-MM-DD' UTC
      control_framework TEXT NOT NULL,            -- 'soc2' | 'iso27001' | 'gdpr'
      control_area      TEXT NOT NULL,            -- 'CC1'..'CC9' / 'A.5'.. / 'Art.6'..
      count             INTEGER NOT NULL,
      rolled_up_at      TEXT NOT NULL,            -- ISO-8601
      PRIMARY KEY (occurred_date, control_framework, control_area)
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_daily_by_control_area_framework_date
    ON audit_daily_by_control_area (control_framework, occurred_date DESC)`).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS audit_daily_by_object_class (
      occurred_date  TEXT NOT NULL,
      object_class   TEXT NOT NULL,               -- 'tool_invocation' | 'file_access' | 'credential_change' | 'permission_change' | 'attestation' | 'channel_subscription_change' | 'reconciliation' | 'anchor'
      count          INTEGER NOT NULL,
      rolled_up_at   TEXT NOT NULL,
      PRIMARY KEY (occurred_date, object_class)
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_daily_by_object_class_date
    ON audit_daily_by_object_class (occurred_date DESC)`).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS audit_daily_by_agent (
      occurred_date  TEXT NOT NULL,
      agent_id       TEXT NOT NULL,
      object_class   TEXT NOT NULL,               -- per-class breakdown so rollup is faceted
      count          INTEGER NOT NULL,
      rolled_up_at   TEXT NOT NULL,
      PRIMARY KEY (occurred_date, agent_id, object_class)
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_daily_by_agent_date
    ON audit_daily_by_agent (agent_id, occurred_date DESC)`).run();

  // ────────────────────────────────────────────────────────────────────────
  // CP13.1 / ADR-0032 Phase 1.1 — Output-strand substrate (2026-06-17)
  //
  // Three first-class tables for cluster bare-git output tracking.
  // Populated by the bare-git walker (yaklog-output-ingester; Phase 1.2).
  // Per ADR-0032 §Schema canonical:
  //   - output_commit: per-commit lineage with agent-attribution
  //   - output_merge: per-merge lineage (PR-flow + direct-bare-git-push)
  //   - output_ingester_cursor: per-repo last-walked-ref state
  //
  // Phase 2 (GitHub API extension): output_pr + output_pr_review tables
  // deferred to Phase 2 ratify-cycle; schema authored at that cycle.
  //
  // Substrate-by-construction discipline carried forward from ADR-0030 +
  // ADR-0031: agent_attribution column with NULL fallback per
  // [[feedback_no_attribution]]; attribution_method classifier surfaces
  // coverage gaps for /api/v1/output/coverage-gap honesty surface;
  // runtime_class column ties Co-Authored-By trailer parse to CP14.1 canon.
  // ────────────────────────────────────────────────────────────────────────
  db.prepare(`
    CREATE TABLE IF NOT EXISTS output_commit (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      repo                  TEXT NOT NULL,
      commit_sha            TEXT NOT NULL,
      author_name           TEXT NOT NULL,
      author_email          TEXT NOT NULL,
      committer_name        TEXT NOT NULL,
      committer_email       TEXT NOT NULL,
      occurred_at           TEXT NOT NULL,
      branch                TEXT,
      subject               TEXT NOT NULL,
      body_digest           TEXT,
      agent_attribution     TEXT,
      attribution_method    TEXT,
      runtime_class         TEXT,
      files_changed         INTEGER,
      bytes_delta           INTEGER,
      UNIQUE(repo, commit_sha)
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_output_commit_repo_occurred ON output_commit(repo, occurred_at)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_output_commit_agent ON output_commit(agent_attribution, occurred_at)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_output_commit_occurred ON output_commit(occurred_at)`).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS output_merge (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      repo                  TEXT NOT NULL,
      merge_commit_sha      TEXT NOT NULL,
      source_branch         TEXT,
      target_branch         TEXT NOT NULL,
      pr_number             INTEGER,
      occurred_at           TEXT NOT NULL,
      merged_by_agent       TEXT,
      attribution_method    TEXT,
      parent_commit_count   INTEGER,
      child_commit_count    INTEGER,
      bytes_delta           INTEGER,
      UNIQUE(repo, merge_commit_sha)
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_output_merge_occurred ON output_merge(occurred_at)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_output_merge_agent_occurred ON output_merge(merged_by_agent, occurred_at)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_output_merge_repo_occurred ON output_merge(repo, occurred_at)`).run();

  // Sister to audit_ingester_cursor (CP12.5). Tracks per-repo last-walked
  // ref for incremental catchup; attribution_gap_count surfaces parser-miss
  // volume at substrate without needing API query (operator early-warning
  // for attribution-canon drift).
  db.prepare(`
    CREATE TABLE IF NOT EXISTS output_ingester_cursor (
      repo                  TEXT PRIMARY KEY,
      last_ref              TEXT NOT NULL,
      last_walked_at        TEXT NOT NULL,
      commits_ingested      INTEGER NOT NULL DEFAULT 0,
      merges_ingested       INTEGER NOT NULL DEFAULT 0,
      attribution_gap_count INTEGER NOT NULL DEFAULT 0
    )
  `).run();

  // CP13.6 Phase 2.1 / ADR-0032 Phase 2 ratify (parch #9799):
  //   - output_pr: per-PR state metadata from GitHub API
  //     (state/opened_at/merged_at/closed_at + author + branches + merge_sha
  //     for cross-walker join to output_commit + output_merge).
  //   - output_pr_cursor: per-repo incremental-fetch cursor + rate-limit
  //     budget tracking + last-walk diagnostic status.
  //   - output_repo: GitHub repo allowlist canonical (Q1 Option C ratified
  //     parch #9799); bare_git_path links to /srv/git/*.git canonical for
  //     cross-walker correlation; ops-mutable via Phase 2.2 endpoint.
  //
  // output_pr_review DELIBERATELY DROPPED (Q3 unanimous-quorum + parch
  // ratify #9799) — review-substrate is semantic-class-2 anti-feature per
  // ADR-0032 §8 (quality-measurement class); forward-cycle ADR-amendment
  // trigger banked for cluster-discipline-signal class if buyer-recognition
  // gap surfaces (techmark observation #9793 + parch banking #9799).
  db.prepare(`
    CREATE TABLE IF NOT EXISTS output_pr (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      github_owner_repo   TEXT NOT NULL,
      pr_number           INTEGER NOT NULL,
      state               TEXT NOT NULL,
      title               TEXT NOT NULL,
      author_login        TEXT NOT NULL,
      author_email        TEXT,
      base_ref            TEXT NOT NULL,
      head_ref            TEXT NOT NULL,
      opened_at           TEXT NOT NULL,
      merged_at           TEXT,
      closed_at           TEXT,
      merge_commit_sha    TEXT,
      commit_count        INTEGER,
      last_synced_at      TEXT NOT NULL,
      UNIQUE(github_owner_repo, pr_number)
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_output_pr_opened ON output_pr(opened_at)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_output_pr_merged ON output_pr(merged_at)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_output_pr_state ON output_pr(state)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_output_pr_owner_repo ON output_pr(github_owner_repo)`).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS output_pr_cursor (
      github_owner_repo       TEXT PRIMARY KEY,
      last_pr_updated_at      TEXT NOT NULL,
      prs_synced_total        INTEGER NOT NULL DEFAULT 0,
      rate_limit_remaining    INTEGER,
      rate_limit_reset_at     TEXT,
      last_walk_status        TEXT,
      last_walk_message       TEXT
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS output_repo (
      github_owner_repo   TEXT PRIMARY KEY,
      bare_git_path       TEXT,
      enabled             INTEGER NOT NULL DEFAULT 1,
      added_at            TEXT NOT NULL,
      added_by            TEXT,
      last_walked_at      TEXT
    )
  `).run();

  // CP17.A (Jon-direct 2026-07-06; secops #11759 SIGN-OFF; parch #11687 Class B):
  //   - bare_git_request: intent-record for agent-authored bare-git canonical
  //     creation; admin-agent auto-fulfills via poll+execute
  //   - audit_repo_change: non-bypassable audit-fold for every mutation across
  //     output_repo + bare_git_request lifecycle
  // Design shape per PLAN-CP17-CLUSTER-REPO-SUBSTRATE.md §3.1 (T1-T7 security
  // touchpoints baked at design-time per secops #11686/#11688/#11759).
  db.prepare(`
    CREATE TABLE IF NOT EXISTS bare_git_request (
      request_id          INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_name           TEXT NOT NULL,
      requested_by        TEXT NOT NULL,
      purpose             TEXT,
      requested_at        TEXT NOT NULL,
      fulfilled_at        TEXT,
      fulfilled_by        TEXT,
      fulfillment_result  TEXT NOT NULL DEFAULT 'pending',
      error_message       TEXT
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_bare_git_request_status ON bare_git_request(fulfillment_result, requested_at)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_bare_git_request_requester ON bare_git_request(requested_by)`).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS audit_repo_change (
      seq             INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_key        TEXT NOT NULL,
      action          TEXT NOT NULL,
      actor_agent_id  TEXT NOT NULL,
      metadata_json   TEXT,
      at_ts           TEXT NOT NULL
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_repo_change_key ON audit_repo_change(repo_key, at_ts)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_repo_change_actor ON audit_repo_change(actor_agent_id, at_ts)`).run();

  // CP17.B (Jon-direct 2026-07-07 kickoff): output_daily rollup for fast
  // Repos-tab heatmap queries. Sister-shape cost_daily (CP16 Pillar 2) +
  // audit_daily_by_agent (Task #253). Promotes daily-rollup pattern to N=3
  // canonicalization per parch #11687 canon-fold observation.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS output_daily (
      date              TEXT NOT NULL,
      repo_key          TEXT NOT NULL,
      agent_id          TEXT NOT NULL,
      commits           INTEGER NOT NULL DEFAULT 0,
      merges            INTEGER NOT NULL DEFAULT 0,
      prs_opened        INTEGER NOT NULL DEFAULT 0,
      prs_merged        INTEGER NOT NULL DEFAULT 0,
      attribution_gaps  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, repo_key, agent_id)
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_output_daily_date ON output_daily(date)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_output_daily_repo ON output_daily(repo_key, date)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_output_daily_agent ON output_daily(agent_id, date)`).run();

  return db;
}

function getDb() {
  return db || initializeDb();
}

// ── CP13.6 Phase 2.2: output_pr + output_pr_cursor + output_repo helpers ───

const UPSERT_OUTPUT_PR_SQL = `
  INSERT INTO output_pr (
    github_owner_repo, pr_number, state, title, author_login, author_email,
    base_ref, head_ref, opened_at, merged_at, closed_at, merge_commit_sha,
    commit_count, last_synced_at
  ) VALUES (
    @github_owner_repo, @pr_number, @state, @title, @author_login, @author_email,
    @base_ref, @head_ref, @opened_at, @merged_at, @closed_at, @merge_commit_sha,
    @commit_count, @last_synced_at
  )
  ON CONFLICT(github_owner_repo, pr_number) DO UPDATE SET
    state            = excluded.state,
    title            = excluded.title,
    author_email     = excluded.author_email,
    merged_at        = excluded.merged_at,
    closed_at        = excluded.closed_at,
    merge_commit_sha = excluded.merge_commit_sha,
    commit_count     = excluded.commit_count,
    last_synced_at   = excluded.last_synced_at
`;

function upsertOutputPr(row) {
  const database = getDb();
  database.prepare(UPSERT_OUTPUT_PR_SQL).run({
    github_owner_repo: row.github_owner_repo,
    pr_number: row.pr_number,
    state: row.state,
    title: row.title,
    author_login: row.author_login,
    author_email: row.author_email ?? null,
    base_ref: row.base_ref,
    head_ref: row.head_ref,
    opened_at: row.opened_at,
    merged_at: row.merged_at ?? null,
    closed_at: row.closed_at ?? null,
    merge_commit_sha: row.merge_commit_sha ?? null,
    commit_count: row.commit_count ?? null,
    last_synced_at: row.last_synced_at,
  });
}

function getOutputPrCursor(githubOwnerRepo) {
  const database = getDb();
  return database.prepare(
    `SELECT * FROM output_pr_cursor WHERE github_owner_repo = ?`
  ).get(githubOwnerRepo) || null;
}

function upsertOutputPrCursor(githubOwnerRepo, cursor) {
  const database = getDb();
  database.prepare(`
    INSERT INTO output_pr_cursor (
      github_owner_repo, last_pr_updated_at, prs_synced_total,
      rate_limit_remaining, rate_limit_reset_at, last_walk_status, last_walk_message
    ) VALUES (
      @github_owner_repo, @last_pr_updated_at, @prs_synced_total,
      @rate_limit_remaining, @rate_limit_reset_at, @last_walk_status, @last_walk_message
    )
    ON CONFLICT(github_owner_repo) DO UPDATE SET
      last_pr_updated_at   = excluded.last_pr_updated_at,
      prs_synced_total     = excluded.prs_synced_total,
      rate_limit_remaining = excluded.rate_limit_remaining,
      rate_limit_reset_at  = excluded.rate_limit_reset_at,
      last_walk_status     = excluded.last_walk_status,
      last_walk_message    = excluded.last_walk_message
  `).run({
    github_owner_repo: githubOwnerRepo,
    last_pr_updated_at: cursor.last_pr_updated_at,
    prs_synced_total: cursor.prs_synced_total ?? 0,
    rate_limit_remaining: cursor.rate_limit_remaining ?? null,
    rate_limit_reset_at: cursor.rate_limit_reset_at ?? null,
    last_walk_status: cursor.last_walk_status ?? null,
    last_walk_message: cursor.last_walk_message ?? null,
  });
}

function listEnabledOutputRepos() {
  const database = getDb();
  return database.prepare(
    `SELECT * FROM output_repo WHERE enabled = 1 ORDER BY github_owner_repo`
  ).all();
}

function listAllOutputRepos() {
  const database = getDb();
  return database.prepare(
    `SELECT * FROM output_repo ORDER BY github_owner_repo`
  ).all();
}

function upsertOutputRepo({ github_owner_repo, bare_git_path = null, enabled = 1, added_by = null }) {
  const database = getDb();
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  database.prepare(`
    INSERT INTO output_repo (github_owner_repo, bare_git_path, enabled, added_at, added_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(github_owner_repo) DO UPDATE SET
      bare_git_path = COALESCE(excluded.bare_git_path, output_repo.bare_git_path),
      enabled       = excluded.enabled
  `).run(github_owner_repo, bare_git_path, enabled, nowIso, added_by);
}

function disableOutputRepo(githubOwnerRepo) {
  const database = getDb();
  const result = database.prepare(
    `UPDATE output_repo SET enabled = 0 WHERE github_owner_repo = ?`
  ).run(githubOwnerRepo);
  return result.changes;
}

/**
 * Bootstrap output_repo allowlist from per-host config file at first walk if
 * table is empty. Config format: one entry per line; either `owner/repo` OR
 * `owner/repo\t/srv/git/repo.git`. Blank lines + `#` comments skipped.
 * Per Q1 Option C ratify (parch #9799).
 */
function bootstrapOutputReposFromConfig(configPath) {
  const fs = require('node:fs');
  const database = getDb();
  const existing = database.prepare(`SELECT COUNT(*) AS n FROM output_repo`).get();
  if (existing.n > 0) return { bootstrapped: 0, reason: 'output_repo not empty' };
  if (!configPath || !fs.existsSync(configPath)) {
    return { bootstrapped: 0, reason: 'no config file' };
  }
  const content = fs.readFileSync(configPath, 'utf8');
  let count = 0;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const githubOwnerRepo = parts[0];
    const bareGitPath = parts[1] || null;
    if (!githubOwnerRepo.includes('/')) continue;
    upsertOutputRepo({ github_owner_repo: githubOwnerRepo, bare_git_path: bareGitPath, added_by: 'bootstrap-from-config' });
    count += 1;
  }
  return { bootstrapped: count, reason: count > 0 ? 'bootstrapped from config' : 'config empty' };
}

// ── CP17.A helpers (bare_git_request + audit_repo_change) ─────────────────
// Per PLAN-CP17-CLUSTER-REPO-SUBSTRATE.md §3.1 + secops #11759 SIGN-OFF.
// Atomic compare-and-set on fulfillment transition per secops §3.1.2 condition
// (prevents double-execution across fulfiller restart).

function insertBareGitRequest({ repo_name, requested_by, purpose = null }) {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO bare_git_request (repo_name, requested_by, purpose, requested_at, fulfillment_result)
    VALUES (@repo_name, @requested_by, @purpose, datetime('now'), 'pending')
  `);
  const result = stmt.run({ repo_name, requested_by, purpose });
  return result.lastInsertRowid;
}

function getBareGitRequest(requestId) {
  const database = getDb();
  return database.prepare(`SELECT * FROM bare_git_request WHERE request_id = ?`).get(requestId);
}

function getPendingBareGitRequestByName(repo_name) {
  const database = getDb();
  return database.prepare(
    `SELECT * FROM bare_git_request WHERE repo_name = ? AND fulfillment_result = 'pending'`
  ).get(repo_name);
}

function listPendingBareGitRequests() {
  const database = getDb();
  return database.prepare(
    `SELECT * FROM bare_git_request WHERE fulfillment_result = 'pending' ORDER BY requested_at`
  ).all();
}

// Atomic compare-and-set: transitions 'pending' → 'success'|'error' only if
// current state is 'pending'. Returns changes count (1 on success, 0 if row
// no longer pending — race guard). Per secops #11759 §3.1.2 condition:
// "T4 must be a genuinely ATOMIC compare-and-set" so a record can't be
// double-executed across fulfiller restart.
function fulfillBareGitRequest({ request_id, fulfilled_by, result, error_message = null }) {
  if (result !== 'success' && result !== 'error') {
    throw new Error(`fulfillBareGitRequest: result must be 'success' or 'error' (got ${result})`);
  }
  const database = getDb();
  const stmt = database.prepare(`
    UPDATE bare_git_request
    SET fulfilled_at = datetime('now'),
        fulfilled_by = @fulfilled_by,
        fulfillment_result = @result,
        error_message = @error_message
    WHERE request_id = @request_id
      AND fulfillment_result = 'pending'
  `);
  const info = stmt.run({ request_id, fulfilled_by, result, error_message });
  return info.changes;
}

function insertAuditRepoChange({ repo_key, action, actor_agent_id, metadata = null }) {
  const database = getDb();
  const metadata_json = metadata ? JSON.stringify(metadata) : null;
  const stmt = database.prepare(`
    INSERT INTO audit_repo_change (repo_key, action, actor_agent_id, metadata_json, at_ts)
    VALUES (@repo_key, @action, @actor_agent_id, @metadata_json, datetime('now'))
  `);
  const result = stmt.run({ repo_key, action, actor_agent_id, metadata_json });
  return result.lastInsertRowid;
}

function listAuditRepoChangesByRepo(repo_key, { limit = 100 } = {}) {
  const database = getDb();
  return database.prepare(
    `SELECT * FROM audit_repo_change WHERE repo_key = ? ORDER BY seq DESC LIMIT ?`
  ).all(repo_key, limit);
}

// ── CP17.B output_daily rollup helpers ────────────────────────────────────
// Per PLAN-CP17-CLUSTER-REPO-SUBSTRATE.md §3.2. Sister-shape cost_daily and
// audit_daily rollup discipline (idempotent DELETE + INSERT within txn).
// Nightly job runs rebuildOutputDailyForDate(date) at daemon-load-off hour.

// Idempotent: DELETE existing rows for date, then INSERT aggregated rows from
// output_commit + output_pr for that date. Wrapped in caller transaction where
// atomicity across multi-date runs is desired.
function rebuildOutputDailyForDate(date) {
  const database = getDb();
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`rebuildOutputDailyForDate: date must be YYYY-MM-DD (got ${date})`);
  }
  const tx = database.transaction(() => {
    // Clean existing rows for date (idempotent).
    database.prepare(`DELETE FROM output_daily WHERE date = ?`).run(date);

    // Aggregate output_commit for date grouped by (repo, agent_attribution).
    // NULL attribution → 'unattributed' bucket + attribution_gaps counter.
    database.prepare(`
      INSERT INTO output_daily (date, repo_key, agent_id, commits, attribution_gaps)
      SELECT
        date(occurred_at) AS date,
        repo AS repo_key,
        COALESCE(agent_attribution, 'unattributed') AS agent_id,
        COUNT(*) AS commits,
        SUM(CASE WHEN agent_attribution IS NULL THEN 1 ELSE 0 END) AS attribution_gaps
      FROM output_commit
      WHERE date(occurred_at) = @date
      GROUP BY date(occurred_at), repo, COALESCE(agent_attribution, 'unattributed')
    `).run({ date });

    // Aggregate output_merge for date grouped by (repo, merged_by_agent).
    // UPSERT on top of any existing commits row from above.
    database.prepare(`
      INSERT INTO output_daily (date, repo_key, agent_id, merges)
      SELECT
        date(occurred_at) AS date,
        repo AS repo_key,
        COALESCE(merged_by_agent, 'unattributed') AS agent_id,
        COUNT(*) AS merges
      FROM output_merge
      WHERE date(occurred_at) = @date
      GROUP BY date(occurred_at), repo, COALESCE(merged_by_agent, 'unattributed')
      ON CONFLICT (date, repo_key, agent_id) DO UPDATE SET
        merges = merges + excluded.merges
    `).run({ date });

    // Aggregate output_pr for date grouped by github_owner_repo + pr author.
    // prs_opened rolls up by opened_at date; prs_merged by merged_at date (which
    // may be different from opened_at, so runs as separate aggregation).
    database.prepare(`
      INSERT INTO output_daily (date, repo_key, agent_id, prs_opened)
      SELECT
        date(opened_at) AS date,
        github_owner_repo AS repo_key,
        COALESCE(author_login, 'unattributed') AS agent_id,
        COUNT(*) AS prs_opened
      FROM output_pr
      WHERE opened_at IS NOT NULL AND date(opened_at) = @date
      GROUP BY date(opened_at), github_owner_repo, COALESCE(author_login, 'unattributed')
      ON CONFLICT (date, repo_key, agent_id) DO UPDATE SET
        prs_opened = prs_opened + excluded.prs_opened
    `).run({ date });

    database.prepare(`
      INSERT INTO output_daily (date, repo_key, agent_id, prs_merged)
      SELECT
        date(merged_at) AS date,
        github_owner_repo AS repo_key,
        COALESCE(author_login, 'unattributed') AS agent_id,
        COUNT(*) AS prs_merged
      FROM output_pr
      WHERE merged_at IS NOT NULL AND date(merged_at) = @date
      GROUP BY date(merged_at), github_owner_repo, COALESCE(author_login, 'unattributed')
      ON CONFLICT (date, repo_key, agent_id) DO UPDATE SET
        prs_merged = prs_merged + excluded.prs_merged
    `).run({ date });
  });
  tx();
  const count = database.prepare(`SELECT COUNT(*) AS n FROM output_daily WHERE date = ?`).get(date);
  return { date, rows: count.n };
}

// Virtual current-day rollup (Task #274/#275 forward-track: live-tail per
// PLAN §3.2). Computes output_daily-shaped rows for a single date without
// persisting. Called by query helpers when the window includes today.
function queryVirtualOutputDailyForDate(date) {
  const database = getDb();
  const rows = new Map();
  const bucket = (repo, agent) => {
    const k = `${repo} ${agent}`;
    if (!rows.has(k)) {
      rows.set(k, {
        date, repo_key: repo, agent_id: agent,
        commits: 0, merges: 0, prs_opened: 0, prs_merged: 0, attribution_gaps: 0,
      });
    }
    return rows.get(k);
  };
  for (const c of database.prepare(`
    SELECT repo, COALESCE(agent_attribution, 'unattributed') AS agent, COUNT(*) AS n,
           SUM(CASE WHEN agent_attribution IS NULL THEN 1 ELSE 0 END) AS gaps
    FROM output_commit WHERE date(occurred_at) = @date
    GROUP BY repo, COALESCE(agent_attribution, 'unattributed')
  `).all({ date })) {
    const r = bucket(c.repo, c.agent);
    r.commits += c.n;
    r.attribution_gaps += c.gaps;
  }
  for (const m of database.prepare(`
    SELECT repo, COALESCE(merged_by_agent, 'unattributed') AS agent, COUNT(*) AS n
    FROM output_merge WHERE date(occurred_at) = @date
    GROUP BY repo, COALESCE(merged_by_agent, 'unattributed')
  `).all({ date })) {
    bucket(m.repo, m.agent).merges += m.n;
  }
  for (const p of database.prepare(`
    SELECT github_owner_repo AS repo, COALESCE(author_login, 'unattributed') AS agent, COUNT(*) AS n
    FROM output_pr WHERE opened_at IS NOT NULL AND date(opened_at) = @date
    GROUP BY github_owner_repo, COALESCE(author_login, 'unattributed')
  `).all({ date })) {
    bucket(p.repo, p.agent).prs_opened += p.n;
  }
  for (const p of database.prepare(`
    SELECT github_owner_repo AS repo, COALESCE(author_login, 'unattributed') AS agent, COUNT(*) AS n
    FROM output_pr WHERE merged_at IS NOT NULL AND date(merged_at) = @date
    GROUP BY github_owner_repo, COALESCE(author_login, 'unattributed')
  `).all({ date })) {
    bucket(p.repo, p.agent).prs_merged += p.n;
  }
  return [...rows.values()];
}

// Read output_daily rows for [from, to] with live-tail current-day. Returns
// row array where today (if in range) is computed virtually rather than
// read from output_daily. Ensures Repos-tab activity shows even before
// nightly rollup fires. Sister-shape existing daily-rollup live-tail canon
// per PLAN §3.2.
function _readOutputDailyRowsInRange({ from, to }) {
  const today = new Date().toISOString().slice(0, 10);
  const database = getDb();
  const includesToday = today >= from && today <= to;
  const rollupRows = database.prepare(`
    SELECT date, repo_key, agent_id, commits, merges, prs_opened, prs_merged, attribution_gaps
    FROM output_daily WHERE date >= @from AND date <= @to
      AND (@includesToday = 0 OR date != @today)
  `).all({ from, to, today, includesToday: includesToday ? 1 : 0 });
  if (!includesToday) return rollupRows;
  return rollupRows.concat(queryVirtualOutputDailyForDate(today));
}

function queryOutputDailySummary({ from, to }) {
  const rows = _readOutputDailyRowsInRange({ from, to });
  const repos = new Set(), agents = new Set();
  let commit_count = 0, merge_count = 0, pr_opened_count = 0, pr_merged_count = 0, attribution_gap_count = 0;
  for (const r of rows) {
    repos.add(r.repo_key);
    if (r.agent_id !== 'unattributed') agents.add(r.agent_id);
    commit_count += r.commits || 0;
    merge_count += r.merges || 0;
    pr_opened_count += r.prs_opened || 0;
    pr_merged_count += r.prs_merged || 0;
    attribution_gap_count += r.attribution_gaps || 0;
  }
  return {
    repo_count: repos.size,
    commit_count, merge_count, pr_opened_count, pr_merged_count,
    engaged_agents: agents.size,
    attribution_gap_count,
  };
}

function queryOutputDailyHeatmap({ from, to, dim = 'commits', filter_repo = null, filter_agent = null }) {
  const validDims = new Set(['commits', 'merges', 'prs_opened', 'prs_merged', 'attribution_gaps']);
  if (!validDims.has(dim)) {
    throw new Error(`queryOutputDailyHeatmap: dim must be one of ${[...validDims].join(', ')}`);
  }
  const rows = _readOutputDailyRowsInRange({ from, to });
  const byDate = new Map();
  for (const r of rows) {
    if (filter_repo && r.repo_key !== filter_repo) continue;
    if (filter_agent && r.agent_id !== filter_agent) continue;
    byDate.set(r.date, (byDate.get(r.date) || 0) + (r[dim] || 0));
  }
  return [...byDate.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function queryOutputDailyRepoList({ from, to }) {
  const rows = _readOutputDailyRowsInRange({ from, to });
  const byRepo = new Map();
  for (const r of rows) {
    if (!byRepo.has(r.repo_key)) {
      byRepo.set(r.repo_key, {
        repo_key: r.repo_key,
        commit_count: 0, merge_count: 0, pr_opened_count: 0, pr_merged_count: 0,
        _agents: new Set(), attribution_gap_count: 0, last_activity_at: null,
      });
    }
    const g = byRepo.get(r.repo_key);
    g.commit_count += r.commits || 0;
    g.merge_count += r.merges || 0;
    g.pr_opened_count += r.prs_opened || 0;
    g.pr_merged_count += r.prs_merged || 0;
    if (r.agent_id !== 'unattributed') g._agents.add(r.agent_id);
    g.attribution_gap_count += r.attribution_gaps || 0;
    if (!g.last_activity_at || r.date > g.last_activity_at) g.last_activity_at = r.date;
  }
  return [...byRepo.values()]
    .map(g => ({
      repo_key: g.repo_key,
      commit_count: g.commit_count,
      merge_count: g.merge_count,
      pr_opened_count: g.pr_opened_count,
      pr_merged_count: g.pr_merged_count,
      engaged_agents_count: g._agents.size,
      attribution_gap_count: g.attribution_gap_count,
      last_activity_at: g.last_activity_at,
    }))
    .sort((a, b) => b.commit_count - a.commit_count);
}

// Multi-day rollup driver — sister-shape rollupAuditWindow. Rolls a rolling
// window of complete UTC days ending at end_date_exclusive (default = today).
// Idempotent per rebuildOutputDailyForDate. Returns { rolled, window_days,
// end_date_exclusive, results:[{date, rows}] }.
function rollupOutputWindow({ daysBack = 30, endDateExclusive } = {}) {
  if (!Number.isInteger(daysBack) || daysBack < 1 || daysBack > 365) {
    throw new Error(`rollupOutputWindow: daysBack must be integer 1..365 (got ${daysBack})`);
  }
  const database = getDb();
  // end_date_exclusive default = today (UTC); we roll dates STRICTLY BEFORE it
  const endIso = endDateExclusive || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endIso)) {
    throw new Error(`rollupOutputWindow: end_date_exclusive must be YYYY-MM-DD (got ${endIso})`);
  }
  const dates = [];
  const endMs = Date.parse(endIso + 'T00:00:00Z');
  for (let i = 1; i <= daysBack; i += 1) {
    const d = new Date(endMs - i * 86400 * 1000).toISOString().slice(0, 10);
    dates.push(d);
  }
  dates.sort();  // oldest first
  const results = [];
  for (const date of dates) {
    const r = rebuildOutputDailyForDate(date);
    results.push(r);
  }
  return {
    rolled: results.length,
    window_days: daysBack,
    end_date_exclusive: endIso,
    results,
  };
}

// Distinct agents active in window, ordered by commit_count DESC. Used by
// Repos tab agent-filter dropdown enumeration (Task 6). Caps at limit rows
// to keep dropdown UX bounded; excludes 'unattributed' bucket per attribution-
// canon (filter should surface KNOWN agents; unattributed is a separate
// dimension surfaced via attribution_gaps counter).
// Activity feed for Repos tab (CP17.C Task 2). UNION recent commits + PRs
// from output_commit + output_pr; normalized into { kind, repo_key, actor,
// summary, at_ts, ref } rows sorted DESC. Capped at limit rows for feed UX.
function queryRepoActivityFeed({ from, to, limit = 50 }) {
  const database = getDb();
  const rows = database.prepare(`
    SELECT * FROM (
      SELECT
        'commit' AS kind,
        repo AS repo_key,
        COALESCE(agent_attribution, author_name, 'unknown') AS actor,
        subject AS summary,
        occurred_at AS at_ts,
        commit_sha AS ref
      FROM output_commit
      WHERE date(occurred_at) >= @from AND date(occurred_at) <= @to
      UNION ALL
      SELECT
        CASE WHEN merged_at IS NOT NULL THEN 'pr_merged' ELSE 'pr_opened' END AS kind,
        github_owner_repo AS repo_key,
        author_login AS actor,
        title AS summary,
        COALESCE(merged_at, opened_at) AS at_ts,
        CAST(pr_number AS TEXT) AS ref
      FROM output_pr
      WHERE (opened_at IS NOT NULL AND date(opened_at) >= @from AND date(opened_at) <= @to)
         OR (merged_at IS NOT NULL AND date(merged_at) >= @from AND date(merged_at) <= @to)
    )
    ORDER BY at_ts DESC
    LIMIT @limit
  `).all({ from, to, limit });
  return rows;
}

function queryOutputDailyAgentsInWindow({ from, to, limit = 100 }) {
  const rows = _readOutputDailyRowsInRange({ from, to });
  const byAgent = new Map();
  for (const r of rows) {
    if (r.agent_id === 'unattributed') continue;
    if (!byAgent.has(r.agent_id)) {
      byAgent.set(r.agent_id, { agent_id: r.agent_id, commit_count: 0, _repos: new Set() });
    }
    const g = byAgent.get(r.agent_id);
    g.commit_count += r.commits || 0;
    g._repos.add(r.repo_key);
  }
  return [...byAgent.values()]
    .map(g => ({ agent_id: g.agent_id, commit_count: g.commit_count, repo_count: g._repos.size }))
    .sort((a, b) => b.commit_count - a.commit_count)
    .slice(0, limit);
}

function queryOutputDailyByAgent({ agent_id, from, to }) {
  const rows = _readOutputDailyRowsInRange({ from, to });
  const byRepo = new Map();
  for (const r of rows) {
    if (r.agent_id !== agent_id) continue;
    if (!byRepo.has(r.repo_key)) {
      byRepo.set(r.repo_key, {
        repo_key: r.repo_key,
        commit_count: 0, merge_count: 0, pr_opened_count: 0, pr_merged_count: 0,
        first_activity_at: null, last_activity_at: null,
      });
    }
    const g = byRepo.get(r.repo_key);
    g.commit_count += r.commits || 0;
    g.merge_count += r.merges || 0;
    g.pr_opened_count += r.prs_opened || 0;
    g.pr_merged_count += r.prs_merged || 0;
    if (!g.first_activity_at || r.date < g.first_activity_at) g.first_activity_at = r.date;
    if (!g.last_activity_at || r.date > g.last_activity_at) g.last_activity_at = r.date;
  }
  return [...byRepo.values()].sort((a, b) => b.commit_count - a.commit_count);
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

function listMessages({ channel, limit = 50, afterId = null, beforeId = null, beforeTs = null, afterTs = null }) {
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

  // Task #264 Phase 2.6 (Jon-direct 2026-07-03): time-anchored cursor for
  // dashboard-tier time-navigation Bus tab. before_ts / after_ts accept
  // ISO-8601 strings; use SQLite's datetime() function on BOTH sides to
  // normalize — created_at is stored as "YYYY-MM-DD HH:MM:SS" (SQLite's
  // datetime('now') default; SPACE separator) while ISO uses 'T'. Direct
  // lexicographic string compare across separators returns wrong results
  // (space < T means any created_at row is < any ISO cursor).
  if (beforeTs !== null) {
    where.push('datetime(created_at) < datetime(@beforeTs)');
    params.beforeTs = beforeTs;
  }
  if (afterTs !== null) {
    where.push('datetime(created_at) >= datetime(@afterTs)');
    params.afterTs = afterTs;
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

// CP11.x.2 (2026-06-13): vendor derivation from model identifier. Aligned
// with the s345-aieng #8539 canonical runtime_class enum (claude-code /
// codex-cli / gemini-cli) but expressed at the vendor name level for
// Cost dashboard rendering. Update both this function AND the migration
// backfill CASE expression in tandem when adding new vendors.
function vendorOf(model) {
  if (!model || typeof model !== 'string') return 'Other';
  if (model.startsWith('claude-')) return 'Anthropic';
  if (model.startsWith('gemini-')) return 'Google';
  if (model.startsWith('gpt-') || model.startsWith('codex-')) return 'OpenAI';
  if (/^o[1-4]-/.test(model)) return 'OpenAI';
  return 'Other';
}

// UPSERT a cost_daily row. Unique on (date, full dim-tuple); INSERT OR
// REPLACE preserves the auto-increment id-cycle but is acceptable for
// daily-rollup re-runs (id stability not load-bearing for cost_daily).
function upsertCostDaily(row) {
  if (!row || !row.date || typeof row.date !== 'string') {
    throw new Error('upsertCostDaily: row.date is required (YYYY-MM-DD)');
  }
  const database = getDb();
  const computed_at = row.computed_at || new Date().toISOString();
  // CP11.x.2: prefer caller-supplied vendor; derive from model otherwise.
  // Allows Layer-2 codex/gemini emitters (per s345-aieng #8539 schema) to
  // pass vendor explicitly while CC/Prom-rollup path derives from model.
  const vendor = row.vendor || vendorOf(row.model);
  database.prepare(`
    INSERT INTO cost_daily (
      date, agent_id, user_email, organization_id, model, host,
      cost_center, project_tag, environment_tier, billable_flag,
      tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation,
      cost_usd, source, computed_at, vendor
    ) VALUES (
      @date, @agent_id, @user_email, @organization_id, @model, @host,
      @cost_center, @project_tag, @environment_tier, @billable_flag,
      @tokens_input, @tokens_output, @tokens_cache_read, @tokens_cache_creation,
      @cost_usd, @source, @computed_at, @vendor
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
      computed_at           = excluded.computed_at,
      vendor                = excluded.vendor
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
    vendor,
  });
}

// Query cost_daily rows by date range with optional dimension filter.
// Returns array of row objects (NOT aggregated; caller sums if needed).
// CP11.x.2: aggregate cost_daily grouped by vendor across [from, to]. Returns
// array of {vendor, cost_usd, tokens_input, tokens_output, tokens_cache_read,
// tokens_cache_creation, row_count, agent_count} ordered by cost desc.
// Powers the per-vendor totals strip + share-% pills on the Cost tab.
function getCostByVendor({ from, to } = {}) {
  if (!from || !to) throw new Error('getCostByVendor: from + to are required (YYYY-MM-DD)');
  const database = getDb();
  return database.prepare(`
    SELECT
      COALESCE(NULLIF(vendor, ''), 'Other') AS vendor,
      ROUND(SUM(cost_usd), 4) AS cost_usd,
      SUM(tokens_input) AS tokens_input,
      SUM(tokens_output) AS tokens_output,
      SUM(tokens_cache_read) AS tokens_cache_read,
      SUM(tokens_cache_creation) AS tokens_cache_creation,
      COUNT(*) AS row_count,
      COUNT(DISTINCT agent_id) AS agent_count
    FROM cost_daily
    WHERE date >= @from AND date <= @to
    GROUP BY COALESCE(NULLIF(vendor, ''), 'Other')
    ORDER BY cost_usd DESC
  `).all({ from, to });
}

// CP11.x.2: per-vendor daily-bucket time-series for the composition-lens
// stacked-area chart. Returns array of {date, vendor, cost_usd}.
function getCostByVendorDaily({ from, to } = {}) {
  if (!from || !to) throw new Error('getCostByVendorDaily: from + to are required (YYYY-MM-DD)');
  const database = getDb();
  return database.prepare(`
    SELECT
      date,
      COALESCE(NULLIF(vendor, ''), 'Other') AS vendor,
      ROUND(SUM(cost_usd), 4) AS cost_usd
    FROM cost_daily
    WHERE date >= @from AND date <= @to
    GROUP BY date, COALESCE(NULLIF(vendor, ''), 'Other')
    ORDER BY date ASC, cost_usd DESC
  `).all({ from, to });
}

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

// ============================================================================
// CP12.1 (2026-06-04): ADR-0030 v1.1 audit + governance helpers.
// Hash-chain formula per admin R2 fold-in:
//   event_id = sha256(prev_event_id || occurred_at || agent_id || action_class || metadata_only)[0:16]
// Subject hash for GDPR DSAR per bizmodel #7697 OQ#4 fold:
//   subject_hash = sha256(user_email).hex (full 64 chars)
// Atomic tombstone txn per admin R2: payload delete + tombstone_at set in
// same SQLite transaction; reader checks tombstone_at IS NOT NULL before
// payload dereference, returns tombstone-marker when set.
// ============================================================================

// Compute hash-chain event_id (16-char correlation handle, anchor-compatible).
// metadata_only EXCLUDES payload_ref content per admin R2 — guarantees
// tombstoning a payload does not break hash-chain verification.
function computeAuditEventId(prevEventId, occurredAt, agentId, actionClass, metadataOnly) {
  const input = [
    prevEventId || '',
    occurredAt || '',
    agentId || '',
    actionClass || '',
    typeof metadataOnly === 'string' ? metadataOnly : JSON.stringify(metadataOnly || {}),
  ].join('|');
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

// Compute subject_hash for GDPR DSAR queries (full 64-char sha256 of email).
function subjectHash(userEmail) {
  if (!userEmail || typeof userEmail !== 'string') return null;
  return crypto.createHash('sha256').update(userEmail.toLowerCase().trim()).digest('hex');
}

// Compute full sha256 hex of a buffer or string (for input_digest / output_digest).
// Full 64-char per secops R3 fold — tombstone integrity evidence after payload deletion.
function fullSha256(input) {
  if (input == null) return null;
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ─── audit_tool_invocation ──────────────────────────────────────────────────

function insertAuditToolInvocation(row) {
  if (!row || !row.agent_id || !row.tool_name || !row.tool_phase) {
    throw new Error('insertAuditToolInvocation: agent_id + tool_name + tool_phase required');
  }
  if (!['pre', 'post', 'failure'].includes(row.tool_phase)) {
    throw new Error(`insertAuditToolInvocation: tool_phase must be pre|post|failure (got ${row.tool_phase})`);
  }
  const database = getDb();
  const occurred_at = row.occurred_at || new Date().toISOString();
  const event_id = row.event_id || computeAuditEventId(
    row.prev_event_id, occurred_at, row.agent_id, `tool:${row.tool_phase}`,
    { tool_name: row.tool_name, status: row.status || null, source_event_id: row.source_event_id || null }
  );
  const result = database.prepare(`
    INSERT INTO audit_tool_invocation (
      event_id, agent_id, occurred_at, tool_name, tool_phase,
      input_digest, output_digest, status, status_detail,
      subagent_type, source_event_id, payload_ref
    ) VALUES (
      @event_id, @agent_id, @occurred_at, @tool_name, @tool_phase,
      @input_digest, @output_digest, @status, @status_detail,
      @subagent_type, @source_event_id, @payload_ref
    )
  `).run({
    event_id,
    agent_id: row.agent_id,
    occurred_at,
    tool_name: row.tool_name,
    tool_phase: row.tool_phase,
    input_digest: row.input_digest || null,
    output_digest: row.output_digest || null,
    status: row.status || null,
    status_detail: row.status_detail ? String(row.status_detail).slice(0, 200) : null,
    subagent_type: row.subagent_type || null,
    source_event_id: row.source_event_id || null,
    payload_ref: row.payload_ref || null,
  });
  return { id: result.lastInsertRowid, event_id };
}

function listAuditToolInvocations({ from, to, agent_id, tool_name, status, limit = 100 } = {}) {
  const database = getDb();
  const where = [];
  const params = {};
  if (from) { where.push('occurred_at >= @from'); params.from = from; }
  if (to)   { where.push('occurred_at <= @to'); params.to = to; }
  if (agent_id)  { where.push('agent_id = @agent_id'); params.agent_id = agent_id; }
  if (tool_name) { where.push('tool_name = @tool_name'); params.tool_name = tool_name; }
  if (status)    { where.push('status = @status'); params.status = status; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return database
    .prepare(`SELECT * FROM audit_tool_invocation ${whereClause} ORDER BY occurred_at DESC LIMIT @limit`)
    .all({ ...params, limit });
}

function getAuditToolInvocationByEventId(event_id) {
  const database = getDb();
  return database.prepare('SELECT * FROM audit_tool_invocation WHERE event_id = ?').get(event_id) || null;
}

// ─── audit_file_access ──────────────────────────────────────────────────────

function insertAuditFileAccess(row) {
  if (!row || row.uid == null || !row.path || !row.access_mode) {
    throw new Error('insertAuditFileAccess: uid + path + access_mode required');
  }
  const database = getDb();
  const occurred_at = row.occurred_at || new Date().toISOString();
  const attribution_confidence = row.attribution_confidence || 'uid_unique';
  if (!['uid_unique', 'uid_shared'].includes(attribution_confidence)) {
    throw new Error(`insertAuditFileAccess: attribution_confidence must be uid_unique|uid_shared`);
  }
  const event_id = row.event_id || computeAuditEventId(
    row.prev_event_id, occurred_at, row.agent_id || `uid:${row.uid}`, `file:${row.access_mode}`,
    { path: row.path, attribution_confidence }
  );
  const result = database.prepare(`
    INSERT INTO audit_file_access (
      event_id, occurred_at, agent_id, uid, path, access_mode,
      bytes_in, bytes_out, content_digest,
      attribution_confidence, session_correlator, payload_ref
    ) VALUES (
      @event_id, @occurred_at, @agent_id, @uid, @path, @access_mode,
      @bytes_in, @bytes_out, @content_digest,
      @attribution_confidence, @session_correlator, @payload_ref
    )
  `).run({
    event_id,
    occurred_at,
    agent_id: row.agent_id || null,
    uid: row.uid,
    path: row.path,
    access_mode: row.access_mode,
    bytes_in: row.bytes_in != null ? row.bytes_in : null,
    bytes_out: row.bytes_out != null ? row.bytes_out : null,
    content_digest: row.content_digest || null,
    attribution_confidence,
    session_correlator: row.session_correlator || null,
    payload_ref: row.payload_ref || null,
  });
  return { id: result.lastInsertRowid, event_id };
}

function listAuditFileAccess({ from, to, agent_id, path_prefix, limit = 100 } = {}) {
  const database = getDb();
  const where = [];
  const params = {};
  if (from) { where.push('occurred_at >= @from'); params.from = from; }
  if (to)   { where.push('occurred_at <= @to'); params.to = to; }
  if (agent_id) { where.push('agent_id = @agent_id'); params.agent_id = agent_id; }
  if (path_prefix) { where.push('path LIKE @path_prefix'); params.path_prefix = path_prefix + '%'; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return database
    .prepare(`SELECT * FROM audit_file_access ${whereClause} ORDER BY occurred_at DESC LIMIT @limit`)
    .all({ ...params, limit });
}

// ─── audit_credential_change ───────────────────────────────────────────────

function insertAuditCredentialChange(row) {
  if (!row || !row.credential_class || !row.change_type || !row.actor) {
    throw new Error('insertAuditCredentialChange: credential_class + change_type + actor required');
  }
  const database = getDb();
  const occurred_at = row.occurred_at || new Date().toISOString();
  const event_id = row.event_id || computeAuditEventId(
    row.prev_event_id, occurred_at, row.agent_id || '', `cred:${row.change_type}`,
    { credential_class: row.credential_class }
  );
  const result = database.prepare(`
    INSERT INTO audit_credential_change (
      event_id, occurred_at, credential_class, agent_id, change_type,
      actor, prior_digest, new_digest, reason
    ) VALUES (
      @event_id, @occurred_at, @credential_class, @agent_id, @change_type,
      @actor, @prior_digest, @new_digest, @reason
    )
  `).run({
    event_id,
    occurred_at,
    credential_class: row.credential_class,
    agent_id: row.agent_id || null,
    change_type: row.change_type,
    actor: row.actor,
    prior_digest: row.prior_digest || null,
    new_digest: row.new_digest || null,
    reason: row.reason ? String(row.reason).slice(0, 200) : null,
  });
  return { id: result.lastInsertRowid, event_id };
}

function listAuditCredentialChanges({ from, to, credential_class, limit = 100 } = {}) {
  const database = getDb();
  const where = [];
  const params = {};
  if (from) { where.push('occurred_at >= @from'); params.from = from; }
  if (to)   { where.push('occurred_at <= @to'); params.to = to; }
  if (credential_class) { where.push('credential_class = @credential_class'); params.credential_class = credential_class; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return database
    .prepare(`SELECT * FROM audit_credential_change ${whereClause} ORDER BY occurred_at DESC LIMIT @limit`)
    .all({ ...params, limit });
}

// ─── audit_permission_change ───────────────────────────────────────────────

function insertAuditPermissionChange(row) {
  if (!row || !row.agent_id || !row.change_type || !row.rule_text || !row.actor) {
    throw new Error('insertAuditPermissionChange: agent_id + change_type + rule_text + actor required');
  }
  const database = getDb();
  const occurred_at = row.occurred_at || new Date().toISOString();
  const event_id = row.event_id || computeAuditEventId(
    row.prev_event_id, occurred_at, row.agent_id, `perm:${row.change_type}`,
    { rule_text_hash: fullSha256(row.rule_text).slice(0, 16) }
  );
  const result = database.prepare(`
    INSERT INTO audit_permission_change (
      event_id, occurred_at, agent_id, change_type, rule_text,
      actor, source_path, reason
    ) VALUES (
      @event_id, @occurred_at, @agent_id, @change_type, @rule_text,
      @actor, @source_path, @reason
    )
  `).run({
    event_id,
    occurred_at,
    agent_id: row.agent_id,
    change_type: row.change_type,
    rule_text: row.rule_text,
    actor: row.actor,
    source_path: row.source_path || null,
    reason: row.reason ? String(row.reason).slice(0, 200) : null,
  });
  return { id: result.lastInsertRowid, event_id };
}

function listAuditPermissionChanges({ from, to, agent_id, limit = 100 } = {}) {
  const database = getDb();
  const where = [];
  const params = {};
  if (from) { where.push('occurred_at >= @from'); params.from = from; }
  if (to)   { where.push('occurred_at <= @to'); params.to = to; }
  if (agent_id) { where.push('agent_id = @agent_id'); params.agent_id = agent_id; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return database
    .prepare(`SELECT * FROM audit_permission_change ${whereClause} ORDER BY occurred_at DESC LIMIT @limit`)
    .all({ ...params, limit });
}

// ─── audit_attestation (CP12.10 Phase 3 governance substrate) ─────────────

// Canonical SOC 2 areas eligible for Phase 3 governance attestation.
// Phase 3.5 will expand to ISO 27001 A.5 + GDPR Art.5 once cross-framework
// attestation cadence is parch-ratified.
const ATTESTATION_CONTROL_AREAS = new Set(['CC1', 'CC2', 'CC9']);
const ATTESTATION_TEXT_MAX = 16 * 1024;

function insertAuditAttestation(row) {
  if (!row || !row.control_area || !row.attestation_class || !row.attestation_text || !row.actor) {
    throw new Error('insertAuditAttestation: control_area + attestation_class + attestation_text + actor required');
  }
  if (!ATTESTATION_CONTROL_AREAS.has(row.control_area)) {
    throw new Error(`insertAuditAttestation: control_area must be one of ${[...ATTESTATION_CONTROL_AREAS].join('|')}`);
  }
  if (typeof row.attestation_text !== 'string' || row.attestation_text.length > ATTESTATION_TEXT_MAX) {
    throw new Error(`insertAuditAttestation: attestation_text required (max ${ATTESTATION_TEXT_MAX} chars)`);
  }
  const database = getDb();
  const occurred_at = row.occurred_at || new Date().toISOString();
  const event_id = row.event_id || computeAuditEventId(
    row.prev_event_id, occurred_at, row.actor, `attest:${row.control_area}:${row.attestation_class}`,
    { text_hash: fullSha256(row.attestation_text).slice(0, 16) }
  );
  const result = database.prepare(`
    INSERT INTO audit_attestation (
      event_id, occurred_at, control_area, attestation_class, attestation_text,
      actor, period_start, period_end, reference_url
    ) VALUES (
      @event_id, @occurred_at, @control_area, @attestation_class, @attestation_text,
      @actor, @period_start, @period_end, @reference_url
    )
  `).run({
    event_id,
    occurred_at,
    control_area: row.control_area,
    attestation_class: row.attestation_class,
    attestation_text: row.attestation_text,
    actor: row.actor,
    period_start: row.period_start || null,
    period_end: row.period_end || null,
    reference_url: row.reference_url ? String(row.reference_url).slice(0, 500) : null,
  });
  return { id: result.lastInsertRowid, event_id };
}

function listAuditAttestations({ from, to, control_area, limit = 100 } = {}) {
  const database = getDb();
  const where = [];
  const params = {};
  if (from)         { where.push('occurred_at >= @from'); params.from = from; }
  if (to)           { where.push('occurred_at <= @to'); params.to = to; }
  if (control_area) { where.push('control_area = @control_area'); params.control_area = control_area; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return database
    .prepare(`SELECT * FROM audit_attestation ${whereClause} ORDER BY occurred_at DESC LIMIT @limit`)
    .all({ ...params, limit });
}

// ─── policy_rule ────────────────────────────────────────────────────────────

function upsertPolicyRule(row) {
  if (!row || !row.rule_id || !row.name || !row.description || !row.applicability_json || !row.predicate_dsl || !row.severity_class || !row.authored_by) {
    throw new Error('upsertPolicyRule: rule_id + name + description + applicability_json + predicate_dsl + severity_class + authored_by required');
  }
  if (!['info', 'warn', 'violation', 'critical'].includes(row.severity_class)) {
    throw new Error('upsertPolicyRule: severity_class must be info|warn|violation|critical');
  }
  const database = getDb();
  const authored_at = row.authored_at || new Date().toISOString();
  const existing = database.prepare('SELECT current_version, predicate_dsl FROM policy_rule WHERE rule_id = ?').get(row.rule_id);
  const next_version = existing
    ? (existing.predicate_dsl === row.predicate_dsl ? existing.current_version : existing.current_version + 1)
    : 1;
  const applicability_str = typeof row.applicability_json === 'string'
    ? row.applicability_json
    : JSON.stringify(row.applicability_json);
  database.prepare(`
    INSERT INTO policy_rule (
      rule_id, name, description, applicability_json, predicate_dsl,
      severity_class, status, authored_by, authored_at, current_version
    ) VALUES (
      @rule_id, @name, @description, @applicability_json, @predicate_dsl,
      @severity_class, @status, @authored_by, @authored_at, @current_version
    )
    ON CONFLICT (rule_id) DO UPDATE SET
      name               = excluded.name,
      description        = excluded.description,
      applicability_json = excluded.applicability_json,
      predicate_dsl      = excluded.predicate_dsl,
      severity_class     = excluded.severity_class,
      status             = excluded.status,
      current_version    = excluded.current_version
  `).run({
    rule_id: row.rule_id,
    name: row.name,
    description: row.description,
    applicability_json: applicability_str,
    predicate_dsl: row.predicate_dsl,
    severity_class: row.severity_class,
    status: row.status || 'draft',
    authored_by: row.authored_by,
    authored_at,
    current_version: next_version,
  });
  return { rule_id: row.rule_id, current_version: next_version };
}

function listPolicyRules({ status } = {}) {
  const database = getDb();
  if (status) {
    return database.prepare('SELECT * FROM policy_rule WHERE status = ? ORDER BY rule_id').all(status);
  }
  return database.prepare('SELECT * FROM policy_rule ORDER BY rule_id').all();
}

function getPolicyRule(rule_id) {
  const database = getDb();
  return database.prepare('SELECT * FROM policy_rule WHERE rule_id = ?').get(rule_id) || null;
}

function ratifyPolicyRule(rule_id, ratified_by) {
  if (!rule_id || !ratified_by) throw new Error('ratifyPolicyRule: rule_id + ratified_by required');
  const database = getDb();
  const result = database.prepare(`
    UPDATE policy_rule
    SET status = 'active', ratified_by = @ratified_by, ratified_at = @ratified_at
    WHERE rule_id = @rule_id
  `).run({ rule_id, ratified_by, ratified_at: new Date().toISOString() });
  return { changed: result.changes };
}

function deprecatePolicyRule(rule_id) {
  const database = getDb();
  const result = database.prepare(`UPDATE policy_rule SET status = 'deprecated' WHERE rule_id = ?`).run(rule_id);
  return { changed: result.changes };
}

// ─── policy_violation ───────────────────────────────────────────────────────

function insertPolicyViolation(row) {
  if (!row || !row.rule_id || !row.rule_version || !row.matched_object_class || !row.matched_object_ref) {
    throw new Error('insertPolicyViolation: rule_id + rule_version + matched_object_class + matched_object_ref required');
  }
  const database = getDb();
  const occurred_at = row.occurred_at || new Date().toISOString();
  const event_id = row.event_id || computeAuditEventId(
    row.prev_event_id, occurred_at, row.agent_id || '', `policy:${row.rule_id}:v${row.rule_version}`,
    { matched_object_ref: row.matched_object_ref }
  );
  const result = database.prepare(`
    INSERT INTO policy_violation (
      event_id, rule_id, rule_version, occurred_at, agent_id,
      matched_object_class, matched_object_ref, match_detail_json
    ) VALUES (
      @event_id, @rule_id, @rule_version, @occurred_at, @agent_id,
      @matched_object_class, @matched_object_ref, @match_detail_json
    )
  `).run({
    event_id,
    rule_id: row.rule_id,
    rule_version: row.rule_version,
    occurred_at,
    agent_id: row.agent_id || null,
    matched_object_class: row.matched_object_class,
    matched_object_ref: row.matched_object_ref,
    match_detail_json: row.match_detail_json
      ? (typeof row.match_detail_json === 'string' ? row.match_detail_json : JSON.stringify(row.match_detail_json))
      : null,
  });
  return { id: result.lastInsertRowid, event_id };
}

function listPolicyViolations({ from, to, rule_id, disposition, limit = 100 } = {}) {
  const database = getDb();
  const where = [];
  const params = {};
  if (from) { where.push('v.occurred_at >= @from'); params.from = from; }
  if (to)   { where.push('v.occurred_at <= @to'); params.to = to; }
  if (rule_id) { where.push('v.rule_id = @rule_id'); params.rule_id = rule_id; }
  if (disposition) { where.push('v.disposition = @disposition'); params.disposition = disposition; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // bizmodel R-A2 sort: pending first, then severity (joined from policy_rule), then time desc
  return database.prepare(`
    SELECT v.*, r.severity_class
    FROM policy_violation v
    LEFT JOIN policy_rule r ON r.rule_id = v.rule_id
    ${whereClause}
    ORDER BY
      CASE WHEN v.disposition = 'pending' THEN 0 ELSE 1 END,
      CASE r.severity_class
        WHEN 'critical' THEN 0
        WHEN 'violation' THEN 1
        WHEN 'warn' THEN 2
        WHEN 'info' THEN 3
        ELSE 4 END,
      v.occurred_at DESC
    LIMIT @limit
  `).all({ ...params, limit });
}

function disposePolicyViolation(id, { disposition, disposition_by, disposition_note }) {
  if (!id || !disposition || !disposition_by) {
    throw new Error('disposePolicyViolation: id + disposition + disposition_by required');
  }
  if (!['pending', 'acknowledged', 'remediated', 'accepted-with-rationale', 'suppressed'].includes(disposition)) {
    throw new Error(`disposePolicyViolation: invalid disposition (${disposition})`);
  }
  const database = getDb();
  const result = database.prepare(`
    UPDATE policy_violation
    SET disposition = @disposition, disposition_by = @disposition_by,
        disposition_at = @disposition_at, disposition_note = @disposition_note
    WHERE id = @id
  `).run({
    id,
    disposition,
    disposition_by,
    disposition_at: new Date().toISOString(),
    disposition_note: disposition_note ? String(disposition_note).slice(0, 500) : null,
  });
  return { changed: result.changes };
}

// ─── audit_reconciliation ───────────────────────────────────────────────────

// CP12.16 Phase 2: canonical reconcile-class vocab discipline. Operators
// stuffing free-form labels into external_system_label fragments the audit-
// tab narrative; reconcile_class provides cross-cycle aggregation key.
//
//   grc-platform    — Vanta / Drata / ServiceNow GRC / Hyperproof
//   soc-tool        — SOC analyst tooling (Splunk + Sentinel + Chronicle)
//   siem            — SIEM-export reconciliation (most common Phase 1 path)
//   internal-export — internal audit bundle delta reconciliation
//   other           — catch-all (default for pre-CP12.16 rows)
const RECONCILE_CLASS_VOCAB = new Set([
  'grc-platform', 'soc-tool', 'siem', 'internal-export', 'other',
]);

function insertAuditReconciliation(row) {
  if (!row || !row.period_start || !row.period_end || !row.external_system_label || !row.reconciler_agent_id || !row.reconciled_by) {
    throw new Error('insertAuditReconciliation: period_start + period_end + external_system_label + reconciler_agent_id + reconciled_by required');
  }
  if (!Number.isInteger(row.plexus_count) || !Number.isInteger(row.external_count)) {
    throw new Error('insertAuditReconciliation: plexus_count + external_count must be integers');
  }
  const reconcile_class = row.reconcile_class || 'other';
  if (!RECONCILE_CLASS_VOCAB.has(reconcile_class)) {
    throw new Error(`insertAuditReconciliation: reconcile_class must be one of ${[...RECONCILE_CLASS_VOCAB].join('|')}`);
  }
  const database = getDb();
  const delta_count = row.external_count - row.plexus_count;
  const delta_pct = row.plexus_count !== 0
    ? (delta_count / row.plexus_count) * 100
    : (row.external_count === 0 ? 0 : 100);
  const result = database.prepare(`
    INSERT INTO audit_reconciliation (
      period_start, period_end, external_system_label, reconcile_class,
      plexus_count, external_count, delta_count, delta_pct,
      concentration_json, notes, reconciler_agent_id, reconciled_by, reconciled_at
    ) VALUES (
      @period_start, @period_end, @external_system_label, @reconcile_class,
      @plexus_count, @external_count, @delta_count, @delta_pct,
      @concentration_json, @notes, @reconciler_agent_id, @reconciled_by, @reconciled_at
    )
  `).run({
    period_start: row.period_start,
    period_end: row.period_end,
    external_system_label: row.external_system_label,
    reconcile_class,
    plexus_count: row.plexus_count,
    external_count: row.external_count,
    delta_count,
    delta_pct,
    concentration_json: row.concentration_json
      ? (typeof row.concentration_json === 'string' ? row.concentration_json : JSON.stringify(row.concentration_json))
      : null,
    notes: row.notes || null,
    reconciler_agent_id: row.reconciler_agent_id,
    reconciled_by: row.reconciled_by,
    reconciled_at: row.reconciled_at || new Date().toISOString(),
  });
  return { id: result.lastInsertRowid, delta_count, delta_pct };
}

function listAuditReconciliations({ from, to, reconcile_class, external_system_label, limit = 100 } = {}) {
  const database = getDb();
  const where = [];
  const params = { limit };
  if (from)                  { where.push('period_end >= @from'); params.from = from; }
  if (to)                    { where.push('period_end <= @to'); params.to = to; }
  if (reconcile_class)       { where.push('reconcile_class = @reconcile_class'); params.reconcile_class = reconcile_class; }
  if (external_system_label) { where.push('external_system_label = @external_system_label'); params.external_system_label = external_system_label; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return database
    .prepare(`SELECT * FROM audit_reconciliation ${whereClause} ORDER BY id DESC LIMIT @limit`)
    .all(params);
}

function aggregateAuditReconciliationsByClass({ from, to } = {}) {
  const database = getDb();
  const where = [];
  const params = {};
  if (from) { where.push('period_end >= @from'); params.from = from; }
  if (to)   { where.push('period_end <= @to'); params.to = to; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return database
    .prepare(`
      SELECT reconcile_class, COUNT(*) AS count,
             SUM(delta_count) AS total_delta_count,
             AVG(delta_pct) AS avg_delta_pct
      FROM audit_reconciliation
      ${whereClause}
      GROUP BY reconcile_class
      ORDER BY count DESC
    `)
    .all(params);
}

// ─── audit_payload_store ───────────────────────────────────────────────────

function insertAuditPayload(payload) {
  const database = getDb();
  const payload_ref = crypto.randomUUID();
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  database.prepare(`
    INSERT INTO audit_payload_store (payload_ref, payload, created_at)
    VALUES (?, ?, ?)
  `).run(payload_ref, buf, new Date().toISOString());
  return { payload_ref, content_digest: fullSha256(buf) };
}

function getAuditPayload(payload_ref) {
  if (!payload_ref) return null;
  const database = getDb();
  return database.prepare('SELECT * FROM audit_payload_store WHERE payload_ref = ?').get(payload_ref) || null;
}

// Atomic tombstone per admin R2 fold: payload delete + tombstone_at set in
// same SQLite transaction. Reader must check tombstone_at IS NOT NULL before
// dereferencing payload_ref (returns tombstone-marker response when set).
// table_name must be one of the audit_* tables that has tombstone_at column.
function tombstoneAuditPayload({ table_name, row_id, ops_key_sha256, reason }) {
  const ALLOWED = new Set(['audit_tool_invocation', 'audit_file_access']);
  if (!ALLOWED.has(table_name)) {
    throw new Error(`tombstoneAuditPayload: table_name must be one of ${[...ALLOWED].join(', ')}`);
  }
  if (!row_id || !ops_key_sha256) {
    throw new Error('tombstoneAuditPayload: row_id + ops_key_sha256 required');
  }
  const database = getDb();
  const tombstone_at = new Date().toISOString();
  const txn = database.transaction(() => {
    const row = database.prepare(`SELECT payload_ref, tombstone_at FROM ${table_name} WHERE id = ?`).get(row_id);
    if (!row) throw new Error(`tombstoneAuditPayload: row ${table_name}#${row_id} not found`);
    if (row.tombstone_at) throw new Error(`tombstoneAuditPayload: row already tombstoned at ${row.tombstone_at}`);
    if (row.payload_ref) {
      database.prepare(`DELETE FROM audit_payload_store WHERE payload_ref = ?`).run(row.payload_ref);
    }
    database.prepare(`UPDATE ${table_name} SET tombstone_at = ? WHERE id = ?`).run(tombstone_at, row_id);
    // Meta-audit: tombstone itself produces an audit_credential_change row.
    insertAuditCredentialChange({
      occurred_at: tombstone_at,
      credential_class: 'audit-payload-tombstone',
      agent_id: null,
      change_type: 'revoke',
      actor: ops_key_sha256,
      prior_digest: row.payload_ref || null,
      new_digest: null,
      reason: reason || `tombstone ${table_name}#${row_id}`,
    });
  });
  txn();
  return { tombstone_at, table_name, row_id };
}

// ─── subject_directory (GDPR DSAR hash-at-ingestion) ────────────────────────

// UPSERT a subject. Idempotent on subject_hash; safe to call from every
// rollup pass — only inserts if absent. Cleartext lives only here.
function upsertSubjectDirectory(user_email) {
  if (!user_email || typeof user_email !== 'string') return null;
  const subject_hash = subjectHash(user_email);
  const database = getDb();
  database.prepare(`
    INSERT INTO subject_directory (subject_hash, user_email_cleartext, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT (subject_hash) DO NOTHING
  `).run(subject_hash, user_email.toLowerCase().trim(), new Date().toISOString());
  return subject_hash;
}

function getSubjectByHash(subject_hash) {
  if (!subject_hash) return null;
  const database = getDb();
  return database.prepare('SELECT * FROM subject_directory WHERE subject_hash = ?').get(subject_hash) || null;
}

// Right-to-be-forgotten: tombstone the cleartext (single-row deletion of
// user_email_cleartext + tombstone_at set). audit tables retain subject_hash
// (hash-chain intact; correlation severed).
function tombstoneSubject({ subject_hash, ops_key_sha256, reason }) {
  if (!subject_hash || !ops_key_sha256 || !reason) {
    throw new Error('tombstoneSubject: subject_hash + ops_key_sha256 + reason required (lawful-basis-class)');
  }
  const database = getDb();
  const tombstone_at = new Date().toISOString();
  const result = database.prepare(`
    UPDATE subject_directory
    SET user_email_cleartext = NULL,
        tombstone_at = @tombstone_at,
        tombstone_reason = @reason,
        tombstone_by = @ops_key_sha256
    WHERE subject_hash = @subject_hash AND tombstone_at IS NULL
  `).run({ subject_hash, tombstone_at, reason, ops_key_sha256 });
  if (result.changes === 0) {
    throw new Error(`tombstoneSubject: subject ${subject_hash.slice(0, 12)}... not found or already tombstoned`);
  }
  // Meta-audit
  insertAuditCredentialChange({
    occurred_at: tombstone_at,
    credential_class: 'subject-directory-tombstone',
    change_type: 'revoke',
    actor: ops_key_sha256,
    prior_digest: subject_hash,
    reason: `GDPR right-to-be-forgotten: ${reason}`.slice(0, 200),
  });
  return { tombstone_at, subject_hash };
}

// ─── ADR-0026 v2 Phase A: messages-tombstone canon ──────────────────────────
//
// Sister-shape canon to tombstoneAuditPayload (CP12.12.1). Closes the bus-DB
// plaintext receipt-window discipline gap for DM credential-delivery substrate
// per parch #10375 Q2 (b)+ lean. Body redacted to sentinel '[REDACTED]';
// audit metadata (sender/channel/mentions/private/created_at) preserved for
// ops-audit trail per ADR-0026 audit-by-construction discipline.
//
// Idempotency: re-tombstone of already-tombstoned row throws (sister-shape
// audit-tombstone double-tombstone-rejection canon).
function tombstoneMessage({ message_id, ops_key_sha256, reason }) {
  if (!Number.isInteger(message_id) || message_id <= 0 || !ops_key_sha256 || !reason) {
    throw new Error('tombstoneMessage: message_id (positive int) + ops_key_sha256 + reason required');
  }
  const database = getDb();
  const tombstone_at = new Date().toISOString();
  const REDACTED_SENTINEL = '[REDACTED]';
  const txn = database.transaction(() => {
    const row = database.prepare(`SELECT id, sender, channel, private, tombstone_at FROM messages WHERE id = ?`).get(message_id);
    if (!row) throw new Error(`tombstoneMessage: message ${message_id} not found`);
    if (row.tombstone_at) throw new Error(`tombstoneMessage: message ${message_id} already tombstoned at ${row.tombstone_at}`);
    database.prepare(`
      UPDATE messages
      SET body = @sentinel,
          tombstone_at = @tombstone_at,
          tombstone_reason = @reason
      WHERE id = @message_id
    `).run({ sentinel: REDACTED_SENTINEL, tombstone_at, reason, message_id });
    return { message_id, tombstone_at, sender: row.sender, channel: row.channel, private: !!row.private };
  });
  const result = txn();
  // Meta-audit per sister-shape tombstoneSubject canon
  insertAuditCredentialChange({
    occurred_at: tombstone_at,
    credential_class: 'message-body-tombstone',
    change_type: 'revoke',
    actor: ops_key_sha256,
    prior_digest: `msg#${message_id}`,
    reason: `message-body redact (DM/credential-receipt-window discipline): ${reason}`.slice(0, 200),
  });
  return result;
}

// ─── audit_ingester_cursor (CP12.4) ─────────────────────────────────────────

function getIngesterCursor(ingester_name) {
  const database = getDb();
  return database.prepare('SELECT * FROM audit_ingester_cursor WHERE ingester_name = ?').get(ingester_name) || null;
}

function upsertIngesterCursor({ ingester_name, last_source_id, rows_ingested }) {
  const database = getDb();
  const last_run_at = new Date().toISOString();
  database.prepare(`
    INSERT INTO audit_ingester_cursor (ingester_name, last_source_id, last_run_at, rows_ingested)
    VALUES (@ingester_name, @last_source_id, @last_run_at, @rows_ingested)
    ON CONFLICT (ingester_name) DO UPDATE SET
      last_source_id = excluded.last_source_id,
      last_run_at    = excluded.last_run_at,
      rows_ingested  = audit_ingester_cursor.rows_ingested + excluded.rows_ingested
  `).run({
    ingester_name,
    last_source_id,
    last_run_at,
    rows_ingested: rows_ingested || 0,
  });
}

// Source-side scan for the agent_activity → audit_tool_invocation ingester.
// Returns rows newer than after_id, capped at limit. Tool-invocation events
// only (PreToolUse / PostToolUse / PostToolUseFailure / SubagentStart /
// SubagentStop) — non-tool events (SessionStart, Stop, etc.) are NOT
// audit-tool-invocation class per ADR-0030 §audit_tool_invocation table.
function scanAgentActivityForAudit(after_id = 0, limit = 500) {
  const database = getDb();
  return database.prepare(`
    SELECT id, agent_id, ts, event, payload_json
    FROM agent_activity
    WHERE id > @after_id
      AND event IN ('PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop')
    ORDER BY id ASC
    LIMIT @limit
  `).all({ after_id, limit });
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

// CP12.13 Phase 2 aggregate views over existing substrate.

function listRegistrationEventsByAgent(agent_id, { from, to, limit = 200 } = {}) {
  const database = getDb();
  const where = ['agent_id = @agent_id'];
  const params = { agent_id, limit };
  if (from) { where.push('ts >= @from'); params.from = from; }
  if (to)   { where.push('ts <= @to'); params.to = to; }
  return database.prepare(`
    SELECT event_id, registration_id, agent_id, ts, event_type, actor,
           ciphertext_sha256_prefix, token_sha256_prefix, registrant_pubkey_sha256_prefix
    FROM registration_events
    WHERE ${where.join(' AND ')}
    ORDER BY ts DESC, rowid DESC
    LIMIT @limit
  `).all(params);
}

function aggregateRegistrationEventsByAgent({ from, to } = {}) {
  const database = getDb();
  const where = [];
  const params = {};
  if (from) { where.push('ts >= @from'); params.from = from; }
  if (to)   { where.push('ts <= @to'); params.to = to; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return database.prepare(`
    SELECT agent_id, event_type, COUNT(*) as count
    FROM registration_events
    ${whereClause}
    GROUP BY agent_id, event_type
    ORDER BY agent_id, event_type
  `).all(params);
}

const CREDENTIAL_AGG_GROUP_BY = new Set(['credential_class', 'change_type', 'actor']);

function aggregateCredentialChanges({ from, to, group_by = 'credential_class' } = {}) {
  if (!CREDENTIAL_AGG_GROUP_BY.has(group_by)) {
    throw new Error(`aggregateCredentialChanges: group_by must be one of ${[...CREDENTIAL_AGG_GROUP_BY].join('|')}`);
  }
  const database = getDb();
  const where = [];
  const params = {};
  if (from) { where.push('occurred_at >= @from'); params.from = from; }
  if (to)   { where.push('occurred_at <= @to'); params.to = to; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return database.prepare(`
    SELECT ${group_by} AS bucket, COUNT(*) AS count
    FROM audit_credential_change
    ${whereClause}
    GROUP BY ${group_by}
    ORDER BY count DESC
  `).all(params);
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
    stop_failure: 'stop_failure',
    // CP14.x (Task #174): in_flight = long-running CLI runtime session
    // (Codex/Gemini sessions minutes-to-hours; distinct from short-duration
    // tool_running per-invocation). Sister-shape online_tool_running but
    // signals "expect extended wait for next state change."
    in_flight: 'online_in_flight'
  },
  down: { active: 'offline', idle: 'offline', unknown: 'offline', tool_running: 'offline', idle_between_tools: 'offline', compacting: 'offline', stop_failure: 'offline', in_flight: 'offline' }
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
  runtime_state, runtime_blocked_until,
  // CP14.1 (2026-06-13): runtime-class. Caller may pass explicit value (future
  // Layer 2 — daemon-reported via OTEL_RESOURCE_ATTRIBUTES service.name);
  // when omitted, server-side compute via agentRuntimes.runtimeOf() lookup.
  runtime,
  // Operator-session Phase A per PLAN-OPERATOR-SESSION-SUBSTRATE v2 RATIFIED
  // by parch #10382 + Jon-direct #10404. Caller (routes.js POST /presence/event
  // handler) sets this from req.tokenClass at the auth boundary — NEVER from
  // request body — per secops Block-1 server-enforcement discipline. Defaults
  // to 'agent' if omitted by caller (back-compat for legacy callers and tests).
  session_class
}) {
  const database = getDb();
  const now = new Date().toISOString();
  // CP14.1: compute runtime-class server-side when caller doesn't pass it.
  // Source-of-truth = src/agentRuntimes.js REGISTRY map + DEFAULT fallback.
  if (runtime == null) {
    const { runtimeOf } = require('./agentRuntimes');
    runtime = runtimeOf(agent_id);
  }
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

  // CP12.x.4: track last_cursor_advance_at. Sleuth's #8532 + admin #8536
  // forensic on the SSE silent-dead window showed cursor stays frozen at
  // the message-id-before-disconnect while heartbeats stay fresh — the
  // silent-dead signature. Persisting the timestamp lets the dashboard
  // surface "fresh heartbeat + stale cursor + cluster traffic flowing" as
  // an SSE-stale pill, catching the case in minutes not hours.
  const cursorAdvanced = existing
    && existing.cursor_position != null
    && cursor_position != null
    && Number(cursor_position) > Number(existing.cursor_position);
  const last_cursor_advance_at = cursorAdvanced
    ? now
    : (existing && existing.last_cursor_advance_at) || (cursor_position != null ? now : null);

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
      runtime_state, runtime_blocked_until,
      runtime, last_cursor_advance_at, session_class
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
      @runtime_state, @runtime_blocked_until,
      @runtime, @last_cursor_advance_at, @session_class
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
      -- v0.5.7.4 → v0.5.16.1: daemon-process fields use COALESCE so non-
      -- canonical-daemon runtimes (e.g. Ptah self-emit from Windows VM
      -- episode runtime) that send daemon_pid+version+started_at only on
      -- initial emit don't have the value wiped by subsequent minimal
      -- heartbeats. Sister-shape to the v0.5.9.1 runtime_state COALESCE
      -- below. For canonical yaklog-sub (which sends these every heartbeat),
      -- COALESCE is functionally equivalent to raw-assign — non-null new
      -- values win COALESCE so daemon restart with a new pid/started_at
      -- still propagates correctly. Per s345-aieng #10246 + yaklog-dev #10250
      -- substrate-finding from Ptah AgentCard data gap empirical.
      daemon_pid = COALESCE(excluded.daemon_pid, presence.daemon_pid),
      daemon_version = COALESCE(excluded.daemon_version, presence.daemon_version),
      daemon_started_at = COALESCE(excluded.daemon_started_at, presence.daemon_started_at),
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
      runtime_blocked_until = COALESCE(excluded.runtime_blocked_until, presence.runtime_blocked_until),
      -- CP14.1: runtime-class. Raw assign because server-side compute is
      -- always-known (runtimeOf() returns DEFAULT 'claude_code' when not in
      -- REGISTRY). When daemons start passing explicit runtime in Layer 2,
      -- their value wins via raw-assign — consistent with the daemon-pid /
      -- daemon-version pattern (current authoritative value, not accumulated).
      runtime = excluded.runtime,
      -- CP12.x.4: SSE-stale detection. Raw assign — JS layer computed the
      -- correct value (advanced timestamp on cursor increase, retained
      -- prior timestamp otherwise, seeded to now on first row with cursor).
      last_cursor_advance_at = excluded.last_cursor_advance_at,
      -- Operator-session Phase A per PLAN-OPERATOR-SESSION-SUBSTRATE v2
      -- RATIFIED parch #10382 + Jon-direct #10404. COALESCE-style preservation:
      -- once a binding-tier-derived session_class is set, subsequent heartbeats
      -- (which also derive from same binding tier) will provide the same
      -- value. Raw-assign canon-clean here since server-enforces from binding
      -- tier per secops Block-1 — value is always-authoritative-at-write.
      session_class = excluded.session_class
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
    runtime_blocked_until: runtime_blocked_until ?? null,
    runtime: runtime ?? null,
    last_cursor_advance_at: last_cursor_advance_at ?? null,
    session_class: session_class || 'agent'
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
    runtime_blocked_until: row.runtime_blocked_until,
    // CP14.1 runtime-class (CC / Codex / Gemini)
    runtime: row.runtime,
    // CP12.x.4 SSE-stale detection
    last_cursor_advance_at: row.last_cursor_advance_at,
    // Operator-session Phase A: session_class + decommissioned_at per
    // PLAN-OPERATOR-SESSION-SUBSTRATE v2 RATIFIED parch #10382 + Jon-direct #10404
    session_class: row.session_class || 'agent',
    decommissioned_at: row.decommissioned_at || null
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
    runtime_blocked_until: row.runtime_blocked_until,
    // CP14.1 runtime-class (CC / Codex / Gemini)
    runtime: row.runtime,
    // CP12.x.4 SSE-stale detection
    last_cursor_advance_at: row.last_cursor_advance_at,
    // Operator-session Phase A
    session_class: row.session_class || 'agent',
    decommissioned_at: row.decommissioned_at || null
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

// ─── CP12.7 Phase B: env-diff boot detector ────────────────────────────────
//
// At app startup, parse the current YAKLOG_API_KEYS + YAKLOG_TOKEN_BINDINGS +
// YAKLOG_HOST_INGESTER_BINDINGS env state into a canonical sha256[:16]
// fingerprint set; compare to credential_state_snapshot; emit
// audit_credential_change rows for each diff; persist the new snapshot.
//
// Per CP12 Attestation status tile: this is the retroactive backfill of
// CC6 credential-change events that the ad-hoc operator-tooling rotation
// pattern (Python .env rewrite + container env-recreate) doesn't otherwise
// emit. Future operator rotations also surface here on next boot.
//
// Returns { mints, revokes, binds, unbinds, total_emitted } for caller
// logging / observability. Safe to call from app boot OR from a manual
// /api/v1/ops endpoint if needed (future Phase 2 scope).

function computeCredentialFingerprintSet({ apiKeysString, tokenBindingsString, hostIngesterBindingsString }) {
  // Parse the env-strings into normalized fingerprint sets.
  // sha256[:16] is the cluster-canonical fingerprint (per
  // feedback_token_fingerprint_hash_method_canon).
  const crypto = require('crypto');
  function shaPrefix(token) {
    return crypto.createHash('sha256').update(token, 'utf-8').digest('hex').slice(0, 16);
  }
  // api_keys: comma-separated bearer tokens
  const apiKeys = (apiKeysString || '')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean)
    .map(shaPrefix);
  // token_bindings: comma-separated agent_id:token pairs
  function parseBindings(s) {
    return (s || '')
      .split(',')
      .map(e => e.trim())
      .filter(Boolean)
      .map(entry => {
        const idx = entry.indexOf(':');
        if (idx <= 0 || idx === entry.length - 1) return null;
        const key = entry.slice(0, idx).trim();
        const tok = entry.slice(idx + 1).trim();
        if (!key || !tok) return null;
        return `${key}:${shaPrefix(tok)}`;
      })
      .filter(Boolean);
  }
  return {
    api_keys: apiKeys.sort(),
    token_bindings: parseBindings(tokenBindingsString).sort(),
    host_bindings: parseBindings(hostIngesterBindingsString).sort(),
  };
}

function diffCredentialFingerprintSets(prior, current) {
  // Set-difference per category. Returns {mints, revokes, binds, unbinds}
  // as arrays of fingerprint strings to emit.
  function setDiff(a, b) {
    const bSet = new Set(b);
    return a.filter(x => !bSet.has(x));
  }
  const p = prior || { api_keys: [], token_bindings: [], host_bindings: [] };
  return {
    // api-key adds → mint events
    mints: setDiff(current.api_keys, p.api_keys),
    // api-key removes → revoke events
    revokes: setDiff(p.api_keys, current.api_keys),
    // binding adds (both token_bindings + host_bindings) → bind events
    binds: [
      ...setDiff(current.token_bindings, p.token_bindings).map(s => ({ kind: 'token', entry: s })),
      ...setDiff(current.host_bindings, p.host_bindings).map(s => ({ kind: 'host', entry: s })),
    ],
    // binding removes → unbind events
    unbinds: [
      ...setDiff(p.token_bindings, current.token_bindings).map(s => ({ kind: 'token', entry: s })),
      ...setDiff(p.host_bindings, current.host_bindings).map(s => ({ kind: 'host', entry: s })),
    ],
  };
}

function envDiffBootDetector({ apiKeysString, tokenBindingsString, hostIngesterBindingsString, actor = 'env-diff-boot-detector', now } = {}) {
  const database = getDb();
  const occurred_at = now || new Date().toISOString();
  const current = computeCredentialFingerprintSet({
    apiKeysString: apiKeysString != null ? apiKeysString : process.env.YAKLOG_API_KEYS,
    tokenBindingsString: tokenBindingsString != null ? tokenBindingsString : process.env.YAKLOG_TOKEN_BINDINGS,
    hostIngesterBindingsString: hostIngesterBindingsString != null ? hostIngesterBindingsString : process.env.YAKLOG_HOST_INGESTER_BINDINGS,
  });
  const priorRow = database.prepare('SELECT snapshot_json FROM credential_state_snapshot WHERE id = 1').get();
  let prior = null;
  if (priorRow) {
    try { prior = JSON.parse(priorRow.snapshot_json); } catch (e) { prior = null; }
  }
  const isFirstBoot = !prior;
  const diff = diffCredentialFingerprintSets(prior, current);

  // On first boot, do NOT emit "mint" events for every existing token —
  // that's a false-positive (those tokens were minted historically, not
  // at this boot). Just persist the snapshot + return zero-count.
  if (isFirstBoot) {
    database.prepare(`
      INSERT INTO credential_state_snapshot (id, snapshot_json, updated_at)
      VALUES (1, @snapshot_json, @updated_at)
    `).run({ snapshot_json: JSON.stringify(current), updated_at: occurred_at });
    return {
      first_boot: true,
      api_keys_count: current.api_keys.length,
      token_bindings_count: current.token_bindings.length,
      host_bindings_count: current.host_bindings.length,
      mints: 0, revokes: 0, binds: 0, unbinds: 0, total_emitted: 0,
    };
  }

  let emitted = 0;
  // Emit mint events
  for (const fp of diff.mints) {
    try {
      insertAuditCredentialChange({
        occurred_at,
        credential_class: 'api-key',
        agent_id: null,
        change_type: 'mint',
        actor,
        prior_digest: null,
        new_digest: fp,
        reason: 'env-diff boot detector: api-key added since prior snapshot'
      });
      emitted++;
    } catch (e) { /* never block boot */ }
  }
  // Emit revoke events
  for (const fp of diff.revokes) {
    try {
      insertAuditCredentialChange({
        occurred_at,
        credential_class: 'api-key',
        agent_id: null,
        change_type: 'revoke',
        actor,
        prior_digest: fp,
        new_digest: null,
        reason: 'env-diff boot detector: api-key removed since prior snapshot'
      });
      emitted++;
    } catch (e) { /* never block boot */ }
  }
  // Emit bind events
  for (const b of diff.binds) {
    const [agent_id, fp] = b.entry.split(':');
    try {
      insertAuditCredentialChange({
        occurred_at,
        credential_class: b.kind === 'host' ? 'host-ingester-binding' : 'sender-binding',
        agent_id: b.kind === 'host' ? null : agent_id,
        change_type: 'bind',
        actor,
        prior_digest: null,
        new_digest: fp,
        reason: b.kind === 'host'
          ? `env-diff boot detector: host-ingester binding added (host=${agent_id})`
          : `env-diff boot detector: sender binding added (agent_id=${agent_id})`
      });
      emitted++;
    } catch (e) { /* never block boot */ }
  }
  // Emit unbind events
  for (const b of diff.unbinds) {
    const [agent_id, fp] = b.entry.split(':');
    try {
      insertAuditCredentialChange({
        occurred_at,
        credential_class: b.kind === 'host' ? 'host-ingester-binding' : 'sender-binding',
        agent_id: b.kind === 'host' ? null : agent_id,
        change_type: 'unbind',
        actor,
        prior_digest: fp,
        new_digest: null,
        reason: b.kind === 'host'
          ? `env-diff boot detector: host-ingester binding removed (host=${agent_id})`
          : `env-diff boot detector: sender binding removed (agent_id=${agent_id})`
      });
      emitted++;
    } catch (e) { /* never block boot */ }
  }

  // Persist the new snapshot.
  database.prepare(`
    INSERT OR REPLACE INTO credential_state_snapshot (id, snapshot_json, updated_at)
    VALUES (1, @snapshot_json, @updated_at)
  `).run({ snapshot_json: JSON.stringify(current), updated_at: occurred_at });

  return {
    first_boot: false,
    mints: diff.mints.length,
    revokes: diff.revokes.length,
    binds: diff.binds.length,
    unbinds: diff.unbinds.length,
    total_emitted: emitted,
  };
}

// ─── CP12.8 Phase 2: permission-change scan processor ──────────────────────
//
// Accepts a scanner-provided list of {source_class, source_path, agent_id,
// fingerprint} entries (sha256[:16] computed on the host); diffs against
// permission_state_snapshot; emits audit_permission_change rows for adds /
// modifies / removes; persists new snapshot.
//
// First-scan discipline mirrors CP12.7 Phase B envDiffBootDetector: persist
// baseline silently (don't false-positive "add" every existing file).
//
// Each source row's identity is (source_class, source_path, agent_id).
// Modify detection: same identity, different fingerprint.

function diffPermissionSources(prior, current) {
  function keyOf(s) { return `${s.source_class}|${s.source_path}|${s.agent_id}`; }
  const priorMap = new Map((prior || []).map(s => [keyOf(s), s]));
  const currMap = new Map(current.map(s => [keyOf(s), s]));
  const adds = [];
  const modifies = [];
  const removes = [];
  for (const [k, s] of currMap.entries()) {
    if (!priorMap.has(k)) {
      adds.push(s);
    } else if (priorMap.get(k).fingerprint !== s.fingerprint) {
      const prev = priorMap.get(k);
      modifies.push({ ...s, prior_fingerprint: prev.fingerprint });
    }
  }
  for (const [k, s] of priorMap.entries()) {
    if (!currMap.has(k)) removes.push(s);
  }
  return { adds, modifies, removes };
}

function processPermissionScan({ sources, actor, scan_at } = {}) {
  if (!Array.isArray(sources)) {
    throw new Error('processPermissionScan: sources array required');
  }
  if (!actor || typeof actor !== 'string') {
    throw new Error('processPermissionScan: actor (ops-key sha256[:16] OR script-id) required');
  }
  // Validate source-row shape; reject malformed entries to keep the
  // snapshot table clean. Tolerate but log unknown source_classes.
  const validClasses = new Set([
    'settings.local.json',
    'agent-specs.git-head',
    'systemd-override',
    'authorized_keys',
    'gh-hosts.yml',
  ]);
  const validated = sources.filter(s =>
    s && typeof s.source_class === 'string' && validClasses.has(s.source_class)
    && typeof s.source_path === 'string' && s.source_path.length > 0
    && typeof s.agent_id === 'string' && s.agent_id.length > 0
    && typeof s.fingerprint === 'string' && /^[0-9a-f]{16}$/.test(s.fingerprint)
  );
  if (validated.length !== sources.length) {
    console.warn(`[permission-scan] dropped ${sources.length - validated.length} malformed source rows`);
  }

  const database = getDb();
  const occurred_at = scan_at || new Date().toISOString();
  const priorRow = database.prepare('SELECT snapshot_json FROM permission_state_snapshot WHERE id = 1').get();
  let prior = null;
  if (priorRow) {
    try { prior = JSON.parse(priorRow.snapshot_json).sources; } catch (e) { prior = null; }
  }
  const isFirstScan = !prior;

  if (isFirstScan) {
    database.prepare(`
      INSERT INTO permission_state_snapshot (id, snapshot_json, updated_at)
      VALUES (1, @snapshot_json, @updated_at)
    `).run({
      snapshot_json: JSON.stringify({ sources: validated }),
      updated_at: occurred_at
    });
    return {
      first_scan: true,
      sources_count: validated.length,
      adds: 0, modifies: 0, removes: 0, total_emitted: 0,
    };
  }

  const diff = diffPermissionSources(prior, validated);
  let emitted = 0;
  function safeEmit(row) {
    try { insertAuditPermissionChange(row); emitted++; } catch (e) { /* never block scan */ }
  }
  for (const s of diff.adds) {
    safeEmit({
      occurred_at, agent_id: s.agent_id, change_type: 'add', actor,
      rule_text: `${s.source_class}:${s.fingerprint}`,
      source_path: s.source_path,
      reason: `permission-scan: ${s.source_class} added`
    });
  }
  for (const s of diff.modifies) {
    safeEmit({
      occurred_at, agent_id: s.agent_id, change_type: 'modify', actor,
      rule_text: `${s.source_class}:${s.fingerprint}`,
      source_path: s.source_path,
      reason: `permission-scan: ${s.source_class} modified (prior ${s.prior_fingerprint} → ${s.fingerprint})`
    });
  }
  for (const s of diff.removes) {
    safeEmit({
      occurred_at, agent_id: s.agent_id, change_type: 'remove', actor,
      rule_text: `${s.source_class}:${s.fingerprint}`,
      source_path: s.source_path,
      reason: `permission-scan: ${s.source_class} removed`
    });
  }

  database.prepare(`
    INSERT OR REPLACE INTO permission_state_snapshot (id, snapshot_json, updated_at)
    VALUES (1, @snapshot_json, @updated_at)
  `).run({
    snapshot_json: JSON.stringify({ sources: validated }),
    updated_at: occurred_at
  });

  return {
    first_scan: false,
    adds: diff.adds.length,
    modifies: diff.modifies.length,
    removes: diff.removes.length,
    total_emitted: emitted,
  };
}

// ─── CP12.12 Phase 3 (A): external integrity anchor (S3 Object Lock) ─────
//
// Per parch #7984 4-OQ ratify: daily hash digest of the chain-high-water
// event_id concatenated with the most-recent N event_ids; published to an
// external append-only substrate (S3 Object Lock baseline + dual-publish
// 12mo forward-track per OQ-3.4). Anchor format is substrate-portable
// plain-text — if substrate migrates, only the wrappers change.
//
// Chain-high-water source: across audit_tool_invocation / audit_file_access
// / audit_credential_change / audit_permission_change / audit_attestation
// / audit_channel_subscription_change. Pick the highest event_id by max ts
// and concatenate that table's last 100 event_ids for the digest input.

const ANCHOR_SUBSTRATE_VOCAB = new Set([
  's3-object-lock', 'rfc3161-tsa', 'ipfs',
]);
const ANCHOR_CHAIN_TABLES = [
  'audit_tool_invocation',
  'audit_file_access',
  'audit_credential_change',
  'audit_permission_change',
  'audit_attestation',
  'audit_channel_subscription_change',
];

function computeChainSnapshot() {
  const database = getDb();
  // Find the table + event_id with the most-recent occurred_at across all
  // audit-chain tables. Then concat last 100 event_ids from that table.
  let best = null;
  for (const table of ANCHOR_CHAIN_TABLES) {
    const row = database
      .prepare(`SELECT event_id, occurred_at FROM ${table} ORDER BY occurred_at DESC LIMIT 1`)
      .get();
    if (row && (!best || row.occurred_at > best.occurred_at)) {
      best = { table, event_id: row.event_id, occurred_at: row.occurred_at };
    }
  }
  if (!best) {
    return {
      chain_high_water_event_id: '0'.repeat(16),
      chain_high_water_table: ANCHOR_CHAIN_TABLES[0],
      digest_sha256: require('crypto').createHash('sha256').update('').digest('hex'),
      sample_size: 0,
    };
  }
  const recent = database
    .prepare(`SELECT event_id FROM ${best.table} ORDER BY occurred_at DESC LIMIT 100`)
    .all();
  const input = `${best.event_id}|${recent.map(r => r.event_id).join('|')}`;
  const digest_sha256 = require('crypto').createHash('sha256').update(input).digest('hex');
  return {
    chain_high_water_event_id: best.event_id,
    chain_high_water_table: best.table,
    digest_sha256,
    sample_size: recent.length,
  };
}

function insertAuditAnchor(row) {
  if (!row || !row.anchor_day || !row.digest_sha256 || !row.anchor_substrate
      || !row.anchor_uri || !row.published_by || !row.chain_high_water_event_id
      || !row.chain_high_water_table) {
    throw new Error('insertAuditAnchor: anchor_day + digest_sha256 + anchor_substrate + anchor_uri + published_by + chain_high_water_event_id + chain_high_water_table required');
  }
  if (!ANCHOR_SUBSTRATE_VOCAB.has(row.anchor_substrate)) {
    throw new Error(`insertAuditAnchor: anchor_substrate must be one of ${[...ANCHOR_SUBSTRATE_VOCAB].join('|')}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.anchor_day)) {
    throw new Error('insertAuditAnchor: anchor_day must be YYYY-MM-DD');
  }
  if (!/^[0-9a-f]{64}$/.test(row.digest_sha256)) {
    throw new Error('insertAuditAnchor: digest_sha256 must be 64-char lowercase hex');
  }
  const database = getDb();
  const published_at = row.published_at || new Date().toISOString();
  try {
    const result = database.prepare(`
      INSERT INTO audit_anchor (
        anchor_day, chain_high_water_event_id, chain_high_water_table,
        digest_sha256, anchor_substrate, anchor_uri, published_at, published_by
      ) VALUES (
        @anchor_day, @chain_high_water_event_id, @chain_high_water_table,
        @digest_sha256, @anchor_substrate, @anchor_uri, @published_at, @published_by
      )
    `).run({
      anchor_day: row.anchor_day,
      chain_high_water_event_id: row.chain_high_water_event_id,
      chain_high_water_table: row.chain_high_water_table,
      digest_sha256: row.digest_sha256,
      anchor_substrate: row.anchor_substrate,
      anchor_uri: row.anchor_uri,
      published_at,
      published_by: row.published_by,
    });
    return { id: result.lastInsertRowid };
  } catch (e) {
    if (/UNIQUE constraint failed/.test(e.message)) {
      throw new Error(`audit_anchor: duplicate anchor for day=${row.anchor_day} substrate=${row.anchor_substrate}`);
    }
    throw e;
  }
}

function listAuditAnchors({ from, to, anchor_substrate, limit = 100 } = {}) {
  const database = getDb();
  const where = [];
  const params = { limit };
  if (from)             { where.push('anchor_day >= @from'); params.from = from; }
  if (to)               { where.push('anchor_day <= @to'); params.to = to; }
  if (anchor_substrate) { where.push('anchor_substrate = @anchor_substrate'); params.anchor_substrate = anchor_substrate; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return database
    .prepare(`SELECT * FROM audit_anchor ${whereClause} ORDER BY anchor_day DESC, id DESC LIMIT @limit`)
    .all(params);
}

function getAuditAnchorByDay(anchor_day, anchor_substrate) {
  const database = getDb();
  if (anchor_substrate) {
    return database.prepare('SELECT * FROM audit_anchor WHERE anchor_day = ? AND anchor_substrate = ?').get(anchor_day, anchor_substrate);
  }
  // Return all substrates for the day (dual-publish window may have multiple)
  return database.prepare('SELECT * FROM audit_anchor WHERE anchor_day = ? ORDER BY id DESC').all(anchor_day);
}

// CP12.12.1 (2026-06-07): substrate-semantic fix per bizmodel #8029 + secops
// #8030. Reading-1 (compare against current tip) always returned match:false
// in live clusters after any new event lands — chain-tamper-detection was
// non-operational. Fixed to Reading-2: recompute over events UP TO the
// stored high-water mark, so a match:false unambiguously signals tamper.
//
// Audit tables are append-only per substrate canon, so the same bounded
// event-set produces identical digest indefinitely. match:true is
// reproducible at any future point; match:false means either:
//   (a) high-water event_id no longer present (deletion / tamper), OR
//   (b) digest over events≤high-water differs (event payload tamper)

function computeChainSnapshotAt({ high_water_event_id, high_water_table }) {
  if (!ANCHOR_CHAIN_TABLES.includes(high_water_table)) {
    throw new Error(`computeChainSnapshotAt: high_water_table must be one of ${ANCHOR_CHAIN_TABLES.join('|')}`);
  }
  const database = getDb();
  const hwRow = database
    .prepare(`SELECT occurred_at FROM ${high_water_table} WHERE event_id = ?`)
    .get(high_water_event_id);
  if (!hwRow) {
    return null;  // high-water event vanished → tamper signal
  }
  const recent = database
    .prepare(`SELECT event_id FROM ${high_water_table} WHERE occurred_at <= ? ORDER BY occurred_at DESC LIMIT 100`)
    .all(hwRow.occurred_at);
  const input = `${high_water_event_id}|${recent.map(r => r.event_id).join('|')}`;
  const digest_sha256 = require('crypto').createHash('sha256').update(input).digest('hex');
  return {
    chain_high_water_event_id: high_water_event_id,
    chain_high_water_table: high_water_table,
    digest_sha256,
    sample_size: recent.length,
  };
}

function verifyAuditAnchor(anchor_day, anchor_substrate) {
  const database = getDb();
  const row = anchor_substrate
    ? database.prepare('SELECT * FROM audit_anchor WHERE anchor_day = ? AND anchor_substrate = ?').get(anchor_day, anchor_substrate)
    : database.prepare('SELECT * FROM audit_anchor WHERE anchor_day = ? ORDER BY id DESC LIMIT 1').get(anchor_day);
  if (!row) {
    return { found: false, anchor_day, anchor_substrate: anchor_substrate || null };
  }
  const recomputed = computeChainSnapshotAt({
    high_water_event_id: row.chain_high_water_event_id,
    high_water_table: row.chain_high_water_table,
  });
  if (!recomputed) {
    return {
      found: true,
      match: false,
      tamper_detected: true,
      anchor_day: row.anchor_day,
      anchor_substrate: row.anchor_substrate,
      stored_digest: row.digest_sha256,
      stored_high_water_event_id: row.chain_high_water_event_id,
      stored_high_water_table: row.chain_high_water_table,
      note: 'TAMPER ALERT: stored high-water event_id no longer present in chain. Event may have been deleted post-anchor.',
    };
  }
  const match = recomputed.digest_sha256 === row.digest_sha256;
  return {
    found: true,
    match,
    tamper_detected: !match,
    anchor_day: row.anchor_day,
    anchor_substrate: row.anchor_substrate,
    stored_digest: row.digest_sha256,
    recomputed_digest: recomputed.digest_sha256,
    stored_high_water_event_id: row.chain_high_water_event_id,
    stored_high_water_table: row.chain_high_water_table,
    sample_size: recomputed.sample_size,
    note: match
      ? 'chain state up to stored anchor matches anchor digest — no tampering detected'
      : 'TAMPER ALERT: chain state up to stored anchor DIFFERS from anchor digest. Investigate immediately (event payload may have been modified post-anchor).',
  };
}

// ─── CP12.17 Phase 2: ADR change-history bus-message-ID cross-reference ───
//
// Per parch #8015 OQ-B: each ADR commit in /audit/adr-change-history is
// correlated with cluster-bus messages whose body text references that ADR
// (regex /ADR-NNNN/i) within commit_ts ± window_days. Returns DESC message
// IDs (newest first); cap defaults to 50 per ADR (operator can drill into
// /messages for the full thread).

function findMessageIdsReferencingAdr({ adr_number, from, to, limit = 50 } = {}) {
  if (!adr_number || !/^\d{1,5}$/.test(String(adr_number))) {
    return [];
  }
  const database = getDb();
  // Normalize: ADR-0030 + ADR-30 + adr-0030 all match. Use LIKE with
  // padded + unpadded form; correlate at app layer via regex post-filter
  // to avoid SQLite regex extension dependency.
  const padded = String(adr_number).padStart(4, '0');
  const where = [];
  const params = {};
  // Lex-compare against ISO timestamps.
  if (from) { where.push('created_at >= @from'); params.from = from; }
  if (to)   { where.push('created_at <= @to');   params.to = to; }
  // Pre-filter via LIKE for common ADR-NNNN / ADR-NN reference shapes.
  // Catches both padded ("ADR-0030") and unpadded ("ADR-30") forms.
  where.push(`(body LIKE @like_padded OR body LIKE @like_unpadded)`);
  params.like_padded = `%ADR-${padded}%`;
  params.like_unpadded = `%ADR-${String(adr_number).replace(/^0+/, '') || '0'}%`;
  const whereClause = `WHERE ${where.join(' AND ')}`;
  const rows = database
    .prepare(`SELECT id, body FROM messages ${whereClause} ORDER BY id DESC LIMIT @cap`)
    .all({ ...params, cap: Math.min(limit * 4, 500) });  // overscan for app-layer regex
  // App-layer precision filter: must contain "ADR-<n>" where n matches
  // either padded or unpadded, with word boundary on either side.
  const re = new RegExp(`\\bADR[-_]?0*${Number(adr_number)}\\b`, 'i');
  return rows
    .filter(r => re.test(r.body))
    .slice(0, limit)
    .map(r => r.id);
}

// ─── CP12.15 Phase 2: channel-subscription change history ─────────────────
//
// Accepts a scanner-provided list of {agent_id, channels[], source_path}
// entries (one per scanned ~/.config/yaklog/channels file); diffs against
// channel_subscription_snapshot; emits audit_channel_subscription_change
// rows for subscribes / unsubscribes; persists new snapshot.
//
// First-scan discipline: persist baseline silently. Each diff produces N
// atomic rows (one per channel added/removed for that agent).

const CHANNEL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function insertAuditChannelSubscriptionChange(row) {
  if (!row || !row.agent_id || !row.change_type || !row.channel_name || !row.actor) {
    throw new Error('insertAuditChannelSubscriptionChange: agent_id + change_type + channel_name + actor required');
  }
  if (!['subscribe', 'unsubscribe'].includes(row.change_type)) {
    throw new Error('insertAuditChannelSubscriptionChange: change_type must be subscribe|unsubscribe');
  }
  if (!CHANNEL_NAME_RE.test(row.channel_name)) {
    throw new Error('insertAuditChannelSubscriptionChange: channel_name must match [a-zA-Z0-9_-]{1,64}');
  }
  const database = getDb();
  const occurred_at = row.occurred_at || new Date().toISOString();
  const event_id = row.event_id || computeAuditEventId(
    row.prev_event_id, occurred_at, row.agent_id, `csc:${row.change_type}`,
    { channel: row.channel_name }
  );
  const result = database.prepare(`
    INSERT INTO audit_channel_subscription_change (
      event_id, occurred_at, agent_id, change_type, channel_name,
      actor, source_path, reason
    ) VALUES (
      @event_id, @occurred_at, @agent_id, @change_type, @channel_name,
      @actor, @source_path, @reason
    )
  `).run({
    event_id, occurred_at,
    agent_id: row.agent_id,
    change_type: row.change_type,
    channel_name: row.channel_name,
    actor: row.actor,
    source_path: row.source_path || null,
    reason: row.reason ? String(row.reason).slice(0, 200) : null,
  });
  return { id: result.lastInsertRowid, event_id };
}

function listAuditChannelSubscriptionChanges({ from, to, agent_id, channel_name, limit = 100 } = {}) {
  const database = getDb();
  const where = [];
  const params = {};
  if (from)         { where.push('occurred_at >= @from'); params.from = from; }
  if (to)           { where.push('occurred_at <= @to'); params.to = to; }
  if (agent_id)     { where.push('agent_id = @agent_id'); params.agent_id = agent_id; }
  if (channel_name) { where.push('channel_name = @channel_name'); params.channel_name = channel_name; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return database
    .prepare(`SELECT * FROM audit_channel_subscription_change ${whereClause} ORDER BY occurred_at DESC, rowid DESC LIMIT @limit`)
    .all({ ...params, limit });
}

// ──────────────────────────────────────────────────────────────────────────
// COUNT-ONLY helpers per audit-object class (perf fix for /audit/by-control-area).
// Pre-fix: countsForObjectClasses fetched up to 10k full rows per class then
// `.length`-counted in JS — SOC2 framework triggered ~10-12 such fetches +
// hydration, total ~60s on growing audit data. SELECT COUNT(*) per class is
// 100-1000× faster.
//
// Sister-shape list* but projects to COUNT(*) AS c. Same WHERE-clause set.
// ──────────────────────────────────────────────────────────────────────────

function countAuditToolInvocations({ from, to, agent_id, tool_name, status } = {}) {
  const database = getDb();
  const where = [];
  const params = {};
  if (from) { where.push('occurred_at >= @from'); params.from = from; }
  if (to)   { where.push('occurred_at <= @to'); params.to = to; }
  if (agent_id)  { where.push('agent_id = @agent_id'); params.agent_id = agent_id; }
  if (tool_name) { where.push('tool_name = @tool_name'); params.tool_name = tool_name; }
  if (status)    { where.push('status = @status'); params.status = status; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return database.prepare(`SELECT COUNT(*) AS c FROM audit_tool_invocation ${whereClause}`).get(params).c;
}

function countAuditFileAccess({ from, to, agent_id, path_prefix } = {}) {
  const database = getDb();
  const where = [];
  const params = {};
  if (from) { where.push('occurred_at >= @from'); params.from = from; }
  if (to)   { where.push('occurred_at <= @to'); params.to = to; }
  if (agent_id)    { where.push('agent_id = @agent_id'); params.agent_id = agent_id; }
  if (path_prefix) { where.push('path LIKE @path_prefix'); params.path_prefix = path_prefix + '%'; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return database.prepare(`SELECT COUNT(*) AS c FROM audit_file_access ${whereClause}`).get(params).c;
}

function countAuditCredentialChanges({ from, to, credential_class } = {}) {
  const database = getDb();
  const where = [];
  const params = {};
  if (from) { where.push('occurred_at >= @from'); params.from = from; }
  if (to)   { where.push('occurred_at <= @to'); params.to = to; }
  if (credential_class) { where.push('credential_class = @credential_class'); params.credential_class = credential_class; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return database.prepare(`SELECT COUNT(*) AS c FROM audit_credential_change ${whereClause}`).get(params).c;
}

function countAuditPermissionChanges({ from, to, agent_id } = {}) {
  const database = getDb();
  const where = [];
  const params = {};
  if (from) { where.push('occurred_at >= @from'); params.from = from; }
  if (to)   { where.push('occurred_at <= @to'); params.to = to; }
  if (agent_id) { where.push('agent_id = @agent_id'); params.agent_id = agent_id; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return database.prepare(`SELECT COUNT(*) AS c FROM audit_permission_change ${whereClause}`).get(params).c;
}

function countAuditAttestations({ from, to, control_area } = {}) {
  const database = getDb();
  const where = [];
  const params = {};
  if (from) { where.push('occurred_at >= @from'); params.from = from; }
  if (to)   { where.push('occurred_at <= @to'); params.to = to; }
  if (control_area) { where.push('control_area = @control_area'); params.control_area = control_area; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return database.prepare(`SELECT COUNT(*) AS c FROM audit_attestation ${whereClause}`).get(params).c;
}

function countAuditChannelSubscriptionChanges({ from, to, agent_id, channel_name } = {}) {
  const database = getDb();
  const where = [];
  const params = {};
  if (from) { where.push('occurred_at >= @from'); params.from = from; }
  if (to)   { where.push('occurred_at <= @to'); params.to = to; }
  if (agent_id)     { where.push('agent_id = @agent_id'); params.agent_id = agent_id; }
  if (channel_name) { where.push('channel_name = @channel_name'); params.channel_name = channel_name; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return database.prepare(`SELECT COUNT(*) AS c FROM audit_channel_subscription_change ${whereClause}`).get(params).c;
}

function countPolicyRules({ status } = {}) {
  const database = getDb();
  const where = [];
  const params = {};
  if (status) { where.push('status = @status'); params.status = status; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return database.prepare(`SELECT COUNT(*) AS c FROM policy_rule ${whereClause}`).get(params).c;
}

function countPolicyViolations({ from, to, rule_id, disposition } = {}) {
  const database = getDb();
  const where = [];
  const params = {};
  if (from) { where.push('occurred_at >= @from'); params.from = from; }
  if (to)   { where.push('occurred_at <= @to'); params.to = to; }
  if (rule_id)     { where.push('rule_id = @rule_id'); params.rule_id = rule_id; }
  if (disposition) { where.push('disposition = @disposition'); params.disposition = disposition; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return database.prepare(`SELECT COUNT(*) AS c FROM policy_violation ${whereClause}`).get(params).c;
}

// CP16 audit-rollup helpers — sister-shape upsertCostDaily. Idempotent UPSERT
// keyed on PRIMARY KEY tuple; safe to re-rollup same day. `rolled_up_at`
// captures the most-recent rollup pass timestamp.

function upsertAuditDailyByControlArea({ occurred_date, control_framework, control_area, count, rolled_up_at }) {
  if (!occurred_date || !control_framework || !control_area) {
    throw new Error('upsertAuditDailyByControlArea: occurred_date + control_framework + control_area required');
  }
  if (typeof count !== 'number' || count < 0) {
    throw new Error('upsertAuditDailyByControlArea: count must be non-negative number');
  }
  const now = rolled_up_at || new Date().toISOString();
  getDb().prepare(`
    INSERT INTO audit_daily_by_control_area (occurred_date, control_framework, control_area, count, rolled_up_at)
    VALUES (@occurred_date, @control_framework, @control_area, @count, @rolled_up_at)
    ON CONFLICT(occurred_date, control_framework, control_area) DO UPDATE SET
      count = excluded.count,
      rolled_up_at = excluded.rolled_up_at
  `).run({ occurred_date, control_framework, control_area, count, rolled_up_at: now });
}

function upsertAuditDailyByObjectClass({ occurred_date, object_class, count, rolled_up_at }) {
  if (!occurred_date || !object_class) {
    throw new Error('upsertAuditDailyByObjectClass: occurred_date + object_class required');
  }
  if (typeof count !== 'number' || count < 0) {
    throw new Error('upsertAuditDailyByObjectClass: count must be non-negative number');
  }
  const now = rolled_up_at || new Date().toISOString();
  getDb().prepare(`
    INSERT INTO audit_daily_by_object_class (occurred_date, object_class, count, rolled_up_at)
    VALUES (@occurred_date, @object_class, @count, @rolled_up_at)
    ON CONFLICT(occurred_date, object_class) DO UPDATE SET
      count = excluded.count,
      rolled_up_at = excluded.rolled_up_at
  `).run({ occurred_date, object_class, count, rolled_up_at: now });
}

function upsertAuditDailyByAgent({ occurred_date, agent_id, object_class, count, rolled_up_at }) {
  if (!occurred_date || !agent_id || !object_class) {
    throw new Error('upsertAuditDailyByAgent: occurred_date + agent_id + object_class required');
  }
  if (typeof count !== 'number' || count < 0) {
    throw new Error('upsertAuditDailyByAgent: count must be non-negative number');
  }
  const now = rolled_up_at || new Date().toISOString();
  getDb().prepare(`
    INSERT INTO audit_daily_by_agent (occurred_date, agent_id, object_class, count, rolled_up_at)
    VALUES (@occurred_date, @agent_id, @object_class, @count, @rolled_up_at)
    ON CONFLICT(occurred_date, agent_id, object_class) DO UPDATE SET
      count = excluded.count,
      rolled_up_at = excluded.rolled_up_at
  `).run({ occurred_date, agent_id, object_class, count, rolled_up_at: now });
}

function listAuditDailyByControlArea({ control_framework, from_date, to_date, control_area } = {}) {
  const where = [];
  const params = {};
  if (control_framework) { where.push('control_framework = @control_framework'); params.control_framework = control_framework; }
  if (control_area)      { where.push('control_area = @control_area'); params.control_area = control_area; }
  if (from_date) { where.push('occurred_date >= @from_date'); params.from_date = from_date; }
  if (to_date)   { where.push('occurred_date <= @to_date'); params.to_date = to_date; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return getDb().prepare(`SELECT * FROM audit_daily_by_control_area ${whereClause} ORDER BY occurred_date DESC, control_framework, control_area`).all(params);
}

function listAuditDailyByObjectClass({ object_class, from_date, to_date } = {}) {
  const where = [];
  const params = {};
  if (object_class) { where.push('object_class = @object_class'); params.object_class = object_class; }
  if (from_date)    { where.push('occurred_date >= @from_date'); params.from_date = from_date; }
  if (to_date)      { where.push('occurred_date <= @to_date'); params.to_date = to_date; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return getDb().prepare(`SELECT * FROM audit_daily_by_object_class ${whereClause} ORDER BY occurred_date DESC, object_class`).all(params);
}

function listAuditDailyByAgent({ agent_id, object_class, from_date, to_date } = {}) {
  const where = [];
  const params = {};
  if (agent_id)     { where.push('agent_id = @agent_id'); params.agent_id = agent_id; }
  if (object_class) { where.push('object_class = @object_class'); params.object_class = object_class; }
  if (from_date)    { where.push('occurred_date >= @from_date'); params.from_date = from_date; }
  if (to_date)      { where.push('occurred_date <= @to_date'); params.to_date = to_date; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return getDb().prepare(`SELECT * FROM audit_daily_by_agent ${whereClause} ORDER BY occurred_date DESC, agent_id, object_class`).all(params);
}

function diffChannelSubscriptions(prior, current) {
  // Identity: agent_id. Diff: per-agent set-difference of channel names.
  // Returns: { subscribes: [{agent_id, channel_name, source_path}], unsubscribes: [...] }
  function indexBy(list) {
    const m = new Map();
    for (const e of (list || [])) m.set(e.agent_id, e);
    return m;
  }
  const priorMap = indexBy(prior);
  const currMap = indexBy(current);
  const subscribes = [];
  const unsubscribes = [];
  for (const [agent_id, curr] of currMap.entries()) {
    const prev = priorMap.get(agent_id);
    const prevSet = new Set((prev && prev.channels) || []);
    const currSet = new Set(curr.channels || []);
    for (const ch of currSet) {
      if (!prevSet.has(ch)) {
        subscribes.push({ agent_id, channel_name: ch, source_path: curr.source_path });
      }
    }
    for (const ch of prevSet) {
      if (!currSet.has(ch)) {
        unsubscribes.push({ agent_id, channel_name: ch, source_path: curr.source_path });
      }
    }
  }
  // Agents that vanished entirely → all their channels become unsubscribes.
  for (const [agent_id, prev] of priorMap.entries()) {
    if (!currMap.has(agent_id)) {
      for (const ch of (prev.channels || [])) {
        unsubscribes.push({ agent_id, channel_name: ch, source_path: prev.source_path });
      }
    }
  }
  return { subscribes, unsubscribes };
}

function processChannelSubscriptionScan({ subscriptions, actor, scan_at } = {}) {
  if (!Array.isArray(subscriptions)) {
    throw new Error('processChannelSubscriptionScan: subscriptions array required');
  }
  if (!actor || typeof actor !== 'string') {
    throw new Error('processChannelSubscriptionScan: actor (ops-key sha256[:16] OR script-id) required');
  }
  // Validate + normalize each subscription entry. Drop malformed silently;
  // log count for operator visibility.
  const validated = subscriptions.filter(s =>
    s && typeof s.agent_id === 'string' && s.agent_id.length > 0
    && Array.isArray(s.channels)
    && s.channels.every(c => typeof c === 'string' && CHANNEL_NAME_RE.test(c))
  ).map(s => ({
    agent_id: s.agent_id,
    channels: [...new Set(s.channels)].sort(),  // dedup + sort for stable snapshot
    source_path: s.source_path || null,
  }));
  if (validated.length !== subscriptions.length) {
    console.warn(`[channel-sub-scan] dropped ${subscriptions.length - validated.length} malformed subscription rows`);
  }

  const database = getDb();
  const occurred_at = scan_at || new Date().toISOString();
  const priorRow = database.prepare('SELECT snapshot_json FROM channel_subscription_snapshot WHERE id = 1').get();
  let prior = null;
  if (priorRow) {
    try { prior = JSON.parse(priorRow.snapshot_json).subscriptions; } catch (e) { prior = null; }
  }
  const isFirstScan = !prior;

  if (isFirstScan) {
    database.prepare(`
      INSERT INTO channel_subscription_snapshot (id, snapshot_json, updated_at)
      VALUES (1, @snapshot_json, @updated_at)
    `).run({
      snapshot_json: JSON.stringify({ subscriptions: validated }),
      updated_at: occurred_at,
    });
    return {
      first_scan: true,
      subscriptions_count: validated.length,
      subscribes: 0, unsubscribes: 0, total_emitted: 0,
    };
  }

  const diff = diffChannelSubscriptions(prior, validated);
  let emitted = 0;
  function safeEmit(row) {
    try { insertAuditChannelSubscriptionChange(row); emitted++; } catch (e) { /* never block scan */ }
  }
  for (const s of diff.subscribes) {
    safeEmit({
      occurred_at, agent_id: s.agent_id, change_type: 'subscribe',
      channel_name: s.channel_name, actor,
      source_path: s.source_path,
      reason: `channel-sub-scan: ${s.agent_id} subscribed to ${s.channel_name}`,
    });
  }
  for (const s of diff.unsubscribes) {
    safeEmit({
      occurred_at, agent_id: s.agent_id, change_type: 'unsubscribe',
      channel_name: s.channel_name, actor,
      source_path: s.source_path,
      reason: `channel-sub-scan: ${s.agent_id} unsubscribed from ${s.channel_name}`,
    });
  }

  database.prepare(`
    INSERT OR REPLACE INTO channel_subscription_snapshot (id, snapshot_json, updated_at)
    VALUES (1, @snapshot_json, @updated_at)
  `).run({
    snapshot_json: JSON.stringify({ subscriptions: validated }),
    updated_at: occurred_at,
  });

  return {
    first_scan: false,
    subscribes: diff.subscribes.length,
    unsubscribes: diff.unsubscribes.length,
    total_emitted: emitted,
  };
}

// ─── Task #223 v1: agent_channel_subscription (canonical authority tier) ────
// Per PLAN-PLEXUS-ADMIN-CHANNEL-SUBSCRIPTION + parch #11225 RATIFY.
// Distinct from CP12.15 audit_channel_subscription_change (log tier).

function getAgentChannels(agent_id) {
  const database = getDb();
  const rows = database
    .prepare('SELECT channel FROM agent_channel_subscription WHERE agent_id = ? ORDER BY channel')
    .all(String(agent_id || ''));
  return rows.map(r => r.channel);
}

function setAgentChannels({ agent_id, channels, subscribed_by }) {
  if (!agent_id || typeof agent_id !== 'string') {
    throw new Error('setAgentChannels: agent_id required');
  }
  if (!Array.isArray(channels)) {
    throw new Error('setAgentChannels: channels array required');
  }
  if (!subscribed_by || typeof subscribed_by !== 'string') {
    throw new Error('setAgentChannels: subscribed_by required');
  }
  // Per PLAN OQ-C RATIFY: format-only validation, not allowlist
  // (preserves ad-hoc subscription discipline). CHANNEL_NAME_RE per CP12.15.
  const invalid = channels.filter(c => typeof c !== 'string' || !CHANNEL_NAME_RE.test(c));
  if (invalid.length > 0) {
    throw new Error(`setAgentChannels: invalid channel names: ${invalid.join(', ')}`);
  }
  const canonical = [...new Set(channels)].sort();
  const prior = getAgentChannels(agent_id);
  const priorSet = new Set(prior);
  const canonicalSet = new Set(canonical);
  const subscribes = canonical.filter(c => !priorSet.has(c));
  const unsubscribes = prior.filter(c => !canonicalSet.has(c));
  const now = new Date().toISOString();
  const database = getDb();
  const tx = database.transaction(() => {
    database.prepare('DELETE FROM agent_channel_subscription WHERE agent_id = ?').run(agent_id);
    const ins = database.prepare(`
      INSERT INTO agent_channel_subscription (agent_id, channel, subscribed_at, subscribed_by)
      VALUES (?, ?, ?, ?)
    `);
    for (const c of canonical) {
      ins.run(agent_id, c, now, subscribed_by);
    }
  });
  tx();
  // Per PLAN OQ-D RATIFY: sister-shape audit-emission via CP12.15 helper.
  // Emit one audit row per delta (subscribe/unsubscribe); actor field = subscribed_by.
  for (const ch of subscribes) {
    try {
      insertAuditChannelSubscriptionChange({
        occurred_at: now,
        agent_id,
        change_type: 'subscribe',
        channel_name: ch,
        actor: subscribed_by,
        source_path: 'agent_channel_subscription-authority-tier',
        reason: `admin-canonical set: subscribed ${agent_id} to ${ch}`,
      });
    } catch (e) { /* audit-emission never blocks the write */ }
  }
  for (const ch of unsubscribes) {
    try {
      insertAuditChannelSubscriptionChange({
        occurred_at: now,
        agent_id,
        change_type: 'unsubscribe',
        channel_name: ch,
        actor: subscribed_by,
        source_path: 'agent_channel_subscription-authority-tier',
        reason: `admin-canonical set: unsubscribed ${agent_id} from ${ch}`,
      });
    } catch (e) { /* audit-emission never blocks */ }
  }
  return {
    agent_id,
    channels: canonical,
    subscribed_by,
    updated_at: now,
    subscribes_count: subscribes.length,
    unsubscribes_count: unsubscribes.length,
  };
}

module.exports = {
  initializeDb,
  getDb,
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
  // CP12.13 Phase 2 aggregate views
  listRegistrationEventsByAgent,
  aggregateRegistrationEventsByAgent,
  aggregateCredentialChanges,
  expireStalePresence,
  deletePresenceRow,
  deriveLabel,
  // CP10.3: activity timeline
  insertAgentActivity,
  listAgentActivity,
  // CP11.1: cost-persistence (pre-staged for ADR-0029 Phase 1)
  upsertCostDaily,
  vendorOf,
  getCostByPeriod,
  getCostByVendor,
  getCostByVendorDaily,
  upsertCostDimensionTags,
  getCostDimensionTags,
  upsertCostBudget,
  getCostBudgets,
  insertCostReconciliation,
  listCostReconciliations,
  // CP12.1: audit + governance substrate (ADR-0030 v1.1 ratified)
  computeAuditEventId,
  subjectHash,
  fullSha256,
  insertAuditToolInvocation,
  listAuditToolInvocations,
  getAuditToolInvocationByEventId,
  insertAuditFileAccess,
  listAuditFileAccess,
  insertAuditCredentialChange,
  // CP12.7 Phase B: env-diff boot detector + supporting pure functions for tests
  envDiffBootDetector,
  computeCredentialFingerprintSet,
  diffCredentialFingerprintSets,
  // CP12.8 Phase 2 admin-R4: permission-change scan processor + pure diff
  processPermissionScan,
  diffPermissionSources,
  listAuditCredentialChanges,
  insertAuditPermissionChange,
  listAuditPermissionChanges,
  // CP12.10 (2026-06-07): audit_attestation governance substrate (Phase 3 ADR-0030)
  insertAuditAttestation,
  listAuditAttestations,
  ATTESTATION_CONTROL_AREAS,
  // CP12.15 (2026-06-07): channel-subscription change history (Phase 2)
  insertAuditChannelSubscriptionChange,
  listAuditChannelSubscriptionChanges,
  processChannelSubscriptionScan,
  diffChannelSubscriptions,
  // Task #223 v1 (2026-07-01): canonical-authority tier
  getAgentChannels,
  setAgentChannels,
  // COUNT-only helpers for /audit/by-control-area perf fix (sister-shape list* but SELECT COUNT(*)).
  countAuditToolInvocations,
  countAuditFileAccess,
  countAuditCredentialChanges,
  countAuditPermissionChanges,
  countAuditAttestations,
  countAuditChannelSubscriptionChanges,
  countPolicyRules,
  countPolicyViolations,
  upsertAuditDailyByControlArea,
  upsertAuditDailyByObjectClass,
  upsertAuditDailyByAgent,
  listAuditDailyByControlArea,
  listAuditDailyByObjectClass,
  listAuditDailyByAgent,
  // CP12.16 (2026-06-07): GRC reconcile-class extension (Phase 2)
  RECONCILE_CLASS_VOCAB,
  aggregateAuditReconciliationsByClass,
  // CP12.17 (2026-06-07): ADR change-history bus-message-ID cross-reference
  findMessageIdsReferencingAdr,
  // CP12.12 (2026-06-07): Phase 3 (A) external integrity anchor
  ANCHOR_SUBSTRATE_VOCAB,
  ANCHOR_CHAIN_TABLES,
  computeChainSnapshot,
  // CP12.12.1: substrate-semantic verify (Reading 2 per bizmodel #8029)
  computeChainSnapshotAt,
  insertAuditAnchor,
  listAuditAnchors,
  getAuditAnchorByDay,
  verifyAuditAnchor,
  upsertPolicyRule,
  listPolicyRules,
  getPolicyRule,
  ratifyPolicyRule,
  deprecatePolicyRule,
  insertPolicyViolation,
  listPolicyViolations,
  disposePolicyViolation,
  insertAuditReconciliation,
  listAuditReconciliations,
  insertAuditPayload,
  getAuditPayload,
  tombstoneAuditPayload,
  tombstoneMessage,
  upsertSubjectDirectory,
  getSubjectByHash,
  tombstoneSubject,
  // CP12.4 (2026-06-05): audit_ingester_cursor + scan helper
  getIngesterCursor,
  upsertIngesterCursor,
  scanAgentActivityForAudit,
  // CP13.6 Phase 2.2 (2026-06-20): output_pr + output_pr_cursor + output_repo helpers
  upsertOutputPr,
  getOutputPrCursor,
  upsertOutputPrCursor,
  listEnabledOutputRepos,
  listAllOutputRepos,
  upsertOutputRepo,
  disableOutputRepo,
  bootstrapOutputReposFromConfig,
  // CP17.A helpers
  insertBareGitRequest,
  getBareGitRequest,
  getPendingBareGitRequestByName,
  listPendingBareGitRequests,
  fulfillBareGitRequest,
  insertAuditRepoChange,
  listAuditRepoChangesByRepo,
  // CP17.B rollup + query helpers
  rebuildOutputDailyForDate,
  rollupOutputWindow,
  queryVirtualOutputDailyForDate,
  queryOutputDailySummary,
  queryOutputDailyHeatmap,
  queryOutputDailyRepoList,
  queryRepoActivityFeed,
  queryOutputDailyAgentsInWindow,
  queryOutputDailyByAgent,
  closeDb,
  messageBus
};
