// CP13.2 / ADR-0032 Output-strand ingester
//
// Orchestrates the walker(s) + DB writes + cursor state + attribution
// parsing. One ingester run = walk all repos for all configured walkers,
// insert new output_commit/output_merge rows, update
// output_ingester_cursor. Idempotent via UNIQUE constraints on schema.
//
// Per ADR-0032 Phase 1.2: ingester is cron-driven (hourly tick via
// yaklog-output-ingester.timer in Phase 1.2 systemd unit). This module
// exposes the runOnce() entry point that the cron driver invokes.

'use strict';

const { parseAttribution } = require('./outputAttributionParser');
const { BareGitWalker, GitHubWalker } = require('./outputWalker');
const dbModule = require('./db');

// ── insert prepared statements (cached per-call to runOnce) ───────────────

function prepareStatements(db) {
  return {
    insertCommit: db.prepare(`
      INSERT INTO output_commit (
        repo, commit_sha, author_name, author_email,
        committer_name, committer_email, occurred_at, branch, subject,
        body_digest, agent_attribution, attribution_method,
        runtime_class, files_changed, bytes_delta,
        signed, parent_count
      ) VALUES (
        @repo, @commit_sha, @author_name, @author_email,
        @committer_name, @committer_email, @occurred_at, @branch, @subject,
        @body_digest, @agent_attribution, @attribution_method,
        @runtime_class, @files_changed, @bytes_delta,
        @signed, @parent_count
      )
      ON CONFLICT(repo, commit_sha) DO NOTHING
    `),
    insertMerge: db.prepare(`
      INSERT INTO output_merge (
        repo, merge_commit_sha, source_branch, target_branch, pr_number,
        occurred_at, merged_by_agent, attribution_method,
        parent_commit_count, child_commit_count, bytes_delta
      ) VALUES (
        @repo, @merge_commit_sha, @source_branch, @target_branch, @pr_number,
        @occurred_at, @merged_by_agent, @attribution_method,
        @parent_commit_count, @child_commit_count, @bytes_delta
      )
      ON CONFLICT(repo, merge_commit_sha) DO NOTHING
    `),
    upsertCursor: db.prepare(`
      INSERT INTO output_ingester_cursor (
        repo, last_ref, last_walked_at, commits_ingested, merges_ingested,
        attribution_gap_count
      ) VALUES (
        @repo, @last_ref, @last_walked_at, @commits_ingested, @merges_ingested,
        @attribution_gap_count
      )
      ON CONFLICT(repo) DO UPDATE SET
        last_ref = excluded.last_ref,
        last_walked_at = excluded.last_walked_at,
        commits_ingested = output_ingester_cursor.commits_ingested + excluded.commits_ingested,
        merges_ingested = output_ingester_cursor.merges_ingested + excluded.merges_ingested,
        attribution_gap_count = output_ingester_cursor.attribution_gap_count + excluded.attribution_gap_count
    `),
    getCursor: db.prepare(`SELECT last_ref FROM output_ingester_cursor WHERE repo = ?`),
  };
}

// ── load known-agent registry (presence table) for attribution body-parse ─

function loadKnownAgentIds(db) {
  const rows = db.prepare(`SELECT DISTINCT agent_id FROM presence`).all();
  return new Set(rows.map((r) => r.agent_id));
}

// ── single repo ingest ────────────────────────────────────────────────────

function ingestRepo(walker, repo, stmts, knownAgentIds, opts = {}) {
  const cursorRow = stmts.getCursor.get(repo);
  const lastRef = cursorRow ? cursorRow.last_ref : null;
  const { commits, merges, newRef } = walker.walkRepo(repo, lastRef);

  let commitsIngested = 0;
  let mergesIngested = 0;
  let attributionGapCount = 0;

  for (const c of commits) {
    // Phase 0 Item C: pass author_email to parser for direct-author
    // attribution fallback (Codex+Gemini direct-author commits).
    const attr = parseAttribution(c._full_message, knownAgentIds, c.author_email);
    const row = {
      ...c,
      agent_attribution: attr.agent_attribution,
      attribution_method: attr.attribution_method,
      runtime_class: attr.runtime_class,
    };
    // Strip the transient body/message fields before insert
    delete row._body;
    delete row._full_message;
    const res = stmts.insertCommit.run(row);
    if (res.changes > 0) {
      commitsIngested += 1;
      if (attr.attribution_method === 'null_fallback') attributionGapCount += 1;
    }
  }

  for (const m of merges) {
    // Phase 0 Item C: merges don't carry author_email directly in current
    // walker schema; pass null (falls through to body-pattern + null-fallback
    // chain). Forward-track: extend walker merge-row to include the merge-
    // commit's author_email if direct-author attribution is needed at the
    // merge tier.
    const attr = parseAttribution(m._full_message, knownAgentIds, null);
    const row = {
      ...m,
      merged_by_agent: attr.agent_attribution,
      attribution_method: attr.attribution_method,
    };
    delete row._full_message;
    const res = stmts.insertMerge.run(row);
    if (res.changes > 0) {
      mergesIngested += 1;
    }
  }

  // Only update cursor when walker produced a newRef
  if (newRef) {
    stmts.upsertCursor.run({
      repo,
      last_ref: newRef,
      last_walked_at: opts.now || new Date().toISOString(),
      commits_ingested: commitsIngested,
      merges_ingested: mergesIngested,
      attribution_gap_count: attributionGapCount,
    });
  }

  return { commitsIngested, mergesIngested, attributionGapCount, substrate: walker.substrateType() };
}

// ── CP13.6 Phase 2.2: GitHubWalker repo ingest (PR substrate) ─────────────

// Task #290 (CP13.6 Phase 3): GitHub commit-walk substrate.
// Uses the same output_commit table as bare-git ingest; attribution flows
// through parseAttribution (with author_email + full-message body). Repo key
// is `owner/repo` (bare-git uses `<name>.git`) — schema handles both.
async function ingestRepoGithubCommits(walker, githubOwnerRepo, stmts, knownAgentIds, opts = {}) {
  const cursor = dbModule.getOutputGithubCommitCursor(githubOwnerRepo);
  const result = await walker.walkCommits(githubOwnerRepo, cursor);

  let commitsIngested = 0;
  let attributionGapCount = 0;
  if (!result.skipped && Array.isArray(result.commits)) {
    for (const c of result.commits) {
      const attr = parseAttribution(c._full_message, knownAgentIds, c.author_email);
      const row = {
        ...c,
        agent_attribution: attr.agent_attribution,
        attribution_method: attr.attribution_method,
        runtime_class: attr.runtime_class,
      };
      delete row._body;
      delete row._full_message;
      const res = stmts.insertCommit.run(row);
      if (res.changes > 0) {
        commitsIngested += 1;
        if (attr.attribution_method === 'null_fallback') attributionGapCount += 1;
      }
    }
  }
  if (result.cursor) {
    dbModule.upsertOutputGithubCommitCursor(githubOwnerRepo, result.cursor);
  }
  return {
    commitsIngested,
    attributionGapCount,
    skipped: result.skipped || false,
    reason: result.reason || null,
  };
}

// Task #290: one-shot repo-meta refresh (creation_at / default_branch /
// size / language / visibility / repo timestamps). Idempotent per-pass.
async function ingestRepoMeta(walker, githubOwnerRepo) {
  const result = await walker.walkRepoMeta(githubOwnerRepo);
  if (!result.skipped && result.meta) {
    dbModule.upsertOutputRepoMeta(githubOwnerRepo, result.meta);
    return { metaSynced: true };
  }
  return { metaSynced: false, reason: result.reason || null };
}

async function ingestRepoPrs(walker, githubOwnerRepo, opts = {}) {
  const cursor = dbModule.getOutputPrCursor(githubOwnerRepo);
  const result = await walker.walkRepo(githubOwnerRepo, cursor);

  let prsIngested = 0;
  if (!result.skipped && Array.isArray(result.prs)) {
    for (const pr of result.prs) {
      dbModule.upsertOutputPr(pr);
      prsIngested += 1;
    }
  }
  if (result.cursor) {
    dbModule.upsertOutputPrCursor(githubOwnerRepo, result.cursor);
  }
  return {
    prsIngested,
    skipped: result.skipped || false,
    reason: result.reason || null,
    substrate: walker.substrateType(),
  };
}

// ── CP13.6 Phase 2.2: GitHubWalker auto-instantiation per env ─────────────

function maybeAddGitHubWalker(walkers, db) {
  const patFile = process.env.GITHUB_PAT_FILE;
  if (!patFile) return walkers;  // no PAT configured → graceful-degradation
  // Bootstrap output_repo from per-host config if empty + config exists
  const configPath = process.env.OUTPUT_REPO_CONFIG_FILE || '/etc/plexus/output-repos.txt';
  dbModule.bootstrapOutputReposFromConfig(configPath);
  const enabledRepos = dbModule.listEnabledOutputRepos();
  if (enabledRepos.length === 0) return walkers;  // no repos enabled → skip
  walkers.push(new GitHubWalker({
    patFile,
    repos: enabledRepos.map((r) => r.github_owner_repo),
  }));
  return walkers;
}

// ── runOnce entry point ───────────────────────────────────────────────────

/**
 * Run ingester pass across all configured walkers. Async per Phase 2.2 —
 * GitHubWalker requires network IO; BareGitWalker stays sync internally
 * (its walkRepo() is synchronous; we just await for uniformity).
 *
 * @param {object} [opts]
 * @param {object[]} [opts.walkers] - walker instances; defaults to
 *   [new BareGitWalker()] + GitHubWalker if GITHUB_PAT_FILE env present +
 *   output_repo has enabled rows. Tests pass in fixture-pointing walkers.
 * @param {object} [opts.db] - DB handle; defaults to dbModule.initializeDb()
 * @param {string} [opts.now] - ISO-8601 timestamp; defaults to actual now
 * @returns {Promise<object>} per-repo summary with totals
 */
async function runOnce(opts = {}) {
  const db = opts.db || dbModule.initializeDb();
  let walkers = opts.walkers;
  if (!walkers) {
    walkers = [new BareGitWalker()];
    walkers = maybeAddGitHubWalker(walkers, db);
  }
  const stmts = prepareStatements(db);
  const knownAgentIds = loadKnownAgentIds(db);
  const perRepo = {};
  let totalCommits = 0;
  let totalMerges = 0;
  let totalAttributionGaps = 0;
  let totalPrs = 0;

  for (const walker of walkers) {
    if (walker.substrateType() === 'github') {
      // Phase 3 (Task #290): meta → commits → PRs per repo. Meta refresh is
      // cheap (single GET) and populates governance-coverage columns for the
      // demo dashboard. Commit-walk uses output_commit (sister to bare-git);
      // attribution flows through parseAttribution.
      for (const repo of walker.listRepos()) {
        const metaResult = await ingestRepoMeta(walker, repo);
        const commitResult = await ingestRepoGithubCommits(walker, repo, stmts, knownAgentIds, opts);
        const prResult = await ingestRepoPrs(walker, repo, opts);
        perRepo[repo] = {
          substrate: 'github',
          metaSynced: metaResult.metaSynced,
          commitsIngested: commitResult.commitsIngested,
          attributionGapCount: commitResult.attributionGapCount,
          prsIngested: prResult.prsIngested,
          skipped: prResult.skipped,
          reason: prResult.reason,
        };
        totalCommits += commitResult.commitsIngested;
        totalAttributionGaps += commitResult.attributionGapCount;
        totalPrs += prResult.prsIngested;
      }
    } else {
      // Phase 1: BareGitWalker (sync walkRepo + output_commit/merge tables)
      for (const repo of walker.listRepos()) {
        const result = ingestRepo(walker, repo, stmts, knownAgentIds, opts);
        perRepo[repo] = result;
        totalCommits += result.commitsIngested;
        totalMerges += result.mergesIngested;
        totalAttributionGaps += result.attributionGapCount;
      }
    }
  }

  return {
    perRepo,
    totalCommits,
    totalMerges,
    totalAttributionGaps,
    totalPrs,
    walkersUsed: walkers.map((w) => w.substrateType()),
  };
}

module.exports = {
  runOnce,
  // exposed for unit-testing
  ingestRepo,
  ingestRepoPrs,
  ingestRepoMeta,
  ingestRepoGithubCommits,
  prepareStatements,
  loadKnownAgentIds,
  maybeAddGitHubWalker,
};
