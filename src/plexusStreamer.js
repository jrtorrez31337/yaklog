// Plan C Stage 2.5 — Plexus SSE streamer.
//
// Replaces the per-chart browser-polling model with a server-side
// publish-on-change push channel.
//
// Architecture:
//
//   Browser opens EventSource('/api/v1/plexus/public/stream')
//             ↓ keeps connection open; receives SSE events
//   Server emits "frame" events as polled data changes
//             ↑
//   Each registered FRAME has its own background poll loop:
//     - hits Prom once every interval (default 15s)
//     - computes content-hash of the result
//     - on change: broadcasts to all SSE subscribers + caches latest
//     - on no change: silent (no bandwidth)
//   Per-frame poll is GLOBAL across all clients (single Prom query
//   serves N browsers).
//
// What this replaces:
//   - 3-5 fetch calls per dashboard browser tab every 15s
//   - 60s in-memory cache layer for the polled queries
//   - chart destroy+recreate on each refresh
//   - per-tab bandwidth burn even when nothing changes
//
// What stays:
//   - allowlist (frames are pre-registered; can't subscribe to arbitrary PromQL)
//   - the request-driven /api/v1/plexus/query for on-demand queries (e.g. popover)
//     and Cost tab (per-user dim/window selection — not push-friendly without
//     per-subscriber state machinery; defer)
//
// New connections get the LAST KNOWN frame immediately (cached snapshot),
// then live updates. So a dashboard reload sees data instantly without
// waiting for the next poll cycle.

const { EventEmitter } = require('events');
const config = require('./config');

// ──────────────────────────────────────────────────────────────────────
// Registered FRAMES — server pushes these on change.
// Mirrors the templates in plexusRoutes.js but with concrete params bound,
// since SSE subscribers don't get to vary params (those go through the
// request/response /query endpoint).
//
// Frames are the Live-tab charts (the things every dashboard wants).
// Cost-tab queries vary per-user-selection so they keep using /query.
// ──────────────────────────────────────────────────────────────────────

const FRAMES = [
  {
    // v0.5.7.2: aggregate-only token rate per Jon-direct 2026-05-25
    // ("only show aggregate not each agent, we will do each agent at
    // another time"). Per-agent + per-type breakdown will come back as
    // a separate template/panel when cluster adoption is broader.
    name: 'tokens.rate.cluster',
    kind: 'range',
    lookbackS: 3600,
    step: '15s',
    promql: 'sum(rate(claude_code_token_usage_tokens_total[5m]))',
  },
  {
    name: 'cost.rate.byAgent',
    kind: 'range',
    lookbackS: 3600,
    step: '15s',
    promql: 'sum by (plexus_agent_id, model) (rate(claude_code_cost_usage_USD_total[5m]))',
  },
  // CP6.6 (2026-05-25): agents.emitting.count FRAME removed per Jon-direct
  // ("don't think we need the OTEL graph as it's not really useful"). The
  // dashboard's card-grid section divider already shows the same info
  // ("N agents · M emitting OTel") computed client-side from per-agent
  // SSE frames, so this frame was wasting a poll cycle every 15s.
  // CP6.1: cluster cost-accounting hero data sources. All instant queries
  // with dynamic @ timestamps for time-anchored "today" and "MTD" semantics
  // (computed at poll time so they roll over correctly at midnight + month).
  {
    // Cluster spend since 00:00 UTC today. Uses @ modifier with start-of-day
    // unix ts so the "today" window slides each new day. `or vector(0)` keeps
    // the diff well-defined if Prom doesn't have a series at midnight yet
    // (Stage 1 startup edge case).
    name: 'cluster.cost.today',
    kind: 'instant',
    buildPromql: () => {
      const startOfDay = Math.floor(new Date(new Date().setUTCHours(0, 0, 0, 0)).getTime() / 1000);
      return `(sum(claude_code_cost_usage_USD_total) or vector(0)) - (sum(claude_code_cost_usage_USD_total @ ${startOfDay}) or vector(0))`;
    },
  },
  {
    // Cluster spend over rolling 7 days. Static `increase[7d]` query.
    name: 'cluster.cost.7d',
    kind: 'instant',
    promql: 'sum(increase(claude_code_cost_usage_USD_total[7d]))',
  },
  {
    // Month-to-date cluster spend. @ start of UTC month.
    name: 'cluster.cost.mtd',
    kind: 'instant',
    buildPromql: () => {
      const now = new Date();
      const startOfMonth = Math.floor(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).getTime() / 1000);
      return `(sum(claude_code_cost_usage_USD_total) or vector(0)) - (sum(claude_code_cost_usage_USD_total @ ${startOfMonth}) or vector(0))`;
    },
  },
  {
    // Top-10 cost drivers by agent (cumulative all-time).
    name: 'cluster.cost.topAgents',
    kind: 'instant',
    promql: 'topk(10, sum by (plexus_agent_id) (claude_code_cost_usage_USD_total))',
  },
  {
    // Top-10 cost drivers by Anthropic account (user_email is the most
    // human-readable identity; user_account_id is preserved as a label
    // on the series for cross-reference in the popover).
    name: 'cluster.cost.byAccount',
    kind: 'instant',
    promql: 'topk(10, sum by (user_email, user_account_id) (claude_code_cost_usage_USD_total))',
  },
  {
    // 24h spend sparkline for the hero. Range query; one series.
    name: 'cluster.cost.spark24h',
    kind: 'range',
    lookbackS: 86400,
    step: '15m',
    promql: 'sum(increase(claude_code_cost_usage_USD_total[15m]))',
  },
  {
    name: 'active_time.rate.byAgent',
    kind: 'range',
    lookbackS: 3600,
    step: '15s',
    promql: 'sum by (plexus_agent_id) (rate(claude_code_active_time_seconds_total[5m]))',
  },
];

const POLL_INTERVAL_MS = 15000;
const KEEPALIVE_MS = 25000;

// ──────────────────────────────────────────────────────────────────────
// Streamer — singleton, owns the poll loops + subscriber registry.
// ──────────────────────────────────────────────────────────────────────

class PlexusStreamer extends EventEmitter {
  constructor() {
    super();
    this.lastSnapshots = new Map();   // frame.name → { etag, payload, ts }
    this.pollTimers = new Map();       // frame.name → setInterval handle
    this.subscriberCount = 0;
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    for (const frame of FRAMES) {
      this._kickFramePoll(frame);
    }
    console.log(`[plexus-streamer] started: ${FRAMES.length} frames, interval=${POLL_INTERVAL_MS}ms`);
  }

  stop() {
    for (const t of this.pollTimers.values()) clearInterval(t);
    this.pollTimers.clear();
    this.started = false;
  }

  _kickFramePoll(frame) {
    // First poll immediately so new subscribers get fresh data fast.
    this._pollFrame(frame).catch((e) => {
      console.warn(`[plexus-streamer] initial poll failed for ${frame.name}:`, e.message);
    });
    const timer = setInterval(() => {
      this._pollFrame(frame).catch((e) => {
        console.warn(`[plexus-streamer] poll failed for ${frame.name}:`, e.message);
      });
    }, POLL_INTERVAL_MS);
    timer.unref();   // don't block process exit on these timers
    this.pollTimers.set(frame.name, timer);
  }

  async _pollFrame(frame) {
    // CP6.1: support kind: 'instant' (POST /api/v1/query) alongside the
    // existing 'range' (query_range). Some templates also use buildPromql()
    // — a function that returns the promql string at poll time, so it can
    // embed dynamic timestamps (e.g. @ midnight UTC for "today" semantics).
    const promql = typeof frame.buildPromql === 'function' ? frame.buildPromql() : frame.promql;
    const isInstant = frame.kind === 'instant';
    const to = Math.floor(Date.now() / 1000);
    const from = isInstant ? null : to - frame.lookbackS;
    const url = new URL(`${config.plexusPromUrl}/api/v1/${isInstant ? 'query' : 'query_range'}`);
    url.searchParams.set('query', promql);
    if (!isInstant) {
      url.searchParams.set('start', String(from));
      url.searchParams.set('end', String(to));
      url.searchParams.set('step', frame.step);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.plexusQueryTimeoutMs);
    let body;
    try {
      const r = await fetch(url, { signal: controller.signal });
      if (!r.ok) throw new Error(`Prom HTTP ${r.status}`);
      body = await r.json();
    } catch (e) {
      // On error, don't broadcast; just log. Subscribers keep their last good snapshot.
      console.warn(`[plexus-streamer] ${frame.name}: ${e.message}`);
      return;
    } finally {
      clearTimeout(timeout);
    }

    // Content-hash for change detection.
    const etag = hashFrame(body);
    const prev = this.lastSnapshots.get(frame.name);
    if (prev && prev.etag === etag) return;

    const payload = {
      template: frame.name,
      kind: frame.kind,
      query: promql,
      ...(isInstant ? { instant_at: String(to) } : { range: { from: String(from), to: String(to), step: frame.step } }),
      ...body,
    };
    const snap = { etag, payload, ts: Date.now() };
    this.lastSnapshots.set(frame.name, snap);
    this.emit('frame', { name: frame.name, snap });
  }

  // Returns the most recent snapshot for a frame, or null. Used by /stream
  // to send initial state on connect.
  getSnapshot(frameName) {
    return this.lastSnapshots.get(frameName) || null;
  }

  getAllSnapshots() {
    const out = [];
    for (const [name, snap] of this.lastSnapshots.entries()) {
      out.push({ name, snap });
    }
    return out;
  }
}

function hashFrame(body) {
  // Cheap content-hash: stringify with stable key ordering would be ideal,
  // but Prom returns deterministically-ordered results for our queries, so
  // a JSON-stringify is sufficient. (If a future Prom version reorders
  // results, switch to a sort-then-stringify.)
  const s = JSON.stringify(body);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(16);
}

const streamer = new PlexusStreamer();

// ──────────────────────────────────────────────────────────────────────
// SSE handler — mounted at /api/v1/plexus/public/stream (no auth; mirrors
// /presence/public security boundary).
// ──────────────────────────────────────────────────────────────────────

function streamHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  streamer.subscriberCount++;

  // Send all current snapshots immediately so a fresh dashboard reload
  // has data to render without waiting for the next poll cycle.
  for (const { name, snap } of streamer.getAllSnapshots()) {
    if (res.writableEnded) return;
    res.write(`event: frame\ndata: ${JSON.stringify(snap.payload)}\n\n`);
  }

  const onFrame = ({ name, snap }) => {
    if (res.writableEnded) return;
    res.write(`event: frame\ndata: ${JSON.stringify(snap.payload)}\n\n`);
  };
  streamer.on('frame', onFrame);

  // Keep-alive comment so middleboxes don't drop idle connections.
  const keepalive = setInterval(() => {
    if (res.writableEnded) return;
    res.write(': keepalive\n\n');
  }, KEEPALIVE_MS);
  keepalive.unref();

  const cleanup = () => {
    streamer.off('frame', onFrame);
    clearInterval(keepalive);
    streamer.subscriberCount = Math.max(0, streamer.subscriberCount - 1);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

module.exports = {
  streamer,
  streamHandler,
  FRAMES,
  _internals: { hashFrame, PlexusStreamer },
};
