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
const plexusRoutes = require('./plexusRoutes');
const auditRoutes = require('./auditRoutes');           // CP12.2 (ADR-0030 §5.1)
const auditOpsRoutes = require('./auditOpsRoutes');     // CP12.2 (ADR-0030 §5.2)
const auth = require('./middleware/auth');
const { opsKeyAuditMiddleware } = require('./middleware/opsKeyAudit'); // CP12.2 admin R1 fold
const { initializeDb, listPresence, getGlobalHwm } = require('./db');

initializeDb();

// CP11.2 (2026-06-04): cost-history rollup scheduling per ratified ADR-0029.
// Skipped in test env (tests mock Prom; don't want timer-noise interfering).
// Backfill runs after a short delay to let the server come up cleanly first;
// schedulers run in parallel from server boot.
if (process.env.NODE_ENV !== 'test' && process.env.YAKLOG_COST_ROLLUP_DISABLED !== '1') {
  const costRollup = require('./costRollup');
  setTimeout(() => {
    costRollup.backfill(15).catch((e) => {
      console.error(`[costRollup] startup backfill failed: ${e.message}`);
    });
  }, 5_000);
  costRollup.scheduleNightly();
  costRollup.scheduleIntraday(3600_000);  // every 1h per OQ#3 CONCUR
  console.log('[costRollup] backfill+schedulers armed (nightly 00:30 UTC; intraday 1h)');
}

// CP12.4 (2026-06-05): agent_activity → audit_tool_invocation DRY-augment
// ingester per ADR-0030 OQ#8 CONCUR. Boot drain catches up backlog from
// existing agent_activity rows; periodic ticker keeps coverage-gap indicator
// fresh as new rows land. Skipped in test env (timer-noise + tests seed their
// own audit rows directly).
if (process.env.NODE_ENV !== 'test' && process.env.YAKLOG_AUDIT_INGESTER_DISABLED !== '1') {
  const auditFromActivity = require('./auditFromActivity');
  setTimeout(() => {
    auditFromActivity.drain().then((r) => {
      console.log(`[auditFromActivity] boot drain: ${r.totalProcessed} processed + ${r.totalSkipped} skipped over ${r.iterations} iters`);
    }).catch((e) => {
      console.error(`[auditFromActivity] boot drain failed: ${e.message}`);
    });
  }, 7_000);  // 2s after costRollup backfill so they don't both fire at server-warm-up
  auditFromActivity.scheduleTicker(60_000);  // every 60s
  console.log('[auditFromActivity] boot drain + ticker armed (60s interval)');
}

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
// CP12.2 (ADR-0030 v1.1 admin Refinement 1 — mandatory pre-ship): redact
// Authorization header value BEFORE morgan / any logger captures headers.
// Per `feedback_admin_session_otel_secret_leak`: ops-key in Bearer header
// otherwise crosses OTel-raw-body-logging surface. Middleware sets
// req.rawBearer + req.opsKeySha256 for downstream auth fallback.
app.use(opsKeyAuditMiddleware);
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
    hash.update(`${row.agent_id}:${row.daemon_state}:${row.session_state}:${row.cursor_position ?? ''}:${row.lock_held ? 1 : 0}:${row.last_state_change_at}:${row.current_model ?? ''}:${row.current_tool ?? ''}:${row.last_tool_name ?? ''}:${row.last_tool_status ?? ''}:${row.subagent_active_count ?? ''}:${row.last_stop_reason ?? ''}:${row.runtime_uid ?? ''}:${row.runtime_gid ?? ''}:${row.runtime_hostname ?? ''}:${row.current_cwd ?? ''}:${row.daemon_pid ?? ''}:${row.daemon_version ?? ''}:${row.daemon_started_at ?? ''}:${row.update_available ?? ''}:${row.canonical_daemon_version ?? ''}:${row.runtime ?? ''}:${row.runtime_state ?? ''}:${row.runtime_blocked_until ?? ''}\n`);
  }
  return `"${hash.digest('hex').slice(0, 16)}"`;
}
app.get('/api/v1/presence/public', (req, res) => {
  const presence = listPresence();
  const globalHwm = getGlobalHwm();
  // CP7.2: enrich each row with update_available + canonical_daemon_version
  // by comparing reported daemon_version against the /update manifest.
  // Frontend renders an "update available" pill when update_available=true.
  // Lazy-require to avoid circular concerns; manifest is pure data + cheap.
  const { canonicalVersionOf } = require('./updateManifest');
  const { runtimeOf } = require('./agentRuntimes');
  const canonicalDaemonVersion = canonicalVersionOf('yaklog-sub daemon');
  for (const row of presence) {
    row.canonical_daemon_version = canonicalDaemonVersion;
    // update_available is null when the daemon doesn't yet report
    // daemon_version (pre-v0.5.7.4 → we can't know if it's behind),
    // true when reported version != canonical, false when matched.
    row.update_available = (row.daemon_version == null)
      ? null
      : (row.daemon_version !== canonicalDaemonVersion);
    // v0.5.8.2: hand-curated registry-fallback runtime. Frontend prefers the
    // OTel-derived runtime when available (service_name → claude_code/gemini),
    // falls back to this field for agents that don't emit Plexus telemetry.
    row.runtime = runtimeOf(row.agent_id);
  }
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

// Plan C Stage 4 CP7.1 — /update + /api/v1/update/manifest.
// Public (no auth) — mirrors /dashboard + /presence/public posture.
// Manifest is hand-curated in src/updateManifest.js; HTML page renders
// each artifact as a card with version + install command (copy-pasteable).
const { getManifest } = require('./updateManifest');
app.get('/api/v1/update/manifest', (req, res) => {
  res.json(getManifest());
});
app.get('/update', noCacheDashboard, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'update.html'));
});
app.get('/update.js', noCacheDashboard, (req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, '..', 'public', 'update.js'));
});

// CP10.4 (2026-06-02): cascade-upgrade artifact serving — daemon-facing.
// Serves canonical artifact CONTENT from /srv/git/agent-tooling.git (bare-git)
// so v0.5.15+ daemons with YAKLOG_AUTO_UPDATE=1 can pull a fresh binary
// without touching git directly. Whitelisted by artifact name (no path
// traversal); content fetched via `git show <ref>:<path>` of canonical
// HEAD on the manifest-named source_repo. SHA-256 of returned content is
// in a response header so daemon can verify against manifest before swap.
const { execFileSync: execFileSyncForArtifact } = require('child_process');
const cryptoForArtifact = require('crypto');
const ARTIFACT_WHITELIST = {
  // name in manifest → { bare-git repo path, file path within repo, ref (default HEAD) }
  'yaklog-sub': { repo: '/srv/git/agent-tooling.git', path: 'yaklog-sub/yaklog-sub', ref: 'HEAD' },
};
app.get('/api/v1/update/artifact/:name', (req, res) => {
  const name = req.params.name;
  const spec = ARTIFACT_WHITELIST[name];
  if (!spec) {
    return res.status(404).json({ error: 'NotFound', message: `Unknown artifact: ${name}` });
  }
  let content;
  try {
    content = execFileSyncForArtifact('git', [
      '--git-dir=' + spec.repo, 'show', `${spec.ref}:${spec.path}`,
    ], { maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    return res.status(500).json({ error: 'GitReadError', message: e.message });
  }
  const sha256 = cryptoForArtifact.createHash('sha256').update(content).digest('hex');
  res.setHeader('X-Artifact-SHA256', sha256);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(content.length));
  res.send(content);
});

// CP2: vendored frontend libs (uPlot etc.). Versioned content, served with
// long-lived browser cache. express.static handles content-type, range,
// etag, and 404-on-missing without us hand-rolling each file.
app.use('/vendor', express.static(path.join(__dirname, '..', 'public', 'vendor'), {
  maxAge: '7d',
  immutable: false,  // we DO update vendored libs occasionally; allow revalidation
  fallthrough: false,
}));

// /register endpoints mount BEFORE the global Bearer auth middleware because
// per ADR-0025 §Authority matrix POST /register is open-submission (any agent;
// no Bearer required at submission time). Other /register endpoints carry
// heterogeneous custom auth (enforceRegistrantToken / enforceOpsKey /
// enforceSenderBinding) wired per-route inside registerRoutes.
app.use('/api/v1/register', registerRoutes);
// Plexus public mirror — MUST mount BEFORE the auth'd /api/v1/plexus mount
// below (Express tries mounts in order; longer-prefix-first wins). Mirrors
// the /api/v1/presence/public pattern: read-only, allowlisted (only the
// registered templates can run), exists because the /dashboard browser
// surface cannot easily hold a Bearer YAKLOG_TOKEN. Production multi-tenant
// will swap this for cookie-auth — flagged in PLAN-C-STAGE-2-DESIGN.md §5.
app.use('/api/v1/plexus/public', plexusRoutes.publicRouter);
// CP12.2 (ADR-0030 §5.1): audit + governance public-read mirror. Mounts
// under same `/api/v1/plexus/public` namespace; reads from db.js helpers
// only (no mutations). Network-isolation trust model — same as cost/.
app.use('/api/v1/plexus/public', auditRoutes);
// Plexus query proxy (auth'd): server-to-server callers (other agents,
// scripts) use this with a Bearer YAKLOG_TOKEN.
app.use('/api/v1/plexus', auth, plexusRoutes);
app.use('/api/v1', auth, routes);
// CP12.2 (ADR-0030 §5.2): ops-key gated audit + policy mutations. Mounts
// under `/api/v1/ops` (matches existing /ops/cost/* pattern in routes.js);
// each route inside the router applies enforceOpsKey middleware.
app.use('/api/v1/ops', auditOpsRoutes);

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
