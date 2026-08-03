// CP11.2 (2026-06-04): Phase 2 of ratified ADR-0029 (Yaklog cost-history
// persistence + finance viz). Prom → cost_daily rollup job.
//
// Implements:
//   - rollupDay(dateUTC, {windowS, offsetS}) — query Prom for one calendar
//     day, UPSERT into cost_daily per (agent_id, user_email, organization_id,
//     model) tuple. Joins cost_dimension_tags for operator-tag enrichment
//     on write (forward-propagate; never retroactive per bizmodel §Q2).
//   - scheduleNightly() — 00:30 UTC daily; rolls up YESTERDAY (24h window
//     with 30m offset so we look at 00:00→23:59 of prior day cleanly).
//   - scheduleIntraday(intervalMs) — every 1h (default); rolls up TODAY
//     (window = elapsed-since-midnight). Idempotent UPSERT lets re-runs
//     refine the same row.
//   - backfill(daysBack) — one-shot at server startup; walks back N days
//     (bounded by Prom retention; default 15 per OQ#1 CONCUR).
//
// Per ADR-0029 v2.3 ratified scope. Per feedback_canonical_adrs_are_read_only_for_me
// — design follows the ratified canonical exactly (10 OQs LOCKED per v2.2).

const config = require('./config');
const {
  upsertCostDaily,
  getCostDimensionTags,
} = require('./db');

// ── Helpers ──────────────────────────────────────────────────────────────

// YYYY-MM-DD UTC for a Date object.
function dateToYmd(d) {
  return d.toISOString().slice(0, 10);
}

// Start-of-day UTC for a YYYY-MM-DD string.
function ymdToStartOfDayUtc(ymd) {
  return new Date(`${ymd}T00:00:00Z`);
}

// True if YYYY-MM-DD is "today" in UTC.
function ymdIsToday(ymd) {
  return ymd === dateToYmd(new Date());
}

// Prom fetch helper (mirrors yaklogRoutes.promFetch shape; standalone copy
// to avoid circular import). Times out via AbortController.
async function promFetch(path, params, { timeoutMs = config.yaklogQueryTimeoutMs || 10000 } = {}) {
  const url = new URL(`${config.yaklogPromUrl}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { status: 'error', error: text }; }
    return { httpStatus: r.status, body: json };
  } finally {
    clearTimeout(t);
  }
}

// ── Rollup core ──────────────────────────────────────────────────────────

// Tag enrichment cache to avoid hammering cost_dimension_tags for the same
// agent_id repeatedly within a single rollup batch.
function buildTagsCache(agentIds) {
  const cache = new Map();
  for (const id of agentIds) {
    if (cache.has(id)) continue;
    cache.set(id, getCostDimensionTags(id) || null);
  }
  return cache;
}

// Roll up one day. windowS = how many seconds to query backward;
// offsetS = how many seconds to offset the window into the past.
//
// For YESTERDAY at nightly job: windowS = 86400, offsetS = (elapsed-since-yesterday-end).
// For TODAY at intraday: windowS = elapsed-since-midnight, offsetS = 0.
async function rollupDay(ymd, opts = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    throw new Error(`rollupDay: ymd must be YYYY-MM-DD, got ${ymd}`);
  }

  const isToday = ymdIsToday(ymd);
  let windowS, offsetClause;
  if (opts.windowS != null && opts.offsetS != null) {
    windowS = opts.windowS;
    offsetClause = opts.offsetS > 0 ? ` offset ${opts.offsetS}s` : '';
  } else if (isToday) {
    // TODAY: window = elapsed-since-midnight (in seconds), offset = 0
    const startOfDay = ymdToStartOfDayUtc(ymd).getTime();
    windowS = Math.max(60, Math.floor((Date.now() - startOfDay) / 1000));
    offsetClause = '';
  } else {
    // ARBITRARY PAST DAY: window = 24h, offset = how far past midnight-end-of-day is from now
    const endOfDay = ymdToStartOfDayUtc(ymd).getTime() + 86400_000;
    const offsetS = Math.max(0, Math.floor((Date.now() - endOfDay) / 1000));
    windowS = 86400;
    offsetClause = offsetS > 0 ? ` offset ${offsetS}s` : '';
  }

  // CP11.2 schema-aligned dim list. Note: `host` column exists in cost_daily
  // but no equivalent Prom label (closest is host_arch/os_type; per ADR-0029
  // v2.3 facts §4 — recommend leaving host empty for v1; future migration
  // can map host_arch in if useful).
  const dimsForGrouping = ['yaklog_agent_id', 'user_email', 'organization_id', 'model'];
  const groupBy = dimsForGrouping.join(', ');

  // Cost query: sum by dims of increase over the window.
  const costPromql = `sum by (${groupBy}) (increase(claude_code_cost_usage_USD_total[${windowS}s]${offsetClause}))`;
  // Tokens query: same dims + type for per-bucket breakdown.
  const tokenPromql = `sum by (${groupBy}, type) (increase(claude_code_token_usage_tokens_total[${windowS}s]${offsetClause}))`;
  // CP11.x.1 (2026-06-15) Jon-direct "complete all CP11 items": multi-runtime
  // token rollup. Codex emits `yaklog_tokens_{input,output}_total` with
  // `yaklog_runtime_class` resource attribute (per s345-aieng #8539 canonical
  // schema). Gemini will emit through the same family when wiring lands
  // (currently zero series). No cost USD counter for codex/gemini — these
  // runtimes have no Anthropic-style cost-tagged metric (consumed via
  // workspace/quota API). cost_usd stays $0 for these rows; tokens are
  // accurately tracked. Future CP11.x.x cycle can derive cost from per-vendor
  // ratemap × token counts if/when bizmodel asks. Per
  // [[feedback_canonical_phase_label_check_before_claiming]] honesty:
  // "token-tracked / cost-untracked" surface in dashboard tooltip.
  //
  // Grouping uses yaklog_runtime_class (not model — codex's yaklog_tokens
  // metrics carry no model label per #8907 empirical probe). Vendor derivation
  // happens server-side via vendorOf() OR by the upsertCostDaily caller
  // passing vendor explicitly (we use the explicit path for these rows since
  // model is synthetic).
  const multiRuntimeGroupBy = 'yaklog_agent_id, user_email, organization_id, yaklog_runtime_class';
  const multiRuntimeInputPromql = `sum by (${multiRuntimeGroupBy}) (increase(yaklog_tokens_input_total[${windowS}s]${offsetClause}))`;
  const multiRuntimeOutputPromql = `sum by (${multiRuntimeGroupBy}) (increase(yaklog_tokens_output_total[${windowS}s]${offsetClause}))`;

  const [costRes, tokenRes, multiInputRes, multiOutputRes] = await Promise.all([
    promFetch('/api/v1/query', { query: costPromql }),
    promFetch('/api/v1/query', { query: tokenPromql }),
    promFetch('/api/v1/query', { query: multiRuntimeInputPromql }),
    promFetch('/api/v1/query', { query: multiRuntimeOutputPromql }),
  ]);

  if (costRes.httpStatus !== 200 || costRes.body.status !== 'success') {
    throw new Error(`rollupDay cost query failed (HTTP ${costRes.httpStatus}): ${JSON.stringify(costRes.body).slice(0, 200)}`);
  }
  if (tokenRes.httpStatus !== 200 || tokenRes.body.status !== 'success') {
    throw new Error(`rollupDay tokens query failed (HTTP ${tokenRes.httpStatus}): ${JSON.stringify(tokenRes.body).slice(0, 200)}`);
  }
  // Multi-runtime queries fail-soft: a non-success response from these new
  // queries should NOT abort the CC rollup. Log + continue with empty result.
  if (multiInputRes.httpStatus !== 200 || multiInputRes.body.status !== 'success') {
    console.warn(`[costRollup] CP11.x.1 multi-runtime input query non-success (HTTP ${multiInputRes.httpStatus}); skipping non-CC runtimes this cycle`);
    multiInputRes.body = { data: { result: [] } };
  }
  if (multiOutputRes.httpStatus !== 200 || multiOutputRes.body.status !== 'success') {
    console.warn(`[costRollup] CP11.x.1 multi-runtime output query non-success (HTTP ${multiOutputRes.httpStatus}); skipping non-CC runtimes this cycle`);
    multiOutputRes.body = { data: { result: [] } };
  }

  // Build a map keyed by the dim-tuple. Cost rows are unique per (dims);
  // token rows are unique per (dims + type) — fold types into one row.
  const byKey = new Map();
  const dimKey = (m) => [
    m.yaklog_agent_id || '',
    m.user_email || '',
    m.organization_id || '',
    m.model || '',
  ].join(' ');

  for (const series of (costRes.body.data && costRes.body.data.result) || []) {
    const m = series.metric || {};
    const value = parseFloat((series.value && series.value[1]) || '0') || 0;
    const k = dimKey(m);
    const row = byKey.get(k) || {
      agent_id: m.yaklog_agent_id || '',
      user_email: m.user_email || '',
      organization_id: m.organization_id || '',
      model: m.model || '',
      host: '',  // see ADR-0029 v2.3 facts §4; no Prom equivalent
      cost_usd: 0,
      tokens_input: 0,
      tokens_output: 0,
      tokens_cache_read: 0,
      tokens_cache_creation: 0,
    };
    row.cost_usd += value;
    byKey.set(k, row);
  }

  for (const series of (tokenRes.body.data && tokenRes.body.data.result) || []) {
    const m = series.metric || {};
    const value = parseFloat((series.value && series.value[1]) || '0') || 0;
    const k = dimKey(m);
    let row = byKey.get(k);
    if (!row) {
      // Tokens series but no cost series — possible if cost is 0 for this dim;
      // create the row so token counts are still captured.
      row = {
        agent_id: m.yaklog_agent_id || '',
        user_email: m.user_email || '',
        organization_id: m.organization_id || '',
        model: m.model || '',
        host: '',
        cost_usd: 0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_cache_read: 0,
        tokens_cache_creation: 0,
      };
      byKey.set(k, row);
    }
    // Map CC token type → cost_daily column.
    // Known type label values: input, output, cacheRead, cacheCreation.
    switch (m.type) {
      case 'input': row.tokens_input += Math.round(value); break;
      case 'output': row.tokens_output += Math.round(value); break;
      case 'cacheRead': row.tokens_cache_read += Math.round(value); break;
      case 'cacheCreation': row.tokens_cache_creation += Math.round(value); break;
      // unknown type → drop (default-deny; matches activity-distillation discipline)
    }
  }

  // CP11.x.1 (2026-06-15): merge multi-runtime (codex / gemini) token series.
  // These metrics carry `yaklog_runtime_class` instead of `model` — we use
  // the runtime_class string as the synthetic model name so per-runtime
  // breakdowns work at the dashboard layer. Vendor is derived via the same
  // upsertCostDaily path (which prefers caller-supplied vendor, falls back
  // to vendorOf(model)). We pass explicit vendor on insert via the rows-fold
  // below since runtime_class → vendor is more direct than model-prefix
  // pattern-matching (which only recognizes 'claude-' / 'gemini-' / 'gpt-' /
  // 'codex-' / 'o1-4-' prefixes per db.js vendorOf).
  //
  // RUNTIME_CLASS_TO_VENDOR map: keep in sync with vendorOf() in db.js and
  // with s345-aieng #8539 canonical schema enum.
  const RUNTIME_CLASS_TO_VENDOR = {
    'claude-code': 'Anthropic',
    'codex-cli': 'OpenAI',
    'gemini-cli': 'Google',
  };
  const multiRuntimeKey = (m) => [
    m.yaklog_agent_id || '',
    m.user_email || '',
    m.organization_id || '',
    m.yaklog_runtime_class || '',
  ].join(' ');
  const mergeMultiRuntime = (series, field) => {
    for (const s of series) {
      const m = s.metric || {};
      const runtime_class = m.yaklog_runtime_class || '';
      if (!runtime_class) continue;  // skip un-classed series (cluster hygiene)
      const value = parseFloat((s.value && s.value[1]) || '0') || 0;
      const k = multiRuntimeKey(m);
      let row = byKey.get(k);
      if (!row) {
        row = {
          agent_id: m.yaklog_agent_id || '',
          user_email: m.user_email || '',
          organization_id: m.organization_id || '',
          model: runtime_class,  // synthetic model = runtime_class string
          vendor: RUNTIME_CLASS_TO_VENDOR[runtime_class] || 'Other',
          host: '',
          cost_usd: 0,  // no cost USD counter for codex/gemini (see CP11.x.1 note above)
          tokens_input: 0,
          tokens_output: 0,
          tokens_cache_read: 0,
          tokens_cache_creation: 0,
        };
        byKey.set(k, row);
      }
      row[field] += Math.round(value);
    }
  };
  mergeMultiRuntime((multiInputRes.body.data && multiInputRes.body.data.result) || [], 'tokens_input');
  mergeMultiRuntime((multiOutputRes.body.data && multiOutputRes.body.data.result) || [], 'tokens_output');

  if (byKey.size === 0) {
    // No data for this day; not an error. Could be a quiet day or no agents
    // had emitted by this point. Leave cost_daily unchanged.
    return { date: ymd, rows: 0, agents: 0 };
  }

  // Enrich with operator tags + UPSERT.
  const agentIds = [...new Set([...byKey.values()].map((r) => r.agent_id).filter(Boolean))];
  const tagsCache = buildTagsCache(agentIds);
  const computedAt = new Date().toISOString();
  const source = opts.source || 'prom';

  let inserted = 0;
  for (const row of byKey.values()) {
    const tags = (row.agent_id && tagsCache.get(row.agent_id)) || {};
    upsertCostDaily({
      date: ymd,
      agent_id: row.agent_id,
      user_email: row.user_email,
      organization_id: row.organization_id,
      model: row.model,
      // CP11.x.1: explicit vendor only when set by multi-runtime fold;
      // CC path leaves undefined and lets db.js vendorOf(model) derive
      // 'Anthropic' from the model string. Mixed strategy preserves
      // backward compat for the CC rollup hot path.
      vendor: row.vendor,
      host: row.host,
      cost_center: tags.cost_center || '',
      project_tag: tags.project_tag || '',
      environment_tier: tags.environment_tier || '',
      billable_flag: tags.billable_flag || 0,
      tokens_input: row.tokens_input,
      tokens_output: row.tokens_output,
      tokens_cache_read: row.tokens_cache_read,
      tokens_cache_creation: row.tokens_cache_creation,
      cost_usd: row.cost_usd,
      source,
      computed_at: computedAt,
    });
    inserted += 1;
  }

  return { date: ymd, rows: inserted, agents: agentIds.length };
}

// ── Schedulers ───────────────────────────────────────────────────────────

let _nightlyTimer = null;
let _intradayTimer = null;

// 00:30 UTC daily. Runs YESTERDAY's full 24h rollup with 30m offset.
function scheduleNightly() {
  function nextNightlyMs() {
    const now = new Date();
    const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 30, 0));
    if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
    return target - now;
  }
  function fire() {
    const yesterday = new Date(Date.now() - 86400_000);
    const ymd = dateToYmd(yesterday);
    rollupDay(ymd).then((r) => {
      console.log(`[costRollup] nightly: rolled up ${ymd} → ${r.rows} rows (${r.agents} agents)`);
    }).catch((e) => {
      console.error(`[costRollup] nightly rollup ${ymd} failed: ${e.message}`);
    });
    _nightlyTimer = setTimeout(fire, nextNightlyMs());
  }
  _nightlyTimer = setTimeout(fire, nextNightlyMs());
}

// Intraday: every intervalMs (default 1h). Runs TODAY's rollup with current
// elapsed-since-midnight window. Idempotent UPSERT refines the same row.
function scheduleIntraday(intervalMs = 3600_000) {
  function fire() {
    const today = dateToYmd(new Date());
    rollupDay(today).then((r) => {
      console.log(`[costRollup] intraday: rolled up ${today} → ${r.rows} rows (${r.agents} agents)`);
    }).catch((e) => {
      console.error(`[costRollup] intraday rollup ${today} failed: ${e.message}`);
    });
  }
  // Initial fire after 60s (let server settle); then every intervalMs.
  _intradayTimer = setTimeout(() => {
    fire();
    _intradayTimer = setInterval(fire, intervalMs);
  }, 60_000);
}

// One-shot at server startup. Walks daysBack days (bounded by Prom retention).
// Per OQ#1 CONCUR-on-15d: default 15 days.
async function backfill(daysBack = 15) {
  const results = [];
  for (let i = 1; i <= daysBack; i++) {
    const d = new Date(Date.now() - i * 86400_000);
    const ymd = dateToYmd(d);
    try {
      const r = await rollupDay(ymd, { source: 'backfill' });
      results.push(r);
    } catch (e) {
      console.error(`[costRollup] backfill ${ymd} failed: ${e.message}`);
      results.push({ date: ymd, error: e.message });
    }
  }
  // Also roll up today so dashboards have current-day data immediately.
  try {
    const r = await rollupDay(dateToYmd(new Date()), { source: 'backfill' });
    results.push(r);
  } catch (e) {
    console.error(`[costRollup] backfill today failed: ${e.message}`);
  }
  const ok = results.filter((r) => !r.error).length;
  console.log(`[costRollup] backfill complete: ${ok}/${results.length} days rolled up`);
  return results;
}

// Stop schedulers (for tests + graceful shutdown).
function stopSchedulers() {
  if (_nightlyTimer) { clearTimeout(_nightlyTimer); _nightlyTimer = null; }
  if (_intradayTimer) { clearTimeout(_intradayTimer); clearInterval(_intradayTimer); _intradayTimer = null; }
}

module.exports = {
  rollupDay,
  scheduleNightly,
  scheduleIntraday,
  backfill,
  stopSchedulers,
  // Exported for test-injection
  _internal: { dateToYmd, ymdToStartOfDayUtc, ymdIsToday },
};
