const config = require('../config');

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

module.exports = function auth(req, res, next) {
  if (config.apiKeys.size === 0) {
    return res.status(503).json({
      error: 'ServiceMisconfigured',
      message: 'YAKLOG_API_KEYS is required.'
    });
  }

  const token = extractToken(req);
  if (!token || !config.apiKeys.has(token)) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Provide a valid Bearer token or X-API-Key header.'
    });
  }

  req.auth = { token };
  return next();
};
