// enforceOpsKey middleware per ADR-0025 §4b.
//
// Gates ferry-group-only routes:
//   GET /register/<id>/ciphertext  (FALLBACK admin-courier path; PRIMARY
//                                   registrant pull uses registration_access_token)
//   POST /register/<id>/ferry-complete
//   GET /register/<id>/events      (ops-only audit-trail surface)
//   GET /register/audit            (ops-only audit query)
//
// Validates Bearer token against the YAKLOG_OPS_API_KEYS set (separate from
// YAKLOG_API_KEYS baseline). Held by secops + ssw-devops + admin-agent only.
// New registrants do not have an op-key (their auth is the per-registration
// registrant_access_token returned at /register submit).

const config = require('../config');

function extractBearerToken(req) {
  const auth = req.headers['authorization'];
  if (!auth || typeof auth !== 'string') return null;
  const match = auth.match(/^Bearer\s+(.+)$/);
  return match ? match[1].trim() : null;
}

function enforceOpsKey(req, res, next) {
  const token = extractBearerToken(req);
  if (!token) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Bearer op-key required for ops-only route.'
    });
  }
  if (!config.opsApiKeys.has(token)) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Token is not a valid ops-key. ADR-0025 §4b: ops-only routes require YAKLOG_OPS_API_KEYS membership.'
    });
  }
  return next();
}

module.exports = { enforceOpsKey };
