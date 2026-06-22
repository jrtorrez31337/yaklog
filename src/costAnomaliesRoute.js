// CP16 Pillar 2: Cost-tab anomaly mean7d compute → server per parch #10268
// ratify of PLAN-CP16-SERVER-SIDE-COMPUTE-MIGRATION §6.
//
// Migrates the per-dim-value mean7d/ratio/spike compute at
// public/dashboard.js:2455-2501 (formerly browser-side Prom-rate samples ×
// dim-grouping reduction) to a single fast SQLite query against cost_daily.
//
// Endpoint: GET /api/v1/cost/anomalies?period=7d&threshold=2.0&dim=agent_id
// Returns: { generated_at, period, threshold, dim, anomalies: [{dim_value, current_usd, mean7d_usd, ratio, is_spike, severity}, ...] }
// Auth: bearer-token (mounted under app.use('/api/v1', auth, ...) parent)
//
// Sister-shape:
//   outputRatios.detectAnomalies (CP13.3 / CP13.6 Phase 2.3) — same pattern (today vs prior-mean ratio + spike threshold)
//   plexusRoutes /cost/anomaly-detail — same cost_daily substrate; this is the LIST view (per-dim across all dim_values); anomaly-detail is DETAIL view (single dim_value + top contributors)
//
// Data semantics shift vs the browser code being replaced: the browser code
// summed Prom rate samples per dim_value across a 7d window. This endpoint
// sums cost_daily.cost_usd per dim_value per day. The aggregates differ in
// units (cost-rate vs cost-magnitude) but yield equivalent spike-detection
// semantics + a more faithful "actual spend" signal.

'use strict';

const express = require('express');
const { getCostByPeriod } = require('./db');

const router = express.Router();

// dim allowlist — matches cost_daily column names. Sister-shape with
// plexusRoutes /cost/anomaly-detail VALID_DIMS set.
const VALID_DIMS = new Set([
  'agent_id',
  'user_email',
  'organization_id',
  'model',
  'cost_center',
  'project_tag',
  'environment_tier',
  'host',
]);

const VALID_PERIODS = new Set(['7d']);

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

function classifySeverity(ratio, threshold) {
  if (ratio == null) return 'unknown';
  if (ratio < threshold) return 'normal';
  if (ratio < threshold * 2) return 'warn';
  return 'critical';
}

router.get('/anomalies', (req, res) => {
  const period = String(req.query.period || '7d');
  if (!VALID_PERIODS.has(period)) {
    return res.status(400).json({
      error: 'ValidationError',
      message: `period must be one of: ${[...VALID_PERIODS].join(', ')}`,
    });
  }
  const dim = String(req.query.dim || 'agent_id');
  if (!VALID_DIMS.has(dim)) {
    return res.status(400).json({
      error: 'ValidationError',
      message: `dim must be one of: ${[...VALID_DIMS].join(', ')}`,
    });
  }
  const threshold = Number(req.query.threshold);
  const thresholdValid = Number.isFinite(threshold) && threshold > 1 && threshold <= 10;
  const effectiveThreshold = thresholdValid ? threshold : 2.0;
  if (req.query.threshold !== undefined && !thresholdValid) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'threshold must be a number in (1, 10]',
    });
  }

  // 7d window: today (current) + prior 6 days (mean7d denominator). Sister-shape
  // outputRatios.detectAnomalies uses "today vs prior N days mean" — same shape
  // here, applied per-dim-value.
  const today = new Date();
  const fromDate = new Date(today.getTime() - 6 * 86400_000);
  const from = ymd(fromDate);
  const to = ymd(today);

  const rows = getCostByPeriod({ from, to });

  // Group by (date, dim_value). Each group's cost_usd is summed.
  // Then per dim_value: current = sum of today's groups; mean7d = average of
  // per-day sums across the window (including today, since "7d" = 7 calendar
  // days; mean is denominator-stable regardless of position).
  const todayStr = to;
  const perDimDaily = new Map();  // dim_value -> Map<date, dailySum>
  for (const r of rows) {
    const dv = r[dim] || '(empty)';
    if (!perDimDaily.has(dv)) perDimDaily.set(dv, new Map());
    const m = perDimDaily.get(dv);
    m.set(r.date, (m.get(r.date) || 0) + (Number(r.cost_usd) || 0));
  }

  const anomalies = [];
  for (const [dim_value, dailyMap] of perDimDaily.entries()) {
    const current_usd = dailyMap.get(todayStr) || 0;
    const dailyVals = [...dailyMap.values()];
    const mean7d_usd = dailyVals.length > 0
      ? dailyVals.reduce((a, b) => a + b, 0) / dailyVals.length
      : 0;
    const ratio = mean7d_usd > 0 ? current_usd / mean7d_usd : null;
    const is_spike = ratio != null && ratio >= effectiveThreshold;
    anomalies.push({
      dim_value,
      current_usd,
      mean7d_usd,
      ratio,
      is_spike,
      severity: classifySeverity(ratio, effectiveThreshold),
    });
  }

  // Sort: spikes first (severity-ordered), then by current_usd descending.
  const sevRank = { critical: 0, warn: 1, normal: 2, unknown: 3 };
  anomalies.sort((a, b) => {
    const sa = sevRank[a.severity] ?? 9;
    const sb = sevRank[b.severity] ?? 9;
    if (sa !== sb) return sa - sb;
    return b.current_usd - a.current_usd;
  });

  return res.json({
    generated_at: new Date().toISOString(),
    period,
    threshold: effectiveThreshold,
    dim,
    window: { from, to },
    anomalies,
  });
});

module.exports = router;
