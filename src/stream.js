const { messageBus, listMessagesAfter } = require('./db');

const CHANNEL_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const SENDER_RE = /^[a-zA-Z0-9._:@/-]{1,64}$/;
const MENTION_RE = /^[A-Za-z0-9_\-]{1,64}$/;

const KEEPALIVE_MS = Number.parseInt(process.env.YAKLOG_STREAM_KEEPALIVE_MS, 10) || 15_000;
const DEFAULT_COALESCE_MS = 500;

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

function messageMatches(msg, filters) {
  if (filters.channel && msg.channel !== filters.channel) return false;
  if (filters.excludeSender && msg.sender === filters.excludeSender) return false;
  if (filters.mentions) {
    const msgMentions = msg.mentions || [];
    if (!filters.mentions.some((m) => msgMentions.includes(m))) return false;
  }
  return true;
}

function formatEvent(msg) {
  return `id: ${msg.id}\nevent: message\ndata: ${JSON.stringify(msg)}\n\n`;
}

function streamHandler(req, res) {
  const channel = req.query.channel ? String(req.query.channel) : null;
  if (channel && !CHANNEL_RE.test(channel)) {
    return res.status(400).json({ error: 'ValidationError', message: 'invalid channel' });
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

  const filters = { channel, excludeSender, mentions };

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

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (keepalive) clearInterval(keepalive);
    if (flushTimer) clearTimeout(flushTimer);
    pending.length = 0;
    if (currentListener) messageBus.off('message', currentListener);
  };
  req.on('close', cleanup);

  // Race-free replay: subscribe first (buffer), then replay, then drain buffer.
  const buffered = [];
  currentListener = (msg) => buffered.push(msg);
  messageBus.on('message', currentListener);

  let highestReplayed = cursor !== null ? cursor : 0;
  if (cursor !== null && !closed) {
    const rows = listMessagesAfter({ afterId: cursor, channel, excludeSender, mentions });
    for (const msg of rows) {
      if (closed) break;
      res.write(formatEvent(msg));
      highestReplayed = Math.max(highestReplayed, msg.id);
    }
  }

  const seen = new Set();
  for (const msg of buffered) {
    if (closed) break;
    if (msg.id <= highestReplayed) continue;
    if (!messageMatches(msg, filters)) continue;
    if (seen.has(msg.id)) continue;
    seen.add(msg.id);
    res.write(formatEvent(msg));
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
    }
    pending.length = 0;
  };

  if (minQuietMs === 0) {
    currentListener = (msg) => {
      if (!messageMatches(msg, filters)) return;
      res.write(formatEvent(msg));
    };
  } else {
    currentListener = (msg) => {
      if (!messageMatches(msg, filters)) return;
      pending.push(msg);
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(flush, minQuietMs);
    };
  }
  messageBus.on('message', currentListener);

  keepalive = setInterval(() => {
    res.write(`: keepalive\n\n`);
  }, KEEPALIVE_MS);
}

module.exports = { streamHandler };
