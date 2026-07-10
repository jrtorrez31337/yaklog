// Task #277 Phase B / Task 3 — queryOutputRepoSummary aggregates repo-scoped
// counts + governance signals in one call. Backs the #output tab repo-context
// strip (drill-in state) per PLAN-OUTPUT-REFACTOR-COMMIT-HISTORY-B §5.1.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-task277-b-repo-summary-'));
process.env.YAKLOG_DB_PATH = path.join(tempRoot, 'test.db');
process.env.YAKLOG_API_KEYS = 'tok-x';
process.env.YAKLOG_OPS_API_KEYS = 'ops-y';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const {
  closeDb, initializeDb, getDb,
  queryOutputRepoSummary, upsertOutputRepo, upsertOutputRepoMeta,
} = require('../src/db');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});

function seed({ commits, signed, merges, prs, prsMerged, attrGaps, addRepoRow = true }) {
  initializeDb();
  const db = getDb();
  db.prepare(`DELETE FROM output_commit`).run();
  db.prepare(`DELETE FROM output_pr`).run();
  db.prepare(`DELETE FROM output_merge`).run();
  db.prepare(`DELETE FROM output_repo`).run();

  if (addRepoRow) {
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
  }

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
      1, '2026-07-06T10:00:00Z',
    );
  }
  const insMerge = db.prepare(`INSERT INTO output_merge
    (repo, merge_commit_sha, source_branch, target_branch, pr_number,
     occurred_at, merged_by_agent, attribution_method,
     parent_commit_count, child_commit_count, bytes_delta)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < merges; i += 1) {
    insMerge.run('owner/geometry', `msha-x-${i}`, 'feat', 'main', null,
      '2026-07-05T10:00:00Z', 'agent-x', 'body_signature', 2, 3, 100);
  }
}

test('queryOutputRepoSummary — happy path returns full response shape', () => {
  seed({ commits: 5, signed: 3, merges: 0, prs: 1, prsMerged: 1, attrGaps: 0 });
  const r = queryOutputRepoSummary({
    repo_key: 'owner/geometry', from: '2026-07-01', to: '2026-07-10',
  });
  assert.deepEqual(r.period, { from: '2026-07-01', to: '2026-07-10' });
  assert.equal(r.repo.github_owner_repo, 'owner/geometry');
  assert.equal(r.repo.github_default_branch, 'main');
  assert.equal(r.repo.github_primary_language, 'Python');
  assert.equal(r.counts.commits, 5);
  assert.equal(r.counts.prs, 1);
  assert.equal(r.counts.agents_engaged, 1);
  assert.equal(r.counts.attribution_gaps, 0);
  assert.equal(r.governance.signed_commits, 3);
  assert.equal(r.governance.signed_pct, 60);
  assert.equal(r.governance.merge_commit_count, 0);
  assert.equal(r.governance.history_shape, 'linear');
  assert.equal(r.governance.attribution_completeness_pct, 100);
});

test('queryOutputRepoSummary — repo not in allowlist returns null', () => {
  seed({ commits: 5, signed: 0, merges: 0, prs: 0, prsMerged: 0, attrGaps: 0, addRepoRow: false });
  const r = queryOutputRepoSummary({
    repo_key: 'owner/unknown', from: '2026-07-01', to: '2026-07-10',
  });
  assert.equal(r, null);
});

test('queryOutputRepoSummary — repo with 0 commits in window returns zeroed counts + no-data governance', () => {
  seed({ commits: 0, signed: 0, merges: 0, prs: 0, prsMerged: 0, attrGaps: 0 });
  const r = queryOutputRepoSummary({
    repo_key: 'owner/geometry', from: '2026-07-01', to: '2026-07-10',
  });
  assert.ok(r);
  assert.equal(r.counts.commits, 0);
  assert.equal(r.governance.signed_pct, 0);
  assert.equal(r.governance.history_shape, 'no-data');
  assert.equal(r.governance.attribution_completeness_pct, null);
});

test('queryOutputRepoSummary — merge commits flip history_shape to branchy', () => {
  seed({ commits: 10, signed: 0, merges: 2, prs: 0, prsMerged: 0, attrGaps: 0 });
  const r = queryOutputRepoSummary({
    repo_key: 'owner/geometry', from: '2026-07-01', to: '2026-07-10',
  });
  assert.equal(r.governance.merge_commit_count, 2);
  assert.equal(r.governance.history_shape, 'branchy');
});

test('queryOutputRepoSummary — attribution_completeness reflects null_fallback ratio', () => {
  seed({ commits: 100, signed: 0, merges: 0, prs: 0, prsMerged: 0, attrGaps: 3 });
  const r = queryOutputRepoSummary({
    repo_key: 'owner/geometry', from: '2026-07-01', to: '2026-07-10',
  });
  assert.equal(r.counts.attribution_gaps, 3);
  assert.equal(r.governance.attribution_completeness_pct, 97);
});
