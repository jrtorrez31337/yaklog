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

module.exports = router;
module.exports.publicRouter = publicRouter;
module.exports._internals = { templates, cache, COST_DIM_ALLOWLIST, RATE_WINDOW_ALLOWLIST };
