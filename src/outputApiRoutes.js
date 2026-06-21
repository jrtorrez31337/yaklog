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

const publicRouter = express.Router();
const opsRouter = express.Router();

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
    return res.json(filtered);
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
  return res.json({ by, ...result });
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
  return res.json(detectAnomalies(db, { threshold, lookback_days: lookback }));
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
  return res.json({ agent, period, rows });
});

// ── PUBLIC: GET /coverage-gap ─────────────────────────────────────────────

publicRouter.get('/coverage-gap', (req, res) => {
  const period = req.query.period || '30d';
  const sampleLimit = req.query.sample_limit ? Number(req.query.sample_limit) : 20;
  const db = dbModule.initializeDb();
  return res.json(computeCoverageGap(db, { period, sample_limit: sampleLimit }));
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

module.exports = {
  publicRouter,
  opsRouter,
};
