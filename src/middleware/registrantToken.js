// enforceRegistrantToken middleware per ferry-canon §4 + secops sign-off
// (#5437) §4a-d:
//
//   §4a TTL: bound to registration non-terminal lifecycle
//            (SUBMITTED..PENDING_ACTIVATION; retires at ACTIVE/REVOKED/REJECTED).
//   §4b   : reusable within non-terminal window (NOT single-use).
//   §4c   : leak response = natural expiry; no revoke-reissue (ciphertext
//            is the real security boundary; leaked token only fetches
//            undecryptable ciphertext).
//   §4d   : three-way server-side binding —
//            registration_id ↔ agent_id ↔ registrant_token_hash.
//
// Used by registrant-only routes:
//   GET /register/<id>           (status fetch)
//   GET /register/<id>/ciphertext (PRIMARY runtime-pull path)
//
// Distinct from op-key (held by ferry-group) and Bearer (existing baseline).

const crypto = require('crypto');
const config = require('../config');
const { getRegistration } = require('../db');

function extractBearerToken(req) {
  // ADR-0030 v1.1 R1: opsKeyAuditMiddleware (mounted before morgan) stashes
  // the original Bearer on req.rawBearer and masks req.headers.authorization
  // to `Bearer sha256:<prefix>`. Prefer the stashed original so the
  // registrant-token comparison validates the real token; fall through to
  // header parsing for requests that bypassed the audit middleware (tests,
  // direct mounts). Mirrors src/middleware/auth.js extractToken pattern.
  if (req.rawBearer) return req.rawBearer;
  const auth = req.headers['authorization'];
  if (!auth || typeof auth !== 'string') return null;
  const match = auth.match(/^Bearer\s+(.+)$/);
  return match ? match[1].trim() : null;
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf-8').digest('hex');
}

const NON_TERMINAL_STATES = new Set([
  'SUBMITTED', 'PARCH_REVIEW', 'JON_RATIFY',
  'APPROVED_PENDING_FERRY', 'FERRIED', 'PENDING_ACTIVATION'
]);

function enforceRegistrantToken(req, res, next) {
  const registrationId = req.params.id;
  if (!registrationId) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'Missing :id in route path.'
    });
  }
  const token = extractBearerToken(req);
  if (!token) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Bearer registration_access_token required.'
    });
  }
  const reg = getRegistration(registrationId);
  if (!reg) {
    return res.status(404).json({
      error: 'NotFound',
      message: `Registration ${registrationId} not found.`
    });
  }
  // §4a: retire at terminal states.
  if (!NON_TERMINAL_STATES.has(reg.status)) {
    return res.status(403).json({
      error: 'Forbidden',
      message: `Registration ${registrationId} is in terminal state ${reg.status}; registration_access_token retired.`
    });
  }
  // §4d: binding match.
  if (!reg.registrant_token_hash || reg.registrant_token_hash !== sha256Hex(token)) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'registration_access_token does not match this registration.'
    });
  }
  // Attach registration to req for downstream handler convenience.
  req.registration = reg;
  return next();
}

module.exports = { enforceRegistrantToken };
