// CP13.6 Phase 2.1 / Q1 Option C ratify (parch #9799)
// Schema test for output_repo table (GitHub repo allowlist canonical).
//
// Per parch ratify: bootstrap from per-host config (~/.config/yaklog/
// github-repos.txt) + ops-mutable via Phase 2.2 POST/DELETE endpoints.
// bare_git_path links to /srv/git/*.git canonical for cross-walker
// correlation (output_merge.merge_commit_sha → output_commit lookup).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-output-repo-schema-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-x';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const { getDb, closeDb } = require('../src/db');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

test('output_repo table exists with canonical columns', () => {
  const db = getDb();
  const cols = db.prepare(`PRAGMA table_info(output_repo)`).all();
  const colNames = cols.map(c => c.name).sort();
  assert.deepEqual(colNames, [
    'added_at', 'added_by', 'bare_git_path', 'enabled',
    // Task #290 (CP13.6 Phase 3): GitHub repo-meta governance-coverage columns
    'github_default_branch', 'github_last_meta_synced_at',
    'github_owner_repo', 'github_primary_language',
    'github_repo_created_at', 'github_repo_pushed_at', 'github_repo_updated_at',
    'github_size_kb', 'github_visibility',
    'last_walked_at',
  ]);
});

test('output_repo PRIMARY KEY on github_owner_repo', () => {
  const db = getDb();
  const cols = db.prepare(`PRAGMA table_info(output_repo)`).all();
  const pkCol = cols.find(c => c.pk === 1);
  assert.equal(pkCol?.name, 'github_owner_repo');
});

test('output_repo enabled column defaults to 1', () => {
  const db = getDb();
  const cols = db.prepare(`PRAGMA table_info(output_repo)`).all();
  const enabledCol = cols.find(c => c.name === 'enabled');
  assert.equal(enabledCol?.dflt_value, '1');
});

test('output_repo allows INSERT + SELECT round-trip with bare_git_path NULL', () => {
  const db = getDb();
  // bare_git_path nullable for external repos with no /srv/git/ mirror
  db.prepare(`INSERT INTO output_repo (github_owner_repo, bare_git_path, added_at, added_by)
              VALUES (?, ?, ?, ?)`)
    .run('jrtorrez31337/external', null, '2026-06-20T03:55:00Z', 'yaklog-dev-agent');
  const row = db.prepare(`SELECT * FROM output_repo WHERE github_owner_repo = ?`)
                .get('jrtorrez31337/external');
  assert.equal(row.bare_git_path, null);
  assert.equal(row.enabled, 1);
  assert.equal(row.added_by, 'yaklog-dev-agent');
});
