// CP17.B Task 3: public read endpoints for Repos tab consumption.
// Per PLAN-CP17-CLUSTER-REPO-SUBSTRATE.md §3.2 + §4 CP17.B Task 3.
//
// Time-nav aware: accepts ?period=<preset> OR ?from=&to= (YYYY-MM-DD).
// Sister-shape existing /cost/summary + /cost/daily patterns
// (plexusRoutes.js:508). Mounts under /api/v1/plexus/public/repos
// alongside existing cost/audit read endpoints.

const express = require('express');
const dbModule = require('./db');
const { periodToRange } = require('./costQuery');

const router = express.Router();

// ── Range resolver: accepts ?period=<preset> OR ?from=&to= ────────────────
// Returns { from, to } or throws ValidationError for the handler to catch.
function resolveRange(req) {
  const explicitFrom = req.query.from ? String(req.query.from) : null;
  const explicitTo = req.query.to ? String(req.query.to) : null;
  const period = req.query.period ? String(req.query.period) : null;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (explicitFrom && explicitTo) {
    if (!DATE_RE.test(explicitFrom) || !DATE_RE.test(explicitTo)) {
      throw new Error('from + to must be YYYY-MM-DD');
    }
    return { from: explicitFrom, to: explicitTo, period: null };
  }
  if (period) {
    const r = periodToRange(period);
    return { from: r.from, to: r.to, period };
  }
  // Default: last 30d sister-shape Cost tab default cadence
  const r = periodToRange('30d');
  return { from: r.from, to: r.to, period: '30d' };
}

// ── GET /summary ─────────────────────────────────────────────────────────
router.get('/summary', (req, res) => {
  try {
    const { from, to, period } = resolveRange(req);
    const stats = dbModule.queryOutputDailySummary({ from, to });
    // Pending bare_git_request count for the Repos tab tile.
    const pending = dbModule.listPendingBareGitRequests();
    return res.json({
      period, from, to,
      repo_count: stats.repo_count || 0,
      commit_count: stats.commit_count || 0,
      merge_count: stats.merge_count || 0,
      pr_opened_count: stats.pr_opened_count || 0,
      pr_merged_count: stats.pr_merged_count || 0,
      engaged_agents: stats.engaged_agents || 0,
      attribution_gap_count: stats.attribution_gap_count || 0,
      pending_bare_git_requests: pending.length,
    });
  } catch (e) {
    return res.status(400).json({ error: 'ValidationError', message: e.message });
  }
});

// ── GET /heatmap ─────────────────────────────────────────────────────────
router.get('/heatmap', (req, res) => {
  try {
    const { from, to, period } = resolveRange(req);
    const dim = req.query.dim ? String(req.query.dim) : 'commits';
    const filter_repo = req.query.filter_repo ? String(req.query.filter_repo) : null;
    const filter_agent = req.query.filter_agent ? String(req.query.filter_agent) : null;
    const cells = dbModule.queryOutputDailyHeatmap({ from, to, dim, filter_repo, filter_agent });
    // Compute scale for client-side color calibration.
    let min = 0, max = 0, p95 = 0;
    if (cells.length > 0) {
      const vals = cells.map(c => c.value || 0).sort((a, b) => a - b);
      min = vals[0];
      max = vals[vals.length - 1];
      p95 = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.95))];
    }
    return res.json({
      dim, period, from, to,
      cells,
      scale: { min, max, p95 },
    });
  } catch (e) {
    return res.status(400).json({ error: 'ValidationError', message: e.message });
  }
});

// ── GET /list ────────────────────────────────────────────────────────────
router.get('/list', (req, res) => {
  try {
    const { from, to, period } = resolveRange(req);
    const repos = dbModule.queryOutputDailyRepoList({ from, to });
    // Cross-reference with output_repo to include type + last_walked_at metadata.
    const registered = dbModule.listAllOutputRepos();
    const byKey = new Map(registered.map(r => [r.github_owner_repo, r]));
    const enriched = repos.map(r => {
      const reg = byKey.get(r.repo_key);
      return {
        ...r,
        type: reg ? 'github' : 'bare-git',
        bare_git_path: reg ? reg.bare_git_path : null,
        enabled: reg ? Boolean(reg.enabled) : true,
        added_by: reg ? reg.added_by : null,
        registered: !!reg,
      };
    });
    return res.json({ period, from, to, repos: enriched });
  } catch (e) {
    return res.status(400).json({ error: 'ValidationError', message: e.message });
  }
});

// ── GET /:repo_key/detail — per-repo drill-in ────────────────────────────
// Route uses (*) wildcard to permit github_owner_repo slashes.
router.get('/:repo_key(*)/detail', (req, res) => {
  try {
    const { from, to, period } = resolveRange(req);
    const repo_key = req.params.repo_key;
    if (!repo_key || repo_key.length === 0) {
      return res.status(400).json({ error: 'ValidationError', message: 'repo_key required in path' });
    }
    // Query the query-daily helper filtered to one repo (via heatmap with filter_repo).
    const timeline = dbModule.queryOutputDailyHeatmap({ from, to, dim: 'commits', filter_repo: repo_key });
    // Agent breakdown for the repo via by-agent per-repo query.
    const database = dbModule.getDb();
    const agents = database.prepare(`
      SELECT
        agent_id,
        SUM(commits) AS commit_count,
        SUM(merges) AS merge_count,
        SUM(prs_opened) AS pr_opened_count,
        SUM(prs_merged) AS pr_merged_count
      FROM output_daily
      WHERE repo_key = @repo_key AND date >= @from AND date <= @to
      GROUP BY agent_id
      ORDER BY commit_count DESC
    `).all({ repo_key, from, to });
    // Sample of recent commits + PRs (capped for drill-in perf).
    const commits = database.prepare(`
      SELECT commit_sha, author_name, occurred_at, subject, agent_attribution
      FROM output_commit
      WHERE repo = @repo_key AND date(occurred_at) >= @from AND date(occurred_at) <= @to
      ORDER BY occurred_at DESC
      LIMIT 500
    `).all({ repo_key, from, to });
    const prs = database.prepare(`
      SELECT pr_number, state, title, author_login, opened_at, merged_at
      FROM output_pr
      WHERE github_owner_repo = @repo_key
        AND (
          (opened_at IS NOT NULL AND date(opened_at) >= @from AND date(opened_at) <= @to)
          OR (merged_at IS NOT NULL AND date(merged_at) >= @from AND date(merged_at) <= @to)
        )
      ORDER BY COALESCE(merged_at, opened_at) DESC
      LIMIT 100
    `).all({ repo_key, from, to });
    return res.json({
      repo_key, period, from, to,
      timeline,
      agents,
      commits,
      prs,
    });
  } catch (e) {
    return res.status(400).json({ error: 'ValidationError', message: e.message });
  }
});

// ── GET /:repo_key/audit — audit_repo_change rows for canary observation ──
// Per secops #11835 Step 4 binding gate #3 request. Public read; no PII
// (repo_key + action + actor_agent_id + metadata_json). Sister-shape
// existing per-repo detail read pattern.
//
// Explicit column whitelist per secops #11837 hardening note 1: prevents
// a future sensitive column added to audit_repo_change from auto-exposing
// publicly. Convention: metadata_json is agent-supplied at request-authoring
// time; MUST NOT contain secrets (documented in bare-git-request POST body
// contract at repoRoutes.js).
router.get('/:repo_key(*)/audit', (req, res) => {
  const repo_key = req.params.repo_key;
  if (!repo_key || repo_key.length === 0) {
    return res.status(400).json({ error: 'ValidationError', message: 'repo_key required in path' });
  }
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const rows = dbModule.listAuditRepoChangesByRepo(repo_key, { limit });
  const audit = rows.map(r => ({
    seq: r.seq,
    repo_key: r.repo_key,
    action: r.action,
    actor_agent_id: r.actor_agent_id,
    metadata_json: r.metadata_json,
    at_ts: r.at_ts,
  }));
  return res.json({ repo_key, audit });
});

// ── GET /activity-feed — CP17.C Task 2 activity feed (commits + PRs merged) ─
router.get('/activity-feed', (req, res) => {
  try {
    const { from, to, period } = resolveRange(req);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    // Task #277 Phase C inc-4 (plexus-ui #12797): wire optional filter_repo
    // to queryRepoActivityFeed's repo_key filter (already accepts it from
    // my Phase B Task 1 commit 4547af8, but the ROUTE was missing the wire).
    // Param name filter_repo matches the /repos/heatmap family convention.
    const filterRepo = typeof req.query.filter_repo === 'string' ? req.query.filter_repo.trim() : '';
    // repo_key may be github (owner/name) or bare-git (name.git). Accept both.
    if (filterRepo && !/^[\w.-]+(\/[\w.-]+)?$/.test(filterRepo)) {
      return res.status(400).json({ error: 'ValidationError', message: 'filter_repo must match owner/name or name.git' });
    }
    const activity = dbModule.queryRepoActivityFeed({
      from, to, limit,
      repo_key: filterRepo || null,
    });
    return res.json({ period, from, to, activity });
  } catch (e) {
    return res.status(400).json({ error: 'ValidationError', message: e.message });
  }
});

// ── GET /agents-in-window — distinct agents for filter dropdowns (Task 6) ─
router.get('/agents-in-window', (req, res) => {
  try {
    const { from, to, period } = resolveRange(req);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const agents = dbModule.queryOutputDailyAgentsInWindow({ from, to, limit });
    return res.json({ period, from, to, agents });
  } catch (e) {
    return res.status(400).json({ error: 'ValidationError', message: e.message });
  }
});

// ── GET /by-agent/:agent_id — cross-repo view for one agent ──────────────
router.get('/by-agent/:agent_id', (req, res) => {
  try {
    const { from, to, period } = resolveRange(req);
    const agent_id = req.params.agent_id;
    if (!agent_id || agent_id.length === 0) {
      return res.status(400).json({ error: 'ValidationError', message: 'agent_id required in path' });
    }
    const repos = dbModule.queryOutputDailyByAgent({ agent_id, from, to });
    return res.json({ agent_id, period, from, to, repos });
  } catch (e) {
    return res.status(400).json({ error: 'ValidationError', message: e.message });
  }
});

module.exports = { router };
