const { messageBus, listMessagesAfter } = require('./db');

const CHANNEL_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const SENDER_RE = /^[a-zA-Z0-9._:@/-]{1,64}$/;
const MENTION_RE = /^[A-Za-z0-9_\-]{1,64}$/;

const KEEPALIVE_MS = Number.parseInt(process.env.YAKLOG_STREAM_KEEPALIVE_MS, 10) || 15_000;

function parseCursor(value) {
  if (value === undefined || value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function messageMatches(msg, filters) {
  if (filters.channel && msg.channel !== filters.channel) return false;
  if (filters.excludeSender && msg.sender === filters.excludeSender) return false;
  if (filters.mention && !(msg.mentions || []).includes(filters.mention)) return false;
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
  const mention = req.query.mention ? String(req.query.mention) : null;
  if (mention && !MENTION_RE.test(mention)) {
    return res.status(400).json({ error: 'ValidationError', message: 'invalid mention' });
  }
  if (!excludeSender) {
    console.warn('[stream] subscription without exclude_sender — may self-wake');
  }

  const headerCursor = parseCursor(req.headers['last-event-id']);
  const sinceCursor = parseCursor(req.query.since);
  const cursor = headerCursor !== null ? headerCursor : sinceCursor;

  const filters = { channel, excludeSender, mention };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');

  // Race-free replay: subscribe first (buffer), then replay, then drain buffer.
  const buffered = [];
  const onBuffer = (msg) => buffered.push(msg);
  messageBus.on('message', onBuffer);

  let highestReplayed = cursor !== null ? cursor : 0;
  if (cursor !== null) {
    const rows = listMessagesAfter({ afterId: cursor, channel, excludeSender, mention });
    for (const msg of rows) {
      res.write(formatEvent(msg));
      highestReplayed = Math.max(highestReplayed, msg.id);
    }
  }

  const seen = new Set();
  for (const msg of buffered) {
    if (msg.id <= highestReplayed) continue;
    if (!messageMatches(msg, filters)) continue;
    if (seen.has(msg.id)) continue;
    seen.add(msg.id);
    res.write(formatEvent(msg));
  }
  buffered.length = 0;

  messageBus.off('message', onBuffer);
  const liveHandler = (msg) => {
    if (!messageMatches(msg, filters)) return;
    res.write(formatEvent(msg));
  };
  messageBus.on('message', liveHandler);

  const keepalive = setInterval(() => {
    res.write(`: keepalive\n\n`);
  }, KEEPALIVE_MS);

  req.on('close', () => {
    clearInterval(keepalive);
    messageBus.off('message', liveHandler);
  });
}

module.exports = { streamHandler };
