// CP13.6 Phase 2.1 / Q1+Q3 ratify (parch #9799)
// Schema test for output_pr table (GitHubWalker substrate).
//
// Per ADR-0032 Phase 2 ratify: output_pr stores PR-state metadata fetched
// from GitHub API. Joins to output_commit + output_merge via
// merge_commit_sha for cross-walker correlation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-output-pr-schema-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-x';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const { getDb, closeDb } = require('../src/db');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

test('output_pr table exists post-init with canonical columns', () => {
  const db = getDb();
  const cols = db.prepare(`PRAGMA table_info(output_pr)`).all();
  const colNames = cols.map(c => c.name).sort();
  assert.deepEqual(colNames, [
    'author_email', 'author_login', 'base_ref', 'closed_at', 'commit_count',
    'github_owner_repo', 'head_ref', 'id', 'last_synced_at', 'merge_commit_sha',
    'merged_at', 'opened_at', 'pr_number', 'state', 'title',
  ]);
});

test('output_pr enforces UNIQUE(github_owner_repo, pr_number)', () => {
  const db = getDb();
  const indexes = db.prepare(`PRAGMA index_list(output_pr)`).all();
  const uniqueIdxs = indexes.filter(i => i.unique === 1);
  assert.ok(uniqueIdxs.length >= 1, 'expected at least one UNIQUE index');
  const idxName = uniqueIdxs[0].name;
  const idxCols = db.prepare(`PRAGMA index_info(${idxName})`).all();
  const idxColNames = idxCols.map(c => c.name).sort();
  assert.deepEqual(idxColNames, ['github_owner_repo', 'pr_number']);
});

test('output_pr has canonical indexes (opened, merged, state, owner_repo)', () => {
  const db = getDb();
  const indexes = db.prepare(`PRAGMA index_list(output_pr)`).all();
  const idxNames = indexes.map(i => i.name);
  assert.ok(idxNames.some(n => n === 'idx_output_pr_opened'), 'expected idx_output_pr_opened');
  assert.ok(idxNames.some(n => n === 'idx_output_pr_merged'), 'expected idx_output_pr_merged');
  assert.ok(idxNames.some(n => n === 'idx_output_pr_state'), 'expected idx_output_pr_state');
  assert.ok(idxNames.some(n => n === 'idx_output_pr_owner_repo'), 'expected idx_output_pr_owner_repo');
});

test('output_pr NOT NULL discipline on load-bearing columns', () => {
  const db = getDb();
  const cols = db.prepare(`PRAGMA table_info(output_pr)`).all();
  const notNullCols = cols.filter(c => c.notnull === 1).map(c => c.name).sort();
  // Substrate-honest: state + title + author_login + base_ref + head_ref +
  // opened_at + last_synced_at + github_owner_repo + pr_number are load-bearing
  // (any insert without these is malformed). author_email is nullable (private-
  // email-shielded GH accounts); merged_at/closed_at nullable (state-dependent);
  // merge_commit_sha nullable (only set when merged); commit_count nullable.
  assert.ok(notNullCols.includes('github_owner_repo'));
  assert.ok(notNullCols.includes('pr_number'));
  assert.ok(notNullCols.includes('state'));
  assert.ok(notNullCols.includes('title'));
  assert.ok(notNullCols.includes('author_login'));
  assert.ok(notNullCols.includes('base_ref'));
  assert.ok(notNullCols.includes('head_ref'));
  assert.ok(notNullCols.includes('opened_at'));
  assert.ok(notNullCols.includes('last_synced_at'));
});
