const fs = require('fs');
const path = require('path');
const { messageBus, listMessagesAfter } = require('./db');
const { applyDmVisibilityFilter, writeAuditEntries } = require('./middleware/dmFilter');

const CHANNEL_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const SENDER_RE = /^[a-zA-Z0-9._:@/-]{1,64}$/;
const MENTION_RE = /^[A-Za-z0-9_\-]{1,64}$/;

const KEEPALIVE_MS = Number.parseInt(process.env.YAKLOG_STREAM_KEEPALIVE_MS, 10) || 15_000;
const DEFAULT_COALESCE_MS = 500;

// ────────────────────────────────────────────────────────────────────────
// CP12.x.4 Layer-1 + #181 + #182 combined-cycle Step 1 instrumentation
// (per parch #8949 Jon-direct 3-arbitration ratify + secops #8945 pre-clear).
//
// Tracks per-agent /stream lifecycle counters in-memory so we can empirically
// anchor the 3-class taxonomy (healthy-advancing / silent-dead-on-arrival /
// post-recovery-stall per ssw-devops #8638) plus the filter-aware false-
// positive distinguisher (per pveadmin #8616). Zero persistence; resets on
// server boot. Surfaced via ops-gated GET /ops/stream/stats.
//
// Per [[feedback_substrate_check_before_routing_claims]] empirical-before-
// claim discipline + [[feedback_jon_regression_report_requires_empirical_
// anchor_before_revert]] sister-pattern.
// ────────────────────────────────────────────────────────────────────────

const SERVER_BOOT_AT = new Date().toISOString();
let clusterEventCount = 0;
messageBus.on('message', () => { clusterEventCount += 1; });

// Per-agent counters. Keyed by exclude_sender (the requesting agent's ID);
// streams with no exclude_sender bucket as '__anonymous__'. Each entry:
// {
//   open_count, current_active_count,
//   close_count_by_reason: {client_close, error, select_timeout, server_close, arrival_silent, recovery_stall},
//   replay_rows_samples: [], replay_filtered_samples: [], replay_ms_samples: [],
//   first_byte_ms_samples: [],
//   keepalive_count_total, events_dispatched_total,
//   duration_s_samples: [],
//   filter_match_count_total,
//   last_close_had_events,  // for #181 recovery_stall distinguishing
//   last_event_dispatched_at, last_keepalive_at,  // CP12.x.4 Step 1.1 live
// }
const agentStats = new Map();

// Bounded sample retention to cap memory (median+p99 don't need raw history).
const SAMPLE_CAP = 256;

function getOrInitAgent(agentId) {
  let s = agentStats.get(agentId);
  if (s) return s;
  s = {
    open_count: 0,
    current_active_count: 0,
    close_count_by_reason: {
      client_close: 0, error: 0, select_timeout: 0, server_close: 0,
      arrival_silent: 0, recovery_stall: 0,
    },
    replay_rows_samples: [], replay_filtered_samples: [], replay_ms_samples: [],
    first_byte_ms_samples: [],
    keepalive_count_total: 0, events_dispatched_total: 0,
    duration_s_samples: [],
    filter_match_count_total: 0,
    last_close_had_events: false,
    last_event_dispatched_at: null,
    last_keepalive_at: null,
  };
  agentStats.set(agentId, s);
  return s;
}

function pushSample(arr, value) {
  arr.push(value);
  if (arr.length > SAMPLE_CAP) arr.shift();
}

function pct(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function histogram(arr, buckets) {
  // buckets: [[label, min, max], ...]; max=Infinity for last bucket
  const out = {};
  for (const [label] of buckets) out[label] = 0;
  for (const v of arr) {
    for (const [label, min, max] of buckets) {
      if (v >= min && v <= max) { out[label] += 1; break; }
    }
  }
  return out;
}

// Public: snapshot per-agent stats for the /ops/stream/stats endpoint.
function getStreamStats() {
  const agents = [];
  const nowMs = Date.now();
  for (const [agent_id, s] of agentStats.entries()) {
    const lastEvMs = s.last_event_dispatched_at ? Date.parse(s.last_event_dispatched_at) : null;
    const lastKaMs = s.last_keepalive_at ? Date.parse(s.last_keepalive_at) : null;
    agents.push({
      agent_id,
      open_count: s.open_count,
      current_active_count: s.current_active_count,
      close_count_by_reason: { ...s.close_count_by_reason },
      replay_rows_histogram: histogram(s.replay_rows_samples, [
        ['0', 0, 0], ['1-10', 1, 10], ['11-100', 11, 100], ['100+', 101, Infinity],
      ]),
      replay_filtered_pct_histogram: histogram(s.replay_filtered_samples, [
        ['0%', 0, 0], ['1-50%', 1, 50], ['51-99%', 51, 99], ['100%', 100, 100],
      ]),
      replay_ms_p50: pct(s.replay_ms_samples, 0.50),
      replay_ms_p99: pct(s.replay_ms_samples, 0.99),
      first_byte_ms_p50: pct(s.first_byte_ms_samples, 0.50),
      first_byte_ms_p99: pct(s.first_byte_ms_samples, 0.99),
      keepalive_count_total: s.keepalive_count_total,
      events_dispatched_total: s.events_dispatched_total,
      duration_s_p50: pct(s.duration_s_samples, 0.50),
      duration_s_p99: pct(s.duration_s_samples, 0.99),
      filter_match_count_total: s.filter_match_count_total,
      // CP12.x.4 Step 1.1 (#9033 self-flagged): live timestamps + derived
      // seconds-since fields so /ops/stream/stats reflects activity on
      // long-lived connections without waiting for cleanup() to flush.
      last_event_dispatched_at: s.last_event_dispatched_at,
      last_keepalive_at: s.last_keepalive_at,
      seconds_since_last_event: lastEvMs !== null ? Math.round((nowMs - lastEvMs) / 1000) : null,
      seconds_since_last_keepalive: lastKaMs !== null ? Math.round((nowMs - lastKaMs) / 1000) : null,
      // #182: low-traffic-likely-healthy = agent's filter matches nothing
      // while cluster traffic flows AND agent is receiving keepalives.
      // Suppresses sse_stream_stale false-positive per pveadmin #8616.
      low_traffic_likely_healthy:
        s.filter_match_count_total === 0
        && clusterEventCount > 0
        && s.keepalive_count_total > 0,
    });
  }
  return {
    agents,
    server_boot_at: SERVER_BOOT_AT,
    cluster_event_count_since_boot: clusterEventCount,
  };
}

// ────────────────────────────────────────────────────────────────────────
// CP12.x.4 Layer-1 Step 2 in-process empirical-anchor snapshot loop
// (per #8967 Option A path; sidesteps ops-key-secrets-at-rest concern by
// running the capture in the yaklog-server process itself, no HTTP, no
// auth-gate, no token-at-rest). Writes one NDJSON line per snapshot to
// the bind-mounted /var/log/yaklog/ path so ssw-devops's external
// /presence/public capture can be joined on snapshot_at + agent_id at
// cycle close.
//
// Opt-in via env: YAKLOG_CP12_X_4_EMPIRICAL_ANCHOR_ENABLED=1
// Anchor zero (default = process start; override for cycle-continuity):
//   YAKLOG_CP12_X_4_EMPIRICAL_ANCHOR_ZERO=<ISO timestamp>
// Output path (default = /var/log/yaklog/cp12-x-4-stream-stats.ndjson):
//   YAKLOG_CP12_X_4_EMPIRICAL_ANCHOR_PATH=<absolute path>
// Cadence (default 30min, matching ssw-devops loop):
//   YAKLOG_CP12_X_4_EMPIRICAL_ANCHOR_INTERVAL_MS=<ms>
// Max iters (default 96 = 48h at 30min; safety bound):
//   YAKLOG_CP12_X_4_EMPIRICAL_ANCHOR_MAX_ITERS=<n>
// ────────────────────────────────────────────────────────────────────────

let _empiricalAnchorTimer = null;
let _empiricalAnchorIter = 0;

function startEmpiricalAnchorLoop() {
  if (process.env.YAKLOG_CP12_X_4_EMPIRICAL_ANCHOR_ENABLED !== '1') return null;
  const intervalMs = Number.parseInt(
    process.env.YAKLOG_CP12_X_4_EMPIRICAL_ANCHOR_INTERVAL_MS, 10,
  ) || 30 * 60 * 1000;
  const maxIters = Number.parseInt(
    process.env.YAKLOG_CP12_X_4_EMPIRICAL_ANCHOR_MAX_ITERS, 10,
  ) || 96;
  const outPath = process.env.YAKLOG_CP12_X_4_EMPIRICAL_ANCHOR_PATH
    || '/var/log/yaklog/cp12-x-4-stream-stats.ndjson';
  const anchorZero = process.env.YAKLOG_CP12_X_4_EMPIRICAL_ANCHOR_ZERO
    || SERVER_BOOT_AT;

  try { fs.mkdirSync(path.dirname(outPath), { recursive: true }); } catch {}

  const fire = () => {
    _empiricalAnchorIter += 1;
    const snapshot = {
      snapshot_at: new Date().toISOString(),
      iteration: _empiricalAnchorIter,
      anchor_zero: anchorZero,
      server_boot_at: SERVER_BOOT_AT,
      stream_stats: getStreamStats(),
    };
    fs.appendFile(outPath, JSON.stringify(snapshot) + '\n', (err) => {
      if (err) console.error(`[empirical-anchor] append failed: ${err.message}`);
    });
    if (_empiricalAnchorIter >= maxIters) {
      stopEmpiricalAnchorLoop();
      console.log(`[empirical-anchor] window complete; stopped at iter=${_empiricalAnchorIter}`);
    }
  };
  _empiricalAnchorTimer = setInterval(fire, intervalMs);
  if (_empiricalAnchorTimer.unref) _empiricalAnchorTimer.unref();
  // Immediate baseline snapshot at iter=1.
  fire();
  console.log(`[empirical-anchor] CP12.x.4 loop started; cadence=${intervalMs/60000}min path=${outPath} anchorZero=${anchorZero} maxIters=${maxIters}`);
  return _empiricalAnchorTimer;
}

function stopEmpiricalAnchorLoop() {
  if (_empiricalAnchorTimer) {
    clearInterval(_empiricalAnchorTimer);
    _empiricalAnchorTimer = null;
  }
}

function parseCursor(value) {
  if (value === undefined || value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseMinQuiet(value) {
  if (value === undefined) return DEFAULT_COALESCE_MS;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_COALESCE_MS;
  return Math.min(parsed, 10_000);
}

function parseMentions(value) {
  if (!value) return null;
  const tokens = String(value).split(',').map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return null;
  for (const t of tokens) {
    if (!MENTION_RE.test(t)) return { error: t };
  }
  return { tokens };
}

// v0.5.10 channel-decomp support — accept CSV of channels, dedupe + validate.
function parseChannels(value) {
  if (!value) return null;
  const seen = new Set();
  const tokens = [];
  for (const raw of String(value).split(',')) {
    const t = raw.trim();
    if (!t || seen.has(t)) continue;
    if (!CHANNEL_RE.test(t)) return { error: t };
    seen.add(t);
    tokens.push(t);
  }
  if (tokens.length === 0) return null;
  return { tokens };
}

function messageMatches(msg, filters) {
  if (filters.channels && !filters.channels.has(msg.channel)) return false;
  if (filters.excludeSender && msg.sender === filters.excludeSender) return false;
  if (filters.mentions) {
    const msgMentions = msg.mentions || [];
    if (!filters.mentions.some((m) => msgMentions.includes(m))) return false;
  }
  return true;
}

// ADR-0026 wrapper: returns true iff the requester is allowed to see this msg.
// Audit entries from ops-key reads are written immediately (NOT batched —
// live SSE has no natural batch point; per-row append is fine for the audit
// log NDJSON format).
function dmVisible(msg, req) {
  const { filtered, auditEntries } = applyDmVisibilityFilter([msg], req);
  if (auditEntries.length > 0) writeAuditEntries(auditEntries);
  return filtered.length > 0;
}

function formatEvent(msg) {
  return `id: ${msg.id}\nevent: message\ndata: ${JSON.stringify(msg)}\n\n`;
}

function streamHandler(req, res) {
  // channel (singular, back-compat) + channels (plural CSV, v0.5.10 lane-decomp).
  // Both accepted; if both provided, the union of the sets is used.
  const singleChannel = req.query.channel ? String(req.query.channel) : null;
  if (singleChannel && !CHANNEL_RE.test(singleChannel)) {
    return res.status(400).json({ error: 'ValidationError', message: 'invalid channel' });
  }
  const channelsResult = parseChannels(req.query.channels);
  if (channelsResult && channelsResult.error) {
    return res.status(400).json({ error: 'ValidationError', message: `invalid channel token: ${channelsResult.error}` });
  }
  let channels = null;
  if (singleChannel || channelsResult) {
    channels = new Set();
    if (singleChannel) channels.add(singleChannel);
    if (channelsResult) for (const t of channelsResult.tokens) channels.add(t);
  }
  const excludeSender = req.query.exclude_sender ? String(req.query.exclude_sender) : null;
  if (excludeSender && !SENDER_RE.test(excludeSender)) {
    return res.status(400).json({ error: 'ValidationError', message: 'invalid exclude_sender' });
  }
  const mentionResult = parseMentions(req.query.mention);
  if (mentionResult && mentionResult.error) {
    return res.status(400).json({ error: 'ValidationError', message: `invalid mention token: ${mentionResult.error}` });
  }
  const mentions = mentionResult ? mentionResult.tokens : null;
  if (!excludeSender) {
    console.warn('[stream] subscription without exclude_sender — may self-wake');
  }

  const minQuietMs = parseMinQuiet(req.query.min_quiet_ms);

  const headerCursor = parseCursor(req.headers['last-event-id']);
  const sinceCursor = parseCursor(req.query.since);
  const cursor = headerCursor !== null ? headerCursor : sinceCursor;

  const filters = { channels, excludeSender, mentions };

  // CP12.x.4 Layer-1 Step 1 (#8949): per-connection instrumentation state.
  const agentKey = excludeSender || '__anonymous__';
  const agentStat = getOrInitAgent(agentKey);
  const openedAt = Date.now();
  agentStat.open_count += 1;
  agentStat.current_active_count += 1;
  let eventsDispatched = 0;
  let keepalivesSent = 0;
  let filterMatchCount = 0;
  let firstByteAt = null;
  let bytesWritten = 0;
  let closeReason = null;  // populated by cleanup()

  // Wrap res.write so we capture first-byte timing + byte volume per
  // connection without touching every call-site.
  const _rawWrite = res.write.bind(res);
  res.write = (chunk) => {
    if (firstByteAt === null) {
      firstByteAt = Date.now();
      pushSample(agentStat.first_byte_ms_samples, firstByteAt - openedAt);
    }
    bytesWritten += Buffer.byteLength(chunk);
    return _rawWrite(chunk);
  };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');

  // Register close handler early so listeners are always cleaned up,
  // even if the client disconnects during the synchronous replay/drain phase.
  let closed = false;
  let currentListener = null;
  let keepalive = null;
  let flushTimer = null;
  const pending = [];

  const cleanup = (reason = 'client_close') => {
    if (closed) return;
    closed = true;
    closeReason = reason;
    if (keepalive) clearInterval(keepalive);
    if (flushTimer) clearTimeout(flushTimer);
    pending.length = 0;
    if (currentListener) messageBus.off('message', currentListener);

    // Lifecycle record per #8949 Step 1 + #181 silent-dead-on-arrival vs
    // recovery-stall distinguisher fold.
    agentStat.current_active_count = Math.max(0, agentStat.current_active_count - 1);
    const durationS = (Date.now() - openedAt) / 1000;
    pushSample(agentStat.duration_s_samples, durationS);
    // CP12.x.4 Step 1.1: counters now flushed live at each call-site, so
    // cleanup() must NOT re-accumulate (would double-count). Locals retained
    // for the per-connection forensic log line below.

    // #181: arrival_silent vs recovery_stall fold. select_timeout with
    // zero events dispatched maps to one of:
    //   - arrival_silent: this is the agent's first connection post-boot
    //     AND zero events dispatched
    //   - recovery_stall: agent has had prior connections-with-events
    //     AND zero events dispatched this cycle
    let foldedReason = reason;
    if (reason === 'select_timeout' && eventsDispatched === 0) {
      foldedReason = agentStat.last_close_had_events ? 'recovery_stall' : 'arrival_silent';
    }
    agentStat.close_count_by_reason[foldedReason] =
      (agentStat.close_count_by_reason[foldedReason] || 0) + 1;
    agentStat.last_close_had_events = eventsDispatched > 0;

    console.log(`[stream-close] agent=${agentKey} reason=${foldedReason} bytes=${bytesWritten} keepalives=${keepalivesSent} events=${eventsDispatched} dur=${durationS.toFixed(1)}s`);
  };
  req.on('close', () => cleanup('client_close'));

  // Race-free replay: subscribe first (buffer), then replay, then drain buffer.
  const buffered = [];
  currentListener = (msg) => buffered.push(msg);
  messageBus.on('message', currentListener);

  let highestReplayed = cursor !== null ? cursor : 0;
  let replayRows = 0;
  let replayFiltered = 0;
  const replayStart = Date.now();
  if (cursor !== null && !closed) {
    const channelsArr = channels ? Array.from(channels) : null;
    const rows = listMessagesAfter({ afterId: cursor, channels: channelsArr, excludeSender, mentions });
    replayRows = rows.length;
    for (const msg of rows) {
      if (closed) break;
      if (!dmVisible(msg, req)) { replayFiltered += 1; continue; }
      res.write(formatEvent(msg));
      eventsDispatched += 1;
      agentStat.events_dispatched_total += 1;
      agentStat.last_event_dispatched_at = new Date().toISOString();
      highestReplayed = Math.max(highestReplayed, msg.id);
    }
  }
  const replayMs = Date.now() - replayStart;
  pushSample(agentStat.replay_rows_samples, replayRows);
  // replay_filtered samples = % of rows filtered out (0-100); guard /0.
  pushSample(
    agentStat.replay_filtered_samples,
    replayRows > 0 ? Math.round((replayFiltered / replayRows) * 100) : 0,
  );
  pushSample(agentStat.replay_ms_samples, replayMs);
  console.log(`[stream-open] agent=${agentKey} since=${cursor ?? 'none'} replay_rows=${replayRows} replay_filtered=${replayFiltered} replay_ms=${replayMs}`);

  const seen = new Set();
  for (const msg of buffered) {
    if (closed) break;
    if (msg.id <= highestReplayed) continue;
    if (!messageMatches(msg, filters)) continue;
    if (!dmVisible(msg, req)) continue;
    if (seen.has(msg.id)) continue;
    seen.add(msg.id);
    res.write(formatEvent(msg));
    eventsDispatched += 1;
    agentStat.events_dispatched_total += 1;
    agentStat.last_event_dispatched_at = new Date().toISOString();
  }
  buffered.length = 0;

  messageBus.off('message', currentListener);
  currentListener = null;
  if (closed) return;

  const flush = () => {
    flushTimer = null;
    if (closed) return;
    for (const msg of pending) {
      res.write(formatEvent(msg));
      eventsDispatched += 1;
      agentStat.events_dispatched_total += 1;
    }
    if (pending.length > 0) {
      agentStat.last_event_dispatched_at = new Date().toISOString();
    }
    pending.length = 0;
  };

  if (minQuietMs === 0) {
    currentListener = (msg) => {
      if (!messageMatches(msg, filters)) return;
      filterMatchCount += 1;
      agentStat.filter_match_count_total += 1;
      if (!dmVisible(msg, req)) return;
      res.write(formatEvent(msg));
      eventsDispatched += 1;
      agentStat.events_dispatched_total += 1;
      agentStat.last_event_dispatched_at = new Date().toISOString();
    };
  } else {
    currentListener = (msg) => {
      if (!messageMatches(msg, filters)) return;
      filterMatchCount += 1;
      agentStat.filter_match_count_total += 1;
      if (!dmVisible(msg, req)) return;
      pending.push(msg);
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(flush, minQuietMs);
    };
  }
  messageBus.on('message', currentListener);

  keepalive = setInterval(() => {
    res.write(`: keepalive\n\n`);
    keepalivesSent += 1;
    agentStat.keepalive_count_total += 1;
    agentStat.last_keepalive_at = new Date().toISOString();
  }, KEEPALIVE_MS);
}

module.exports = { streamHandler, getStreamStats, startEmpiricalAnchorLoop, stopEmpiricalAnchorLoop };
