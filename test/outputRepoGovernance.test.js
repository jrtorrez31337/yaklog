// Task #277 Phase B / Task 4 — queryOutputRepoGovernance isolates
// governance-quality signals for standalone rendering + optional Prom
// textfile emit. Sister-shape queryOutputRepoSummary but focused
// exclusively on the governance panel per PLAN-OUTPUT-REFACTOR-COMMIT-
// HISTORY-B-REPO-FIRST.md §5.2.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-task277-b-repo-governance-'));
process.env.YAKLOG_DB_PATH = path.join(tempRoot, 'test.db');
process.env.YAKLOG_API_KEYS = 'tok-x';
process.env.YAKLOG_OPS_API_KEYS = 'ops-y';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const {
  closeDb, initializeDb, getDb,
  queryOutputRepoGovernance, upsertOutputRepo,
} = require('../src/db');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});

function seedRepo({ commits, signed, merges, prs, prsMerged, attrGaps }) {
  initializeDb();
  const db = getDb();
  db.prepare(`DELETE FROM output_commit`).run();
  db.prepare(`DELETE FROM output_pr`).run();
  db.prepare(`DELETE FROM output_repo`).run();
  upsertOutputRepo({ github_owner_repo: 'owner/geometry', added_by: 'jon' });

  const insCommit = db.prepare(`INSERT INTO output_commit
    (repo, commit_sha, author_name, author_email, committer_name, committer_email,
     occurred_at, branch, subject, body_digest, agent_attribution, attribution_method,
     files_changed, bytes_delta, signed, parent_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < commits; i += 1) {
    const attr = i < attrGaps ? null : 'agent-x';
    const method = i < attrGaps ? 'null_fallback' : 'body_signature';
    insCommit.run(
      'owner/geometry', `sha-${i}`, 'x', 'x@y', 'x', 'x@y',
      '2026-07-05T10:00:00Z', null, `subj-${i}`, null,
      attr, method, 1, 10,
      i < signed ? 1 : 0,
      i < merges ? 2 : 1,
    );
  }
  const insPr = db.prepare(`INSERT INTO output_pr
    (github_owner_repo, pr_number, state, title, author_login, author_email,
     base_ref, head_ref, opened_at, merged_at, closed_at, merge_commit_sha,
     commit_count, last_synced_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < prs; i += 1) {
    const merged = i < prsMerged;
    insPr.run(
      'owner/geometry', i + 1,
      merged ? 'merged' : 'open',
      `PR-${i}`, 'lo', null, 'main', 'feat',
      '2026-07-05T09:00:00Z',
      merged ? '2026-07-06T09:00:00Z' : null,
      merged ? '2026-07-06T09:00:00Z' : null,
      merged ? `msha-${i}` : null,
      3, '2026-07-06T10:00:00Z',
    );
  }
}

test('queryOutputRepoGovernance — demo-shape (55 commits, 0 signed, 0 merges, 0 PRs, 2 gaps)', () => {
  seedRepo({ commits: 55, signed: 0, merges: 0, prs: 0, prsMerged: 0, attrGaps: 2 });
  const r = queryOutputRepoGovernance({
    repo_key: 'owner/geometry', from: '2026-07-01', to: '2026-07-10',
  });
  assert.deepEqual(r.period, { from: '2026-07-01', to: '2026-07-10' });
  assert.equal(r.repo_key, 'owner/geometry');
  assert.equal(r.signals.signed_commits.count, 0);
  assert.equal(r.signals.signed_commits.total, 55);
  assert.equal(r.signals.signed_commits.pct, 0);
  assert.equal(r.signals.merge_commits.count, 0);
  assert.equal(r.signals.merge_commits.history_shape, 'linear');
  assert.equal(r.signals.pr_structure.pr_count, 0);
  assert.equal(r.signals.pr_structure.note, 'no PR-based workflow');
  assert.equal(r.signals.attribution.total_commits, 55);
  assert.equal(r.signals.attribution.gap_count, 2);
  assert.equal(r.signals.attribution.completeness_pct, 96);
});

test('queryOutputRepoGovernance — signed_pct + branchy history', () => {
  seedRepo({ commits: 100, signed: 10, merges: 5, prs: 4, prsMerged: 3, attrGaps: 0 });
  const r = queryOutputRepoGovernance({
    repo_key: 'owner/geometry', from: '2026-07-01', to: '2026-07-10',
  });
  assert.equal(r.signals.signed_commits.pct, 10);
  assert.equal(r.signals.merge_commits.count, 5);
  assert.equal(r.signals.merge_commits.history_shape, 'branchy');
  assert.equal(r.signals.pr_structure.pr_count, 4);
  assert.equal(r.signals.pr_structure.merged_pr_count, 3);
  assert.ok(r.signals.pr_structure.mean_commits_per_pr !== null);
});

test('queryOutputRepoGovernance — 0 commits in window returns zeroed shape with null completeness', () => {
  seedRepo({ commits: 0, signed: 0, merges: 0, prs: 0, prsMerged: 0, attrGaps: 0 });
  const r = queryOutputRepoGovernance({
    repo_key: 'owner/geometry', from: '2026-07-01', to: '2026-07-10',
  });
  assert.equal(r.signals.signed_commits.total, 0);
  assert.equal(r.signals.signed_commits.pct, 0);
  assert.equal(r.signals.merge_commits.history_shape, 'no-data');
  assert.equal(r.signals.attribution.completeness_pct, null);
  assert.equal(r.signals.pr_structure.note, 'no PR-based workflow');
});

test('queryOutputRepoGovernance — divide-by-zero safe when total=0', () => {
  seedRepo({ commits: 0, signed: 0, merges: 0, prs: 0, prsMerged: 0, attrGaps: 0 });
  const r = queryOutputRepoGovernance({
    repo_key: 'owner/geometry', from: '2026-07-01', to: '2026-07-10',
  });
  assert.ok(Number.isFinite(r.signals.signed_commits.pct));
  assert.ok(r.signals.attribution.completeness_pct === null || Number.isFinite(r.signals.attribution.completeness_pct));
});
