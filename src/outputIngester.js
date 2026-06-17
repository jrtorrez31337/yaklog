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
        runtime_class, files_changed, bytes_delta
      ) VALUES (
        @repo, @commit_sha, @author_name, @author_email,
        @committer_name, @committer_email, @occurred_at, @branch, @subject,
        @body_digest, @agent_attribution, @attribution_method,
        @runtime_class, @files_changed, @bytes_delta
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
    const attr = parseAttribution(c._full_message, knownAgentIds);
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
    const attr = parseAttribution(m._full_message, knownAgentIds);
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

// ── runOnce entry point ───────────────────────────────────────────────────

/**
 * Run ingester pass across all configured walkers.
 *
 * @param {object} [opts]
 * @param {object[]} [opts.walkers] - walker instances; defaults to
 *   [new BareGitWalker()]. Tests pass in fixture-pointing walkers.
 * @param {object} [opts.db] - DB handle; defaults to dbModule.initializeDb()
 * @param {string} [opts.now] - ISO-8601 timestamp; defaults to actual now
 * @returns {object} per-repo summary with totals
 */
function runOnce(opts = {}) {
  const db = opts.db || dbModule.initializeDb();
  const walkers = opts.walkers || [new BareGitWalker()];
  const stmts = prepareStatements(db);
  const knownAgentIds = loadKnownAgentIds(db);
  const perRepo = {};
  let totalCommits = 0;
  let totalMerges = 0;
  let totalAttributionGaps = 0;

  for (const walker of walkers) {
    for (const repo of walker.listRepos()) {
      const result = ingestRepo(walker, repo, stmts, knownAgentIds, opts);
      perRepo[repo] = result;
      totalCommits += result.commitsIngested;
      totalMerges += result.mergesIngested;
      totalAttributionGaps += result.attributionGapCount;
    }
  }

  return {
    perRepo,
    totalCommits,
    totalMerges,
    totalAttributionGaps,
    walkersUsed: walkers.map((w) => w.substrateType()),
  };
}

module.exports = {
  runOnce,
  // exposed for unit-testing
  ingestRepo,
  prepareStatements,
  loadKnownAgentIds,
};
