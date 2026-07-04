// Plexus query proxy — Plan C Stage 2 CP1.
//
// Why a server-side proxy (not direct frontend → Prom):
//   - Frontend never gets a Prom credential or network path.
//   - Auth = existing YAKLOG_TOKEN (one credential, not two).
//   - Allowlist of parameterized templates prevents arbitrary PromQL
//     injection / DoS (a malicious or buggy agent can't `sum by(...) (rate(<expensive>[1y]))`).
//   - In-memory cache amortizes Prom load on dashboard auto-refresh.
//
// Stage 2 V1 surface:
//   GET /api/v1/plexus/templates                     — discovery; lists allowlist
//   GET /api/v1/plexus/query?template=X&...          — instant query
//   GET /api/v1/plexus/query_range?template=X&...    — range query (step + from + to)
//
// All endpoints require Bearer YAKLOG_TOKEN (mounted AFTER global auth in app.js).

const express = require('express');
const config = require('./config');

const router = express.Router();
const publicRouter = express.Router();

// ──────────────────────────────────────────────────────────────────────
// Query templates (allowlist).
//
// Each template:
//   - `build(params)`: validates + returns PromQL string. Throws on bad params.
//   - `params`: declared param spec for /templates discovery + validation.
//   - `kind`: 'instant' | 'range' | 'both'  (which endpoint(s) accept it).
//
// Validation strategy: every parameter that lands in PromQL string is either
//   (a) enum-whitelisted (e.g., `dim` ∈ {user_email, organization_id, ...}), or
//   (b) regex-matched to a known-safe shape (e.g., agent_id matches /^[\w.-]+$/).
// We never interpolate user input into PromQL without one of those checks.
// ──────────────────────────────────────────────────────────────────────

// Slicing dims permitted in Cost views. Order matters for /templates display.
const COST_DIM_ALLOWLIST = new Set([
  'plexus_agent_id',
  'user_email',
  'user_id',
  'user_account_id',
  'organization_id',
  'model',
]);

// PromQL-safe identifier regex (label values for filtering). Generous but
// disallows special chars that would break PromQL escaping. We also escape
// quotes on the way in as a belt-and-suspenders.
const SAFE_LABEL_VALUE = /^[\w@.+:/-]{1,128}$/;

// Rate window for *_rate templates. Whitelisted to prevent unbounded windows.
const RATE_WINDOW_ALLOWLIST = new Set(['1m', '5m', '15m', '1h', '1d']);

function escapeLabelValue(v) {
  // PromQL label values: escape backslash, double-quote, newline.
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function requireEnum(name, value, allowed) {
  if (!allowed.has(value)) {
    throw badRequest(`param ${name} must be one of: ${[...allowed].join(', ')}`);
  }
}

function requireSafeLabelValue(name, value) {
  if (typeof value !== 'string' || !SAFE_LABEL_VALUE.test(value)) {
    throw badRequest(`param ${name} contains characters not allowed in PromQL label values`);
  }
}

function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

const templates = {
  // ── Live tab ──────────────────────────────────────────────────────────
  'tokens.rate.byAgent': {
    kind: 'both',
    params: {
      window: { required: false, default: '5m', enum: RATE_WINDOW_ALLOWLIST },
    },
    build({ window }) {
      requireEnum('window', window, RATE_WINDOW_ALLOWLIST);
      return `sum by (plexus_agent_id, model, type) (rate(claude_code_token_usage_tokens_total[${window}]))`;
    },
  },

  'cost.rate.byAgent': {
    kind: 'both',
    params: {
      window: { required: false, default: '5m', enum: RATE_WINDOW_ALLOWLIST },
    },
    build({ window }) {
      requireEnum('window', window, RATE_WINDOW_ALLOWLIST);
      return `sum by (plexus_agent_id, model) (rate(claude_code_cost_usage_USD_total[${window}]))`;
    },
  },

  'session.count.byAgent': {
    kind: 'both',
    params: {},
    build() {
      return 'sum by (plexus_agent_id) (claude_code_session_count_total)';
    },
  },

  'active_time.rate.byAgent': {
    kind: 'both',
    params: {
      window: { required: false, default: '5m', enum: RATE_WINDOW_ALLOWLIST },
    },
    build({ window }) {
      requireEnum('window', window, RATE_WINDOW_ALLOWLIST);
      return `sum by (plexus_agent_id) (rate(claude_code_active_time_seconds_total[${window}]))`;
    },
  },

  // ── Cost tab ──────────────────────────────────────────────────────────
  'cost.cumulative.byDim': {
    kind: 'both',
    params: {
      dim: { required: true, enum: COST_DIM_ALLOWLIST },
    },
    build({ dim }) {
      requireEnum('dim', dim, COST_DIM_ALLOWLIST);
      return `sum by (${dim}) (claude_code_cost_usage_USD_total)`;
    },
  },

  'cost.rate.byDim': {
    kind: 'both',
    params: {
      dim: { required: true, enum: COST_DIM_ALLOWLIST },
      window: { required: false, default: '5m', enum: RATE_WINDOW_ALLOWLIST },
    },
    build({ dim, window }) {
      requireEnum('dim', dim, COST_DIM_ALLOWLIST);
      requireEnum('window', window, RATE_WINDOW_ALLOWLIST);
      return `sum by (${dim}) (rate(claude_code_cost_usage_USD_total[${window}]))`;
    },
  },

  // ── Overlay-popup identity fetch ──────────────────────────────────────
  // CP6.7 (2026-05-25): switched from claude_code_session_count_total to
  // claude_code_active_time_seconds_total. session_count only emits at
  // SessionStart (once per CC session) — Prom drops it from instant
  // queries after 5min staleness, so long-running sessions had no
  // identity data. active_time pushes on every tool use + carries the
  // same identity labels (user_email, user_account_id, organization_id,
  // host_arch, os_*, terminal_type, service_version, plexus.*) but
  // stays fresh as long as the agent is actively working.
  // v0.5.8.3 (2026-05-26): wrap in last_over_time([24h]) so labels persist
  // for idle agents (the live instant query goes stale after ~5min). Also
  // OR with gemini_runtime_cycle_total so Gemini agents get identity too
  // (CC-only metric returned nothing for them, showing "no OTel data"
  // even on actively-emitting Gemini seats).
  'agent.identity.byAgentId': {
    kind: 'instant',
    params: {
      agent_id: { required: true, validator: requireSafeLabelValue },
    },
    build({ agent_id }) {
      requireSafeLabelValue('agent_id', agent_id);
      const id = escapeLabelValue(agent_id);
      return `last_over_time(claude_code_active_time_seconds_total{plexus_agent_id="${id}"}[24h]) or last_over_time(gemini_runtime_cycle_total{plexus_agent_id="${id}"}[24h])`;
    },
  },

  // ── CP6.1: cluster cost-accounting (mirrors streamer FRAMES; lets
  // ad-hoc curl tooling hit the same data the dashboard hero gets via SSE).
  // The streamer's dynamic @ timestamps aren't replayable here — these
  // versions use static queries with no time-anchoring, so they reflect
  // cumulative-since-start-of-Prom-retention rather than today/MTD. For
  // accurate today/MTD numbers, consume via the SSE stream.
  'cluster.cost.7d': {
    kind: 'instant',
    params: {},
    build() {
      return 'sum(increase(claude_code_cost_usage_USD_total[7d]))';
    },
  },

  'cluster.cost.topAgents': {
    kind: 'instant',
    params: {},
    build() {
      return 'topk(10, sum by (plexus_agent_id) (claude_code_cost_usage_USD_total))';
    },
  },

  'cluster.cost.byAccount': {
    kind: 'instant',
    params: {},
    build() {
      return 'topk(10, sum by (user_email, user_account_id) (claude_code_cost_usage_USD_total))';
    },
  },

  'cluster.cost.spark24h': {
    kind: 'range',
    params: {},
    build() {
      return 'sum(increase(claude_code_cost_usage_USD_total[15m]))';
    },
  },
};

// ──────────────────────────────────────────────────────────────────────
// In-memory TTL cache. Capped size; entries past TTL are skipped + lazy-evicted.
// Not strictly LRU (would add complexity for unclear V1 win); rough FIFO when
// cap is reached: oldest insert is dropped first.
// ──────────────────────────────────────────────────────────────────────
const cache = new Map(); // cacheKey -> { expiresAt, body }

function cacheKey(template, params, range) {
  return JSON.stringify([template, params, range || null]);
}
function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.body;
}
function cacheSet(key, body) {
  if (cache.size >= config.plexusQueryCacheMaxEntries) {
    // Evict oldest insert (Map preserves insertion order)
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, { expiresAt: Date.now() + config.plexusQueryCacheTtlMs, body });
}

// ──────────────────────────────────────────────────────────────────────
// Prom fetch helper. Times out via AbortController.
// ──────────────────────────────────────────────────────────────────────
async function promFetch(path, params) {
  const url = new URL(`${config.plexusPromUrl}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), config.plexusQueryTimeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { status: 'error', error: text }; }
    return { httpStatus: r.status, body: json };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { httpStatus: 504, body: { status: 'error', errorType: 'timeout', error: `Prom did not respond within ${config.plexusQueryTimeoutMs}ms` } };
    }
    return { httpStatus: 502, body: { status: 'error', errorType: 'upstream_unreachable', error: String(err.message || err) } };
  } finally {
    clearTimeout(t);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Param resolution + validation against template spec.
// ──────────────────────────────────────────────────────────────────────
function resolveParams(template, query) {
  const out = {};
  for (const [name, spec] of Object.entries(template.params)) {
    let v = query[name];
    if (v === undefined || v === '') {
      if (spec.required) throw badRequest(`missing required param: ${name}`);
      if (spec.default !== undefined) v = spec.default;
    }
    if (v !== undefined) {
      if (spec.enum && !spec.enum.has(v)) {
        throw badRequest(`param ${name} must be one of: ${[...spec.enum].join(', ')}`);
      }
      if (spec.validator) spec.validator(name, v);
      out[name] = v;
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Range-query inputs validation. `from` and `to` are RFC3339 or unix seconds;
// `step` is a whitelisted duration to bound query cost.
// ──────────────────────────────────────────────────────────────────────
const STEP_ALLOWLIST = new Set(['15s', '30s', '1m', '5m', '15m', '1h']);

function validateTime(name, v) {
  if (typeof v !== 'string') throw badRequest(`param ${name} must be a string (RFC3339 or unix-seconds)`);
  if (!/^\d+(\.\d+)?$/.test(v) && !/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    throw badRequest(`param ${name} not a valid RFC3339 timestamp or unix-seconds number`);
  }
}
function validateStep(v) {
  if (!STEP_ALLOWLIST.has(v)) throw badRequest(`step must be one of: ${[...STEP_ALLOWLIST].join(', ')}`);
}

// ──────────────────────────────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────────────────────────────

function templatesHandler(req, res) {
  // Discovery endpoint — lists allowlist for frontend + curl debugging.
  const out = {};
  for (const [name, spec] of Object.entries(templates)) {
    out[name] = {
      kind: spec.kind,
      params: Object.fromEntries(
        Object.entries(spec.params).map(([n, s]) => [n, {
          required: !!s.required,
          default: s.default,
          allowed: s.enum ? [...s.enum] : undefined,
        }])
      ),
    };
  }
  res.json({ templates: out });
}
router.get('/templates', templatesHandler);

async function queryHandler(req, res) {
  const name = req.query.template;
  if (!name) return res.status(400).json({ error: 'missing param: template' });
  const tmpl = templates[name];
  if (!tmpl) return res.status(422).json({ error: `unknown template: ${name}` });
  if (tmpl.kind === 'range') return res.status(422).json({ error: `template ${name} requires /query_range` });

  let params, promql;
  try {
    params = resolveParams(tmpl, req.query);
    promql = tmpl.build(params);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }

  const key = cacheKey(name, params, null);
  const cached = cacheGet(key);
  if (cached) {
    res.set('X-Plexus-Cache', 'hit');
    return res.json(cached);
  }

  const promParams = { query: promql };
  if (req.query.time) {
    try { validateTime('time', req.query.time); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    promParams.time = req.query.time;
  }
  const { httpStatus, body } = await promFetch('/api/v1/query', promParams);
  if (httpStatus < 200 || httpStatus >= 300) {
    return res.status(httpStatus).json({ error: 'prom_upstream_error', promResponse: body });
  }
  const out = { template: name, params, query: promql, ...body };
  cacheSet(key, out);
  res.set('X-Plexus-Cache', 'miss');
  res.json(out);
}
router.get('/query', queryHandler);

async function queryRangeHandler(req, res) {
  const name = req.query.template;
  if (!name) return res.status(400).json({ error: 'missing param: template' });
  const tmpl = templates[name];
  if (!tmpl) return res.status(422).json({ error: `unknown template: ${name}` });
  if (tmpl.kind === 'instant') return res.status(422).json({ error: `template ${name} requires /query (instant only)` });

  let params, promql;
  try {
    params = resolveParams(tmpl, req.query);
    promql = tmpl.build(params);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }

  const from = req.query.from;
  const to = req.query.to;
  const step = req.query.step;
  if (!from || !to || !step) return res.status(400).json({ error: 'missing required params: from, to, step' });
  try { validateTime('from', from); validateTime('to', to); validateStep(step); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

  const rangeKey = `${from}|${to}|${step}`;
  const key = cacheKey(name, params, rangeKey);
  const cached = cacheGet(key);
  if (cached) {
    res.set('X-Plexus-Cache', 'hit');
    return res.json(cached);
  }

  const { httpStatus, body } = await promFetch('/api/v1/query_range', {
    query: promql, start: from, end: to, step,
  });
  if (httpStatus < 200 || httpStatus >= 300) {
    return res.status(httpStatus).json({ error: 'prom_upstream_error', promResponse: body });
  }
  const out = { template: name, params, query: promql, range: { from, to, step }, ...body };
  cacheSet(key, out);
  res.set('X-Plexus-Cache', 'miss');
  res.json(out);
}
router.get('/query_range', queryRangeHandler);

// ──────────────────────────────────────────────────────────────────────
// Public sub-router — mirrors /query + /query_range without auth.
// Mounted at /api/v1/plexus/public/ in app.js.
//
// Why public: the /dashboard browser surface cannot easily hold a Bearer
// token (no cookie-auth session today). Mirrors the existing
// /api/v1/presence/public pattern. The allowlist + cache + Prom proxy
// behaviour is IDENTICAL; only auth differs.
//
// Security posture: on devel single-tenant, the data exposed here is
// the same Jon's-own-data already visible via /presence/public. The
// allowlist guarantees no arbitrary PromQL can be executed via this
// surface. For production multi-tenant deployments, the dashboard
// must grow a cookie-auth session and this /public surface goes away.
// Flagged in PLAN-C-STAGE-2-DESIGN.md §5 (auth deferred work).
// ──────────────────────────────────────────────────────────────────────
publicRouter.get('/query', queryHandler);
publicRouter.get('/query_range', queryRangeHandler);
publicRouter.get('/templates', templatesHandler);

// CP5 / Stage 2.5: SSE push channel for the Live-tab frames. Server runs
// one poll loop per frame; clients receive deltas as Server-Sent Events.
// See src/plexusStreamer.js for the architecture rationale.
const { streamHandler: plexusStreamHandler } = require('./plexusStreamer');
publicRouter.get('/stream', plexusStreamHandler);

// v0.5.8.5 (2026-05-27): bus-feed public mirror for the dashboard #bus tab
// + Live-tab ticker. Unauth → applyDmVisibilityFilter unbound-path returns
// public-only (private=0 rows). DM visibility deferred to item #2 of the
// dashboard-gap plan (needs browser-side auth surface; Stage 2.5+).
const { listMessages } = require('./db');
const { applyDmVisibilityFilter } = require('./middleware/dmFilter');
const { streamHandler: messageStreamHandler } = require('../src/stream');

const PUBLIC_MESSAGES_CHANNEL_RE = /^[a-zA-Z0-9._-]{1,64}$/;
function parsePosInt(v, fallback, max) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  if (max !== undefined && n > max) return max;
  return n;
}

publicRouter.get('/messages', (req, res) => {
  const limit = parsePosInt(req.query.limit, 50, 200);
  if (limit === null) {
    return res.status(400).json({ error: 'ValidationError', message: 'limit must be a non-negative integer (max 200).' });
  }
  const channel = req.query.channel ? String(req.query.channel) : null;
  if (channel && !PUBLIC_MESSAGES_CHANNEL_RE.test(channel)) {
    return res.status(400).json({ error: 'ValidationError', message: 'channel must match [a-zA-Z0-9._-] (1-64 chars).' });
  }
  const afterId = parsePosInt(req.query.after_id, null);
  const beforeId = parsePosInt(req.query.before_id, null);
  if (req.query.after_id !== undefined && afterId === null && req.query.after_id !== '') {
    return res.status(400).json({ error: 'ValidationError', message: 'after_id must be a non-negative integer.' });
  }
  if (req.query.before_id !== undefined && beforeId === null && req.query.before_id !== '') {
    return res.status(400).json({ error: 'ValidationError', message: 'before_id must be a non-negative integer.' });
  }
  // Task #264 Phase 2.6 (Jon-direct 2026-07-03): time-anchored cursor for
  // dashboard-tier Bus tab time-navigation. Sister-shape /api/v1/messages
  // extension at routes.js:73 — before_ts_ms / after_ts_ms epoch-ms → ISO.
  const beforeTsMs = parsePosInt(req.query.before_ts_ms, null);
  const afterTsMs = parsePosInt(req.query.after_ts_ms, null);
  if (req.query.before_ts_ms !== undefined && beforeTsMs === null && req.query.before_ts_ms !== '') {
    return res.status(400).json({ error: 'ValidationError', message: 'before_ts_ms must be a non-negative integer (millisecond epoch).' });
  }
  if (req.query.after_ts_ms !== undefined && afterTsMs === null && req.query.after_ts_ms !== '') {
    return res.status(400).json({ error: 'ValidationError', message: 'after_ts_ms must be a non-negative integer (millisecond epoch).' });
  }
  const beforeTs = beforeTsMs !== null ? new Date(beforeTsMs).toISOString() : null;
  const afterTs = afterTsMs !== null ? new Date(afterTsMs).toISOString() : null;
  const raw = listMessages({ channel, limit, afterId, beforeId, beforeTs, afterTs });
  // req.auth is absent on publicRouter → dmFilter unbound path returns public only.
  const { filtered } = applyDmVisibilityFilter(raw, req);
  return res.json({ messages: filtered, count: filtered.length });
});

publicRouter.get('/messages-stream', messageStreamHandler);

// CP11.3 (2026-06-04) — cost-history public read endpoints (9).
// Per ratified ADR-0029 v2.3 Phase 3. Network-isolation trust per other
// public/* endpoints. All read-only; ops-key mutation endpoints live in
// /api/v1/ops/cost/* (routes.js).
//
// Hybrid persisted+live: periods ending today combine cost_daily rollup
// (persisted) with the intraday-rollup's most-recent computed_at. Periods
// entirely in past read pure cost_daily.

const costQuery = require('./costQuery');
const _costDb = require('./db');

publicRouter.get('/cost/summary', async (req, res) => {
  const period = String(req.query.period || 'mtd');
  try {
    const range = costQuery.periodToRange(period);
    const result = await costQuery.sumCostForRange({ from: range.from, to: range.to });
    return res.json({
      period, ...range, ...result,
    });
  } catch (e) {
    return res.status(400).json({ error: 'ValidationError', message: e.message });
  }
});

// CP11.x.2 (2026-06-13): per-vendor cost summary for the Cost-tab totals strip.
// Returns array of {vendor, cost_usd, share_pct, tokens_*, row_count, agent_count}
// sorted by cost desc. Defaults to month-to-date if period query omitted; accepts
// period (mtd|wtd|prev7d|prev30d|qtr|prevqtr|ytd) or explicit from+to (YYYY-MM-DD).
publicRouter.get('/cost/by-vendor', (req, res) => {
  let from, to;
  try {
    if (req.query.period) {
      const range = costQuery.periodToRange(String(req.query.period));
      from = range.from; to = range.to;
    } else {
      from = req.query.from ? String(req.query.from) : null;
      to = req.query.to ? String(req.query.to) : null;
      if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        // Default to mtd if neither period nor from/to supplied.
        const range = costQuery.periodToRange('mtd');
        from = range.from; to = range.to;
      }
    }
  } catch (e) {
    return res.status(400).json({ error: 'ValidationError', message: e.message });
  }
  const rows = _costDb.getCostByVendor({ from, to });
  const total = rows.reduce((s, r) => s + r.cost_usd, 0);
  const result = rows.map((r) => ({
    ...r,
    share_pct: total > 0 ? Math.round((r.cost_usd / total) * 10000) / 100 : 0,
  }));
  return res.json({ from, to, total_usd: Math.round(total * 10000) / 10000, vendors: result });
});

// CP11.x.2: per-vendor daily time-series for the Composition-lens stacked-area
// chart. Returns array of {date, vendor, cost_usd}. Frontend pivots into the
// uPlot series shape (one series per vendor, x=date).
publicRouter.get('/cost/by-vendor-daily', (req, res) => {
  let from, to;
  try {
    if (req.query.period) {
      const range = costQuery.periodToRange(String(req.query.period));
      from = range.from; to = range.to;
    } else {
      from = req.query.from ? String(req.query.from) : null;
      to = req.query.to ? String(req.query.to) : null;
      if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        const range = costQuery.periodToRange('30d');
        from = range.from; to = range.to;
      }
    }
  } catch (e) {
    return res.status(400).json({ error: 'ValidationError', message: e.message });
  }
  const rows = _costDb.getCostByVendorDaily({ from, to });
  return res.json({ from, to, count: rows.length, rows });
});

publicRouter.get('/cost/daily', (req, res) => {
  const from = req.query.from ? String(req.query.from) : null;
  const to = req.query.to ? String(req.query.to) : null;
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'ValidationError', message: 'from + to required (YYYY-MM-DD)' });
  }
  const by = req.query.by ? String(req.query.by).split(',').map(s => s.trim()) : null;
  // CP11.x.2 (2026-06-13): vendor added to VALID_DIMS so the Cost dashboard
  // can request by=vendor for the per-vendor stacked-area chart.
  const VALID_DIMS = new Set(['agent_id', 'user_email', 'organization_id', 'model', 'host',
    'cost_center', 'project_tag', 'environment_tier', 'billable_flag', 'vendor']);
  if (by && !by.every(d => VALID_DIMS.has(d))) {
    return res.status(400).json({ error: 'ValidationError', message: `by must be CSV of: ${[...VALID_DIMS].join(', ')}` });
  }
  // Single-table query then optionally group at JS layer (cost_daily is small enough).
  const rows = _costDb.getCostByPeriod({ from, to });
  let result;
  if (by && by.length > 0) {
    const grouped = new Map();
    for (const r of rows) {
      const key = by.map(d => String(r[d] != null ? r[d] : '')).join('|');
      let g = grouped.get(key);
      if (!g) {
        g = { date_min: r.date, date_max: r.date,
          cost_usd: 0, tokens_input: 0, tokens_output: 0, tokens_cache_read: 0, tokens_cache_creation: 0 };
        for (const d of by) g[d] = r[d];
        grouped.set(key, g);
      }
      g.cost_usd += r.cost_usd;
      g.tokens_input += r.tokens_input;
      g.tokens_output += r.tokens_output;
      g.tokens_cache_read += r.tokens_cache_read;
      g.tokens_cache_creation += r.tokens_cache_creation;
      if (r.date < g.date_min) g.date_min = r.date;
      if (r.date > g.date_max) g.date_max = r.date;
    }
    result = [...grouped.values()].sort((a, b) => b.cost_usd - a.cost_usd);
  } else {
    result = rows;
  }
  return res.json({ from, to, by, rows: result, count: result.length });
});

publicRouter.get('/cost/projection', (req, res) => {
  const period = String(req.query.period || 'eom');
  try {
    const range = costQuery.projectionPeriodToRange(period);
    const projection = costQuery.projectByLinear(range);
    return res.json({ period, ...projection });
  } catch (e) {
    return res.status(400).json({ error: 'ValidationError', message: e.message });
  }
});

publicRouter.get('/cost/compare', async (req, res) => {
  const period = String(req.query.period || 'mtd');
  const compareTo = String(req.query.compare_to || 'last_month_to_date');
  try {
    const cur = costQuery.periodToRange(period);
    const prev = costQuery.periodToRange(compareTo);
    const curSum = await costQuery.sumCostForRange({ from: cur.from, to: cur.to });
    const prevSum = await costQuery.sumCostForRange({ from: prev.from, to: prev.to });
    const deltaUsd = curSum.value_usd - prevSum.value_usd;
    const deltaPct = prevSum.value_usd > 0 ? (deltaUsd / prevSum.value_usd) * 100 : (curSum.value_usd > 0 ? 100 : 0);
    return res.json({
      current: { period, ...cur, value_usd: curSum.value_usd },
      compare: { period: compareTo, ...prev, value_usd: prevSum.value_usd },
      delta_usd: deltaUsd, delta_pct: deltaPct,
    });
  } catch (e) {
    return res.status(400).json({ error: 'ValidationError', message: e.message });
  }
});

publicRouter.get('/cost/burn-vs-budget', (req, res) => {
  const cost_center = req.query.cost_center != null ? String(req.query.cost_center) : '';
  const period_kind = String(req.query.period_kind || req.query.period || 'monthly');
  if (!['monthly', 'quarterly'].includes(period_kind)) {
    return res.status(400).json({ error: 'ValidationError', message: 'period_kind must be monthly or quarterly' });
  }
  try {
    return res.json(costQuery.burnVsBudget({ cost_center, period_kind }));
  } catch (e) {
    return res.status(500).json({ error: 'InternalError', message: e.message });
  }
});

publicRouter.get('/cost/by-cost-center', (req, res) => {
  const period = String(req.query.period || 'mtd');
  const period_kind = String(req.query.period_kind || 'monthly');
  try {
    const range = costQuery.periodToRange(period);
    const rows = _costDb.getCostByPeriod({ from: range.from, to: range.to });
    const grouped = new Map();
    for (const r of rows) {
      const cc = r.cost_center || '';
      let g = grouped.get(cc) || { cost_center: cc, actual_usd: 0 };
      g.actual_usd += r.cost_usd;
      grouped.set(cc, g);
    }
    // Enrich each with budget if available
    const out = [];
    for (const g of grouped.values()) {
      const budget = costQuery.burnVsBudget({ cost_center: g.cost_center, period_kind });
      out.push({
        cost_center: g.cost_center,
        actual_usd: g.actual_usd,
        budget_usd: budget.budget_usd,
        pct_consumed: budget.pct_consumed != null ? budget.pct_consumed : null,
        threshold_state: budget.threshold_state,
      });
    }
    out.sort((a, b) => b.actual_usd - a.actual_usd);
    return res.json({ period, ...range, period_kind, rows: out, count: out.length });
  } catch (e) {
    return res.status(400).json({ error: 'ValidationError', message: e.message });
  }
});

publicRouter.get('/cost/by-api-key', (req, res) => {
  // user_email serves as the API-key-shape proxy in our schema; per
  // bizmodel §Q6 reconciliation flow this lets the operator pick arbitrary
  // date ranges to match Anthropic invoice periods (not just calendar-month).
  const period_start = req.query.period_start ? String(req.query.period_start) : null;
  const period_end = req.query.period_end ? String(req.query.period_end) : null;
  if (!period_start || !period_end ||
      !/^\d{4}-\d{2}-\d{2}$/.test(period_start) || !/^\d{4}-\d{2}-\d{2}$/.test(period_end)) {
    return res.status(400).json({ error: 'ValidationError', message: 'period_start + period_end required (YYYY-MM-DD)' });
  }
  const rows = _costDb.getCostByPeriod({ from: period_start, to: period_end });
  const grouped = new Map();
  for (const r of rows) {
    const k = `${r.user_email}|${r.model}`;
    let g = grouped.get(k);
    if (!g) {
      g = {
        api_key_label: r.user_email || '(none)', model: r.model || '(unspecified)',
        organization_id: r.organization_id || '',
        tokens_input: 0, tokens_output: 0, tokens_cache_read: 0, tokens_cache_creation: 0,
        total_usd: 0,
      };
      grouped.set(k, g);
    }
    g.tokens_input += r.tokens_input;
    g.tokens_output += r.tokens_output;
    g.tokens_cache_read += r.tokens_cache_read;
    g.tokens_cache_creation += r.tokens_cache_creation;
    g.total_usd += r.cost_usd;
  }
  const out = [...grouped.values()].sort((a, b) => b.total_usd - a.total_usd);
  return res.json({ period_start, period_end, rows: out, count: out.length });
});

publicRouter.get('/cost/anomaly-detail', (req, res) => {
  const date = req.query.date ? String(req.query.date) : null;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'ValidationError', message: 'date required (YYYY-MM-DD)' });
  }
  const dim_key = req.query.dim_key ? String(req.query.dim_key) : 'agent_id';
  const dim_value = req.query.dim_value ? String(req.query.dim_value) : null;
  const VALID_DIMS = new Set(['agent_id', 'user_email', 'organization_id', 'model', 'cost_center', 'project_tag', 'environment_tier']);
  if (!VALID_DIMS.has(dim_key)) {
    return res.status(400).json({ error: 'ValidationError', message: `dim_key must be one of: ${[...VALID_DIMS].join(', ')}` });
  }

  // Date in question + 7d baseline
  const dayRows = _costDb.getCostByPeriod({ from: date, to: date });
  const baselineFrom = costQuery._internal.ymd(new Date(new Date(date) - 7 * 86400_000));
  const baselineTo = costQuery._internal.ymd(new Date(new Date(date) - 1 * 86400_000));
  const baselineRows = _costDb.getCostByPeriod({ from: baselineFrom, to: baselineTo });

  // Filter to dim_value if specified
  const dayFilt = dim_value ? dayRows.filter(r => r[dim_key] === dim_value) : dayRows;
  const baselineFilt = dim_value ? baselineRows.filter(r => r[dim_key] === dim_value) : baselineRows;

  const dayTotal = dayFilt.reduce((s, r) => s + r.cost_usd, 0);
  const baselineTotal = baselineFilt.reduce((s, r) => s + r.cost_usd, 0);
  const baselineDailyAvg = baselineTotal / 7;
  const deltaVsBaseline = dayTotal - baselineDailyAvg;

  // Top contributors on the day (within filter)
  const contribMap = new Map();
  for (const r of dayFilt) {
    const k = `${r.agent_id}|${r.model}`;
    let g = contribMap.get(k) || { agent_id: r.agent_id, model: r.model, cost_usd: 0 };
    g.cost_usd += r.cost_usd;
    contribMap.set(k, g);
  }
  const topContributors = [...contribMap.values()].sort((a, b) => b.cost_usd - a.cost_usd).slice(0, 10);

  return res.json({
    date, dim_key, dim_value,
    day_total_usd: dayTotal,
    baseline_window: { from: baselineFrom, to: baselineTo },
    baseline_daily_avg_usd: baselineDailyAvg,
    delta_vs_baseline_usd: deltaVsBaseline,
    delta_vs_baseline_pct: baselineDailyAvg > 0 ? (deltaVsBaseline / baselineDailyAvg) * 100 : null,
    top_contributors: topContributors,
  });
});

publicRouter.get('/cost/export', (req, res) => {
  const format = String(req.query.format || 'csv');
  const period = String(req.query.period || 'mtd');
  const schema = String(req.query.schema || 'plexus-default');
  if (format !== 'csv') {
    return res.status(400).json({ error: 'ValidationError', message: 'only format=csv supported v1' });
  }
  let range;
  try { range = costQuery.periodToRange(period); }
  catch (e) { return res.status(400).json({ error: 'ValidationError', message: e.message }); }

  const rows = _costDb.getCostByPeriod({ from: range.from, to: range.to });

  const csvEsc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  let header, lines;
  if (schema === 'anthropic-invoice') {
    // Per bizmodel §Q6: reconciliation-friendly column schema matching Anthropic invoice shape
    header = ['period_start', 'period_end', 'api_key_label', 'model',
      'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'total_cost_usd'];
    // Group by user_email × model across the full period
    const grouped = new Map();
    for (const r of rows) {
      const k = `${r.user_email}|${r.model}`;
      let g = grouped.get(k) || {
        api_key_label: r.user_email || '(none)', model: r.model || '(unspecified)',
        input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_cost_usd: 0,
      };
      g.input_tokens += r.tokens_input;
      g.output_tokens += r.tokens_output;
      g.cache_read_tokens += r.tokens_cache_read;
      g.cache_write_tokens += r.tokens_cache_creation;
      g.total_cost_usd += r.cost_usd;
      grouped.set(k, g);
    }
    lines = [...grouped.values()].sort((a, b) => b.total_cost_usd - a.total_cost_usd)
      .map(g => [range.from, range.to, g.api_key_label, g.model,
        g.input_tokens, g.output_tokens, g.cache_read_tokens, g.cache_write_tokens,
        g.total_cost_usd.toFixed(6)].map(csvEsc).join(','));
  } else {
    // Default schema: full row dump
    header = ['date', 'agent_id', 'user_email', 'organization_id', 'model', 'host',
      'cost_center', 'project_tag', 'environment_tier', 'billable_flag',
      'tokens_input', 'tokens_output', 'tokens_cache_read', 'tokens_cache_creation', 'cost_usd', 'source'];
    lines = rows.map(r => header.map(h => csvEsc(r[h])).join(','));
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="plexus-cost-${period}-${range.from}-to-${range.to}-${schema}.csv"`);
  res.send([header.join(','), ...lines].join('\n') + '\n');
});

// CP10.3 (2026-06-02) — per-agent activity timeline public-mirror.
// Operator-facing dashboard view; network-isolation trust (same posture as
// the rest of public/*). Daemon-side allowlist redacts secrets before they
// reach the server; this endpoint just reads back the rolling buffer.
publicRouter.get('/activity', (req, res) => {
  const { listAgentActivity } = require('./db');
  const agent_id = req.query.agent_id ? String(req.query.agent_id) : null;
  if (!agent_id || !/^[a-zA-Z0-9._:@/-]{1,64}$/.test(agent_id)) {
    return res.status(400).json({ error: 'ValidationError', message: 'agent_id is required, must match [a-zA-Z0-9._:@/-] (1-64 chars).' });
  }
  const limit = parsePosInt(req.query.limit, 50, 200);
  if (limit === null) {
    return res.status(400).json({ error: 'ValidationError', message: 'limit must be a non-negative integer (max 200).' });
  }
  const activity = listAgentActivity(agent_id, limit);
  return res.json({ agent_id, activity, count: activity.length });
});

// CP9 (2026-06-01) — Channels tab: per-channel sidebar listing.
// Public-mirror of the authed /channels surface (network-isolation trust
// per the rest of /api/v1/plexus/public/*). Returns one row per channel
// with message_count, latest_id, last_message_at — used by the dashboard
// sidebar to rank channels by recency and show "last activity" hints.
publicRouter.get('/channels', (req, res) => {
  const limit = parsePosInt(req.query.limit, 100, 200);
  if (limit === null) {
    return res.status(400).json({ error: 'ValidationError', message: 'limit must be a non-negative integer (max 200).' });
  }
  const { listChannels } = require('./db');
  const channels = listChannels(limit);
  return res.json({ channels, count: channels.length });
});

// v0.5.8.6 (2026-05-27) — dashboard item #2 (DM audit surface).
// Public-mirror endpoints behind network-isolation trust (same posture as
// the rest of /api/v1/plexus/public/*; proper browser-auth comes Stage 2.5+).
//
// (1) GET /dm-audit-log: lists envelope-only audit entries from
//     /var/log/yaklog/dm-audit.ndjson with server-side filtering.
// (2) GET /messages/:id: returns ANY message including private (intended
//     for the audit-tab "reveal body" flow); writes a fresh audit entry
//     marker (via='dashboard') so the audit log captures dashboard reveals
//     alongside CLI ops-key reads — single audit source of truth.
const { readDmAuditLog } = require('./audit');
const { getMessage } = require('./db');
const { writeAuditEntries } = require('./middleware/dmFilter');

publicRouter.get('/dm-audit-log', (req, res) => {
  const limit = parsePosInt(req.query.limit, 100, 500);
  if (limit === null) {
    return res.status(400).json({ error: 'ValidationError', message: 'limit must be a non-negative integer (max 500).' });
  }
  let result;
  try {
    result = readDmAuditLog({
      limit,
      since: req.query.since ? String(req.query.since) : null,
      until: req.query.until ? String(req.query.until) : null,
      sender: req.query.sender ? String(req.query.sender) : null,
      recipient: req.query.recipient ? String(req.query.recipient) : null,
      message_id: req.query.message_id ? parseInt(req.query.message_id, 10) : null,
      ops_key_id: req.query.ops_key_id ? String(req.query.ops_key_id) : null,
    });
  } catch (err) {
    return res.status(500).json({ error: 'AuditReadError', message: err.message });
  }
  return res.json(result);
});

// CP8.5 (2026-05-27) — dashboard item #6 (/register admin surface).
// Public-mirror endpoint (network-isolation trust posture per the rest of
// /api/v1/plexus/public/*). Returns registration rows from the ADR-0025
// state machine table with SECRET-BEARING fields stripped: ciphertext_b64
// (the encrypted token payload) + token hashes (forensic-only). Operator
// workflow fields (status, ratification metadata, justifications) are
// surfaced for the "what's pending my ratify?" / "what's stuck in ferry?"
// admin views.
const { listAllRegistrations } = require('./db');

const REGISTRATION_NON_TERMINAL = new Set([
  'NEW', 'SUBMITTED', 'PARCH_REVIEW', 'JON_RATIFY',
  'APPROVED_PENDING_FERRY', 'FERRIED', 'PENDING_ACTIVATION',
]);

function sanitizeRegistration(row) {
  if (!row) return null;
  // Whitelist of fields safe for the public-mirror surface. Anything not
  // listed here is excluded by construction (default-deny). DO NOT add
  // ciphertext_b64 / *_token_hash to this list without an ADR amendment.
  return {
    registration_id: row.registration_id,
    agent_id: row.agent_id,
    status: row.status,
    is_terminal: !REGISTRATION_NON_TERMINAL.has(row.status),
    justification_json: row.justification_json,
    submission_json: row.submission_json,
    ratified_by: row.ratified_by,
    ratified_at: row.ratified_at,
    ferried_by: row.ferried_by,
    ferried_at: row.ferried_at,
    activated_at: row.activated_at,
    revoked_at: row.revoked_at,
    revoked_reason: row.revoked_reason,
    rejected_reason: row.rejected_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

publicRouter.get('/registrations', (req, res) => {
  const limit = parsePosInt(req.query.limit, 100, 500);
  if (limit === null) {
    return res.status(400).json({ error: 'ValidationError', message: 'limit must be a non-negative integer (max 500).' });
  }
  const rows = listAllRegistrations(limit);
  const registrations = rows.map(sanitizeRegistration);
  return res.json({ registrations, count: registrations.length });
});

publicRouter.get('/messages/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id < 1) {
    return res.status(400).json({ error: 'ValidationError', message: 'id must be a positive integer.' });
  }
  const message = getMessage(id);
  if (!message) {
    return res.status(404).json({ error: 'NotFound', message: `Message id ${id} not found.` });
  }
  // If private, write an audit entry with via='dashboard' marker so the
  // audit log captures this read alongside CLI ops-key reads. opsKeyId is
  // 'public-dashboard' (a stable non-secret marker; not a real key hash).
  if (message.private) {
    writeAuditEntries([{
      ts: new Date().toISOString(),
      ops_key_id: 'public-dashboard',
      requester_ip: req.ip || null,
      message_id: message.id,
      channel: message.channel,
      sender: message.sender,
      recipients: message.mentions || [],
      via: 'dashboard',
    }]);
  }
  return res.json({ message });
});

module.exports = router;
module.exports.publicRouter = publicRouter;
module.exports._internals = { templates, cache, COST_DIM_ALLOWLIST, RATE_WINDOW_ALLOWLIST };
