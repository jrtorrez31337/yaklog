// CP13.3 / ADR-0032 Phase 1.3 — output API routes
//
// Mounted at /api/v1/output (public; network-isolation trust per
// auditRoutes pattern) and /api/v1/ops/output (ops-key gated mutations
// per auditOpsRoutes pattern).
//
// 7 endpoints total (Phase 1; the 9th comparable-anchor endpoint is
// Phase 2 forward-track):
//
// PUBLIC (5):
//   GET /api/v1/output/ratios?period=30d&audience=buyer|practitioner|investor
//   GET /api/v1/output/composition?period=30d&by=agent|repo
//   GET /api/v1/output/anomalies?lookback_days=7&threshold=2.0
//   GET /api/v1/output/merges?period=30d&agent=<id>
//   GET /api/v1/output/coverage-gap?period=30d
//
// OPS-KEY GATED (2):
//   PUT  /api/v1/ops/output/attribution     (manual attribution correction)
//   POST /api/v1/ops/output/ingest          (manual ingester trigger)
//
// SERVER-SIDE Fold B HARD GATE enforcement per s345 #9234 §5.6 is applied
// inside filterRatiosByAudience() — activity-numerator ratios are stripped
// at substrate level, NOT honor-system at render layer.

'use strict';

const express = require('express');
const crypto = require('crypto');
const { enforceOpsKey } = require('./middleware/opsKey');
const {
  AUDIENCE_TIERS,
  computeRatios,
  filterRatiosByAudience,
  computeCompositionByAgent,
  computeCompositionByRepo,
  computeCoverageGap,
  listMergesByAgent,
  detectAnomalies,
} = require('./outputRatios');
const dbModule = require('./db');
const { periodToRange } = require('./costQuery');

const publicRouter = express.Router();
const opsRouter = express.Router();

// Range resolver: sister-shape repoQueryRoutes.js resolveRange (same contract).
// Accepts ?period=<preset> OR ?from=&to= (YYYY-MM-DD). Defaults to '30d'.
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
  const r = periodToRange('30d');
  return { from: r.from, to: r.to, period: '30d' };
}

// Task #258 / PLAN-EFFORT-METADATA-RESPONSE (parch #11208 RATIFY).
// Attach namespaced _metadata to PUBLIC /output/* successful 2xx responses.
// Sister-shape Pillar 3 _filter at src/app.js:456 per parch #11169 OQ2 pattern.
// OQ2 RATIFY: error envelopes (4xx/5xx) do NOT get _metadata (canon-shape
// preservation). OQ1 RATIFY: unconditional (single semantics).
function attachMetadata(body, isEmpty) {
  if (!body || typeof body !== 'object') return body;
  body._metadata = {
    as_of_unix: Math.floor(Date.now() / 1000),
    computed_empty_period: !!isEmpty,
  };
  return body;
}

// ── PUBLIC: GET /ratios ───────────────────────────────────────────────────

publicRouter.get('/ratios', (req, res) => {
  const period = req.query.period || '30d';
  const audience = (req.query.audience || 'buyer').toLowerCase();
  if (!AUDIENCE_TIERS.has(audience)) {
    return res.status(400).json({
      error: 'ValidationError',
      message: `audience must be one of: ${[...AUDIENCE_TIERS].join(', ')}`,
    });
  }
  const db = dbModule.initializeDb();
  try {
    const raw = computeRatios(db, { period });
    const filtered = filterRatiosByAudience(raw, audience);
    // Empty: zero merges denominator → all numerator ratios degenerate (null/zero)
    const isEmpty = (filtered._merges === 0) || (raw && raw._merges === 0);
    return res.json(attachMetadata(filtered, isEmpty));
  } catch (err) {
    return res.status(500).json({ error: 'InternalError', message: err.message });
  }
});

// ── PUBLIC: GET /composition?by=agent|repo ────────────────────────────────

publicRouter.get('/composition', (req, res) => {
  const period = req.query.period || '30d';
  const by = (req.query.by || 'agent').toLowerCase();
  if (!['agent', 'repo'].includes(by)) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'by must be one of: agent, repo',
    });
  }
  const db = dbModule.initializeDb();
  const result = by === 'agent'
    ? computeCompositionByAgent(db, { period })
    : computeCompositionByRepo(db, { period });
  const isEmpty = !Array.isArray(result.rows) || result.rows.length === 0;
  return res.json(attachMetadata({ by, ...result }, isEmpty));
});

// ── PUBLIC: GET /anomalies ────────────────────────────────────────────────

publicRouter.get('/anomalies', (req, res) => {
  const threshold = req.query.threshold ? Number(req.query.threshold) : 2.0;
  const lookback = req.query.lookback_days ? Number(req.query.lookback_days) : 7;
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return res.status(400).json({ error: 'ValidationError', message: 'threshold must be a positive number' });
  }
  if (!Number.isInteger(lookback) || lookback <= 0) {
    return res.status(400).json({ error: 'ValidationError', message: 'lookback_days must be a positive integer' });
  }
  const db = dbModule.initializeDb();
  const result = detectAnomalies(db, { threshold, lookback_days: lookback });
  const isEmpty = !result || !Array.isArray(result.anomalies) || result.anomalies.length === 0;
  return res.json(attachMetadata(result, isEmpty));
});

// ── PUBLIC: GET /pace?period=eom|eoq&audience= ────────────────────────────
// Task #259 / PLAN-EFFORT-PACE-ENDPOINT (parch #11211 RATIFY `/output/pace`
// naming + s345 #11212 surface-class CONFIRM + parch OQ2-4 silence-is-ack).
//
// Linear projection sister-shape /api/v1/plexus/public/cost/projection
// (src/plexusRoutes.js:597). Effort-strand equivalent: project end-of-period
// counts (linear extrapolation) + rate-class metrics as steady-state.
//
// Per-audience filter sister to /ratios filterRatiosByAudience (BUYER returns
// empty current/projected per Fold B HARD GATE; PRACTITIONER + INVESTOR see
// value-ratios; activity-numerator NOT in Pace per substrate-honest scope).

publicRouter.get('/pace', (req, res) => {
  const period = req.query.period || 'eom';
  const audience = (req.query.audience || 'practitioner').toLowerCase();
  if (!['eom', 'eoq'].includes(period)) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'period must be one of: eom, eoq',
    });
  }
  if (!AUDIENCE_TIERS.has(audience)) {
    return res.status(400).json({
      error: 'ValidationError',
      message: `audience must be one of: ${[...AUDIENCE_TIERS].join(', ')}`,
    });
  }
  const costQuery = require('./costQuery');
  const range = costQuery.projectionPeriodToRange(period);
  const db = dbModule.initializeDb();
  const mergeRow = db.prepare(
    `SELECT COUNT(*) AS n FROM output_merge WHERE date(occurred_at) >= ? AND date(occurred_at) <= ?`,
  ).get(range.current_from, range.current_to);
  const merges = mergeRow.n;
  const costRow = db.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS s FROM cost_daily WHERE date >= ? AND date <= ?`,
  ).get(range.current_from, range.current_to);
  const costUsd = Number(costRow.s);
  const fromDate = new Date(`${range.current_from}T00:00:00Z`);
  const toDate = new Date(`${range.current_to}T00:00:00Z`);
  const endDate = new Date(`${range.period_end}T00:00:00Z`);
  const dayMs = 86400000;
  const elapsedDays = Math.max(1, Math.round((toDate - fromDate) / dayMs) + 1);
  const totalDays = Math.max(1, Math.round((endDate - fromDate) / dayMs) + 1);
  const projectionFactor = totalDays / elapsedDays;
  const dollarPerMergedPr = merges > 0 ? costUsd / merges : null;
  // BUYER tier: Fold B HARD GATE — no output-strand ratios visible.
  // Empty current/projected objects but echo _audience + period_basis so
  // client can render "metric not visible at buyer lens" placeholder.
  const isBuyer = audience === 'buyer';
  const current = isBuyer ? {} : {
    _merges: merges,
    _cost_usd: costUsd,
    dollar_per_merged_pr: dollarPerMergedPr,
  };
  const projected = isBuyer ? {} : {
    // Count-class: linear extrapolation
    _merges_projected: Math.round(merges * projectionFactor),
    _cost_usd_projected: costUsd * projectionFactor,
    // Rate-class (per PLAN §4): steady-state — projected rate = current rate
    dollar_per_merged_pr: dollarPerMergedPr,
  };
  return res.json(attachMetadata({
    period_basis: {
      current_from: range.current_from,
      current_to: range.current_to,
      period_end: range.period_end,
      basis_days: elapsedDays,
      basis_label: `Linear projection from last ${elapsedDays}d`,
    },
    current,
    projected,
    _audience: audience,
  }, merges === 0));
});

// ── PUBLIC: GET /merges?agent=<id> ────────────────────────────────────────

publicRouter.get('/merges', (req, res) => {
  const period = req.query.period || '30d';
  const agent = req.query.agent;
  if (!agent || typeof agent !== 'string') {
    return res.status(400).json({ error: 'ValidationError', message: 'agent query param is required' });
  }
  const db = dbModule.initializeDb();
  const rows = listMergesByAgent(db, agent, { period });
  return res.json(attachMetadata({ agent, period, rows }, rows.length === 0));
});

// ── PUBLIC: GET /coverage-gap ─────────────────────────────────────────────

publicRouter.get('/coverage-gap', (req, res) => {
  const period = req.query.period || '30d';
  const sampleLimit = req.query.sample_limit ? Number(req.query.sample_limit) : 20;
  const db = dbModule.initializeDb();
  const result = computeCoverageGap(db, { period, sample_limit: sampleLimit });
  // Empty: no commits walked OR all commits are covered (no gap detected)
  const isEmpty = !result || result.total_commits === 0;
  return res.json(attachMetadata(result, isEmpty));
});

// ── PUBLIC: GET /hero-summary — ADR-0041 P1a #output shared hero ──────────
// Fold-B-by-construction: ALL fields cross-tier-safe (OUTCOME/COVERAGE/PROOF).
// The always-fetched hero-summary payload PHYSICALLY cannot leak tier-gated
// data regardless of client bug — defense-in-depth via data-partitioning
// (plexus-ui #11973 applause). Tier-gated tiles fetch /output/ratios?audience=<tier>
// separately.
//
// Contract locked at plexus-ui #11975 + s345 #11973 (R1 total-headline
// expose-both; R2 lifetime cumulative, never window-rate).
publicRouter.get('/hero-summary', (req, res) => {
  try {
    const { from, to, period } = resolveRange(req);
    const result = dbModule.queryHeroSummary({ from, to });
    return res.json(attachMetadata({ period, from, to, ...result }, false));
  } catch (e) {
    return res.status(400).json({ error: 'ValidationError', message: e.message });
  }
});

// ── OPS: PUT /attribution (manual correction for parser misses) ───────────

opsRouter.use(enforceOpsKey);

opsRouter.put('/attribution', (req, res) => {
  const { repo, commit_sha, agent_attribution, runtime_class } = req.body || {};
  if (typeof repo !== 'string' || typeof commit_sha !== 'string') {
    return res.status(400).json({ error: 'ValidationError', message: 'repo + commit_sha required' });
  }
  if (agent_attribution !== null && typeof agent_attribution !== 'string') {
    return res.status(400).json({ error: 'ValidationError', message: 'agent_attribution must be string or null' });
  }
  const db = dbModule.initializeDb();
  const result = db.prepare(`
    UPDATE output_commit
       SET agent_attribution = ?, runtime_class = ?, attribution_method = 'operator_override'
     WHERE repo = ? AND commit_sha = ?
  `).run(agent_attribution, runtime_class || null, repo, commit_sha);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'NotFound', message: 'no matching output_commit row' });
  }
  return res.json({ ok: true, updated: result.changes });
});

// ── OPS: POST /ingest (manual ingester trigger) ───────────────────────────

opsRouter.post('/ingest', async (req, res) => {
  // Lazy-require to avoid loading the walker (with its spawn-based git
  // calls) at module-import time. Tests can mock by passing walkers
  // through the request body.
  // CP13.6 Phase 2.2: runOnce is now async (GitHubWalker requires network IO).
  const { runOnce } = require('./outputIngester');
  // CP16-prep observability per parch #10166 (Option 2c): emit gauges
  // so cluster Prom surfaces ingester health via /api/v1/metrics scrape.
  const { emit } = require('./metrics');
  const t0 = Date.now();
  try {
    const result = await runOnce({ db: dbModule.initializeDb() });
    emit.outputIngester({
      elapsed_ms: Date.now() - t0,
      commits_walked: result.totalCommits || 0,
      merges_walked: result.totalMerges || 0,
      prs_walked: result.totalPrs || 0,
      success: true,
    });
    return res.json(result);
  } catch (err) {
    emit.outputIngester({
      elapsed_ms: Date.now() - t0,
      commits_walked: 0,
      merges_walked: 0,
      prs_walked: 0,
      success: false,
    });
    return res.status(500).json({ error: 'InternalError', message: err.message });
  }
});

// ── OPS: POST /reattribute (Q5 amendment ratify per parch #10879) ─────────
// Re-parse output_commit rows where attribution_method='null_fallback' using
// the post-1ab450f parser (#10872). Operator-corrected rows are NEVER touched.
// One-shot use post-rebuild; idempotent + safe to re-run (only updates rows
// where new parse yields non-null agent_attribution).

opsRouter.post('/reattribute', (req, res) => {
  const { reattributeNullFallback } = require('./outputReattribute');
  const dryRun = req.body && req.body.dry_run === true;
  const limit = (req.body && Number.isInteger(req.body.limit)) ? req.body.limit : 10000;
  try {
    const result = reattributeNullFallback({
      db: dbModule.initializeDb(),
      limit,
      dryRun,
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: 'InternalError', message: err.message });
  }
});

// ── OPS: output_repo allowlist management (CP13.6 Phase 2.2 / Q1 Option C) ─

opsRouter.post('/repos', (req, res) => {
  const { github_owner_repo, bare_git_path, enabled } = req.body || {};
  if (typeof github_owner_repo !== 'string' || !github_owner_repo.includes('/')) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'github_owner_repo required in "owner/repo" form',
    });
  }
  dbModule.upsertOutputRepo({
    github_owner_repo,
    bare_git_path: bare_git_path || null,
    enabled: enabled === false ? 0 : 1,
    added_by: req.headers['x-ops-key-id'] || 'ops-endpoint',
  });
  return res.json({ ok: true, github_owner_repo });
});

opsRouter.delete('/repos/:github_owner_repo(*)', (req, res) => {
  // Soft-disable per parch ratify; hard-delete forward-track
  const githubOwnerRepo = req.params.github_owner_repo;
  const changes = dbModule.disableOutputRepo(githubOwnerRepo);
  if (changes === 0) {
    return res.status(404).json({ error: 'NotFound', message: 'no matching output_repo row' });
  }
  return res.json({ ok: true, disabled: githubOwnerRepo });
});

publicRouter.get('/repos', (req, res) => {
  // Read-only listing for operator visibility
  const repos = dbModule.listAllOutputRepos();
  return res.json({ repos });
});

// ── CP17.A ops: bare_git_request lifecycle (admin poll+fulfill) ───────────
// Per PLAN-CP17-CLUSTER-REPO-SUBSTRATE.md §3.1 + secops #11759 SIGN-OFF.
// Admin-agent auto-fulfills pending intents via poll+execute script (single-
// instance per secops #11761 T5 caveat; script co-review with secops before
// authorship per binding gate #1).

opsRouter.get('/repos/bare-git-request', (req, res) => {
  // Admin poll target. Default status filter = pending; expandable later.
  const status = req.query.status ? String(req.query.status) : 'pending';
  if (status !== 'pending') {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'only status=pending is supported at v1',
    });
  }
  const requests = dbModule.listPendingBareGitRequests();
  return res.json({ requests });
});

opsRouter.post('/repos/bare-git-request/:id/fulfilled', (req, res) => {
  const requestId = parseInt(req.params.id, 10);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'request_id must be a positive integer.',
    });
  }
  const { result, error_message } = req.body || {};
  if (result !== 'success' && result !== 'error') {
    return res.status(400).json({
      error: 'ValidationError',
      message: "result must be 'success' or 'error'.",
    });
  }
  if (error_message !== undefined && error_message !== null) {
    if (typeof error_message !== 'string' || error_message.length > 1024) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'error_message must be a string (max 1024 chars).',
      });
    }
  }
  const fulfiller = `ops:${req.headers['x-ops-key-id'] || req.auth?.opsKeyId || 'admin'}`;

  // Atomic compare-and-set on fulfillment per secops #11759 §3.1.2 condition.
  // Same-txn audit-fold ensures fulfillment + audit succeed together.
  const database = dbModule.getDb();
  let changes;
  const tx = database.transaction(() => {
    changes = dbModule.fulfillBareGitRequest({
      request_id: requestId,
      fulfilled_by: fulfiller,
      result,
      error_message: error_message || null,
    });
    if (changes === 1) {
      // Only insert audit row if the CAS succeeded (guards against replay-audit).
      const row = dbModule.getBareGitRequest(requestId);
      dbModule.insertAuditRepoChange({
        repo_key: `bare-git:${row.repo_name}`,
        action: 'bare-git-fulfilled',
        actor_agent_id: fulfiller,
        metadata: {
          request_id: requestId,
          result,
          error_message: error_message || null,
          requested_by: row.requested_by,
        },
      });
    }
  });
  tx();

  if (changes === 0) {
    // Compare-and-set failed: row was not in 'pending' state (already
    // fulfilled OR non-existent). Return 409 for already-fulfilled semantic.
    const row = dbModule.getBareGitRequest(requestId);
    if (!row) {
      return res.status(404).json({
        error: 'NotFound',
        message: 'no matching bare_git_request row',
      });
    }
    return res.status(409).json({
      error: 'Conflict',
      message: `bare-git-request already in state ${row.fulfillment_result}`,
      fulfillment_result: row.fulfillment_result,
    });
  }
  return res.json({ ok: true, request_id: requestId, fulfilled_by: fulfiller });
});

// ── CP17.B ops: output_daily rollup driver ────────────────────────────────
// POST /api/v1/ops/output/output-rollup/backfill
// Sister-shape /ops/audit-rollup/backfill (auditOpsRoutes.js:547) — ops-key
// gated + structured response. Cron-driver invokes via yaklog-output-rollup.sh
// systemd timer. Also usable for post-deploy initial backfill + on-demand.
opsRouter.post('/output-rollup/backfill', (req, res) => {
  const b = req.body || {};
  const daysBack = Number.isInteger(b.days_back) ? b.days_back : 90;
  if (daysBack < 1 || daysBack > 365) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'days_back must be integer 1..365',
    });
  }
  const endDateExclusive = (typeof b.end_date_exclusive === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.end_date_exclusive))
    ? b.end_date_exclusive
    : null;
  const actor = `ops:${req.headers['x-ops-key-id'] || req.auth?.opsKeyId || 'admin'}`;
  const t0 = Date.now();
  try {
    const result = dbModule.rollupOutputWindow({
      daysBack,
      endDateExclusive: endDateExclusive || undefined,
    });
    const elapsed_ms = Date.now() - t0;
    let totalRows = 0;
    for (const day of result.results) totalRows += day.rows || 0;
    return res.json({
      ok: true,
      window_days: result.window_days,
      end_date_exclusive: result.end_date_exclusive,
      days_rolled: result.rolled,
      output_daily_rows: totalRows,
      elapsed_ms,
      actor,
    });
  } catch (e) {
    return res.status(500).json({ error: 'InternalError', message: e.message });
  }
});

module.exports = {
  publicRouter,
  opsRouter,
};
