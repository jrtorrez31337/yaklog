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

module.exports = {
  port: parseNumber(process.env.PORT, 3100),
  host: process.env.HOST || '0.0.0.0',
  dbPath: process.env.YAKLOG_DB_PATH || path.join(process.cwd(), 'data', 'yaklog.db'),
  apiKeys: parseApiKeys(process.env.YAKLOG_API_KEYS),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  maxBodyBytes: parseNumber(process.env.MAX_BODY_BYTES, 1_000_000),
  isProduction: process.env.NODE_ENV === 'production'
};
