// Task #277 Phase B / Tasks 5+6 — endpoint tests for
//   GET /api/v1/output/repo-summary
//   GET /api/v1/output/repo-governance
// Sister-shape existing outputApi tests. Route contract per PLAN-OUTPUT-
// REFACTOR-COMMIT-HISTORY-B-REPO-FIRST.md §5.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-task277-b-api-repo-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-a';
process.env.YAKLOG_OPS_API_KEYS = 'ops-a';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const {
  closeDb, initializeDb, getDb, upsertOutputRepo, upsertOutputRepoMeta,
} = require('../src/db');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

test.before(() => {
  initializeDb();
  const db = getDb();
  upsertOutputRepo({ github_owner_repo: 'owner/geometry', added_by: 'jon' });
  upsertOutputRepoMeta('owner/geometry', {
    github_repo_created_at: '2026-06-01T00:00:00Z',
    github_default_branch: 'main',
    github_size_kb: 512,
    github_primary_language: 'Python',
    github_visibility: 'public',
    github_repo_updated_at: '2026-07-05T00:00:00Z',
    github_repo_pushed_at: '2026-07-05T00:00:00Z',
  });
  const ins = db.prepare(`INSERT INTO output_commit
    (repo, commit_sha, author_name, author_email, committer_name, committer_email,
     occurred_at, branch, subject, body_digest, agent_attribution, attribution_method,
     files_changed, bytes_delta, signed, parent_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < 10; i += 1) {
    ins.run('owner/geometry', `sha-${i}`, 'x', 'x@y', 'x', 'x@y',
      '2026-07-05T10:00:00Z', null, `subj-${i}`, null,
      'agent-x', 'body_signature', 1, 10, i < 3 ? 1 : 0, 1);
  }
});

// ─────────────────────────────────────────────────────────────────
// /output/repo-summary
// ─────────────────────────────────────────────────────────────────

test('GET /output/repo-summary returns 200 with valid ?repo + ?range', async () => {
  const r = await request(app).get('/api/v1/output/repo-summary')
    .query({ repo: 'owner/geometry', range: '30d' });
  assert.equal(r.status, 200);
  assert.equal(r.body.repo.github_owner_repo, 'owner/geometry');
  assert.equal(r.body.counts.commits, 10);
  assert.equal(r.body.governance.signed_pct, 30);
  assert.ok(r.body._metadata);
  assert.equal(r.body._metadata.computed_empty_period, false);
});

test('GET /output/repo-summary returns 400 on missing ?repo', async () => {
  const r = await request(app).get('/api/v1/output/repo-summary').query({ range: '30d' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'ValidationError');
});

test('GET /output/repo-summary returns 400 on malformed ?repo', async () => {
  const r = await request(app).get('/api/v1/output/repo-summary')
    .query({ repo: "owner'; DROP TABLE output_commit; --", range: '30d' });
  assert.equal(r.status, 400);
});

test('GET /output/repo-summary returns 404 on unknown repo', async () => {
  const r = await request(app).get('/api/v1/output/repo-summary')
    .query({ repo: 'owner/nonexistent', range: '30d' });
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'RepoNotFound');
});

test('GET /output/repo-summary accepts ?from&to time-nav shape', async () => {
  const r = await request(app).get('/api/v1/output/repo-summary')
    .query({ repo: 'owner/geometry', from: '2026-07-01', to: '2026-07-10' });
  assert.equal(r.status, 200);
  assert.equal(r.body.counts.commits, 10);
});

test('GET /output/repo-summary _metadata.computed_empty_period=true when repo has 0 commits in window', async () => {
  const r = await request(app).get('/api/v1/output/repo-summary')
    .query({ repo: 'owner/geometry', from: '2025-01-01', to: '2025-01-31' });
  assert.equal(r.status, 200);
  assert.equal(r.body.counts.commits, 0);
  assert.equal(r.body._metadata.computed_empty_period, true);
});

// ─────────────────────────────────────────────────────────────────
// /output/repo-governance
// ─────────────────────────────────────────────────────────────────

test('GET /output/repo-governance returns 200 with signals shape', async () => {
  const r = await request(app).get('/api/v1/output/repo-governance')
    .query({ repo: 'owner/geometry', range: '30d' });
  assert.equal(r.status, 200);
  assert.equal(r.body.repo_key, 'owner/geometry');
  assert.equal(r.body.signals.signed_commits.total, 10);
  assert.equal(r.body.signals.signed_commits.pct, 30);
  assert.equal(r.body.signals.merge_commits.history_shape, 'linear');
  assert.equal(r.body.signals.pr_structure.note, 'no PR-based workflow');
  assert.ok(r.body._metadata);
});

test('GET /output/repo-governance returns 400 on missing ?repo', async () => {
  const r = await request(app).get('/api/v1/output/repo-governance').query({ range: '30d' });
  assert.equal(r.status, 400);
});

test('GET /output/repo-governance returns 400 on malformed ?repo', async () => {
  const r = await request(app).get('/api/v1/output/repo-governance')
    .query({ repo: 'not a valid repo key', range: '30d' });
  assert.equal(r.status, 400);
});

test('GET /output/repo-governance returns 200 for unknown repo (zeroed signals + note)', async () => {
  const r = await request(app).get('/api/v1/output/repo-governance')
    .query({ repo: 'owner/nonexistent', range: '30d' });
  assert.equal(r.status, 200);
  assert.equal(r.body.signals.signed_commits.total, 0);
  assert.equal(r.body.signals.merge_commits.history_shape, 'no-data');
  assert.equal(r.body._metadata.computed_empty_period, true);
});
