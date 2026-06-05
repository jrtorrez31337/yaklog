// opsKeyAuditMiddleware — ADR-0030 v1.1 + admin Refinement 1 (#7698).
//
// Mitigation (a) for raw-bearer-on-wire exposure: replace the Authorization
// header value with `Bearer sha256:<prefix>` BEFORE any downstream logger /
// morgan / OTel handler captures the request. Stash the original token on
// `req.rawBearer` so downstream auth middleware (auth.js, opsKey.js) can
// validate without re-reading the now-masked header.
//
// Wire in src/app.js BEFORE app.use(morgan(...)) so masking happens before
// any request-line capture. Auth middleware mounts later in the chain and
// reads req.rawBearer first (falling through to header parsing when this
// middleware did not run — preserves test isolation + backwards-compat).
//
// Per feedback_admin_session_otel_secret_leak: admin's OTel ships raw API
// bodies. If admin posts /ops/audit/reconcile from a CC session, the raw
// ops-key in Authorization: would cross the Plexus collector. This
// middleware ensures the in-memory header value the collector sees is
// already the sha256-prefix form.

const crypto = require('crypto');

function sha256Prefix(token) {
  return crypto.createHash('sha256').update(token, 'utf-8').digest('hex').slice(0, 16);
}

function opsKeyAuditMiddleware(req, res, next) {
  const authHeader = req.headers && req.headers.authorization;
  if (typeof authHeader === 'string') {
    const match = authHeader.match(/^Bearer\s+(.+)$/);
    if (match) {
      const rawBearer = match[1].trim();
      if (rawBearer.length > 0) {
        const prefix = sha256Prefix(rawBearer);
        req.rawBearer = rawBearer;
        req.opsKeySha256 = prefix;
        req.headers.authorization = `Bearer sha256:${prefix}`;
      }
    }
  }
  return next();
}

module.exports = { opsKeyAuditMiddleware, sha256Prefix };
