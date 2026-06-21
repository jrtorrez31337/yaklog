// CP14-X Plexus Secure Store — public ORP read endpoint.
// GET /api/v1/orp/<agent_id>  (auth-required; per parch #10175 Q1 ratify:
// any valid YAKLOG_API_KEYS token reads any ORP; per-agent scoping forward-track)
//
// Returns 200 with {agent_id, orp_json, version, schema_version, updated_at}
// Returns 404 if no ORP for the agent
// Returns 401 if no/invalid Bearer (global auth middleware)
//
// Note: updated_by is intentionally NOT exposed in public read shape
// (ops-tier audit field).

'use strict';

const express = require('express');
const { getOrp } = require('./plexusSecureDb');

const router = express.Router();

const AGENT_ID_RE = /^[a-zA-Z0-9._:@/-]{1,64}$/;

router.get('/:agent_id', (req, res) => {
  const agentId = req.params.agent_id;
  if (!AGENT_ID_RE.test(agentId)) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'agent_id must match [a-zA-Z0-9._:@/-]{1,64}',
    });
  }
  try {
    const orp = getOrp(agentId);
    if (!orp) {
      return res.status(404).json({
        error: 'NotFound',
        message: `no ORP for agent_id=${agentId}`,
      });
    }
    return res.status(200).json({
      agent_id: orp.agent_id,
      orp_json: orp.orp_json,
      version: orp.version,
      schema_version: orp.schema_version,
      updated_at: orp.updated_at,
    });
  } catch (e) {
    return res.status(500).json({
      error: 'InternalError',
      message: e.message,
    });
  }
});

module.exports = router;
