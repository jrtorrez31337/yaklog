const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const crypto = require('crypto');
const path = require('path');

const config = require('./config');
const routes = require('./routes');
const registerRoutes = require('./registerRoutes');
const auth = require('./middleware/auth');
const { initializeDb, listPresence, getGlobalHwm } = require('./db');

initializeDb();

const app = express();

// helmet's default CSP includes `upgrade-insecure-requests` which forces the
// browser to upgrade http://-loaded subresources to https://. yaklog runs
// HTTP-only on internal network (port 3100 has no TLS); the upgrade would
// break the /dashboard <script src> load. Override to remove that directive;
// all other strict CSP directives (script-src 'self', etc.) stay intact.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'upgrade-insecure-requests': null
    }
  },
  // Strict-Transport-Security is ignored by browsers on HTTP (per spec) but
  // emitting it for an HTTP-only internal deployment is misleading; disable.
  strictTransportSecurity: false
}));

const corsOptions = {
  origin: config.corsOrigin === '*'
    ? true
    : config.corsOrigin
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
};

app.use(cors(corsOptions));
app.use(compression({
  filter: (req, res) => {
    if (res.getHeader('Content-Type') === 'text/event-stream') return false;
    return compression.filter(req, res);
  }
}));
app.use(morgan(config.isProduction ? 'combined' : 'dev'));
app.use(express.json({ limit: config.maxBodyBytes }));

app.get('/api/v1/health', (req, res) => {
  res.json({ status: 'ok', service: 'yaklog' });
});

// Unauthenticated public-presence endpoint for the /dashboard eyes-on-glass UI.
// Mirrors GET /api/v1/presence shape but bypasses auth. /presence content is
// low-sensitivity (agent IDs + states + timestamps; no token data).
function publicPresenceEtag(rows, hwm) {
  const hash = crypto.createHash('sha256');
  hash.update(`hwm:${hwm}\n`);
  for (const row of rows) {
    // v0.5.7: include runtime-meta fields in the ETag so dashboard refreshes
    // when current_tool/current_model/subagent_active_count/etc. change even
    // if session_state stays the same.
    hash.update(`${row.agent_id}:${row.daemon_state}:${row.session_state}:${row.cursor_position ?? ''}:${row.lock_held ? 1 : 0}:${row.last_state_change_at}:${row.current_model ?? ''}:${row.current_tool ?? ''}:${row.last_tool_name ?? ''}:${row.last_tool_status ?? ''}:${row.subagent_active_count ?? ''}:${row.last_stop_reason ?? ''}\n`);
  }
  return `"${hash.digest('hex').slice(0, 16)}"`;
}
app.get('/api/v1/presence/public', (req, res) => {
  const presence = listPresence();
  const globalHwm = getGlobalHwm();
  const etag = publicPresenceEtag(presence, globalHwm);
  res.set('ETag', etag);
  res.set('Cache-Control', 'no-cache');
  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }
  return res.json({ presence, count: presence.length, global_hwm: globalHwm });
});

// Eyes-on-glass dashboard: HTML at /dashboard, JS at /dashboard.js (split so
// helmet's default CSP `script-src 'self'` allows the external script; an
// inline <script> would be blocked).
// no-cache on dashboard assets: dashboard.html + dashboard.js are designed
// to evolve in lockstep (server-emitted /presence/public shape changes match
// dashboard.js render() expectations); aggressive browser caching can leave
// stale .js loaded into fresh .html (or vice versa), producing render
// freezes where rows stop updating mid-cycle. Force revalidation per fetch.
function noCacheDashboard(req, res, next) {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
}
app.get('/dashboard', noCacheDashboard, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});
app.get('/dashboard.js', noCacheDashboard, (req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.js'));
});

// /register endpoints mount BEFORE the global Bearer auth middleware because
// per ADR-0025 §Authority matrix POST /register is open-submission (any agent;
// no Bearer required at submission time). Other /register endpoints carry
// heterogeneous custom auth (enforceRegistrantToken / enforceOpsKey /
// enforceSenderBinding) wired per-route inside registerRoutes.
app.use('/api/v1/register', registerRoutes);
app.use('/api/v1', auth, routes);

app.get('/', (req, res) => {
  res.json({
    name: 'yaklog',
    version: '0.1.0',
    purpose: 'Internal coordination log for Claude/Codex sessions.',
    health: '/api/v1/health',
    api_base: '/api/v1'
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'NotFound', message: 'Route not found.' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'InternalServerError', message: 'Unexpected server error.' });
});

module.exports = app;
