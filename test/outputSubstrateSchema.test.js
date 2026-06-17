// CP13.1 / ADR-0032 Phase 1.1: output-strand substrate schema migration tests.
// Validates the 3 first-class tables (output_commit / output_merge /
// output_ingester_cursor) per ADR-0032 §Schema canonical commit eec3039.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-cp131-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-x';
process.env.YAKLOG_OPS_API_KEYS = 'ops-y';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const { closeDb, initializeDb } = require('../src/db');
const getDb = () => initializeDb();

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// ── schema migration: tables exist with expected columns ───────────────────

test('output_commit table exists with canonical columns per ADR-0032 §Schema', () => {
  const cols = getDb().pragma('table_info(output_commit)');
  const colNames = new Set(cols.map((c) => c.name));
  for (const expected of [
    'id', 'repo', 'commit_sha', 'author_name', 'author_email',
    'committer_name', 'committer_email', 'occurred_at', 'branch', 'subject',
    'body_digest', 'agent_attribution', 'attribution_method',
    'runtime_class', 'files_changed', 'bytes_delta',
  ]) {
    assert.ok(colNames.has(expected), `output_commit missing column ${expected}`);
  }
});

test('output_merge table exists with canonical columns per ADR-0032 §Schema', () => {
  const cols = getDb().pragma('table_info(output_merge)');
  const colNames = new Set(cols.map((c) => c.name));
  for (const expected of [
    'id', 'repo', 'merge_commit_sha', 'source_branch', 'target_branch',
    'pr_number', 'occurred_at', 'merged_by_agent', 'attribution_method',
    'parent_commit_count', 'child_commit_count', 'bytes_delta',
  ]) {
    assert.ok(colNames.has(expected), `output_merge missing column ${expected}`);
  }
});

test('output_ingester_cursor table exists with canonical columns per ADR-0032 §Schema', () => {
  const cols = getDb().pragma('table_info(output_ingester_cursor)');
  const colNames = new Set(cols.map((c) => c.name));
  for (const expected of [
    'repo', 'last_ref', 'last_walked_at',
    'commits_ingested', 'merges_ingested', 'attribution_gap_count',
  ]) {
    assert.ok(colNames.has(expected), `output_ingester_cursor missing column ${expected}`);
  }
});

// ── UNIQUE constraints (load-bearing for ingester idempotency) ─────────────

test('output_commit has UNIQUE(repo, commit_sha) for walker idempotency', () => {
  const db = getDb();
  db.prepare(`INSERT INTO output_commit (
    repo, commit_sha, author_name, author_email,
    committer_name, committer_email, occurred_at, subject
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'test.git', 'abc123', 'Jon Torrez', 'j@example.com',
    'Jon Torrez', 'j@example.com', '2026-06-17T00:00:00Z', 'first commit',
  );
  assert.throws(() => {
    db.prepare(`INSERT INTO output_commit (
      repo, commit_sha, author_name, author_email,
      committer_name, committer_email, occurred_at, subject
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'test.git', 'abc123', 'Jon Torrez', 'j@example.com',
      'Jon Torrez', 'j@example.com', '2026-06-17T00:00:00Z', 'duplicate',
    );
  }, /UNIQUE constraint/);
});

test('output_merge has UNIQUE(repo, merge_commit_sha) for walker idempotency', () => {
  const db = getDb();
  db.prepare(`INSERT INTO output_merge (
    repo, merge_commit_sha, target_branch, occurred_at
  ) VALUES (?, ?, ?, ?)`).run(
    'test.git', 'merge1', 'main', '2026-06-17T00:00:00Z',
  );
  assert.throws(() => {
    db.prepare(`INSERT INTO output_merge (
      repo, merge_commit_sha, target_branch, occurred_at
    ) VALUES (?, ?, ?, ?)`).run(
      'test.git', 'merge1', 'main', '2026-06-17T00:00:00Z',
    );
  }, /UNIQUE constraint/);
});

test('output_ingester_cursor repo is PRIMARY KEY (per-repo state singleton)', () => {
  const db = getDb();
  db.prepare(`INSERT INTO output_ingester_cursor (
    repo, last_ref, last_walked_at
  ) VALUES (?, ?, ?)`).run('xyz.git', 'refs/heads/main', '2026-06-17T00:00:00Z');
  assert.throws(() => {
    db.prepare(`INSERT INTO output_ingester_cursor (
      repo, last_ref, last_walked_at
    ) VALUES (?, ?, ?)`).run('xyz.git', 'refs/heads/main', '2026-06-17T00:00:00Z');
  }, /UNIQUE constraint|PRIMARY KEY/);
});

// ── NULL-fallback semantics for attribution (substrate-honesty per ADR-0030
//    coverage-gap canon + ADR-0032 §Agent-attribution parser canon) ────────

test('output_commit accepts NULL agent_attribution + attribution_method (null_fallback honesty)', () => {
  const db = getDb();
  db.prepare(`INSERT INTO output_commit (
    repo, commit_sha, author_name, author_email,
    committer_name, committer_email, occurred_at, subject,
    agent_attribution, attribution_method
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'null-attrib.git', 'def456', 'Jon Torrez', 'j@example.com',
    'Jon Torrez', 'j@example.com', '2026-06-17T01:00:00Z', 'human-direct',
    null, 'null_fallback',
  );
  const row = db.prepare('SELECT agent_attribution, attribution_method FROM output_commit WHERE commit_sha = ?').get('def456');
  assert.equal(row.agent_attribution, null);
  assert.equal(row.attribution_method, 'null_fallback');
});

test('output_merge supports pr_number NULL (direct push) and populated (PR-flow)', () => {
  const db = getDb();
  db.prepare(`INSERT INTO output_merge (
    repo, merge_commit_sha, target_branch, occurred_at, pr_number
  ) VALUES (?, ?, ?, ?, ?)`).run(
    'flow.git', 'direct-push-sha', 'main', '2026-06-17T02:00:00Z', null,
  );
  db.prepare(`INSERT INTO output_merge (
    repo, merge_commit_sha, target_branch, occurred_at, pr_number
  ) VALUES (?, ?, ?, ?, ?)`).run(
    'flow.git', 'pr-flow-sha', 'main', '2026-06-17T02:01:00Z', 42,
  );
  const direct = db.prepare('SELECT pr_number FROM output_merge WHERE merge_commit_sha = ?').get('direct-push-sha');
  const prflow = db.prepare('SELECT pr_number FROM output_merge WHERE merge_commit_sha = ?').get('pr-flow-sha');
  assert.equal(direct.pr_number, null);
  assert.equal(prflow.pr_number, 42);
});

// ── indexes present (load-bearing for ratio query performance) ────────────

test('output_commit indexes exist for ratio query patterns', () => {
  const indexes = getDb().pragma('index_list(output_commit)').map((r) => r.name);
  assert.ok(indexes.includes('idx_output_commit_repo_occurred'),
    'idx_output_commit_repo_occurred missing — required for per-repo time-window queries');
  assert.ok(indexes.includes('idx_output_commit_agent'),
    'idx_output_commit_agent missing — required for per-agent leverage queries');
  assert.ok(indexes.includes('idx_output_commit_occurred'),
    'idx_output_commit_occurred missing — required for cluster-wide time-window queries');
});

test('output_merge indexes exist for ratio query patterns', () => {
  const indexes = getDb().pragma('index_list(output_merge)').map((r) => r.name);
  assert.ok(indexes.includes('idx_output_merge_occurred'),
    'idx_output_merge_occurred missing — required for $/merged-PR rolling-window');
  assert.ok(indexes.includes('idx_output_merge_agent_occurred'),
    'idx_output_merge_agent_occurred missing — required for per-agent merge attribution');
  assert.ok(indexes.includes('idx_output_merge_repo_occurred'),
    'idx_output_merge_repo_occurred missing — required for per-repo composition');
});

// ── idempotency: re-running initializeDb() does not blow away tables ──────

test('schema migration is idempotent (re-init no-op)', () => {
  const db1 = getDb();
  db1.prepare(`INSERT INTO output_commit (
    repo, commit_sha, author_name, author_email,
    committer_name, committer_email, occurred_at, subject
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'idem.git', 'idem-sha', 'Jon Torrez', 'j@example.com',
    'Jon Torrez', 'j@example.com', '2026-06-17T03:00:00Z', 'idempotency test',
  );
  // Force a re-call of getDb() which would re-run initializeDb() if not cached
  const db2 = getDb();
  const row = db2.prepare('SELECT subject FROM output_commit WHERE commit_sha = ?').get('idem-sha');
  assert.equal(row.subject, 'idempotency test');
});

// ── attribution_gap_count default + increment semantics ─────────────────

test('output_ingester_cursor attribution_gap_count defaults to 0 + increments cleanly', () => {
  const db = getDb();
  db.prepare(`INSERT INTO output_ingester_cursor (
    repo, last_ref, last_walked_at
  ) VALUES (?, ?, ?)`).run('gap.git', 'refs/heads/main', '2026-06-17T04:00:00Z');
  const initial = db.prepare('SELECT attribution_gap_count FROM output_ingester_cursor WHERE repo = ?').get('gap.git');
  assert.equal(initial.attribution_gap_count, 0);
  db.prepare(`UPDATE output_ingester_cursor SET attribution_gap_count = attribution_gap_count + 1 WHERE repo = ?`).run('gap.git');
  const incremented = db.prepare('SELECT attribution_gap_count FROM output_ingester_cursor WHERE repo = ?').get('gap.git');
  assert.equal(incremented.attribution_gap_count, 1);
});
