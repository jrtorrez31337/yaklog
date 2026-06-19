// CP13.2 / ADR-0032 Output-strand walkers tests.
//
// BareGitWalker tested against an actual bare-git substrate built in a
// tempdir (real git commands via spawnSync, no shell). GitHubWalker
// tested as a stub for shape conformance.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const {
  OutputWalker,
  BareGitWalker,
  GitHubWalker,
} = require('../src/outputWalker');

// ── test fixture: build a real bare-git substrate with known commits ──────

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-cp132-walker-'));

function runGit(workdir, args) {
  return cp.spawnSync('git', args, {
    cwd: workdir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Jon Torrez',
      GIT_AUTHOR_EMAIL: 'gmail@jontorrez.com',
      GIT_COMMITTER_NAME: 'Jon Torrez',
      GIT_COMMITTER_EMAIL: 'gmail@jontorrez.com',
      GIT_AUTHOR_DATE: '2026-06-01T10:00:00Z',
      GIT_COMMITTER_DATE: '2026-06-01T10:00:00Z',
    },
  });
}

function buildFixture() {
  // Make a working repo with 2 normal commits + 1 merge commit, then
  // mirror to a bare-git repo in tempRoot.
  const workRepo = path.join(tempRoot, 'work');
  fs.mkdirSync(workRepo);
  runGit(workRepo, ['init', '-q', '-b', 'main']);

  // Commit 1: plain commit
  fs.writeFileSync(path.join(workRepo, 'a.txt'), 'first');
  runGit(workRepo, ['add', 'a.txt']);
  runGit(workRepo, ['commit', '-q', '-m', 'first commit\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>']);

  // Commit 2: feature branch + commit there
  runGit(workRepo, ['checkout', '-q', '-b', 'feature']);
  fs.writeFileSync(path.join(workRepo, 'b.txt'), 'second\nline\n');
  runGit(workRepo, ['add', 'b.txt']);
  runGit(workRepo, ['commit', '-q', '-m', 'second commit\n\nAuthored-By: parch']);

  // Merge feature into main (true merge with --no-ff)
  runGit(workRepo, ['checkout', '-q', 'main']);
  runGit(workRepo, ['merge', '-q', '--no-ff', '-m', 'merge feature into main', 'feature']);

  // Mirror to bare repo
  const bareRepo = path.join(tempRoot, 'fixture.git');
  cp.spawnSync('git', ['clone', '-q', '--bare', workRepo, bareRepo]);

  return { workRepo, bareRepo };
}

const fixture = buildFixture();

test.after(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});

// ── interface conformance ─────────────────────────────────────────────────

test('OutputWalker abstract methods throw if not overridden', () => {
  const w = new OutputWalker();
  assert.throws(() => w.listRepos(), /subclass must implement/);
  assert.throws(() => w.walkRepo(), /subclass must implement/);
  assert.throws(() => w.substrateType(), /subclass must implement/);
});

// ── BareGitWalker ─────────────────────────────────────────────────────────

test('BareGitWalker.substrateType returns bare-git', () => {
  const w = new BareGitWalker({ root: tempRoot });
  assert.equal(w.substrateType(), 'bare-git');
});

test('BareGitWalker.listRepos discovers *.git dirs', () => {
  const w = new BareGitWalker({ root: tempRoot });
  const repos = w.listRepos();
  assert.deepEqual(repos, ['fixture.git']);
});

test('BareGitWalker.listRepos returns empty when root is unreadable', () => {
  const w = new BareGitWalker({ root: '/nonexistent/path' });
  assert.deepEqual(w.listRepos(), []);
});

test('BareGitWalker.listRepos honors explicit repo list', () => {
  const w = new BareGitWalker({ root: tempRoot, repos: ['explicit.git'] });
  assert.deepEqual(w.listRepos(), ['explicit.git']);
});

test('BareGitWalker.walkRepo emits commit + merge rows on full walk', () => {
  const w = new BareGitWalker({ root: tempRoot });
  const result = w.walkRepo('fixture.git', null);
  // 2 normal commits + 1 merge = 3 commit rows; 1 merge row
  assert.equal(result.commits.length, 3);
  assert.equal(result.merges.length, 1);
  assert.ok(result.newRef && result.newRef.match(/^[0-9a-f]{40}$/),
    'newRef should be a sha');

  // Verify commit row structure
  for (const c of result.commits) {
    assert.equal(c.repo, 'fixture.git');
    assert.ok(c.commit_sha.match(/^[0-9a-f]{40}$/));
    assert.equal(c.author_name, 'Jon Torrez');
    assert.ok(c.subject);
    assert.ok(typeof c.files_changed === 'number');
    assert.ok(typeof c.bytes_delta === 'number');
    assert.equal(c.agent_attribution, null, 'walker leaves attribution null; ingester fills');
  }

  // Verify merge row structure
  const merge = result.merges[0];
  assert.equal(merge.repo, 'fixture.git');
  assert.equal(merge.target_branch, 'main');
  assert.equal(merge.pr_number, null, 'bare-git has no pr_number');
  assert.equal(merge.parent_commit_count, 2, 'true merge has 2 parents');
});

test('BareGitWalker.walkRepo incremental walk returns empty when at HEAD', () => {
  const w = new BareGitWalker({ root: tempRoot });
  const full = w.walkRepo('fixture.git', null);
  // Now walk again from full.newRef → HEAD; should be empty
  const incremental = w.walkRepo('fixture.git', full.newRef);
  assert.equal(incremental.commits.length, 0);
  assert.equal(incremental.merges.length, 0);
  // newRef should still be the head sha
  assert.equal(incremental.newRef, full.newRef);
});

test('BareGitWalker.walkRepo on missing repo returns empty + preserves lastRef', () => {
  const w = new BareGitWalker({ root: tempRoot });
  const result = w.walkRepo('does-not-exist.git', 'abc123');
  assert.equal(result.commits.length, 0);
  assert.equal(result.merges.length, 0);
  assert.equal(result.newRef, 'abc123');
});

test('BareGitWalker exposes commit body for ingester attribution-parsing', () => {
  const w = new BareGitWalker({ root: tempRoot });
  const { commits } = w.walkRepo('fixture.git', null);
  // First commit has Co-Authored-By trailer
  const first = commits.find((c) => c.subject === 'first commit');
  assert.ok(first._full_message.includes('Co-Authored-By: Claude'),
    'commit row should expose body for parser via _full_message');
  // Second commit has Authored-By body pattern
  const second = commits.find((c) => c.subject === 'second commit');
  assert.ok(second._full_message.includes('Authored-By: parch'));
});

test('BareGitWalker computes body_digest as sha256 hex when body present', () => {
  const w = new BareGitWalker({ root: tempRoot });
  const { commits } = w.walkRepo('fixture.git', null);
  const withBody = commits.filter((c) => c._body);
  assert.ok(withBody.length > 0);
  for (const c of withBody) {
    assert.ok(c.body_digest.match(/^[0-9a-f]{64}$/),
      'body_digest should be 64-char sha256 hex');
  }
});

// ── GitHubWalker (Phase 2 stub) ───────────────────────────────────────────

test('GitHubWalker.substrateType returns github', () => {
  const w = new GitHubWalker();
  assert.equal(w.substrateType(), 'github');
});

test('GitHubWalker.listRepos returns configured allowlist', () => {
  const w = new GitHubWalker({ repos: ['jrtorrez31337/ssw-mmo-alpha'] });
  assert.deepEqual(w.listRepos(), ['jrtorrez31337/ssw-mmo-alpha']);
});

test('GitHubWalker.walkRepo Phase-2-stub returns empty walk + preserves lastRef', () => {
  const w = new GitHubWalker({ repos: ['owner/repo'] });
  const result = w.walkRepo('owner/repo', 'sha123');
  assert.equal(result.commits.length, 0);
  assert.equal(result.merges.length, 0);
  assert.equal(result.newRef, 'sha123');
});

test('GitHubWalker.listRepos defaults to empty when no allowlist', () => {
  const w = new GitHubWalker();
  assert.deepEqual(w.listRepos(), []);
});
