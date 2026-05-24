const crypto = require('crypto');
const config = require('../config');
const { getActiveRegistrationByMintedTokenHash } = require('../db');

function extractToken(req) {
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

  return res.status(401).json({
    error: 'Unauthorized',
    message: 'Provide a valid Bearer token or X-API-Key header.'
  });
};
