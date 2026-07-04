const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { insertMessage, listMessages, listChannels, updateMessage, deleteMessage, getMessage,
        upsertPresence, getPresenceByAgent, listPresence, listPresenceTransitions,
        deletePresenceRow, insertAgentActivity, listAgentActivity } = require('./db');
const { streamHandler, getStreamStats } = require('./stream');
const config = require('./config');
const { enforceSenderBinding, enforceMutationBinding, resolveAllowedSenders } = require('./middleware/senderBinding');
const { enforceDaemonBinding } = require('./middleware/daemonBinding');
const { applyDmVisibilityFilter, writeAuditEntries } = require('./middleware/dmFilter');
const { parseMentions } = require('./mentions');
const brevityHints = require('./middleware/brevityHints');
const { emit } = require('./metrics');

const AGENT_ID_RE = /^[a-zA-Z0-9._:@/-]{1,64}$/;
const DAEMON_STATES = new Set(['up', 'down']);
// v0.5.7: stop_failure added per daemon StopFailure hook recognition.
// Sticky like idle/down; sets last_stop_reason="failure" upstream for the
// Amendment-1 silence-ambiguity sunset signal.
// CP14.x (Task #174): 'in_flight' enum value for long-running CLI runtimes
// (Codex/Gemini sessions that take minutes-to-hours; distinct from per-tool
// tool_running which is short-duration per-invocation). Semantic: SESSION is
// actively computing for an extended period; expect long wait for next state
// change. Forward-track door-opener — existing emitters don't produce yet;
// /presence/event accepts; daemon-side adoption is per-runtime cycle.
const SESSION_STATES = new Set(['active', 'idle', 'unknown', 'tool_running', 'idle_between_tools', 'compacting', 'stop_failure', 'in_flight']);

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

  // Task #264 Phase 2.6 (Jon-direct 2026-07-03): time-anchored cursor for
  // dashboard-tier Bus tab time-navigation. before_ts_ms / after_ts_ms accept
  // millisecond-epoch integers; converted server-side to ISO-8601 strings for
  // lexicographic comparison against created_at TEXT column.
  const beforeTsMs = parseOptionalInt(req.query.before_ts_ms);
  const afterTsMs = parseOptionalInt(req.query.after_ts_ms);
  if (req.query.before_ts_ms !== undefined && beforeTsMs === null) {
    return res.status(400).json({ error: 'ValidationError', message: 'before_ts_ms must be a non-negative integer (millisecond epoch).' });
  }
  if (req.query.after_ts_ms !== undefined && afterTsMs === null) {
    return res.status(400).json({ error: 'ValidationError', message: 'after_ts_ms must be a non-negative integer (millisecond epoch).' });
  }
  // Task #264 hardening nit (parch #11506 forward-track): JS Date range is
  // ±8.64e15 ms. Larger values throw RangeError → 500 instead of a clean 400.
  // Clamp at parse-boundary to preserve validation-layer discipline.
  const MAX_JS_TS_MS = 8_640_000_000_000_000;
  if (beforeTsMs !== null && beforeTsMs > MAX_JS_TS_MS) {
    return res.status(400).json({ error: 'ValidationError', message: `before_ts_ms exceeds max JS timestamp (${MAX_JS_TS_MS}).` });
  }
  if (afterTsMs !== null && afterTsMs > MAX_JS_TS_MS) {
    return res.status(400).json({ error: 'ValidationError', message: `after_ts_ms exceeds max JS timestamp (${MAX_JS_TS_MS}).` });
  }
  const beforeTs = beforeTsMs !== null ? new Date(beforeTsMs).toISOString() : null;
  const afterTs = afterTsMs !== null ? new Date(afterTsMs).toISOString() : null;

  const messages = listMessages({ channel, limit, afterId, beforeId, beforeTs, afterTs });
  // ADR-0026 read-filter: bound → public + sender/mentions-match private;
  // ops-key → all + audit-log per private row; unbound → public only.
  const { filtered, auditEntries } = applyDmVisibilityFilter(messages, req);
  if (auditEntries.length > 0) writeAuditEntries(auditEntries);
  return res.json({ messages: filtered, count: filtered.length });
});

router.post('/messages', (req, res) => {
  const { channel, body, metadata, private: isPrivate } = req.body || {};
  let { sender } = req.body || {};

  // Operator-class server-side sender override (PLAN-DASHBOARD-OPERATOR-DM §2.3
  // Block-1 sister-canon per secops FLAG-3 + parch Q8 RATIFY). Operator-bearer
  // cannot supply an arbitrary sender; server forces sender = operatorId from
  // the auth-binding regardless of request-body value. Sister-canon to
  // ADR-0040 §4.1 session_class server-enforcement at /presence/event handler.
  // Empirical-validation per Q9: operator-bearer POST with sender:"<other>" →
  // server-overridden to operatorId.
  if (req.tokenClass === 'operator' && req.auth && req.auth.operatorId) {
    sender = req.auth.operatorId;
  }

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

  if (isPrivate !== undefined && typeof isPrivate !== 'boolean') {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'private must be a boolean when provided.'
    });
  }

  const violation = enforceSenderBinding(req, sender);
  if (violation) {
    return res.status(violation.status).json(violation.body);
  }

  // ADR-0026 send-path: private=true requires (a) bound sender AND (b)
  // non-empty mentions. (a) defends against unbound bearers spoofing sender
  // on a private send (read-filter depends on row.sender being authoritative;
  // unbound senders carry no enforceable identity). (b) defends against
  // private messages with no recipients (unreadable; almost-certainly bug).
  if (isPrivate === true) {
    const { allowedSenders } = resolveAllowedSenders(req);
    if (!allowedSenders) {
      return res.status(403).json({
        error: 'PrivateSendRequiresBoundSender',
        message: 'private:true requires a Bearer bound to the sender via YAKLOG_TOKEN_BINDINGS or /register. Unbound legacy keys cannot send private messages.'
      });
    }
    const mentions = parseMentions(body);
    if (mentions.length === 0) {
      return res.status(400).json({
        error: 'PrivateSendRequiresMentions',
        message: 'private:true requires at least one @mention in the body (the recipient(s)).'
      });
    }
  }

  const message = insertMessage({
    channel,
    sender,
    body,
    metadata: metadata || null,
    isPrivate: isPrivate === true
  });

  // Task #242 / PLAN-COMMS-BREVITY-SUBSTRATE — server-side soft-warn for
  // brevity-canon violations per parch #11140 Q1-Q5 RATIFY. Pure-function
  // linter; never hard-blocks; attaches warnings to response when present;
  // emits Prom counter per (agent_id, kind). Per Q4: sample text in response
  // only, NEVER in metric labels.
  const warnings = brevityHints.lint(body);
  if (warnings.length > 0) {
    emit.brevityWarnings(sender, warnings);
    return res.status(201).json({ message, warnings });
  }
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
  const rawMessages = listMessages({ channel, limit });
  // ADR-0026 read-filter (same three-branch as GET /messages).
  const { filtered, auditEntries } = applyDmVisibilityFilter(rawMessages, req);
  if (auditEntries.length > 0) writeAuditEntries(auditEntries);
  const messages = filtered;

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

router.get('/messages/:id', (req, res) => {
  const id = parsePositiveInt(req.params.id, null, Number.MAX_SAFE_INTEGER);
  if (id === null) {
    return res.status(400).json({ error: 'ValidationError', message: 'id must be a positive integer.' });
  }
  const message = getMessage(id);
  if (!message) {
    return res.status(404).json({ error: 'NotFound', message: `Message id ${id} not found.` });
  }
  // ADR-0026: run the same three-branch filter on a single-row list. A private
  // message hidden from the requester returns 404 (not 403) — never leak
  // existence to non-recipients.
  const { filtered, auditEntries } = applyDmVisibilityFilter([message], req);
  if (auditEntries.length > 0) writeAuditEntries(auditEntries);
  if (filtered.length === 0) {
    return res.status(404).json({ error: 'NotFound', message: `Message id ${id} not found.` });
  }
  return res.json({ message: filtered[0] });
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

// v0.5.7: validation whitelists for runtime-meta enum-ish fields.
const TOOL_STATUS_VALUES = new Set(['ok', 'error']);
const COMPACTION_REASON_VALUES = new Set(['manual', 'auto']);
const STOP_REASON_VALUES = new Set(['natural', 'failure']);
const SESSION_SOURCE_VALUES = new Set(['startup', 'resume', 'clear', 'compact']);
// v0.5.9 runtime-execution-liveness — parch-ratified field contract #6684.
const RUNTIME_STATE_VALUES = new Set(['active', 'quota_exhausted', 'error']);
// Bounds for free-text runtime-meta fields (model/tool name; substrate-local
// distilled values, not user content — kept tight for sanity).
const RUNTIME_META_STRING_MAX = 128;

function validateOptionalEnum(value, allowed, fieldName) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !allowed.has(value)) {
    return { error: 'ValidationError', message: `${fieldName} must be one of: ${[...allowed].join(', ')} (or null).` };
  }
  return null;
}
function validateOptionalString(value, fieldName, maxLen = RUNTIME_META_STRING_MAX) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > maxLen) {
    return { error: 'ValidationError', message: `${fieldName} must be a string (≤${maxLen} chars) or null.` };
  }
  return null;
}
function validateOptionalNonNegInt(value, fieldName) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 0) {
    return { error: 'ValidationError', message: `${fieldName} must be a non-negative integer or null.` };
  }
  return null;
}

router.post('/presence/event', (req, res) => {
  const {
    agent_id, daemon_state, session_state, cursor_position, lock_held,
    sse_connected, last_hook_at, reason, events_consumer_count,
    // v0.5.7 runtime-meta (all optional)
    current_model, current_tool, last_tool_name, last_tool_status,
    last_compaction_reason, last_compaction_at, last_stop_reason,
    last_session_source, subagent_active_count,
    // v0.5.7.3 runtime-env (all optional)
    runtime_uid, runtime_gid, runtime_hostname, current_cwd,
    // v0.5.7.4 daemon-process (all optional)
    daemon_pid, daemon_version, daemon_started_at,
    // v0.5.9 runtime-execution-liveness (per parch ratification #6684; ADR-0027)
    runtime_state, runtime_blocked_until
  } = req.body || {};

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
  // v0.5.6: events_consumer_count optional (older daemons don't send); when sent, must be non-negative integer or null
  if (events_consumer_count !== undefined && events_consumer_count !== null
      && (!Number.isInteger(events_consumer_count) || events_consumer_count < 0)) {
    return res.status(400).json({ error: 'ValidationError', message: 'events_consumer_count must be a non-negative integer or null.' });
  }
  // v0.5.7 runtime-meta validation. All optional; strict whitelists for
  // enum-shaped fields; bounded strings for free-text; non-negative ints.
  // Privacy-by-design: server doesn't accept arbitrary content here — only
  // values the daemon's distillation layer is supposed to produce.
  for (const [val, allowed, name] of [
    [last_tool_status, TOOL_STATUS_VALUES, 'last_tool_status'],
    [last_compaction_reason, COMPACTION_REASON_VALUES, 'last_compaction_reason'],
    [last_stop_reason, STOP_REASON_VALUES, 'last_stop_reason'],
    [last_session_source, SESSION_SOURCE_VALUES, 'last_session_source'],
  ]) {
    const e = validateOptionalEnum(val, allowed, name);
    if (e) return res.status(400).json(e);
  }
  for (const [val, name] of [
    [current_model, 'current_model'],
    [current_tool, 'current_tool'],
    [last_tool_name, 'last_tool_name'],
    [last_compaction_at, 'last_compaction_at'],
  ]) {
    const e = validateOptionalString(val, name);
    if (e) return res.status(400).json(e);
  }
  {
    const e = validateOptionalNonNegInt(subagent_active_count, 'subagent_active_count');
    if (e) return res.status(400).json(e);
  }
  // v0.5.7.3 runtime-env validation. uid + gid bounded ints; hostname +
  // cwd bounded strings; all optional.
  for (const [val, name] of [
    [runtime_uid, 'runtime_uid'], [runtime_gid, 'runtime_gid'],
  ]) {
    const e = validateOptionalNonNegInt(val, name);
    if (e) return res.status(400).json(e);
  }
  for (const [val, name] of [
    [runtime_hostname, 'runtime_hostname'],
    [current_cwd, 'current_cwd'],
  ]) {
    const e = validateOptionalString(val, name);
    if (e) return res.status(400).json(e);
  }
  // v0.5.7.4 daemon-process: pid non-neg int, version + started_at strings
  {
    const e = validateOptionalNonNegInt(daemon_pid, 'daemon_pid');
    if (e) return res.status(400).json(e);
  }
  for (const [val, name] of [
    [daemon_version, 'daemon_version'],
    [daemon_started_at, 'daemon_started_at'],
  ]) {
    const e = validateOptionalString(val, name);
    if (e) return res.status(400).json(e);
  }
  // v0.5.9 runtime-execution-liveness validation. runtime_state ∈ allowlist
  // (or null = unset / pre-v0.5.9 daemon). runtime_blocked_until = ISO-8601
  // string (or null); only meaningful when runtime_state !== 'active', but
  // we don't enforce the pairing here — daemon-side discipline.
  {
    const e = validateOptionalEnum(runtime_state, RUNTIME_STATE_VALUES, 'runtime_state');
    if (e) return res.status(400).json(e);
  }
  {
    const e = validateOptionalString(runtime_blocked_until, 'runtime_blocked_until');
    if (e) return res.status(400).json(e);
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
    reason: reason ?? null,
    events_consumer_count: events_consumer_count ?? null,
    // v0.5.7 runtime-meta passthrough (db.js applies COALESCE/raw semantics).
    current_model: current_model ?? null,
    current_tool: current_tool ?? null,
    last_tool_name: last_tool_name ?? null,
    last_tool_status: last_tool_status ?? null,
    last_compaction_reason: last_compaction_reason ?? null,
    last_compaction_at: last_compaction_at ?? null,
    last_stop_reason: last_stop_reason ?? null,
    last_session_source: last_session_source ?? null,
    subagent_active_count: subagent_active_count ?? null,
    // v0.5.7.3 runtime-env passthrough
    runtime_uid: runtime_uid ?? null,
    runtime_gid: runtime_gid ?? null,
    runtime_hostname: runtime_hostname ?? null,
    current_cwd: current_cwd ?? null,
    daemon_pid: daemon_pid ?? null,
    daemon_version: daemon_version ?? null,
    daemon_started_at: daemon_started_at ?? null,
    // v0.5.9 runtime-execution-liveness passthrough.
    runtime_state: runtime_state ?? null,
    runtime_blocked_until: runtime_blocked_until ?? null,
    // Operator-session Phase A per PLAN-OPERATOR-SESSION-SUBSTRATE v2 RATIFIED
    // by parch #10382 + Jon-direct #10404. CRITICAL DISCIPLINE per secops
    // Block-1: session_class is SERVER-ENFORCED from the auth binding tier
    // (req.tokenClass). Client-supplied session_class field in request body
    // is IGNORED — operator cannot impersonate agent-class via crafted POST.
    // Sister-shape canon to DAEMON_BINDINGS auth-tier discipline.
    session_class: req.tokenClass === 'operator' ? 'operator' : 'agent'
  });

  return res.status(200).json({ presence });
});

function presenceEtag(rows) {
  const hash = crypto.createHash('sha256');
  for (const row of rows) {
    // v0.5.7: include runtime-meta in ETag so dashboard refreshes when meta
    // changes even if session_state/label don't. current_tool especially is
    // a fast-moving field that the dashboard wants reflected within seconds.
    hash.update(`${row.agent_id}:${row.daemon_state}:${row.session_state}:${row.cursor_position ?? ''}:${row.lock_held ? 1 : 0}:${row.last_state_change_at}:${row.current_model ?? ''}:${row.current_tool ?? ''}:${row.last_tool_name ?? ''}:${row.last_tool_status ?? ''}:${row.subagent_active_count ?? ''}:${row.last_stop_reason ?? ''}\n`);
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

// v0.5.8.4 (2026-05-27): explicit decommission. expireStalePresence only
// flips daemon_state=down; rows never go away. For an explicit retirement
// (e.g. aieng2 decom 2026-05-27) we want the row GONE so the dashboard
// stops rendering a ghost card. Gated to ops-key only (admin / secops /
// ssw-devops lane); req.auth.opsKeyId is populated by middleware/auth.js
// path (c) when the Bearer is a YAKLOG_OPS_API_KEYS member. Records a
// transition with the actor's opsKeyId-prefix for audit.
// CP11.3 (2026-06-04): Phase 3 ops-key mutation endpoints per ratified
// ADR-0029 v2.3. Three endpoints: dimension-tag / budget / reconcile.
// All ops-key gated; all idempotent or audit-append-only.

router.put('/ops/cost/dimension-tag', (req, res) => {
  if (!req.auth || !req.auth.opsKeyId) {
    return res.status(403).json({ error: 'OpsKeyRequired', message: 'requires ops-key' });
  }
  const b = req.body || {};
  if (!b.agent_id || typeof b.agent_id !== 'string') {
    return res.status(400).json({ error: 'ValidationError', message: 'agent_id required' });
  }
  try {
    const { upsertCostDimensionTags } = require('./db');
    upsertCostDimensionTags({
      agent_id: b.agent_id,
      cost_center: b.cost_center || '',
      project_tag: b.project_tag || '',
      environment_tier: b.environment_tier || '',
      billable_flag: b.billable_flag ? 1 : 0,
      updated_by: `ops:${req.auth.opsKeyId}`,
    });
    return res.json({ ok: true, agent_id: b.agent_id });
  } catch (e) {
    return res.status(500).json({ error: 'UpsertFailed', message: e.message });
  }
});

router.put('/ops/cost/budget', (req, res) => {
  if (!req.auth || !req.auth.opsKeyId) {
    return res.status(403).json({ error: 'OpsKeyRequired', message: 'requires ops-key' });
  }
  const b = req.body || {};
  if (b.cost_center == null || !b.period_kind || !b.period_anchor || b.budget_usd == null) {
    return res.status(400).json({ error: 'ValidationError',
      message: 'cost_center + period_kind (monthly|quarterly) + period_anchor (YYYY-MM or YYYY-Qn) + budget_usd required' });
  }
  try {
    const { upsertCostBudget } = require('./db');
    upsertCostBudget({ ...b, updated_by: `ops:${req.auth.opsKeyId}` });
    return res.json({ ok: true, cost_center: b.cost_center, period_kind: b.period_kind, period_anchor: b.period_anchor });
  } catch (e) {
    return res.status(400).json({ error: 'UpsertFailed', message: e.message });
  }
});

router.post('/ops/cost/reconcile', (req, res) => {
  if (!req.auth || !req.auth.opsKeyId) {
    return res.status(403).json({ error: 'OpsKeyRequired', message: 'requires ops-key' });
  }
  const b = req.body || {};
  if (!b.period_start || !b.period_end || b.invoice_total_usd == null) {
    return res.status(400).json({ error: 'ValidationError',
      message: 'period_start + period_end + invoice_total_usd required' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.period_start) || !/^\d{4}-\d{2}-\d{2}$/.test(b.period_end)) {
    return res.status(400).json({ error: 'ValidationError', message: 'period_start/end must be YYYY-MM-DD' });
  }
  try {
    // Compute plexus-side total for the same period; insert audit row with delta.
    const { getCostByPeriod, insertCostReconciliation } = require('./db');
    const rows = getCostByPeriod({ from: b.period_start, to: b.period_end });
    const plexusTotal = rows.reduce((s, r) => s + r.cost_usd, 0);

    // Concentration analysis: where does divergence pile up by (user_email × model)?
    const concentration = {};
    const byDim = new Map();
    for (const r of rows) {
      const k = `${r.user_email}|${r.model}`;
      byDim.set(k, (byDim.get(k) || 0) + r.cost_usd);
    }
    concentration.by_user_email_model = [...byDim.entries()]
      .map(([k, v]) => { const [user_email, model] = k.split('|'); return { user_email, model, plexus_usd: v }; })
      .sort((a, b) => b.plexus_usd - a.plexus_usd).slice(0, 10);

    const result = insertCostReconciliation({
      period_start: b.period_start, period_end: b.period_end,
      invoice_label: b.invoice_label || null,
      invoice_total_usd: b.invoice_total_usd, plexus_total_usd: plexusTotal,
      concentration_json: concentration, notes: b.notes || null,
      reconciled_by: `ops:${req.auth.opsKeyId}`,
    });
    return res.json({ ok: true, ...result, plexus_total_usd: plexusTotal, top_dims: concentration.by_user_email_model.slice(0, 5) });
  } catch (e) {
    return res.status(400).json({ error: 'ReconcileFailed', message: e.message });
  }
});

// CP11.2 (2026-06-04): manual rollup trigger — ops-key gated.
// Forces a cost_daily rollup for a specific date (default today). Useful
// for catching late-arriving data, reconciling after a Prom outage, or
// retroactive re-rollup after operator changes cost_dimension_tags.
router.post('/ops/cost/rollup', async (req, res) => {
  if (!req.auth || !req.auth.opsKeyId) {
    return res.status(403).json({
      error: 'OpsKeyRequired',
      message: 'POST /ops/cost/rollup requires a Bearer token from YAKLOG_OPS_API_KEYS.'
    });
  }
  const date = (req.body && typeof req.body.date === 'string')
    ? req.body.date
    : new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'ValidationError', message: 'date must be YYYY-MM-DD' });
  }
  try {
    const { rollupDay } = require('./costRollup');
    const result = await rollupDay(date, { source: 'manual' });
    return res.json({ ok: true, ...result, requested_by: `ops:${req.auth.opsKeyId}` });
  } catch (e) {
    return res.status(500).json({ error: 'RollupFailed', message: e.message });
  }
});

router.delete('/presence/:agent_id', (req, res) => {
  if (!req.auth || !req.auth.opsKeyId) {
    return res.status(403).json({
      error: 'OpsKeyRequired',
      message: 'DELETE /presence/<id> requires a Bearer token from YAKLOG_OPS_API_KEYS.'
    });
  }
  const agentId = req.params.agent_id;
  if (!AGENT_ID_RE.test(agentId)) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'agent_id must match [a-zA-Z0-9._:@/-] (1-64 chars).'
    });
  }
  const reason = (req.body && typeof req.body.reason === 'string') ? req.body.reason.slice(0, 200) : 'decommissioned';
  const deleted = deletePresenceRow(agentId, { reason, actor: `ops:${req.auth.opsKeyId}` });
  if (!deleted) {
    return res.status(404).json({ error: 'NotFound', message: `No presence record for ${agentId}.` });
  }
  return res.status(200).json({ deleted, reason });
});

// CP10.3 (2026-06-02): per-agent activity timeline ingest.
// Daemon batches distilled hook-events client-side (yaklog-sub allowlist
// redacts secrets BEFORE they leave the daemon host) and POSTs every few
// seconds. Server enforces daemon-binding (sender matches agent_id) and
// caps payload size; storage layer trims to last 200 per agent on insert.
// Operator-only visibility — never crosses to swarm bus per
// feedback_dashboard_alerts_are_human_only generalization.
const ACTIVITY_BATCH_MAX = 100;
const ACTIVITY_PAYLOAD_MAX_BYTES = 4096;
const ACTIVITY_EVENT_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

router.post('/agents/:agent_id/activity', (req, res) => {
  const agent_id = req.params.agent_id;
  if (!AGENT_ID_RE.test(agent_id)) {
    return res.status(400).json({ error: 'ValidationError', message: 'agent_id must match [a-zA-Z0-9._:@/-] (1-64 chars).' });
  }
  const violation = enforceDaemonBinding(req, agent_id);
  if (violation) return res.status(violation.status).json(violation.body);

  const entries = req.body && Array.isArray(req.body.entries) ? req.body.entries : null;
  if (!entries) {
    return res.status(400).json({ error: 'ValidationError', message: 'entries must be an array of activity events.' });
  }
  if (entries.length === 0) {
    return res.json({ inserted: 0 });
  }
  if (entries.length > ACTIVITY_BATCH_MAX) {
    return res.status(400).json({ error: 'ValidationError', message: `entries length must be ≤ ${ACTIVITY_BATCH_MAX}.` });
  }
  // Validate each entry shape + size cap. Reject the whole batch on any
  // bad entry — daemons should produce clean batches; partial-success
  // semantics complicate retry logic.
  for (const e of entries) {
    if (!e || typeof e !== 'object') {
      return res.status(400).json({ error: 'ValidationError', message: 'each entry must be an object.' });
    }
    if (typeof e.event !== 'string' || !ACTIVITY_EVENT_RE.test(e.event)) {
      return res.status(400).json({ error: 'ValidationError', message: 'entry.event must match [A-Za-z][A-Za-z0-9_]{0,63}.' });
    }
    if (e.ts !== undefined && (typeof e.ts !== 'string' || e.ts.length > 40)) {
      return res.status(400).json({ error: 'ValidationError', message: 'entry.ts must be an ISO-8601 string ≤ 40 chars.' });
    }
    if (e.payload !== undefined && e.payload !== null) {
      if (typeof e.payload !== 'object') {
        return res.status(400).json({ error: 'ValidationError', message: 'entry.payload must be an object or null.' });
      }
      let serialized;
      try { serialized = JSON.stringify(e.payload); }
      catch { return res.status(400).json({ error: 'ValidationError', message: 'entry.payload is not JSON-serializable.' }); }
      if (serialized.length > ACTIVITY_PAYLOAD_MAX_BYTES) {
        return res.status(413).json({ error: 'PayloadTooLarge', message: `entry.payload exceeds ${ACTIVITY_PAYLOAD_MAX_BYTES} bytes.` });
      }
    }
  }
  const inserted = insertAgentActivity(agent_id, entries);
  return res.json({ inserted });
});

router.get('/agents/:agent_id/activity', (req, res) => {
  const agent_id = req.params.agent_id;
  if (!AGENT_ID_RE.test(agent_id)) {
    return res.status(400).json({ error: 'ValidationError', message: 'agent_id must match [a-zA-Z0-9._:@/-] (1-64 chars).' });
  }
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
  if (!Number.isFinite(limit) || limit < 1 || limit > 200) {
    return res.status(400).json({ error: 'ValidationError', message: 'limit must be 1-200.' });
  }
  return res.json({ activity: listAgentActivity(agent_id, limit) });
});

router.get('/stream', streamHandler);

// CP12.x.4 Layer-1 + #181 + #182 combined-cycle Step 1 (per parch #8949 Jon-
// direct 3-arbitration ratify + secops #8945 pre-clearance): ops-gated stream
// lifecycle stats endpoint. Returns per-agent counters: open/close lifecycle,
// replay metrics, keepalive count, close-reason fold (incl. arrival_silent vs
// recovery_stall), filter-match counts, low_traffic_likely_healthy boolean.
// No message content, no token material, no cursor values — operational
// metadata only per secops #8945 pre-scope §2.
router.get('/ops/stream/stats', (req, res) => {
  if (!req.auth || !req.auth.opsKeyId) {
    return res.status(403).json({
      error: 'OpsKeyRequired',
      message: 'GET /ops/stream/stats requires a Bearer token from YAKLOG_OPS_API_KEYS.'
    });
  }
  return res.json(getStreamStats());
});

// Canonical-doc name validator: lowercase letters/digits/dot/dash/underscore,
// must end in .md. Rejects anything that could traverse paths or load
// non-markdown content (no slashes, no leading dots, no .. segments).
const CANONICAL_NAME_RE = /^[a-z0-9][a-z0-9._-]*\.md$/i;

function serveCanonical(res, absPath, sourceLabel) {
  let buf;
  try {
    buf = fs.readFileSync(absPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({
        error: 'NotFound',
        message: `canonical doc not present at ${sourceLabel}`
      });
    }
    throw err;
  }

  const etag = `"${crypto.createHash('sha256').update(buf).digest('hex')}"`;
  res.set('ETag', etag);
  res.set('Cache-Control', 'no-cache');

  if (res.req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }

  res.set('Content-Type', 'text/markdown; charset=utf-8');
  return res.status(200).send(buf);
}

// GET /spec — backward-compat. Serves yaklog.md from the canonical-docs
// directory if present; falls back to the legacy single-file specPath if
// not. New consumers should prefer GET /spec/<name> for explicit doc choice.
router.get('/spec', (req, res) => {
  const dirYaklog = path.join(config.specDir, 'yaklog.md');
  if (fs.existsSync(dirYaklog)) {
    return serveCanonical(res, dirYaklog, dirYaklog);
  }
  return serveCanonical(res, config.specPath, config.specPath);
});

// GET /spec/:name — serve any canonical doc by basename from specDir.
// Name must match CANONICAL_NAME_RE (basename only, .md only) to prevent
// path traversal and accidental non-doc content service.
router.get('/spec/:name', (req, res) => {
  const name = req.params.name;
  if (!CANONICAL_NAME_RE.test(name)) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'canonical doc name must match [a-z0-9][a-z0-9._-]*\\.md (basename only).'
    });
  }
  const absPath = path.join(config.specDir, name);
  // Belt-and-suspenders: ensure resolved path stays under specDir.
  if (!path.resolve(absPath).startsWith(path.resolve(config.specDir) + path.sep)) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'canonical doc name resolved outside specDir.'
    });
  }
  return serveCanonical(res, absPath, name);
});

// GET /canonical/:repo/:treeish/* — serve any blob from an allowlisted
// bare-git repo. Use case: Mac substrate (or any client) needs canonical
// hooks/scripts/docs from agent-tooling.git or agent-globals.git without
// SSH or git client. Path is express splat (req.params[0]).
//
// Safety: repo must be allowlisted; treeish + path validated against
// strict regexes (no .., no leading dash, no shell meta); git is invoked
// via execFileSync with explicit args (no shell). ETag from blob sha.
const REPO_RE = /^[a-z0-9][a-z0-9._-]*$/i;
// Treeish: sha-ish (hex) OR branch/tag name. Reject leading dash (could be
// parsed as git option). Allow `/` for refs like `refs/heads/main`.
const TREEISH_RE = /^[a-z0-9][a-z0-9._/-]*$/i;
// Path: blob-path within repo. No leading dash; no .. segments. `@` is allowed
// (load-bearing for systemd template-unit filenames like `monitor-watchdog@.service`,
// per secops #5621 finding when Mac substrate tried to fetch via /canonical).
const CANONICAL_BLOB_PATH_RE = /^[a-z0-9][a-z0-9._/@-]*$/i;

function canonicalContentType(blobPath) {
  if (blobPath.endsWith('.md')) return 'text/markdown; charset=utf-8';
  if (blobPath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (blobPath.endsWith('.sh') || blobPath.endsWith('.py') || blobPath.endsWith('.js')) {
    return 'text/plain; charset=utf-8';
  }
  return 'application/octet-stream';
}

router.get('/canonical/:repo/:treeish/*', (req, res) => {
  const { repo, treeish } = req.params;
  const blobPath = req.params[0];

  if (!REPO_RE.test(repo) || !config.canonicalRepoAllowlist.has(repo)) {
    return res.status(404).json({
      error: 'NotFound',
      message: `repo "${repo}" not in canonical allowlist.`
    });
  }
  if (!TREEISH_RE.test(treeish) || treeish.includes('..')) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'treeish must match [a-z0-9][a-z0-9._/-]* with no .. segments.'
    });
  }
  if (!CANONICAL_BLOB_PATH_RE.test(blobPath) || blobPath.split('/').some((seg) => seg === '..')) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'path must match [a-z0-9][a-z0-9._/-]* with no .. segments.'
    });
  }

  const gitDir = path.join(config.bareGitDir, `${repo}.git`);
  if (!fs.existsSync(gitDir)) {
    return res.status(404).json({
      error: 'NotFound',
      message: `bare-git repo "${repo}.git" not present at ${gitDir}.`
    });
  }

  // Resolve blob sha for ETag (cheap; fails fast on bad treeish/path).
  let blobSha;
  try {
    blobSha = execFileSync('git', ['--git-dir', gitDir, 'rev-parse', `${treeish}:${blobPath}`], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (err) {
    return res.status(404).json({
      error: 'NotFound',
      message: `blob "${treeish}:${blobPath}" not found in ${repo}.git.`
    });
  }

  const etag = `"${blobSha}"`;
  res.set('ETag', etag);
  res.set('Cache-Control', 'no-cache');
  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }

  // Stream blob content via git cat-file (binary-safe).
  let buf;
  try {
    buf = execFileSync('git', ['--git-dir', gitDir, 'cat-file', 'blob', blobSha], {
      timeout: 10000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    return res.status(500).json({
      error: 'InternalServerError',
      message: 'failed to read blob from bare-git.'
    });
  }

  res.set('Content-Type', canonicalContentType(blobPath));
  res.set('X-Canonical-Blob-Sha', blobSha);
  return res.status(200).send(buf);
});

module.exports = router;
