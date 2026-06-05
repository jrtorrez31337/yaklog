const crypto = require('crypto');
const config = require('../config');
const { getActiveRegistrationByMintedTokenHash } = require('../db');

function extractToken(req) {
  // ADR-0030 v1.1 R1: opsKeyAuditMiddleware (mounted before morgan) stashes
  // the original Bearer on req.rawBearer and masks req.headers.authorization
  // to `Bearer sha256:<prefix>`. Prefer the stashed original so the auth
  // chain validates the real token; fall through to header parsing for
  // requests that bypassed the audit middleware (tests, direct mounts).
  if (req.rawBearer) {
    return req.rawBearer;
  }

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  const apiKeyHeader = req.headers['x-api-key'];
  if (apiKeyHeader) {
    return String(apiKeyHeader).trim();
  }

  return null;
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf-8').digest('hex');
}

// Dual-source auth per Jon-direct 2026-05-19 (DB-lookup architecture for
// /register minted tokens). A token is accepted if EITHER:
//   (a) it's in YAKLOG_API_KEYS env (existing static-config path), OR
//   (b) its sha256 matches an ACTIVE registration's minted_token_hash
//       (dynamic per-registration path; activated via POST /register/<id>/activate).
//
// For path (b), sender-binding is implicit: the registration row carries
// the authoritative agent_id; req.auth.registrationAgentId is populated for
// downstream enforceSenderBinding to honor as if it were a YAKLOG_TOKEN_BINDINGS
// match.
module.exports = function auth(req, res, next) {
  if (config.apiKeys.size === 0) {
    return res.status(503).json({
      error: 'ServiceMisconfigured',
      message: 'YAKLOG_API_KEYS is required.'
    });
  }

  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Provide a valid Bearer token or X-API-Key header.'
    });
  }

  // Path (a): static env-configured token.
  if (config.apiKeys.has(token)) {
    req.auth = { token, source: 'env' };
    return next();
  }

  // Path (b): /register-minted token (ACTIVE registration row lookup).
  const regRow = getActiveRegistrationByMintedTokenHash(sha256Hex(token));
  if (regRow) {
    req.auth = {
      token,
      source: 'registration',
      registrationId: regRow.registration_id,
      registrationAgentId: regRow.agent_id
    };
    return next();
  }

  // Path (c): ops-key per ADR-0025 §4b — also accepted as a valid Bearer.
  // ADR-0026 §"Ops-key audit path": ops-keys read DMs bypassing the recipient
  // filter; audit entry written per private row. opsKeyId is a non-secret
  // sha256 prefix for audit-log correlation without echoing the token.
  // Sender-binding fall-through is correct (ops-keys not in tokenBindings →
  // resolveAllowedSenders returns null → binding-exempt).
  if (config.opsApiKeys.has(token)) {
    req.auth = {
      token,
      source: 'ops',
      opsKeyId: sha256Hex(token).slice(0, 16)
    };
    return next();
  }

  return res.status(401).json({
    error: 'Unauthorized',
    message: 'Provide a valid Bearer token or X-API-Key header.'
  });
};
