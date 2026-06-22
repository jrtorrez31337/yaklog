// Task #138 Phase 2A vendor-keys GET route per parch #10320 ratify of
// PLAN-VENDOR-KEY-DELIVERY-SUBSTRATE.md §5.
//
// GET /api/v1/secure-store/vendor-keys
// Bearer auth (mounted under parent app.use auth middleware).
//
// Returns: { keys: { <vendor>: <key>, ... } } for vendors the agent_id is
// granted. Empty {} if no grants (200, NOT 403 — substrate-honest about
// agent-having-no-grants vs agent-unauthenticated).
//
// Defense-in-depth: 503 on plain-HTTP per PLAN §5.2 (pre-TLS gate; never
// expose cleartext keys on wire — sister-shape secops #10249 Cond 2 PASS).
//
// Audit-log on every call (success OR fail) per secops #10237 Cond 5.
// Rate-limit per agent_id token-bucket (10/hr/agent default) per OQ-4 lean.
//
// NOT mounted in app.js until ssw-devops Phase 1 (c) TLS substrate-prep
// cycle Gate (2) PASS + container substrate-prep complete (sops install +
// age-key bind-mount in docker-compose).

'use strict';

const express = require('express');
const { decryptVendorKey } = require('./sopsAge');
const { getGrantedVendorsForAgent } = require('./grants');
const { consumeToken } = require('./rateLimit');
const { recordAccess } = require('./auditVendorKeyAccess');

const router = express.Router();

// Resolve the agent_id from the authenticated bearer. yaklog auth middleware
// stashes config.apiKeyToAgent lookup result on req — but per cluster canon
// the auth middleware also stashes `req.auth.token` (hash-bearer-id) and
// `req.authedSender` (for daemon-binding paths). For per-agent grant
// resolution we need the agent_id; canonical lookup is via
// config.daemonBindings reverse-map OR the token-bindings map.
function resolveAgentId(req, config) {
  // Per cluster canon, the bearer's agent_id can be resolved via the
  // daemonBindings Map<token, Set<agentId>> (one-to-many per
  // feedback_one_to_many_binding_data_structure). For vendor-keys delivery,
  // we want a SINGLE agent_id: if the bearer is in daemonBindings, use the
  // canonical (first) agent_id from its set. If not in daemonBindings,
  // tokens without daemon-bindings cannot resolve to a unique agent_id —
  // return null (substrate-honest: deny).
  if (!req.auth || !req.auth.token) return null;
  const allowed = config.daemonBindings.get(req.auth.token);
  if (!allowed || allowed.size === 0) return null;
  // Per feedback_token_bindings_without_daemon_bindings_allow_any_agent_id_post,
  // first-class agents MUST be in DAEMON_BINDINGS — so this path enforces the
  // canonical pairing. Multi-agent tokens (e.g. ops-key) return null here too:
  // ops-key holders use a different endpoint, not the per-agent scoped-GET.
  if (allowed.size > 1) return null;  // ambiguous — only single-agent bindings can fetch their own keys
  const [agentId] = allowed;
  return agentId;
}

router.get('/vendor-keys', (req, res) => {
  // Defense-in-depth pre-TLS gate: when Caddy sidecar is in front (Phase 1 (c)
  // complete), it sets X-Forwarded-Proto: https. When client connects directly
  // to yaklog:3100 plain-HTTP, no such header → return 503 substrate-honest
  // (handler refuses to serve cleartext keys over plain-HTTP).
  const isTlsTerminated = req.headers['x-forwarded-proto'] === 'https'
    || req.headers['x-forwarded-ssl'] === 'on';
  if (!isTlsTerminated) {
    // Audit-log the rejected call before returning
    try {
      recordAccess({
        agent_id: 'unknown',
        vendors_csv: '',
        outcome: 'rejected-no-tls',
        source_ip: req.ip,
      });
    } catch {}
    return res.status(503).json({
      error: 'TLSRequired',
      message: 'Vendor-key delivery requires TLS-terminated transport (Phase 1 Cond-2 gate). Plain-HTTP cleartext-key exposure refused.',
    });
  }

  // Resolve agent_id from bearer
  const config = require('../config');
  const agentId = resolveAgentId(req, config);
  if (!agentId) {
    try {
      recordAccess({
        agent_id: req.auth && req.auth.token ? 'multi-or-unbound' : 'unknown',
        vendors_csv: '',
        outcome: 'rejected-unresolvable-agent',
        source_ip: req.ip,
      });
    } catch {}
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Bearer must be daemon-bound to exactly one agent_id for vendor-key delivery (cluster canon: first-class agents pair TOKEN_BINDINGS with DAEMON_BINDINGS per feedback_token_bindings_without_daemon_bindings_allow_any_agent_id_post).',
    });
  }

  // Rate-limit gate (per-agent token-bucket)
  const rl = consumeToken(agentId);
  if (!rl.allowed) {
    try {
      recordAccess({
        agent_id: agentId,
        vendors_csv: '',
        outcome: 'rejected-rate-limit',
        source_ip: req.ip,
      });
    } catch {}
    return res.status(429).json({
      error: 'RateLimitExceeded',
      message: `vendor-key fetch rate-limit exceeded for agent_id=${agentId} (limit=${rl.limit}/window).`,
      limit: rl.limit,
      window_ms: rl.window_ms,
    });
  }

  // Resolve granted vendors for this agent
  let grantedVendors;
  try {
    grantedVendors = getGrantedVendorsForAgent(agentId);
  } catch (e) {
    try {
      recordAccess({
        agent_id: agentId,
        vendors_csv: '',
        outcome: 'error-grants-decrypt',
        source_ip: req.ip,
      });
    } catch {}
    return res.status(503).json({
      error: 'GrantsUnavailable',
      message: `vendor-key grants substrate unavailable: ${e.code || 'unknown'}`,
    });
  }

  // Decrypt + return per-vendor keys (substrate-honest about partial-vendor-missing
  // per PLAN OQ-5 lean (a) graceful degrade)
  const keys = {};
  const present = [];
  const missing = [];
  for (const vendor of grantedVendors) {
    try {
      const dotenv = decryptVendorKey(vendor);
      // Convention: each vendor's .sops.env exposes one well-known env-var
      // (OPENAI_API_KEY for openai; ANTHROPIC_API_KEY for anthropic; etc.).
      // Find the first non-empty value in the parsed dotenv — substrate-honest
      // about "one key per vendor file" canon.
      const firstValue = Object.values(dotenv).find(v => typeof v === 'string' && v.length > 0);
      if (firstValue) {
        keys[vendor] = firstValue;
        present.push(vendor);
      } else {
        missing.push(vendor);
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        // Vendor granted but file not present (e.g. Anthropic granted but
        // anthropic.sops.env not yet committed by Jon OOB delivery) — partial
        // success per OQ-5 lean (a) graceful degrade.
        missing.push(vendor);
      } else {
        // Decrypt-actual-error — degrade this vendor but don't fail the whole request
        missing.push(vendor);
      }
    }
  }

  // Audit-log the served outcome
  try {
    recordAccess({
      agent_id: agentId,
      vendors_csv: present.join(','),
      outcome: missing.length === 0 ? 'ok' : 'partial',
      source_ip: req.ip,
    });
  } catch {}

  return res.status(200).json({
    keys,
    missing: missing.length > 0 ? missing : undefined,
    rate_limit: { remaining: rl.remaining, limit: rl.limit, window_ms: rl.window_ms },
  });
});

module.exports = router;
