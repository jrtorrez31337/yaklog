const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const { insertMessage, listMessages, listChannels, updateMessage, deleteMessage, getMessage,
        upsertPresence, getPresenceByAgent, listPresence, listPresenceTransitions } = require('./db');
const { streamHandler } = require('./stream');
const config = require('./config');
const { enforceSenderBinding, enforceMutationBinding } = require('./middleware/senderBinding');
const { enforceDaemonBinding } = require('./middleware/daemonBinding');

const AGENT_ID_RE = /^[a-zA-Z0-9._:@/-]{1,64}$/;
const DAEMON_STATES = new Set(['up', 'down']);
const SESSION_STATES = new Set(['active', 'idle', 'unknown', 'tool_running', 'idle_between_tools']);

const router = express.Router();

const CHANNEL_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const SENDER_RE = /^[a-zA-Z0-9._:@/-]{1,64}$/;

function parsePositiveInt(value, fallback, max) {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.min(parsed, max);
}

function parseOptionalInt(value) {
  if (value === undefined) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

router.get('/messages', (req, res) => {
  const limit = parsePositiveInt(req.query.limit, 50, 200);
  if (limit === null) {
    return res.status(400).json({ error: 'ValidationError', message: 'limit must be a positive integer.' });
  }

  const channel = req.query.channel ? String(req.query.channel) : null;
  if (channel && !CHANNEL_RE.test(channel)) {
    return res.status(400).json({ error: 'ValidationError', message: 'channel must match [a-zA-Z0-9._-] and be <= 64 chars.' });
  }

  const afterId = parseOptionalInt(req.query.after_id);
  const beforeId = parseOptionalInt(req.query.before_id);

  if (req.query.after_id !== undefined && afterId === null) {
    return res.status(400).json({ error: 'ValidationError', message: 'after_id must be a non-negative integer.' });
  }

  if (req.query.before_id !== undefined && beforeId === null) {
    return res.status(400).json({ error: 'ValidationError', message: 'before_id must be a non-negative integer.' });
  }

  const messages = listMessages({ channel, limit, afterId, beforeId });
  return res.json({ messages, count: messages.length });
});

router.post('/messages', (req, res) => {
  const { channel, sender, body, metadata } = req.body || {};

  if (typeof channel !== 'string' || !CHANNEL_RE.test(channel)) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'channel is required and must match [a-zA-Z0-9._-] (1-64 chars).'
    });
  }

  if (typeof sender !== 'string' || !SENDER_RE.test(sender)) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'sender is required and must match [a-zA-Z0-9._:@/-] (1-64 chars).'
    });
  }

  if (typeof body !== 'string' || body.trim().length === 0) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'body is required and must be a non-empty string.'
    });
  }

  if (metadata !== undefined && (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata))) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'metadata must be a JSON object when provided.'
    });
  }

  const violation = enforceSenderBinding(req, sender);
  if (violation) {
    return res.status(violation.status).json(violation.body);
  }

  const message = insertMessage({
    channel,
    sender,
    body,
    metadata: metadata || null
  });

  return res.status(201).json({ message });
});

router.get('/channels', (req, res) => {
  const limit = parsePositiveInt(req.query.limit, 100, 500);
  if (limit === null) {
    return res.status(400).json({ error: 'ValidationError', message: 'limit must be a positive integer.' });
  }

  const channels = listChannels(limit);
  return res.json({ channels, count: channels.length });
});

router.get('/context', (req, res) => {
  const channel = req.query.channel ? String(req.query.channel) : null;
  if (!channel || !CHANNEL_RE.test(channel)) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'channel query param is required and must match [a-zA-Z0-9._-] (1-64 chars).'
    });
  }

  const limit = parsePositiveInt(req.query.limit, 25, 200);
  if (limit === null) {
    return res.status(400).json({ error: 'ValidationError', message: 'limit must be a positive integer.' });
  }

  const format = req.query.format ? String(req.query.format) : 'text';
  const messages = listMessages({ channel, limit });

  if (format === 'json') {
    return res.json({ channel, count: messages.length, messages });
  }

  if (format !== 'text') {
    return res.status(400).json({ error: 'ValidationError', message: 'format must be "text" or "json".' });
  }

  const lines = [`channel=${channel}`, `count=${messages.length}`];
  for (const message of messages) {
    lines.push('---');
    lines.push(`id=${message.id}`);
    lines.push(`time=${message.created_at}`);
    lines.push(`sender=${message.sender}`);
    lines.push('body<<EOF');
    lines.push(message.body);
    lines.push('EOF');
  }

  res.type('text/plain');
  return res.send(`${lines.join('\n')}\n`);
});

router.patch('/messages/:id', (req, res) => {
  const id = parsePositiveInt(req.params.id, null, Number.MAX_SAFE_INTEGER);
  if (id === null) {
    return res.status(400).json({ error: 'ValidationError', message: 'id must be a positive integer.' });
  }

  const { body, metadata } = req.body || {};

  if (body === undefined && metadata === undefined) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'At least one of body or metadata is required.'
    });
  }

  if (body !== undefined && (typeof body !== 'string' || body.trim().length === 0)) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'body must be a non-empty string when provided.'
    });
  }

  if (metadata !== undefined && (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata))) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'metadata must be a JSON object when provided.'
    });
  }

  const existing = getMessage(id);
  if (!existing) {
    return res.status(404).json({ error: 'NotFound', message: 'Message not found.' });
  }

  const violation = enforceMutationBinding(req, existing.sender);
  if (violation) {
    return res.status(violation.status).json(violation.body);
  }

  const updates = {};
  if (body !== undefined) updates.body = body;
  if (metadata !== undefined) updates.metadata = metadata;

  const message = updateMessage(id, updates);
  if (!message) {
    return res.status(404).json({ error: 'NotFound', message: 'Message not found.' });
  }

  return res.json({ message });
});

router.delete('/messages/:id', (req, res) => {
  const id = parsePositiveInt(req.params.id, null, Number.MAX_SAFE_INTEGER);
  if (id === null) {
    return res.status(400).json({ error: 'ValidationError', message: 'id must be a positive integer.' });
  }

  const existing = getMessage(id);
  if (!existing) {
    return res.status(404).json({ error: 'NotFound', message: 'Message not found.' });
  }

  const violation = enforceMutationBinding(req, existing.sender);
  if (violation) {
    return res.status(violation.status).json(violation.body);
  }

  const deleted = deleteMessage(id);
  if (!deleted) {
    return res.status(404).json({ error: 'NotFound', message: 'Message not found.' });
  }

  return res.status(204).send();
});

router.post('/presence/event', (req, res) => {
  const { agent_id, daemon_state, session_state, cursor_position, lock_held, sse_connected, last_hook_at, reason } = req.body || {};

  if (typeof agent_id !== 'string' || !AGENT_ID_RE.test(agent_id)) {
    return res.status(400).json({ error: 'ValidationError', message: 'agent_id is required and must match [a-zA-Z0-9._:@/-] (1-64 chars).' });
  }
  if (typeof daemon_state !== 'string' || !DAEMON_STATES.has(daemon_state)) {
    return res.status(400).json({ error: 'ValidationError', message: `daemon_state must be one of: ${[...DAEMON_STATES].join(', ')}.` });
  }
  if (typeof session_state !== 'string' || !SESSION_STATES.has(session_state)) {
    return res.status(400).json({ error: 'ValidationError', message: `session_state must be one of: ${[...SESSION_STATES].join(', ')}.` });
  }
  if (cursor_position !== undefined && cursor_position !== null && !Number.isInteger(cursor_position)) {
    return res.status(400).json({ error: 'ValidationError', message: 'cursor_position must be an integer or null.' });
  }
  if (last_hook_at !== undefined && last_hook_at !== null && typeof last_hook_at !== 'string') {
    return res.status(400).json({ error: 'ValidationError', message: 'last_hook_at must be an ISO-8601 string or null.' });
  }

  const violation = enforceDaemonBinding(req, agent_id);
  if (violation) {
    return res.status(violation.status).json(violation.body);
  }

  const presence = upsertPresence({
    agent_id,
    daemon_state,
    session_state,
    cursor_position: cursor_position ?? null,
    lock_held: !!lock_held,
    sse_connected: !!sse_connected,
    last_hook_at: last_hook_at ?? null,
    reason: reason ?? null
  });

  return res.status(200).json({ presence });
});

function presenceEtag(rows) {
  const hash = crypto.createHash('sha256');
  for (const row of rows) {
    hash.update(`${row.agent_id}:${row.daemon_state}:${row.session_state}:${row.cursor_position ?? ''}:${row.lock_held ? 1 : 0}:${row.last_state_change_at}\n`);
  }
  return `"${hash.digest('hex').slice(0, 16)}"`;
}

router.get('/presence', (req, res) => {
  const presence = listPresence();
  const etag = presenceEtag(presence);
  res.set('ETag', etag);
  res.set('Cache-Control', 'no-cache');
  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }
  return res.json({ presence, count: presence.length });
});

router.get('/presence/:agent_id', (req, res) => {
  const agentId = String(req.params.agent_id);
  if (!AGENT_ID_RE.test(agentId)) {
    return res.status(400).json({ error: 'ValidationError', message: 'agent_id must match [a-zA-Z0-9._:@/-] (1-64 chars).' });
  }
  const presence = getPresenceByAgent(agentId);
  if (!presence) {
    return res.status(404).json({ error: 'NotFound', message: 'No presence record for agent.' });
  }
  const transitionLimit = parsePositiveInt(req.query.transitions, 20, 200);
  const transitions = listPresenceTransitions(agentId, transitionLimit ?? 20);
  const etag = presenceEtag([presence]);
  res.set('ETag', etag);
  res.set('Cache-Control', 'no-cache');
  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }
  return res.json({ presence, transitions });
});

router.get('/stream', streamHandler);

router.get('/spec', (req, res) => {
  let buf;
  try {
    buf = fs.readFileSync(config.specPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({
        error: 'NotFound',
        message: `spec file not configured or missing at ${config.specPath}`
      });
    }
    throw err;
  }

  const etag = `"${crypto.createHash('sha256').update(buf).digest('hex')}"`;
  res.set('ETag', etag);
  res.set('Cache-Control', 'no-cache');

  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }

  res.set('Content-Type', 'text/markdown; charset=utf-8');
  return res.status(200).send(buf);
});

module.exports = router;
