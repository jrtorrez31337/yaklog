// CP13.3 / ADR-0032 Phase 1.3 — output ratios + composition compute
//
// Pure functions over the existing yaklog SQLite substrate:
//   - cost_daily          (CP11)
//   - messages            (yaklog message bus)
//   - audit_tool_invocation (CP12)
//   - output_commit + output_merge (CP13.1 schema)
//
// Per ADR-0032 §3 + bizmodel #7939: 7-ratio family + 4 hero tiles.
// Phase 1 lands 5 of 7 ratios (bare-git substrate covers 1+2+3+4+5;
// 6 PR-merge-rate + 7 Time-to-merge require Phase 2 GitHub API).
//
// SERVER-SIDE Fold B HARD GATE per s345 #9234 §5.6: activity-numerator
// ratios (#3 + #4 + #5) MUST NOT emit at buyer or investor audience
// regardless of client request. Filter is applied at the substrate layer
// (this module), not at the render layer.

'use strict';

const AUDIENCE_TIERS = new Set(['buyer', 'practitioner', 'investor']);

// Cross-tier-safe ratios: pure-outcome divided by pure-outcome.
// Renderable at any audience-tier default.
const CROSS_TIER_SAFE_RATIOS = new Set([
  'dollar_per_merged_pr',
  'dollar_per_agent_cycle',
]);

// Activity-numerator ratios: activity-count (messages, tool-invocations,
// agents-engaged) divided by outcome. Practitioner-lens ONLY per Fold B
// HARD GATE.
const PRACTITIONER_ONLY_RATIOS = new Set([
  'coord_messages_per_merged_pr',
  'tool_invocations_per_merged_pr',
  'agents_engaged_per_merged_pr',
]);

const VALID_PERIOD_DAYS = { '1d': 1, '7d': 7, '30d': 30, '90d': 90 };

function parsePeriod(period) {
  return VALID_PERIOD_DAYS[period] || 30;
}

function periodBound(periodDays) {
  return `datetime('now', '-${periodDays} days')`;
}

/**
 * Compute the 7-ratio family for the given period.
 * Returns ALL ratios computable from Phase 1 substrate (5 of 7); the
 * audience-tier filter (filterRatiosByAudience) is applied separately so
 * callers can request raw substrate for practitioner-lens or operator
 * audit purposes.
 *
 * @param {object} db - better-sqlite3 handle
 * @param {object} [opts]
 * @param {string} [opts.period] - '1d'|'7d'|'30d'|'90d' (default '30d')
 * @returns {object} keys: dollar_per_merged_pr, dollar_per_agent_cycle,
 *   coord_messages_per_merged_pr, tool_invocations_per_merged_pr,
 *   agents_engaged_per_merged_pr, _period_days, _merges, _commits,
 *   _cost_usd, _messages, _tool_invocations
 */
function computeRatios(db, opts = {}) {
  const periodDays = parsePeriod(opts.period);
  const bound = periodBound(periodDays);

  // Denominators
  const mergeCount = db.prepare(
    `SELECT COUNT(*) AS n FROM output_merge WHERE occurred_at >= ${bound}`,
  ).get().n;
  const commitCount = db.prepare(
    `SELECT COUNT(*) AS n FROM output_commit WHERE occurred_at >= ${bound}`,
  ).get().n;

  // Cost-strand (cost_daily uses date as YYYY-MM-DD; compare via date('now', ...))
  const costRow = db.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM cost_daily WHERE date >= date('now', '-${periodDays} days')`,
  ).get();
  const costUsd = costRow.cost;

  // Effort-strand (cluster-coord)
  const msgRow = db.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE created_at >= ${bound}`,
  ).get();
  const messagesCount = msgRow.n;

  // Effort-strand (tool invocations)
  let toolInvocationsCount = 0;
  try {
    toolInvocationsCount = db.prepare(
      `SELECT COUNT(*) AS n FROM audit_tool_invocation WHERE occurred_at >= ${bound}`,
    ).get().n;
  } catch {
    // audit_tool_invocation may not be populated in some test fixtures
    toolInvocationsCount = 0;
  }

  // Distinct agents engaged in cluster coord
  const distinctAgentsRow = db.prepare(
    `SELECT COUNT(DISTINCT sender) AS n FROM messages WHERE created_at >= ${bound}`,
  ).get();
  const agentsEngaged = distinctAgentsRow.n;

  // Ratios (NULL when denominator is 0 — honest "insufficient data")
  function safeDivide(num, denom) {
    if (denom === 0) return null;
    return num / denom;
  }

  return {
    dollar_per_merged_pr: safeDivide(costUsd, mergeCount),
    dollar_per_agent_cycle: safeDivide(costUsd, commitCount),
    coord_messages_per_merged_pr: safeDivide(messagesCount, mergeCount),
    tool_invocations_per_merged_pr: safeDivide(toolInvocationsCount, mergeCount),
    agents_engaged_per_merged_pr: safeDivide(agentsEngaged, mergeCount),
    // Phase 2 ratios (deferred):
    pr_merge_rate: null,
    time_to_merge_hours: null,
    // metadata
    _period_days: periodDays,
    _merges: mergeCount,
    _commits: commitCount,
    _cost_usd: costUsd,
    _messages: messagesCount,
    _tool_invocations: toolInvocationsCount,
    _agents_engaged: agentsEngaged,
  };
}

/**
 * Apply audience-tier filter (Fold B HARD GATE per s345 #9234 §5.6).
 * SUBSTRATE-LEVEL enforcement: activity-numerator ratios are stripped
 * from buyer + investor responses regardless of client request.
 *
 * @param {object} ratios - output of computeRatios()
 * @param {'buyer'|'practitioner'|'investor'} audience
 * @returns {object} filtered ratios with metadata + audience marker
 */
function filterRatiosByAudience(ratios, audience) {
  if (!AUDIENCE_TIERS.has(audience)) {
    throw new Error(`invalid audience: ${audience}. Must be buyer/practitioner/investor`);
  }
  const allowed = audience === 'practitioner'
    ? new Set([...CROSS_TIER_SAFE_RATIOS, ...PRACTITIONER_ONLY_RATIOS, 'pr_merge_rate', 'time_to_merge_hours'])
    : new Set([...CROSS_TIER_SAFE_RATIOS, 'pr_merge_rate', 'time_to_merge_hours']);
  const filtered = {};
  for (const [key, value] of Object.entries(ratios)) {
    // Always preserve metadata fields (prefixed with _)
    if (key.startsWith('_')) { filtered[key] = value; continue; }
    if (allowed.has(key)) {
      filtered[key] = value;
    }
    // Else: omit (Fold B HARD GATE — server NEVER emits practitioner-only
    // ratios at buyer/investor regardless of client request)
  }
  filtered._audience = audience;
  return filtered;
}

/**
 * Per-agent composition view. Returns rows for the time window.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {string} [opts.period] - default '30d'
 * @returns {Array<object>} { agent_id, coord_msgs, commits, merges, cost_usd }
 */
function computeCompositionByAgent(db, opts = {}) {
  const periodDays = parsePeriod(opts.period);
  const bound = periodBound(periodDays);

  // Join across messages.sender + output_commit.agent_attribution +
  // output_merge.merged_by_agent + cost_daily.agent_id. UNION the agent
  // identifier domain then aggregate per-source.
  const rows = db.prepare(`
    WITH agent_universe AS (
      SELECT DISTINCT sender AS agent_id FROM messages WHERE created_at >= ${bound}
      UNION
      SELECT DISTINCT agent_attribution AS agent_id FROM output_commit WHERE occurred_at >= ${bound} AND agent_attribution IS NOT NULL
      UNION
      SELECT DISTINCT merged_by_agent AS agent_id FROM output_merge WHERE occurred_at >= ${bound} AND merged_by_agent IS NOT NULL
      UNION
      SELECT DISTINCT agent_id FROM cost_daily WHERE date >= date('now', '-${periodDays} days') AND agent_id != ''
    )
    SELECT
      u.agent_id,
      (SELECT COUNT(*) FROM messages WHERE sender = u.agent_id AND created_at >= ${bound}) AS coord_msgs,
      (SELECT COUNT(*) FROM output_commit WHERE agent_attribution = u.agent_id AND occurred_at >= ${bound}) AS commits,
      (SELECT COUNT(*) FROM output_merge WHERE merged_by_agent = u.agent_id AND occurred_at >= ${bound}) AS merges,
      (SELECT COALESCE(SUM(cost_usd), 0) FROM cost_daily WHERE agent_id = u.agent_id AND date >= date('now', '-${periodDays} days')) AS cost_usd
    FROM agent_universe u
    ORDER BY merges DESC, coord_msgs DESC
  `).all();

  return { rows, _period_days: periodDays };
}

/**
 * Per-repo composition view.
 */
function computeCompositionByRepo(db, opts = {}) {
  const periodDays = parsePeriod(opts.period);
  const bound = periodBound(periodDays);

  const rows = db.prepare(`
    SELECT
      repo,
      COUNT(*) AS commits,
      (SELECT COUNT(*) FROM output_merge m WHERE m.repo = c.repo AND m.occurred_at >= ${bound}) AS merges,
      COALESCE(SUM(bytes_delta), 0) AS bytes_delta
    FROM output_commit c
    WHERE occurred_at >= ${bound}
    GROUP BY repo
    ORDER BY merges DESC, commits DESC
  `).all();

  return { rows, _period_days: periodDays };
}

/**
 * Coverage-gap surface per ADR-0030 anti-feature §coverage-gap canon
 * carried forward to ADR-0032. Returns the count of commits with
 * attribution_method='null_fallback' (parser miss) + a sample list.
 */
function computeCoverageGap(db, opts = {}) {
  const periodDays = parsePeriod(opts.period);
  const bound = periodBound(periodDays);
  const sampleLimit = Math.min(Math.max(Number(opts.sample_limit) || 20, 1), 100);

  const counts = db.prepare(`
    SELECT
      COUNT(*) AS total_commits,
      SUM(CASE WHEN attribution_method = 'null_fallback' THEN 1 ELSE 0 END) AS null_fallback_count,
      SUM(CASE WHEN attribution_method = 'co_authored_by' THEN 1 ELSE 0 END) AS co_authored_by_count,
      SUM(CASE WHEN attribution_method = 'body_pattern' THEN 1 ELSE 0 END) AS body_pattern_count
    FROM output_commit WHERE occurred_at >= ${bound}
  `).get();

  const sample = db.prepare(`
    SELECT repo, commit_sha, occurred_at, subject
    FROM output_commit
    WHERE occurred_at >= ${bound} AND attribution_method = 'null_fallback'
    ORDER BY occurred_at DESC
    LIMIT ?
  `).all(sampleLimit);

  return {
    period_days: periodDays,
    total_commits: counts.total_commits || 0,
    null_fallback_count: counts.null_fallback_count || 0,
    co_authored_by_count: counts.co_authored_by_count || 0,
    body_pattern_count: counts.body_pattern_count || 0,
    null_fallback_pct: counts.total_commits
      ? Math.round((counts.null_fallback_count / counts.total_commits) * 100)
      : 0,
    sample,
  };
}

/**
 * Per-agent merge list for drill-through detail surface.
 */
function listMergesByAgent(db, agentId, opts = {}) {
  const periodDays = parsePeriod(opts.period);
  const bound = periodBound(periodDays);
  return db.prepare(`
    SELECT repo, merge_commit_sha, occurred_at, source_branch, target_branch,
           pr_number, parent_commit_count, bytes_delta
    FROM output_merge
    WHERE merged_by_agent = ? AND occurred_at >= ${bound}
    ORDER BY occurred_at DESC
  `).all(agentId);
}

/**
 * Anomaly detection per ADR-0032 §5 + bizmodel #7939. Returns days where
 * cost-rate spiked beyond `threshold × prior-mean`. Mirrors CP11.4
 * Anomaly pattern.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {number} [opts.threshold] - default 2.0 (2x prior mean)
 * @param {number} [opts.lookback_days] - default 7 (compare today vs prior 7d mean)
 */
function detectAnomalies(db, opts = {}) {
  const threshold = Number(opts.threshold) || 2.0;
  const lookback = Number(opts.lookback_days) || 7;

  const todayCost = db.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS c FROM cost_daily WHERE date = date('now')`,
  ).get().c;

  const priorMean = db.prepare(
    `SELECT COALESCE(AVG(daily_sum), 0) AS m FROM (
      SELECT date, SUM(cost_usd) AS daily_sum
      FROM cost_daily
      WHERE date >= date('now', '-${lookback} days') AND date < date('now')
      GROUP BY date
    )`,
  ).get().m;

  const ratio = priorMean === 0 ? null : todayCost / priorMean;
  const isSpike = ratio !== null && ratio >= threshold;

  return {
    today_cost_usd: todayCost,
    prior_mean_usd: priorMean,
    ratio,
    threshold,
    lookback_days: lookback,
    is_spike: isSpike,
  };
}

module.exports = {
  AUDIENCE_TIERS,
  CROSS_TIER_SAFE_RATIOS,
  PRACTITIONER_ONLY_RATIOS,
  computeRatios,
  filterRatiosByAudience,
  computeCompositionByAgent,
  computeCompositionByRepo,
  computeCoverageGap,
  listMergesByAgent,
  detectAnomalies,
};
