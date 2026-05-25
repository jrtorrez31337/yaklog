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
  {
    // v0.5.7.2: replaced cumulative-per-agent session count (was flat at
    // 1 with only yaklog-dev-agent emitting → looked "not populating" to
    // operator). Now reports "agents currently emitting OTel" — count
    // of distinct plexus_agent_id with any RECENT active_time series.
    //
    // Why active_time and not session_count: session_count only emits
    // ONCE per CC session (SessionStart event), so after ~5min of no new
    // CC sessions starting Prom drops it from instant queries (staleness
    // window). active_time_seconds_total pushes on every tool use, so it
    // stays fresh as long as the agent is actively working — the correct
    // signal for "is this agent currently emitting OTel right now."
    name: 'agents.emitting.count',
    kind: 'range',
    lookbackS: 3600,
    step: '15s',
    promql: 'count(count by (plexus_agent_id) (claude_code_active_time_seconds_total))',
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
    const to = Math.floor(Date.now() / 1000);
    const from = to - frame.lookbackS;
    const url = new URL(`${config.plexusPromUrl}/api/v1/query_range`);
    url.searchParams.set('query', frame.promql);
    url.searchParams.set('start', String(from));
    url.searchParams.set('end', String(to));
    url.searchParams.set('step', frame.step);

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

    // Content-hash for change detection. Range queries always change (window
    // slides each cycle), so this rarely short-circuits for range frames, but
    // it WILL short-circuit when there's no live data at all (empty result
    // matches empty result).
    const etag = hashFrame(body);
    const prev = this.lastSnapshots.get(frame.name);
    if (prev && prev.etag === etag) return;

    const payload = {
      template: frame.name,
      kind: frame.kind,
      params: { window: '5m' },
      query: frame.promql,
      range: { from: String(from), to: String(to), step: frame.step },
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
