const express = require('express');
const { insertMessage, listMessages, listChannels, updateMessage, deleteMessage } = require('./db');

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

  const deleted = deleteMessage(id);
  if (!deleted) {
    return res.status(404).json({ error: 'NotFound', message: 'Message not found.' });
  }

  return res.status(204).send();
});

module.exports = router;
