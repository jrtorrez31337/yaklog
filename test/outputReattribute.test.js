// CP14-X Q5 amendment ratify (parch #10879) — re-parse existing
// null_fallback rows with post-1ab450f parser. Tests cover:
//   - dry-run mode (no writes)
//   - happy-path UPDATE on null_fallback rows when new parser yields agent
//   - operator_override rows NEVER touched
//   - rows where parser STILL yields null_fallback NOT updated

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-output-reattribute-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'test-key';
process.env.NODE_ENV = 'test';

const dbModule = require('../src/db');
const { reattributeNullFallback } = require('../src/outputReattribute');
const closeDb = dbModule.closeDb;
function getDb() { return dbModule.initializeDb ? dbModule.initializeDb() : dbModule.getDb(); }

// Seed a tiny bare-git repo with 2 commits authored as different identities.
const bareGitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-bare-'));
const repoName = 'test-fixture.git';
const bareRepoPath = path.join(bareGitRoot, repoName);

function gitBare(args, cwd) {
  const r = cp.spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

let canonSha = null;
let nonCanonSha = null;

test.before(() => {
  // Build a working-tree repo, commit, then convert to bare-clone
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-bare-src-'));
  gitBare(['init', '-q', '-b', 'main'], workDir);
  gitBare(['config', 'user.name', 'canon-test-agent'], workDir);
  gitBare(['config', 'user.email', 'canon-test-agent@internal.subnet345.com'], workDir);
  fs.writeFileSync(path.join(workDir, 'a.txt'), 'A');
  gitBare(['add', 'a.txt'], workDir);
  gitBare(['commit', '-q', '-m', 'canon commit'], workDir);
  canonSha = gitBare(['rev-parse', 'HEAD'], workDir);

  gitBare(['config', 'user.name', 'Random Human'], workDir);
  gitBare(['config', 'user.email', 'random@example.com'], workDir);
  fs.writeFileSync(path.join(workDir, 'b.txt'), 'B');
  gitBare(['add', 'b.txt'], workDir);
  gitBare(['commit', '-q', '-m', 'non-canon commit'], workDir);
  nonCanonSha = gitBare(['rev-parse', 'HEAD'], workDir);

  cp.spawnSync('git', ['clone', '-q', '--bare', workDir, bareRepoPath]);
  fs.rmSync(workDir, { recursive: true, force: true });
});

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(bareGitRoot, { recursive: true, force: true }); } catch {}
});

function seedOutputCommit(row) {
  getDb().prepare(`
    INSERT INTO output_commit
      (repo, commit_sha, author_name, author_email, committer_name, committer_email,
       occurred_at, subject, agent_attribution, attribution_method, runtime_class)
    VALUES (@repo, @commit_sha, @author_name, @author_email, @committer_name, @committer_email,
            @occurred_at, @subject, @agent_attribution, @attribution_method, @runtime_class)
  `).run({
    repo: row.repo,
    commit_sha: row.commit_sha,
    author_name: row.author_name || 'unknown',
    author_email: row.author_email || 'unknown@local',
    committer_name: row.committer_name || 'unknown',
    committer_email: row.committer_email || 'unknown@local',
    occurred_at: row.occurred_at || new Date().toISOString(),
    subject: row.subject || '',
    agent_attribution: row.agent_attribution ?? null,
    attribution_method: row.attribution_method || 'null_fallback',
    runtime_class: row.runtime_class ?? null,
  });
}

test('reattributeNullFallback: canonical-email row gets author_email_direct update', () => {
  seedOutputCommit({ repo: repoName, commit_sha: canonSha, attribution_method: 'null_fallback' });
  seedOutputCommit({ repo: repoName, commit_sha: nonCanonSha, attribution_method: 'null_fallback' });

  const result = reattributeNullFallback({ db: getDb(), bareGitRoot });

  assert.equal(result.scanned, 2);
  assert.equal(result.updated, 1, 'only canon commit re-attributes');
  assert.equal(result.unresolved, 1, 'non-canon stays unresolved');
  assert.equal(result.sample[0].new_agent_attribution, 'canon-test-agent');
  assert.equal(result.sample[0].new_attribution_method, 'author_email_direct');

  const canonRow = getDb().prepare('SELECT * FROM output_commit WHERE commit_sha = ?').get(canonSha);
  assert.equal(canonRow.agent_attribution, 'canon-test-agent');
  assert.equal(canonRow.attribution_method, 'author_email_direct');
  const nonCanonRow = getDb().prepare('SELECT * FROM output_commit WHERE commit_sha = ?').get(nonCanonSha);
  assert.equal(nonCanonRow.attribution_method, 'null_fallback', 'non-canon unchanged');
});

test('reattributeNullFallback: dry_run mode skips writes', () => {
  // Revert canon row to null_fallback
  getDb().prepare(`UPDATE output_commit SET agent_attribution = NULL, attribution_method = 'null_fallback' WHERE commit_sha = ?`).run(canonSha);
  const result = reattributeNullFallback({ db: getDb(), bareGitRoot, dryRun: true });

  assert.equal(result.updated, 1, 'reports 1 would-update');
  assert.equal(result.dry_run, true);

  const canonRow = getDb().prepare('SELECT * FROM output_commit WHERE commit_sha = ?').get(canonSha);
  assert.equal(canonRow.attribution_method, 'null_fallback', 'dry_run did not write');
});

test('reattributeNullFallback: operator_override rows are NEVER scanned', () => {
  // Seed an operator-corrected row for the canon commit
  getDb().prepare(`UPDATE output_commit SET attribution_method = 'operator_override', agent_attribution = 'manually-set' WHERE commit_sha = ?`).run(canonSha);
  const result = reattributeNullFallback({ db: getDb(), bareGitRoot });

  assert.equal(result.scanned, 1, 'only the still-null-fallback non-canon row in scope');
  const canonRow = getDb().prepare('SELECT * FROM output_commit WHERE commit_sha = ?').get(canonSha);
  assert.equal(canonRow.agent_attribution, 'manually-set', 'operator override preserved');
  assert.equal(canonRow.attribution_method, 'operator_override');
});

test('reattributeNullFallback: missing commit in bare-git is counted not thrown', () => {
  // Reset operator_override back to null_fallback so it's scanned
  getDb().prepare(`UPDATE output_commit SET attribution_method = 'null_fallback', agent_attribution = NULL WHERE commit_sha = ?`).run(canonSha);
  seedOutputCommit({
    repo: repoName,
    commit_sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    attribution_method: 'null_fallback',
  });
  const result = reattributeNullFallback({ db: getDb(), bareGitRoot });

  assert.ok(result.missing_commit >= 1, 'missing-commit counted');
  assert.equal(result.scanned, 3, 'scanned includes missing');
});
