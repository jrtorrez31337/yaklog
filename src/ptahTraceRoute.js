// Task #246 Per-Ptah-instance ORP TraceRecord endpoints.
// Mounted at /api/v1/plexus/ptah-orp (matches dashboard.js _renderTrace fetch
// path canon documented in agent-globals/agentcard-field-spec.md §2.6 —
// zero dashboard wire churn per PLAN v4 §2.4 Q7 ratify).
//
// Endpoints:
//   POST /:agent_id/trace                          ingest TraceRecord
//   GET  /:agent_id/trace                          poll traces (since_trace_id|episode_id+from_tick)
//   GET  /:agent_id/episodes                       list episode index
//   GET  /:agent_id/episodes/:episode_id/manifest  cert-manifest for aieng3 verification
//
// Auth model per secops #10728 + parch #10731 Q4: per-agent bearer (own only)
// OR ops-key (cross-instance). Reads further-restricted: NO general
// cluster-bearer (cross-instance trace carries session-context PII).

'use strict';

const express = require('express');
const ptahTraceDb = require('./ptahTraceDb');

const router = express.Router({ mergeParams: true });

function _isOwnAgent(req, agentId) {
  // req.auth populated by global auth middleware. Per-agent bearer carries
  // bound agent_id; ops-key carries source='ops-key'.
  if (!req.auth) return false;
  if (req.auth.source === 'ops-key') return true;
  return req.auth.agentId === agentId;
}

function _validateAgentParam(req, res) {
  const agentId = req.params.agent_id;
  if (!ptahTraceDb.AGENT_ID_RE.test(agentId)) {
    res.status(400).json({ error: 'ValidationError', message: 'agent_id fails AGENT_ID_RE' });
    return null;
  }
  if (!ptahTraceDb.PTAH_AGENT_ID_RE.test(agentId)) {
    res.status(400).json({ error: 'ValidationError', message: 'agent_id must match ptah-* namespace' });
    return null;
  }
  return agentId;
}

// POST /:agent_id/trace — TraceRecord ingest
router.post('/:agent_id/trace', (req, res) => {
  const agentId = _validateAgentParam(req, res);
  if (!agentId) return;
  if (!_isOwnAgent(req, agentId)) {
    return res.status(403).json({ error: 'Forbidden', message: 'per-agent bearer or ops-key required for own agent_id' });
  }
  const rec = req.body || {};
  // recordedBy: sha256-prefix of token bound to writer (defensive — avoids
  // storing full token; sister-shape ptahAuditDb auth_mode pattern)
  const recordedBy = req.auth && req.auth.tokenSha256Prefix
    ? req.auth.tokenSha256Prefix
    : (req.auth && req.auth.source ? `auth:${req.auth.source}` : 'unknown');
  try {
    const r = ptahTraceDb.insertTrace(agentId, rec, recordedBy);
    return res.status(200).json({
      ok: true,
      trace_id: r.lastInsertRowid,
      episode_id: rec.episode_id,
      tick: rec.tick,
    });
  } catch (e) {
    if (/UNIQUE constraint failed: ptah_trace_record\.episode_id/.test(e.message)) {
      return res.status(409).json({
        error: 'Conflict',
        message: `(episode_id, tick) already exists: ${rec.episode_id}/${rec.tick} — monotonic-tick canon per C6`,
      });
    }
    if (/C6 violation/.test(e.message)) {
      return res.status(409).json({ error: 'Conflict', message: e.message });
    }
    if (/agent_id|namespace|fails .*validation/i.test(e.message)) {
      return res.status(400).json({ error: 'ValidationError', message: e.message });
    }
    return res.status(400).json({ error: 'ValidationError', message: e.message });
  }
});

// GET /:agent_id/trace — poll traces
router.get('/:agent_id/trace', (req, res) => {
  const agentId = _validateAgentParam(req, res);
  if (!agentId) return;
  if (!_isOwnAgent(req, agentId)) {
    return res.status(403).json({ error: 'Forbidden', message: 'per-agent bearer or ops-key required (no general cluster-bearer reads — session-context PII)' });
  }
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    if (req.query.episode_id) {
      const rows = ptahTraceDb.getTracesForEpisode(agentId, req.query.episode_id, {
        fromTick: Number(req.query.from_tick) || 0,
        limit,
      });
      return res.status(200).json({ agent_id: agentId, traces: rows, count: rows.length });
    }
    const sinceTraceId = Number(req.query.since_trace_id) || 0;
    const rows = ptahTraceDb.getTracesSince(agentId, { sinceTraceId, limit });
    return res.status(200).json({ agent_id: agentId, traces: rows, count: rows.length });
  } catch (e) {
    return res.status(500).json({ error: 'InternalError', message: e.message });
  }
});

// GET /:agent_id/episodes — list episode index
router.get('/:agent_id/episodes', (req, res) => {
  const agentId = _validateAgentParam(req, res);
  if (!agentId) return;
  if (!_isOwnAgent(req, agentId)) {
    return res.status(403).json({ error: 'Forbidden', message: 'per-agent bearer or ops-key required' });
  }
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const eps = ptahTraceDb.listEpisodes(agentId, { limit });
    return res.status(200).json({ agent_id: agentId, episodes: eps, count: eps.length });
  } catch (e) {
    return res.status(500).json({ error: 'InternalError', message: e.message });
  }
});

// GET /:agent_id/episodes/:episode_id/manifest — cert-manifest for aieng3
router.get('/:agent_id/episodes/:episode_id/manifest', (req, res) => {
  const agentId = _validateAgentParam(req, res);
  if (!agentId) return;
  if (!_isOwnAgent(req, agentId)) {
    return res.status(403).json({ error: 'Forbidden', message: 'per-agent bearer or ops-key required' });
  }
  try {
    const ep = ptahTraceDb.getEpisodeManifest(agentId, req.params.episode_id);
    if (!ep) {
      return res.status(404).json({ error: 'NotFound', message: `no episode ${req.params.episode_id} for ${agentId}` });
    }
    return res.status(200).json({
      agent_id: agentId,
      episode_id: ep.episode_id,
      orp_version: ep.orp_version,
      role_id: ep.role_id,
      started_at: ep.started_at,
      last_tick_at: ep.last_tick_at,
      last_tick: ep.last_tick,
      goal_terminal: ep.goal_terminal,
      manifest: ep.manifest_json ? JSON.parse(ep.manifest_json) : null,
    });
  } catch (e) {
    return res.status(500).json({ error: 'InternalError', message: e.message });
  }
});

module.exports = router;
