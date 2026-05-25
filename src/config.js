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

// Returns Map<token, Set<agentId>> — one-to-many. A token can be authorized
// for multiple agent_id sender names (e.g., legacy short-stem + canonical
// `<name>-agent`). Aligns with the existing --aliases mechanism for SSE
// mention-filtering. See yaklog #4446 for the bug-discovery context.
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
      let set = map.get(token);
      if (!set) {
        set = new Set();
        map.set(token, set);
      }
      set.add(agentId);
    }
  }
  return map;
}

module.exports = {
  port: parseNumber(process.env.PORT, 3100),
  host: process.env.HOST || '0.0.0.0',
  dbPath: process.env.YAKLOG_DB_PATH || path.join(process.cwd(), 'data', 'yaklog.db'),
  apiKeys: parseApiKeys(process.env.YAKLOG_API_KEYS),
  // YAKLOG_OPS_API_KEYS: orthogonal to YAKLOG_API_KEYS per ADR-0025 §4b.
  // Held by the 3-agent ferry group (secops + ssw-devops + admin-agent).
  // Gates ferry-group-scoped /register routes: GET /register/<id>/ciphertext
  // (FALLBACK courier flow only — registrant PRIMARY pull uses
  // registration_access_token, NOT op-key), POST /register/<id>/ferry-complete,
  // and ops-only audit-trail endpoints. Same parsing as apiKeys; same
  // rotation discipline (env edit + container env-only-recreate + safety
  // captures per [[feedback_db_rebuild_safety]]).
  opsApiKeys: parseApiKeys(process.env.YAKLOG_OPS_API_KEYS),
  tokenBindings: parseTokenBindings(process.env.YAKLOG_TOKEN_BINDINGS),
  daemonBindings: parseTokenBindings(process.env.YAKLOG_DAEMON_BINDINGS),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  maxBodyBytes: parseNumber(process.env.MAX_BODY_BYTES, 1_000_000),
  specPath: process.env.YAKLOG_SPEC_PATH || '/data/spec.md',
  specDir: process.env.YAKLOG_SPEC_DIR || '/data/canonical',
  // GET /api/v1/canonical/<repo>/<treeish>/<path> reads from bare-git repos
  // under bareGitDir. Only repos in canonicalRepoAllowlist are addressable;
  // anything else returns 404 without touching the filesystem.
  bareGitDir: process.env.YAKLOG_BARE_GIT_DIR || '/srv/git',
  canonicalRepoAllowlist: new Set(
    (process.env.YAKLOG_CANONICAL_REPOS || 'agent-tooling,agent-globals,yaklog')
      .split(',').map((s) => s.trim()).filter(Boolean)
  ),
  presenceTtlSeconds: parseNumber(process.env.YAKLOG_PRESENCE_TTL_S, 90),
  presenceSweepIntervalMs: parseNumber(process.env.YAKLOG_PRESENCE_SWEEP_MS, 30_000),
  // Plexus Prometheus URL — Stage 2 backend query proxy talks to this.
  // Default targets the docker-compose service-name (resolves on yaklog_default network).
  plexusPromUrl: process.env.YAKLOG_PLEXUS_PROM_URL || 'http://plexus-prometheus:9090',
  plexusQueryCacheTtlMs: parseNumber(process.env.YAKLOG_PLEXUS_QUERY_CACHE_TTL_MS, 60_000),
  plexusQueryCacheMaxEntries: parseNumber(process.env.YAKLOG_PLEXUS_QUERY_CACHE_MAX, 500),
  plexusQueryTimeoutMs: parseNumber(process.env.YAKLOG_PLEXUS_QUERY_TIMEOUT_MS, 5_000),
  isProduction: process.env.NODE_ENV === 'production'
};
