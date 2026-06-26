// CP14-X Per-agent identity canon Q5 amendment ratify (parch #10879):
// re-parse existing output_commit rows where attribution_method='null_fallback'
// using the post-1ab450f parser. Sister-shape walker re-derive behavior;
// NOT git-history rewriting (Q4 anti-pattern).
//
// Scope: only rows where attribution_method='null_fallback'. Operator-corrected
// rows (attribution_method='operator_override') and rows already attributed via
// other paths are NEVER touched.
//
// API:
//   reattributeNullFallback({ db, bareGitRoot, limit, dryRun }) → result
//
// Reads commit metadata (author_email + body) directly from bare-git using
// spawnSync — sister-shape outputWalker.BareGitWalker._gitLog.

'use strict';

const cp = require('child_process');
const path = require('path');
const config = require('./config');
const { parseAttribution } = require('./outputAttributionParser');

const FS_CHAR = '\x1f';
const RS_CHAR = '\x1e';
const COMMIT_FORMAT = ['%H', '%ae', '%ai', '%s', '%b'].join(FS_CHAR);

function _readSingleCommit(repoPath, sha) {
  const result = cp.spawnSync(
    'git',
    [`--git-dir=${repoPath}`, 'show', '-s', `--format=${COMMIT_FORMAT}${RS_CHAR}`, sha],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.status !== 0) return null;
  const rec = result.stdout.split(RS_CHAR)[0]?.trim();
  if (!rec) return null;
  const fields = rec.split(FS_CHAR);
  return {
    sha: fields[0],
    author_email: fields[1],
    occurred_at: fields[2],
    subject: fields[3],
    body: fields[4] || '',
  };
}

function _bareGitRoot() {
  return config.outputIngesterBareGitRoot || '/srv/git';
}

function reattributeNullFallback({ db, bareGitRoot, limit = 10000, dryRun = false } = {}) {
  if (!db) throw new Error('reattributeNullFallback: db required');
  const root = bareGitRoot || _bareGitRoot();

  const rows = db.prepare(
    `SELECT repo, commit_sha
       FROM output_commit
      WHERE attribution_method = 'null_fallback'
      LIMIT ?`
  ).all(limit);

  const updateStmt = db.prepare(
    `UPDATE output_commit
        SET agent_attribution = @agent_attribution,
            attribution_method = @attribution_method,
            runtime_class = @runtime_class
      WHERE repo = @repo AND commit_sha = @commit_sha`
  );

  let updated = 0;
  let unresolved = 0;
  let missingCommit = 0;
  const sample = [];

  for (const row of rows) {
    const repoPath = path.join(root, row.repo);
    const commit = _readSingleCommit(repoPath, row.commit_sha);
    if (!commit) {
      missingCommit++;
      continue;
    }
    const fullMsg = (commit.subject || '') + '\n\n' + (commit.body || '');
    const result = parseAttribution(fullMsg, null, commit.author_email);
    if (result.attribution_method === 'null_fallback' || !result.agent_attribution) {
      unresolved++;
      continue;
    }
    if (!dryRun) {
      updateStmt.run({
        repo: row.repo,
        commit_sha: row.commit_sha,
        agent_attribution: result.agent_attribution,
        attribution_method: result.attribution_method,
        runtime_class: result.runtime_class,
      });
    }
    updated++;
    if (sample.length < 5) {
      sample.push({
        repo: row.repo,
        commit_sha: row.commit_sha,
        author_email: commit.author_email,
        new_agent_attribution: result.agent_attribution,
        new_attribution_method: result.attribution_method,
      });
    }
  }

  return {
    scanned: rows.length,
    updated,
    unresolved,
    missing_commit: missingCommit,
    dry_run: !!dryRun,
    sample,
  };
}

module.exports = {
  reattributeNullFallback,
  _readSingleCommit,  // exported for test mock
};
