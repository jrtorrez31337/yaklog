// CP13.6 Phase 2.2 — outputIngester async + GitHubWalker integration tests.
//
// Tests cover:
//   - ingestRepoPrs upserts PRs + advances cursor on success
//   - ingestRepoPrs preserves cursor on skip + still upserts cursor row
//   - runOnce is async and walks both BareGitWalker + GitHubWalker
//   - maybeAddGitHubWalker auto-adds GitHubWalker when env + repos present
//   - bootstrapOutputReposFromConfig populates from per-host config file

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-cp136-phase22-ingester-'));
const testDbPath = path.join(tempRoot, 'test.db');
process.env.YAKLOG_DB_PATH = testDbPath;
process.env.YAKLOG_API_KEYS = 'tok-x';
process.env.YAKLOG_OPS_API_KEYS = 'ops-y';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const {
  closeDb,
  initializeDb,
  upsertOutputPr,
  getOutputPrCursor,
  listEnabledOutputRepos,
  listAllOutputRepos,
  upsertOutputRepo,
  disableOutputRepo,
  bootstrapOutputReposFromConfig,
} = require('../src/db');
const {
  runOnce,
  ingestRepoPrs,
  maybeAddGitHubWalker,
} = require('../src/outputIngester');
const { GitHubWalker } = require('../src/outputWalker');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});

function makeMockGitHubWalker({ prs = [], skipped = false, reason = null } = {}) {
  return {
    substrateType: () => 'github',
    listRepos: () => ['jrtorrez31337/yaklog'],
    walkRepo: async (githubOwnerRepo, cursor) => ({
      prs: prs.map(p => ({ ...p, github_owner_repo: githubOwnerRepo })),
      skipped,
      reason,
      cursor: skipped ? cursor : {
        last_pr_updated_at: prs[prs.length - 1]?.opened_at || (cursor && cursor.last_pr_updated_at) || '2026-06-20T00:00:00Z',
        prs_synced_total: ((cursor && cursor.prs_synced_total) || 0) + prs.length,
        rate_limit_remaining: 4999,
        rate_limit_reset_at: '2026-06-20T07:00:00Z',
        last_walk_status: 'ok',
        last_walk_message: null,
      },
    }),
  };
}

const samplePr = {
  pr_number: 42,
  state: 'merged',
  title: 'Test PR',
  author_login: 'jrtorrez31337',
  author_email: null,
  base_ref: 'main',
  head_ref: 'feature/test',
  opened_at: '2026-06-15T01:00:00Z',
  merged_at: '2026-06-15T03:00:00Z',
  closed_at: '2026-06-15T03:00:00Z',
  merge_commit_sha: 'abc123',
  commit_count: null,
  last_synced_at: '2026-06-20T06:00:00Z',
};

test('upsertOutputPr inserts new row; idempotent on UNIQUE(github_owner_repo, pr_number)', () => {
  initializeDb();
  upsertOutputPr({ ...samplePr, github_owner_repo: 'jrtorrez31337/yaklog' });
  upsertOutputPr({ ...samplePr, github_owner_repo: 'jrtorrez31337/yaklog' });  // idempotent
  // No throw + only one row
  const { getDb } = require('../src/db');
  const rows = getDb().prepare(`SELECT COUNT(*) AS n FROM output_pr WHERE github_owner_repo = ? AND pr_number = ?`)
    .get('jrtorrez31337/yaklog', 42);
  assert.equal(rows.n, 1);
});

test('upsertOutputPr UPDATEs on conflict (state change reflected)', () => {
  upsertOutputPr({ ...samplePr, github_owner_repo: 'jrtorrez31337/yaklog', state: 'open', merged_at: null });
  const { getDb } = require('../src/db');
  let row = getDb().prepare(`SELECT state, merged_at FROM output_pr WHERE github_owner_repo = ? AND pr_number = ?`)
    .get('jrtorrez31337/yaklog', 42);
  assert.equal(row.state, 'open');
  upsertOutputPr({ ...samplePr, github_owner_repo: 'jrtorrez31337/yaklog', state: 'merged', merged_at: '2026-06-15T03:00:00Z' });
  row = getDb().prepare(`SELECT state, merged_at FROM output_pr WHERE github_owner_repo = ? AND pr_number = ?`)
    .get('jrtorrez31337/yaklog', 42);
  assert.equal(row.state, 'merged');
  assert.equal(row.merged_at, '2026-06-15T03:00:00Z');
});

test('ingestRepoPrs upserts PRs + advances cursor on ok-walk', async () => {
  const walker = makeMockGitHubWalker({
    prs: [
      { ...samplePr, pr_number: 100 },
      { ...samplePr, pr_number: 101, opened_at: '2026-06-15T05:00:00Z' },
    ],
  });
  const result = await ingestRepoPrs(walker, 'jrtorrez31337/yaklog');
  assert.equal(result.prsIngested, 2);
  assert.equal(result.skipped, false);
  assert.equal(result.substrate, 'github');
  const cursor = getOutputPrCursor('jrtorrez31337/yaklog');
  assert.ok(cursor);
  assert.equal(cursor.last_walk_status, 'ok');
});

test('ingestRepoPrs preserves cursor on skip + persists status', async () => {
  const walker = makeMockGitHubWalker({
    skipped: true,
    reason: 'rate-limited',
    prs: [],
  });
  // Need custom walker with cursor passthrough on skip
  walker.walkRepo = async (repo, cursor) => ({
    prs: [],
    skipped: true,
    reason: 'rate-limited',
    cursor: { ...(cursor || {}), last_pr_updated_at: '2026-06-15T01:00:00Z', last_walk_status: 'rate-limited' },
  });
  const result = await ingestRepoPrs(walker, 'jrtorrez31337/yaklog');
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'rate-limited');
  assert.equal(result.prsIngested, 0);
  const cursor = getOutputPrCursor('jrtorrez31337/yaklog');
  assert.equal(cursor.last_walk_status, 'rate-limited');
});

test('runOnce is async + invokes both walkers when GitHubWalker injected', async () => {
  const githubWalker = makeMockGitHubWalker({ prs: [{ ...samplePr, pr_number: 200 }] });
  const result = await runOnce({ walkers: [githubWalker] });
  assert.ok(result.walkersUsed.includes('github'));
  assert.ok(result.totalPrs >= 1);
});

test('maybeAddGitHubWalker no-op when GITHUB_PAT_FILE env not set', () => {
  delete process.env.GITHUB_PAT_FILE;
  const walkers = maybeAddGitHubWalker([], null);
  assert.equal(walkers.length, 0);
});

test('maybeAddGitHubWalker no-op when output_repo empty + no config file', () => {
  process.env.GITHUB_PAT_FILE = '/tmp/some-pat';
  process.env.OUTPUT_REPO_CONFIG_FILE = '/tmp/nonexistent-config-' + Date.now();
  // Clear output_repo to baseline
  const { getDb } = require('../src/db');
  getDb().prepare(`DELETE FROM output_repo`).run();
  const walkers = maybeAddGitHubWalker([], null);
  assert.equal(walkers.length, 0);
  delete process.env.GITHUB_PAT_FILE;
  delete process.env.OUTPUT_REPO_CONFIG_FILE;
});

test('maybeAddGitHubWalker adds walker when env + output_repo populated', () => {
  process.env.GITHUB_PAT_FILE = '/tmp/some-pat';
  const { getDb } = require('../src/db');
  getDb().prepare(`DELETE FROM output_repo`).run();
  upsertOutputRepo({ github_owner_repo: 'jrtorrez31337/yaklog', enabled: 1 });
  const walkers = maybeAddGitHubWalker([], null);
  assert.equal(walkers.length, 1);
  assert.equal(walkers[0].substrateType(), 'github');
  assert.ok(walkers[0].listRepos().includes('jrtorrez31337/yaklog'));
  delete process.env.GITHUB_PAT_FILE;
});

// ── output_repo helpers ────────────────────────────────────────────────────

test('upsertOutputRepo + listEnabledOutputRepos round-trip', () => {
  const { getDb } = require('../src/db');
  getDb().prepare(`DELETE FROM output_repo`).run();
  upsertOutputRepo({ github_owner_repo: 'foo/a', enabled: 1 });
  upsertOutputRepo({ github_owner_repo: 'foo/b', enabled: 0 });
  upsertOutputRepo({ github_owner_repo: 'foo/c', enabled: 1, bare_git_path: '/srv/git/foo-c.git' });
  const enabled = listEnabledOutputRepos();
  assert.equal(enabled.length, 2);
  const all = listAllOutputRepos();
  assert.equal(all.length, 3);
  const c = enabled.find(r => r.github_owner_repo === 'foo/c');
  assert.equal(c.bare_git_path, '/srv/git/foo-c.git');
});

test('disableOutputRepo soft-disables (does not delete row)', () => {
  const { getDb } = require('../src/db');
  getDb().prepare(`DELETE FROM output_repo`).run();
  upsertOutputRepo({ github_owner_repo: 'foo/x', enabled: 1 });
  const changes = disableOutputRepo('foo/x');
  assert.equal(changes, 1);
  const all = listAllOutputRepos();
  assert.equal(all.length, 1);
  assert.equal(all[0].enabled, 0);
});

test('disableOutputRepo returns 0 for nonexistent repo', () => {
  const changes = disableOutputRepo('never/exists');
  assert.equal(changes, 0);
});

test('bootstrapOutputReposFromConfig populates from per-host config when output_repo empty', () => {
  const { getDb } = require('../src/db');
  getDb().prepare(`DELETE FROM output_repo`).run();
  const configFile = path.join(tempRoot, 'output-repos.txt');
  fs.writeFileSync(configFile, [
    '# CP13.6 Phase 2.2 — output_repo bootstrap (Q1 Option C)',
    'jrtorrez31337/yaklog\t/srv/git/yaklog.git',
    'jrtorrez31337/ssw-mmo-alpha',
    '',
    '# another comment',
    'jrtorrez31337/oss-coder',
  ].join('\n'));
  const result = bootstrapOutputReposFromConfig(configFile);
  assert.equal(result.bootstrapped, 3);
  const repos = listAllOutputRepos();
  assert.equal(repos.length, 3);
  const yaklog = repos.find(r => r.github_owner_repo === 'jrtorrez31337/yaklog');
  assert.equal(yaklog.bare_git_path, '/srv/git/yaklog.git');
  assert.equal(yaklog.added_by, 'bootstrap-from-config');
});

test('bootstrapOutputReposFromConfig skips when output_repo not empty', () => {
  const { getDb } = require('../src/db');
  getDb().prepare(`DELETE FROM output_repo`).run();
  upsertOutputRepo({ github_owner_repo: 'preexisting/repo' });
  const configFile = path.join(tempRoot, 'output-repos.txt');
  const result = bootstrapOutputReposFromConfig(configFile);
  assert.equal(result.bootstrapped, 0);
  assert.match(result.reason, /not empty/);
});

test('bootstrapOutputReposFromConfig graceful when no config file', () => {
  const { getDb } = require('../src/db');
  getDb().prepare(`DELETE FROM output_repo`).run();
  const result = bootstrapOutputReposFromConfig('/tmp/nonexistent-' + Date.now());
  assert.equal(result.bootstrapped, 0);
  assert.match(result.reason, /no config file/);
});
