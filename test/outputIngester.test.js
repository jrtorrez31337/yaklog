// CP13.2 / ADR-0032 Output-strand ingester end-to-end tests.
//
// Runs the ingester against a real BareGitWalker pointed at a tempdir
// bare-git fixture, asserts the full pipeline: walker → parser → DB.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-cp132-ingester-'));
const testDbPath = path.join(tempRoot, 'test.db');
process.env.YAKLOG_DB_PATH = testDbPath;
process.env.YAKLOG_API_KEYS = 'tok-x';
process.env.YAKLOG_OPS_API_KEYS = 'ops-y';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const { closeDb, initializeDb } = require('../src/db');
const { runOnce, loadKnownAgentIds } = require('../src/outputIngester');
const { BareGitWalker } = require('../src/outputWalker');

// ── build bare-git fixture with attributed commits ────────────────────────

function runGit(workdir, args, msg = null) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Jon Torrez',
    GIT_AUTHOR_EMAIL: 'gmail@jontorrez.com',
    GIT_COMMITTER_NAME: 'Jon Torrez',
    GIT_COMMITTER_EMAIL: 'gmail@jontorrez.com',
    GIT_AUTHOR_DATE: '2026-06-01T10:00:00Z',
    GIT_COMMITTER_DATE: '2026-06-01T10:00:00Z',
  };
  return cp.spawnSync('git', args, { cwd: workdir, encoding: 'utf8', env });
}

function buildFixture() {
  const repoRoot = path.join(tempRoot, 'repos');
  fs.mkdirSync(repoRoot);
  const workRepo = path.join(repoRoot, 'work');
  fs.mkdirSync(workRepo);
  runGit(workRepo, ['init', '-q', '-b', 'main']);

  // Commit A: with Co-Authored-By trailer → attribution = claude-code
  fs.writeFileSync(path.join(workRepo, 'a.txt'), 'A');
  runGit(workRepo, ['add', 'a.txt']);
  runGit(workRepo, ['commit', '-q', '-m', 'feature A\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>']);

  // Commit B: with Authored-By body pattern → attribution = parch-agent
  fs.writeFileSync(path.join(workRepo, 'b.txt'), 'B');
  runGit(workRepo, ['add', 'b.txt']);
  runGit(workRepo, ['commit', '-q', '-m', 'feature B\n\nAuthored-By: parch']);

  // Commit C: no attribution markers → null_fallback
  fs.writeFileSync(path.join(workRepo, 'c.txt'), 'C');
  runGit(workRepo, ['add', 'c.txt']);
  runGit(workRepo, ['commit', '-q', '-m', 'feature C']);

  // Make a merge commit
  runGit(workRepo, ['checkout', '-q', '-b', 'feat']);
  fs.writeFileSync(path.join(workRepo, 'd.txt'), 'D');
  runGit(workRepo, ['add', 'd.txt']);
  runGit(workRepo, ['commit', '-q', '-m', 'feature D\n\nCo-Authored-By: Codex <noreply@openai.com>']);
  runGit(workRepo, ['checkout', '-q', 'main']);
  runGit(workRepo, ['merge', '-q', '--no-ff', '-m', 'merge feat\n\nAuthored-By: yaklog-dev-agent', 'feat']);

  // Mirror to bare-git
  const bareRepo = path.join(repoRoot, 'fixture.git');
  cp.spawnSync('git', ['clone', '-q', '--bare', workRepo, bareRepo]);

  return repoRoot;
}

const repoRoot = buildFixture();

// Seed presence so loadKnownAgentIds returns the parch-agent / yaklog-dev-agent
// IDs that the attribution parser looks up.
test.before(() => {
  const db = initializeDb();
  const now = new Date().toISOString();
  const insertPresence = db.prepare(`INSERT OR IGNORE INTO presence (
    agent_id, daemon_state, session_state, last_heartbeat_at, last_state_change_at
  ) VALUES (?, 'up', 'idle', ?, ?)`);
  insertPresence.run('parch-agent', now, now);
  insertPresence.run('yaklog-dev-agent', now, now);
});

test.after(() => {
  closeDb();
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});

// ── end-to-end run ────────────────────────────────────────────────────────

test('runOnce ingests commits + merges + populates cursor', async () => {
  const walker = new BareGitWalker({ root: repoRoot });
  const result = await runOnce({ walkers: [walker], db: initializeDb() });
  // Fixture: 3 plain + 1 feat + 1 merge = 5 commit rows; 1 merge row
  assert.equal(result.totalCommits, 5);
  assert.equal(result.totalMerges, 1);
  assert.ok(result.totalAttributionGaps >= 1, 'commit C should null-fallback');
  assert.deepEqual(result.walkersUsed, ['bare-git']);
  assert.ok(result.perRepo['fixture.git']);
});

test('runOnce attribution parsing populates output_commit columns correctly', () => {
  const db = initializeDb();
  // Commit A: Co-Authored-By Claude → runtime_class=claude-code
  const claudeRow = db.prepare(`SELECT agent_attribution, attribution_method, runtime_class FROM output_commit WHERE subject = 'feature A'`).get();
  assert.equal(claudeRow.attribution_method, 'co_authored_by');
  assert.equal(claudeRow.runtime_class, 'claude-code');

  // Commit B: Authored-By parch (resolves via registry to parch-agent)
  const parchRow = db.prepare(`SELECT agent_attribution, attribution_method, runtime_class FROM output_commit WHERE subject = 'feature B'`).get();
  assert.equal(parchRow.attribution_method, 'body_pattern');
  assert.equal(parchRow.agent_attribution, 'parch-agent');

  // Commit C: null_fallback
  const noAttrib = db.prepare(`SELECT agent_attribution, attribution_method FROM output_commit WHERE subject = 'feature C'`).get();
  assert.equal(noAttrib.agent_attribution, null);
  assert.equal(noAttrib.attribution_method, 'null_fallback');
});

test('runOnce is idempotent — re-run inserts nothing new', async () => {
  const walker = new BareGitWalker({ root: repoRoot });
  const second = await runOnce({ walkers: [walker], db: initializeDb() });
  assert.equal(second.totalCommits, 0, 're-run should ingest 0 commits (UNIQUE constraint)');
  assert.equal(second.totalMerges, 0);
});

test('runOnce updates output_ingester_cursor with newRef + ingester counters', () => {
  const db = initializeDb();
  const cursor = db.prepare(`SELECT * FROM output_ingester_cursor WHERE repo = ?`).get('fixture.git');
  assert.ok(cursor, 'cursor row should exist post-runOnce');
  assert.ok(cursor.last_ref && cursor.last_ref.match(/^[0-9a-f]{40}$/), 'last_ref should be sha');
  assert.ok(cursor.last_walked_at);
  assert.ok(cursor.commits_ingested >= 5);
  assert.ok(cursor.attribution_gap_count >= 1);
});

test('runOnce merge row populated with merged_by_agent from body-pattern', () => {
  const db = initializeDb();
  const merge = db.prepare(`SELECT merged_by_agent, attribution_method FROM output_merge LIMIT 1`).get();
  assert.equal(merge.merged_by_agent, 'yaklog-dev-agent',
    'merge body has "Authored-By: yaklog-dev-agent" → resolves via registry');
  assert.equal(merge.attribution_method, 'body_pattern');
});

test('runOnce composite walker list (BareGit + GitHub stub) runs both substrates', async () => {
  const { GitHubWalker } = require('../src/outputWalker');
  // Use empty walkers (both no-op) to assert composite shape works
  const composite = await runOnce({
    walkers: [
      new BareGitWalker({ root: '/nonexistent' }),
      new GitHubWalker({ repos: [] }),
    ],
    db: initializeDb(),
  });
  assert.deepEqual(composite.walkersUsed, ['bare-git', 'github']);
  assert.equal(composite.totalCommits, 0);
  assert.equal(composite.totalMerges, 0);
});

test('loadKnownAgentIds returns presence agent_id registry', () => {
  const ids = loadKnownAgentIds(initializeDb());
  assert.ok(ids instanceof Set);
  assert.ok(ids.has('parch-agent'));
  assert.ok(ids.has('yaklog-dev-agent'));
});
