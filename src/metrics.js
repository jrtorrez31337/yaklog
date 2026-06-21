// CP16-prep observability migration per parch #10157 ratify of #10153 Option 2c
// + parch #10166 6-OQ arbitration. Sister-shape gap fix for both substrate-prep
// scripts (yaklog-wal-checkpoint + yaklog-output-ingester) whose Prom textfile
// emit never landed in cluster Prom — see [[feedback_plexus_prom_topology_does_not_include_node_exporter_textfile_collector]].
//
// Architecture: yaklog server emits gauges via prom-client custom Registry;
// GET /api/v1/metrics route exposes Prom text-format (auth-required per
// secops #10164 corrected Q2 disposition — yaklog:3100 is 0.0.0.0 host-public,
// NOT internal-only like plexus-otel-collector:8889; see
// [[feedback_public_bind_vs_internal_only_network_isolation_distinction_at_substrate_auth_disposition_tier]]).
//
// Custom Registry per secops Gate (1) condition (#10161 / #10166 condition 3):
// no default-collector metrics (process_*, nodejs_*, etc) — only the explicit
// gauges below. Keeps the exposed surface minimal; no Node.js runtime
// introspection leaked.

'use strict';

const { Registry, Gauge, Counter } = require('prom-client');

// Custom Registry — NO default collectors per secops condition 3.
// All explicit gauges/counters below register here.
const registry = new Registry();

// ─── WAL checkpoint maintenance gauges ──────────────────────────────────────
// Set by POST /api/v1/ops/wal-checkpoint handler after PRAGMA returns.
// Cron-driven (hourly) per yaklog-wal-checkpoint.timer + on-demand via direct POST.

// Per-db labels (per secops #10177 + parch #10201 forward-track + task #221):
// labelNames includes 'db' so per-db wal-checkpoint pressure is distinguishable
// in Prom (CP14-X added plexus-secure.db; cron loop fires both yaklog + plexus-secure
// per checkpoint cycle; without 'db' label the second call overwrites the first
// at the /metrics tier per [[feedback_writer_lock_contention_visible_via_checkpoint_elapsed_ms]]).
const walCheckpointElapsedMs = new Gauge({
  name: 'yaklog_wal_checkpoint_elapsed_ms',
  help: 'Time taken by last WAL checkpoint per db (substrate-availability-tier diagnostic per feedback_writer_lock_contention_visible_via_checkpoint_elapsed_ms)',
  labelNames: ['db'],
  registers: [registry],
});

const walCheckpointLogPages = new Gauge({
  name: 'yaklog_wal_checkpoint_log_pages',
  help: 'Pages in WAL at start of last checkpoint per db (0 = WAL already drained by auto-checkpoint)',
  labelNames: ['db'],
  registers: [registry],
});

const walCheckpointPagesCheckpointed = new Gauge({
  name: 'yaklog_wal_checkpoint_pages_checkpointed',
  help: 'Pages successfully written back to main DB file in last checkpoint per db',
  labelNames: ['db'],
  registers: [registry],
});

const walCheckpointBusyFlag = new Gauge({
  name: 'yaklog_wal_checkpoint_busy_flag',
  help: 'SQLite busy flag from last checkpoint per db (1 = writer-lock contention; 0 = clean)',
  labelNames: ['db'],
  registers: [registry],
});

const walCheckpointSuccess = new Gauge({
  name: 'yaklog_wal_checkpoint_success',
  help: 'Whether last WAL checkpoint completed successfully per db (1 = ok, 0 = error)',
  labelNames: ['db'],
  registers: [registry],
});

const walCheckpointLastRunUnixTimestamp = new Gauge({
  name: 'yaklog_wal_checkpoint_last_run_unix_timestamp',
  help: 'Unix timestamp (seconds) of last WAL checkpoint invocation per db',
  labelNames: ['db'],
  registers: [registry],
});

const walCheckpointInvocationsTotal = new Counter({
  name: 'yaklog_wal_checkpoint_invocations_total',
  help: 'Total POST /api/v1/ops/wal-checkpoint invocations per db',
  labelNames: ['mode', 'outcome', 'db'],
  registers: [registry],
});

// ─── Output ingester gauges ─────────────────────────────────────────────────
// Set by POST /api/v1/ops/output/ingest handler after runOnce returns.
// Cron-driven (hourly) per yaklog-output-ingester.timer + on-demand via direct POST.

const outputIngesterElapsedMs = new Gauge({
  name: 'yaklog_output_ingester_elapsed_ms',
  help: 'Time taken by last output-strand ingester run (full runOnce sweep)',
  registers: [registry],
});

const outputIngesterCommitsWalked = new Gauge({
  name: 'yaklog_output_ingester_commits_walked',
  help: 'Total commits walked across all repos in last ingester run',
  registers: [registry],
});

const outputIngesterMergesWalked = new Gauge({
  name: 'yaklog_output_ingester_merges_walked',
  help: 'Total merges walked across all repos in last ingester run',
  registers: [registry],
});

const outputIngesterPrsWalked = new Gauge({
  name: 'yaklog_output_ingester_prs_walked',
  help: 'Total PRs walked across all repos in last ingester run',
  registers: [registry],
});

const outputIngesterSuccess = new Gauge({
  name: 'yaklog_output_ingester_success',
  help: 'Whether last output ingester run completed successfully (1 = ok, 0 = error)',
  registers: [registry],
});

const outputIngesterLastRunUnixTimestamp = new Gauge({
  name: 'yaklog_output_ingester_last_run_unix_timestamp',
  help: 'Unix timestamp (seconds) of last output ingester invocation',
  registers: [registry],
});

const outputIngesterInvocationsTotal = new Counter({
  name: 'yaklog_output_ingester_invocations_total',
  help: 'Total POST /api/v1/ops/output/ingest invocations',
  labelNames: ['outcome'],
  registers: [registry],
});

// ─── ORP write gauges (CP14-X Plexus Secure Store; secops #10172 condition C) ─
// Set by POST /api/v1/ops/orp/<agent_id> handler after upsertOrp returns.

const orpWriteInvocationsTotal = new Counter({
  name: 'yaklog_orp_write_invocations_total',
  help: 'Total POST /api/v1/ops/orp/<agent_id> invocations',
  labelNames: ['outcome'],
  registers: [registry],
});

const orpWriteSuccess = new Gauge({
  name: 'yaklog_orp_write_success',
  help: 'Whether last ORP write succeeded (1 = ok, 0 = error/validation-fail)',
  registers: [registry],
});

const orpWriteLastVersion = new Gauge({
  name: 'yaklog_orp_write_last_version',
  help: 'Version number of last successful ORP write (per agent_id label)',
  labelNames: ['agent_id'],
  registers: [registry],
});

const orpWriteLastRunUnixTimestamp = new Gauge({
  name: 'yaklog_orp_write_last_run_unix_timestamp',
  help: 'Unix timestamp (seconds) of last ORP write attempt',
  registers: [registry],
});

// ─── Emit helpers (called by ops endpoint handlers post-result) ─────────────

function emitWalCheckpoint({ mode, db, elapsed_ms, log, checkpointed, busy, success }) {
  const outcome = success ? 'ok' : 'error';
  // Default db label to 'yaklog' for backward compat with callers that don't
  // pass db (the auditOpsRoutes /wal-checkpoint handler defaults db to 'yaklog'
  // when body omits the param per CP14-X Q3 ratify backward-compat shape).
  const dbLabel = String(db || 'yaklog');
  walCheckpointElapsedMs.set({ db: dbLabel }, Number(elapsed_ms) || 0);
  walCheckpointLogPages.set({ db: dbLabel }, Number(log) || 0);
  walCheckpointPagesCheckpointed.set({ db: dbLabel }, Number(checkpointed) || 0);
  walCheckpointBusyFlag.set({ db: dbLabel }, Number(busy) || 0);
  walCheckpointSuccess.set({ db: dbLabel }, success ? 1 : 0);
  walCheckpointLastRunUnixTimestamp.set({ db: dbLabel }, Math.floor(Date.now() / 1000));
  walCheckpointInvocationsTotal.inc({ mode: String(mode || 'unknown'), outcome, db: dbLabel });
}

function emitOutputIngester({ elapsed_ms, commits_walked, merges_walked, prs_walked, success }) {
  const outcome = success ? 'ok' : 'error';
  outputIngesterElapsedMs.set(Number(elapsed_ms) || 0);
  outputIngesterCommitsWalked.set(Number(commits_walked) || 0);
  outputIngesterMergesWalked.set(Number(merges_walked) || 0);
  outputIngesterPrsWalked.set(Number(prs_walked) || 0);
  outputIngesterSuccess.set(success ? 1 : 0);
  outputIngesterLastRunUnixTimestamp.set(Math.floor(Date.now() / 1000));
  outputIngesterInvocationsTotal.inc({ outcome });
}

function emitOrpWrite({ agent_id, version, success, outcome }) {
  // outcome can be 'ok', 'error', or 'validation-fail' (sub-class of error
  // for distinguishing 422 schema-validation rejects from 500 actual errors).
  const finalOutcome = outcome || (success ? 'ok' : 'error');
  orpWriteSuccess.set(success ? 1 : 0);
  orpWriteLastRunUnixTimestamp.set(Math.floor(Date.now() / 1000));
  orpWriteInvocationsTotal.inc({ outcome: finalOutcome });
  if (success && agent_id && version != null) {
    orpWriteLastVersion.set({ agent_id }, Number(version));
  }
}

module.exports = {
  registry,
  emit: {
    walCheckpoint: emitWalCheckpoint,
    outputIngester: emitOutputIngester,
    orpWrite: emitOrpWrite,
  },
};
