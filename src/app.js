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
const auditIngesterRoutes = require('./auditIngesterRoutes'); // CP12.5 (ADR-0030 Phase 1.5.S)
const auditOtelIngesterRoutes = require('./auditOtelIngesterRoutes'); // ADR-0032 Phase 0 Item B
const outputApiRoutes = require('./outputApiRoutes');   // CP13.3 (ADR-0032 Phase 1.3)
const metricsRoute = require('./metricsRoute');         // CP16-prep observability (parch #10166)
const costAnomaliesRoute = require('./costAnomaliesRoute'); // CP16 Pillar 2 (parch #10268)
const vendorKeysRoute = require('./secureStore/vendorKeysRoute'); // Task #138 Phase 2B (parch #10320)
const orpRoute = require('./orpRoute');                 // CP14-X Plexus Secure Store (parch #10175)
const auth = require('./middleware/auth');
const { opsKeyAuditMiddleware } = require('./middleware/opsKeyAudit'); // CP12.2 admin R1 fold
const { initializeDb, listPresence, getGlobalHwm, envDiffBootDetector } = require('./db');

// CP12.x.4.3 (parch canonical `c5b331c` 2026-06-19): session-state-aware
// stale predicate. Exclusion-list fail-open shape per Option A — treats
// unknown enum values as "maybe consuming, run the check". Extends naturally
// when CP14.x in_flight enum (task #174) lands.
const SESSION_STATES_NOT_CONSUMING = new Set(['idle', 'stop_failure', 'unknown']);

initializeDb();

// CP14-X Plexus Secure Store eager-init at app boot so all schema migrations
// (orp + orp_version + operator_records per PLAN-OPERATOR-SESSION-SUBSTRATE
// v2 Q13 RATIFY) apply at startup rather than waiting for first request to
// orpRoute / auditOpsRoutes / operator_records CRUD. Sister-shape to
// yaklog.db's initializeDb() pattern above. Substrate-honest install-time
// verifiability per ssw-devops Gate (2) #10434 observation.
// Skip in test mode unless explicit YAKLOG_PLEXUS_SECURE_DB_PATH is set —
// most tests don't touch plexus-secure.db and don't bind-mount /data/.
if (process.env.NODE_ENV !== 'test' || process.env.YAKLOG_PLEXUS_SECURE_DB_PATH) {
  const plexusSecureDb = require('./plexusSecureDb');
  plexusSecureDb.initializeDb();
}

// CP12.7 Phase B: env-diff boot detector. Compares current env state
// (YAKLOG_API_KEYS + YAKLOG_TOKEN_BINDINGS + YAKLOG_HOST_INGESTER_BINDINGS
// sha256[:16] fingerprints) to the persisted credential_state_snapshot.
// Emits audit_credential_change rows for each diff (mint/revoke/bind/unbind)
// so retroactive operator-rotations land in CC6 Attestation status.
// First boot post-migration: persists baseline; emits zero (no false-positive
// "mint" events for tokens that pre-existed the detector).
if (process.env.NODE_ENV !== 'test' && process.env.YAKLOG_ENV_DIFF_DETECTOR_DISABLED !== '1') {
  try {
    const result = envDiffBootDetector();
    if (result.first_boot) {
      console.log('[env-diff-detector] first-boot baseline persisted: ' +
        `api_keys=${result.api_keys_count} token_bindings=${result.token_bindings_count} host_bindings=${result.host_bindings_count}`);
    } else {
      console.log(`[env-diff-detector] diff vs prior snapshot: mints=${result.mints} revokes=${result.revokes} ` +
        `binds=${result.binds} unbinds=${result.unbinds} total_emitted=${result.total_emitted}`);
    }
  } catch (e) {
    console.error('[env-diff-detector] failed:', e.message);
  }
}

// CP12.7 Phase C: .env file-watcher per parch #8690 (b) RATIFY + secops
// #8666 cleared snippet shape. Eliminates the temporal lag in Phase B
// (which captures operator-class .env mutations only at next yaklog
// server boot) by re-running envDiffBootDetector immediately when .env
// changes on disk. Per secops #8666 standing-authorization: server-side
// only; zero yaklog-sub touch; respects defensive-freeze posture.
//
// Operational invariant per PLEXUS-FEATURES.md audit_credential_change
// canon (secops-ratified): operators MUST still pair .env mutations
// with a server restart in the same ship cycle for transactional safety;
// the file-watcher is an additional layer that captures mutations even
// when restart is delayed. A mutation reverted before this watcher fires
// won't be captured (matches Phase B semantics).
//
// Opt-out via env (default ON): YAKLOG_ENV_FILE_WATCHER_DISABLED=1
if (process.env.NODE_ENV !== 'test'
    && process.env.YAKLOG_ENV_FILE_WATCHER_DISABLED !== '1') {
  const fs = require('fs');
  const dotenv = require('dotenv');
  const envPath = process.env.YAKLOG_DOTENV_PATH || '/app/.env';
  let debounceTimer = null;
  const DEBOUNCE_MS = 500;  // editors do atomic-write = rename + write;
                            // collapse a burst of fs.watch events into one fire
  try {
    if (!fs.existsSync(envPath)) {
      console.log(`[env-file-watcher] ${envPath} not found; watcher disabled (set YAKLOG_DOTENV_PATH to point elsewhere or YAKLOG_ENV_FILE_WATCHER_DISABLED=1 to silence)`);
    } else {
      const fire = () => {
        try {
          const raw = fs.readFileSync(envPath, 'utf8');
          const reloaded = dotenv.parse(raw);
          const result = envDiffBootDetector({
            apiKeysString: reloaded.YAKLOG_API_KEYS,
            tokenBindingsString: reloaded.YAKLOG_TOKEN_BINDINGS,
            hostIngesterBindingsString: reloaded.YAKLOG_HOST_INGESTER_BINDINGS,
            actor: 'env-file-watcher',
          });
          if (result.first_boot) {
            // Should not happen — Phase B already persisted baseline at boot.
            // Defensive log only.
            console.log('[env-file-watcher] unexpected first_boot=true; baseline now persisted');
          } else if (result.total_emitted > 0) {
            console.log(`[env-file-watcher] diff captured: mints=${result.mints} revokes=${result.revokes} ` +
              `binds=${result.binds} unbinds=${result.unbinds} total_emitted=${result.total_emitted}`);
          }
        } catch (e) {
          console.error('[env-file-watcher] fire failed:', e.message);
        }
      };
      const onChange = () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(fire, DEBOUNCE_MS);
      };
      const watcher = fs.watch(envPath, { persistent: false }, (eventType) => {
        // 'change' = in-place edit; 'rename' = atomic-write swap (editor
        // workflow). Both indicate the file content may have changed;
        // debounce + re-read.
        if (eventType === 'change' || eventType === 'rename') onChange();
      });
      watcher.on('error', (err) => {
        console.error('[env-file-watcher] watcher error:', err.message);
      });
      console.log(`[env-file-watcher] armed on ${envPath} (debounce=${DEBOUNCE_MS}ms)`);
    }
  } catch (e) {
    console.error('[env-file-watcher] setup failed:', e.message);
  }
}

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

// CP12.x.4 Layer-1 Step 2: in-process empirical-anchor snapshot loop
// (per yaklog #8967 Option A path; opt-in via env so test env / production
// without the empirical window stays unaffected). When enabled, writes
// per-30min /ops/stream/stats snapshots to bind-mounted log path for join
// with ssw-devops's external /presence/public capture.
if (process.env.NODE_ENV !== 'test'
    && process.env.YAKLOG_CP12_X_4_EMPIRICAL_ANCHOR_ENABLED === '1') {
  const { startEmpiricalAnchorLoop } = require('./stream');
  startEmpiricalAnchorLoop();
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
    // CP14.1 (2026-06-13): prefer the DB-stored runtime (now schema-resident
    // per upsertPresence server-side compute). Falls back to registry-lookup
    // when row.runtime is null — defends against pre-CP14.1 rows that haven't
    // yet been touched by a fresh heartbeat.
    if (row.runtime == null) {
      row.runtime = runtimeOf(row.agent_id);
    }
    // CP12.x.4 (2026-06-13): SSE-stale detection per sleuth #8532 +
    // admin #8534/#8536 forensics. Surface the silent-dead signature:
    // heartbeat fresh BUT cursor hasn't advanced AND cluster traffic IS
    // flowing. Catches the case where the daemon process is alive but its
    // SSE stream is stuck (sleuth's #8464→#8534 21h gap signature).
    // CP12.x.4.3 (parch canonical c5b331c): session-state-aware predicate.
    // Excludes session_state ∈ {idle, stop_failure, unknown} — operator-idle
    // CC seats where the SSE socket eventually goes silent are NOT
    // silent-dead-needs-fix (yaklog-dev #9446 empirical: 14/18 stale rows
    // were session=idle; 9-agent freeze cohort at #9287 all idle/unknown).
    // null when prerequisites can't be evaluated (preserves null-as-unknown
    // semantics established for update_available + runtime_state fields).
    const isActivelyConsuming = !SESSION_STATES_NOT_CONSUMING.has(row.session_state);
    if (row.daemon_state === 'up'
        && row.last_heartbeat_at
        && row.last_cursor_advance_at
        && row.cursor_position != null
        && isActivelyConsuming) {
      const nowMs = Date.now();
      const hbAgeMs = nowMs - new Date(row.last_heartbeat_at).getTime();
      const cursorAgeMs = nowMs - new Date(row.last_cursor_advance_at).getTime();
      const cursorLag = globalHwm - Number(row.cursor_position);
      row.sse_stream_stale = (hbAgeMs < 90_000)
        && (cursorAgeMs > 300_000)
        && (cursorLag >= 3);
      row.sse_stream_stale_class = null;
    } else if (row.daemon_state === 'up' && !isActivelyConsuming) {
      row.sse_stream_stale = false;
      row.sse_stream_stale_class = 'session_inactive_expected';
    } else {
      row.sse_stream_stale = null;
      row.sse_stream_stale_class = null;
    }
  }
  // 2026-06-19 (Jon-direct urgent): pre-emission AgentCards. Cluster has
  // token-bound agents (per YAKLOG_TOKEN_BINDINGS) that may not yet have
  // emitted a /presence/event heartbeat (e.g., ptah-agent — provisioned at
  // .env + REGISTRY but daemon not yet wired on the Win11 VM). Dashboard
  // renders cards from this endpoint's `presence` array, so these agents
  // were invisible. Substrate-honest fix: append synthetic placeholder
  // rows for token-bound agents missing from `presence`, marked
  // `pre_emission: true` so the dashboard can render a distinct minimal
  // card ("Awaiting first heartbeat"). Sister-shape to existing offline
  // rendering; daemon_state='down' + session_state='unknown' + label
  // 'pre_emission' makes the card honest about the absent emission.
  //
  // Dedupe by token-group (per `feedback_one_to_many_binding_data_structure`
  // Map<token, Set<agentId>> shape since v0.5.2): if ANY agent_id in the
  // token-group is present in /presence, skip the WHOLE group. Otherwise
  // pick one representative id per group (the canonical longest-suffix
  // form when an `<n>-agent` alias exists, else the first iter-order id).
  // Prevents alias noise (e.g., ssw-devops-agent ↔ ssw-devops shared token
  // surfacing both as separate pre-emission cards when ssw-devops is live).
  const presentIds = new Set(presence.map((r) => r.agent_id));
  const tokenGroups = new Set();   // dedupe across both binding maps
  for (const set of config.tokenBindings.values()) tokenGroups.add(set);
  for (const set of config.daemonBindings.values()) tokenGroups.add(set);
  const preEmissionIds = new Set();
  for (const group of tokenGroups) {
    const ids = [...group];
    // Skip entire group if any of its aliases is already presence-emitting.
    if (ids.some((id) => presentIds.has(id))) continue;
    // Pick canonical representative: prefer `-agent` suffix if present,
    // else longest id, else first iter-order.
    const canonical = ids.find((id) => id.endsWith('-agent'))
      || ids.slice().sort((a, b) => b.length - a.length)[0]
      || ids[0];
    if (canonical) preEmissionIds.add(canonical);
  }
  for (const agent_id of preEmissionIds) {
    presence.push({
      agent_id,
      daemon_state: 'down',
      session_state: 'unknown',
      label: 'pre_emission',
      runtime: runtimeOf(agent_id),
      pre_emission: true,
      // Standard fields nulled — dashboard's existing offline-render path
      // tolerates missing values. Explicit null over undefined for ETag
      // determinism + frontend dot-equality clarity.
      cursor_position: null,
      lock_held: false,
      sse_connected: false,
      events_consumer_count: null,
      last_heartbeat_at: null,
      last_hook_at: null,
      last_state_change_at: null,
      current_model: null, current_tool: null,
      last_tool_name: null, last_tool_status: null,
      last_compaction_reason: null, last_compaction_at: null,
      last_stop_reason: null, last_session_source: null,
      subagent_active_count: null,
      runtime_uid: null, runtime_gid: null, runtime_hostname: null, current_cwd: null,
      daemon_pid: null, daemon_version: null, daemon_started_at: null,
      runtime_state: null, runtime_blocked_until: null,
      last_cursor_advance_at: null,
      canonical_daemon_version: canonicalDaemonVersion,
      update_available: null,
      sse_stream_stale: null,
      sse_stream_stale_class: null,
    });
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
// CP13.3 (ADR-0032 Phase 1.3): output ratios + composition + coverage-gap
// + anomalies + merges public reads. Mounted BEFORE the /api/v1 auth
// middleware so network-isolation trust model applies (mirrors
// auditRoutes pattern). SERVER-SIDE Fold B HARD GATE enforcement per
// s345 #9234 §5.6 is inside src/outputRatios.js — activity-numerator
// ratios stripped at substrate level for buyer/investor audience
// regardless of client request.
app.use('/api/v1/output', outputApiRoutes.publicRouter);
// Plexus query proxy (auth'd): server-to-server callers (other agents,
// scripts) use this with a Bearer YAKLOG_TOKEN.
app.use('/api/v1/plexus', auth, plexusRoutes);
app.use('/api/v1', auth, routes);
// CP12.2 (ADR-0030 §5.2): ops-key gated audit + policy mutations. Mounts
// under `/api/v1/ops` (matches existing /ops/cost/* pattern in routes.js);
// each route inside the router applies enforceOpsKey middleware.
app.use('/api/v1/ops', auditOpsRoutes);
// CP12.5 (ADR-0030 Phase 1.5.S): per-host file-access ingester intake.
// Mounts under `/api/v1/ingester` (auth'd; host-binding enforced per-route).
app.use('/api/v1/ingester', auth, auditIngesterRoutes);
// ADR-0032 Phase 0 Item B (cross-runtime telemetry parity): OTel collector
// forwards Codex/Gemini tool events here; mapper translates them into
// audit_tool_invocation rows. Ops-key gated per feedback_secrets_no_yaklog
// (enforced in-router by enforceOpsKey middleware).
app.use('/api/v1/audit/ingest', auditOtelIngesterRoutes);
// CP13.3 (ADR-0032 Phase 1.3): ops-key gated output mutations. Public
// /api/v1/output is mounted above the auth middleware (network-isolation
// trust). This ops-key gated surface mounts under /api/v1/ops/output;
// enforceOpsKey middleware applied at router level inside outputApiRoutes.
app.use('/api/v1/ops/output', outputApiRoutes.opsRouter);
// CP16-prep observability migration per parch #10166 Q1 ratify (Option 2c).
// /api/v1/metrics exposes Prom text-format via custom Registry. Auth REQUIRED
// per secops #10164 corrected Q2 disposition: yaklog:3100 is host-public
// (0.0.0.0:3100), NOT internal-only like plexus-otel-collector:8889. See
// feedback_public_bind_vs_internal_only_network_isolation_distinction_at_substrate_auth_disposition_tier.
// Prometheus scrape config (in prometheus.yml) supplies a scoped bearer per
// ssw-devops Gate (2) install work.
app.use('/api/v1/metrics', auth, metricsRoute);
app.use('/api/v1/cost', auth, costAnomaliesRoute);
app.use('/api/v1/secure-store', auth, vendorKeysRoute);
// CP14-X Plexus Secure Store per parch #10175 Q1 ratify: GET /api/v1/orp/<agent_id>
// auth-required (any valid YAKLOG_API_KEYS token reads any ORP per #10174 +
// secops design Q recommend; per-agent scoping deferred to forward-track).
// POST /ops/orp/<agent_id> lives under /api/v1/ops mount (ops-key gated).
app.use('/api/v1/orp', auth, orpRoute);

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
