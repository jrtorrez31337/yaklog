// CP13.6 Phase 2.1 — output_pr_cursor schema test
// Per-repo cursor for incremental GitHub API fetch. Stores
// last_pr_updated_at (GitHub API ?since= parameter), rate-limit-budget
// tracking, and last-walk diagnostic status. Sister-shape to
// output_ingester_cursor (CP13.1 substrate).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-output-pr-cursor-schema-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-x';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const { getDb, closeDb } = require('../src/db');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

test('output_pr_cursor table exists with canonical columns', () => {
  const db = getDb();
  const cols = db.prepare(`PRAGMA table_info(output_pr_cursor)`).all();
  const colNames = cols.map(c => c.name).sort();
  assert.deepEqual(colNames, [
    'github_owner_repo', 'last_pr_updated_at', 'last_walk_message',
    'last_walk_status', 'prs_synced_total', 'rate_limit_remaining',
    'rate_limit_reset_at',
  ]);
});

test('output_pr_cursor PRIMARY KEY on github_owner_repo', () => {
  const db = getDb();
  const cols = db.prepare(`PRAGMA table_info(output_pr_cursor)`).all();
  const pkCol = cols.find(c => c.pk === 1);
  assert.equal(pkCol?.name, 'github_owner_repo');
});

test('output_pr_cursor load-bearing columns NOT NULL', () => {
  const db = getDb();
  const cols = db.prepare(`PRAGMA table_info(output_pr_cursor)`).all();
  const notNullCols = cols.filter(c => c.notnull === 1).map(c => c.name);
  // last_pr_updated_at + prs_synced_total are required for cursor semantics
  // (rate_limit_* + last_walk_* are nullable — only populated post-first-walk)
  // NOTE: github_owner_repo is PRIMARY KEY (implicitly non-null via PK
  // constraint; SQLite PRAGMA table_info reports notnull=0 for TEXT PKs).
  assert.ok(notNullCols.includes('last_pr_updated_at'));
  assert.ok(notNullCols.includes('prs_synced_total'));
});
