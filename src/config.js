const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

function parseNumber(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseApiKeys(value) {
  if (!value) {
    return new Set();
  }

  return new Set(
    value
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean)
  );
}

function parseTokenBindings(value) {
  const map = new Map();
  if (!value) {
    return map;
  }

  for (const entry of value.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0 || idx === trimmed.length - 1) continue;
    const agentId = trimmed.slice(0, idx).trim();
    const token = trimmed.slice(idx + 1).trim();
    if (agentId && token) {
      map.set(token, agentId);
    }
  }
  return map;
}

module.exports = {
  port: parseNumber(process.env.PORT, 3100),
  host: process.env.HOST || '0.0.0.0',
  dbPath: process.env.YAKLOG_DB_PATH || path.join(process.cwd(), 'data', 'yaklog.db'),
  apiKeys: parseApiKeys(process.env.YAKLOG_API_KEYS),
  tokenBindings: parseTokenBindings(process.env.YAKLOG_TOKEN_BINDINGS),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  maxBodyBytes: parseNumber(process.env.MAX_BODY_BYTES, 1_000_000),
  specPath: process.env.YAKLOG_SPEC_PATH || '/data/spec.md',
  isProduction: process.env.NODE_ENV === 'production'
};
