// CP16-prep observability migration tests per parch #10166 Q1 ratify (Option 2c).
// Tests GET /api/v1/metrics endpoint shape + auth boundary + emit→scrape roundtrip.
// Sister-shape to test/auditOpsApi.test.js standalone mount pattern.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// MUST set env before requiring config-touching modules.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-metrics-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'test-key,scoped-prom-token';
process.env.YAKLOG_OPS_API_KEYS = 'ops-key-secret';
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');

const auth = require('../src/middleware/auth');
const metricsRoute = require('../src/metricsRoute');
const auditOpsRoutes = require('../src/auditOpsRoutes');
const { emit } = require('../src/metrics');
const { closeDb } = require('../src/db');

const app = express();
app.use(express.json());
app.use('/api/v1/metrics', auth, metricsRoute);
app.use('/api/v1/ops', auditOpsRoutes);

const VALID_TOKEN = 'test-key';
const SCOPED_PROM_TOKEN = 'scoped-prom-token';
const OPS_KEY = 'ops-key-secret';

const validAuth = { Authorization: `Bearer ${VALID_TOKEN}` };
const scopedAuth = { Authorization: `Bearer ${SCOPED_PROM_TOKEN}` };
const opsAuth = { Authorization: `Bearer ${OPS_KEY}` };

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

test('GET /metrics: missing Bearer → 401 (per secops #10164 Q2-corrected auth-required disposition)', async () => {
  const r = await request(app).get('/api/v1/metrics');
  assert.equal(r.statusCode, 401);
});

test('GET /metrics: invalid Bearer → 401', async () => {
  const r = await request(app).get('/api/v1/metrics').set({ Authorization: 'Bearer not-a-real-token' });
  assert.equal(r.statusCode, 401);
});

test('GET /metrics: valid Bearer (YAKLOG_API_KEYS) → 200 with Prom text-format', async () => {
  const r = await request(app).get('/api/v1/metrics').set(validAuth);
  assert.equal(r.statusCode, 200);
  // Prom text-format content-type (versioned, e.g. 'text/plain; version=0.0.4; charset=utf-8')
  assert.match(r.headers['content-type'] || '', /text\/plain/);
  // Body should include HELP/TYPE annotations + at least one of our gauge names
  assert.match(r.text, /# HELP yaklog_wal_checkpoint_elapsed_ms/);
  assert.match(r.text, /# TYPE yaklog_wal_checkpoint_elapsed_ms gauge/);
  assert.match(r.text, /# HELP yaklog_output_ingester_success/);
});

test('GET /metrics: scoped Prom-scrape token also accepted (sister-shape per ssw-devops Gate (2) install)', async () => {
  const r = await request(app).get('/api/v1/metrics').set(scopedAuth);
  assert.equal(r.statusCode, 200);
});

test('emit.walCheckpoint updates gauges visible at GET /metrics (per-db labeled per task #221)', async () => {
  emit.walCheckpoint({
    mode: 'TRUNCATE',
    db: 'yaklog',
    elapsed_ms: 123,
    log: 7,
    checkpointed: 5,
    busy: 0,
    success: true,
  });
  const r = await request(app).get('/api/v1/metrics').set(validAuth);
  assert.equal(r.statusCode, 200);
  // Per task #221: all walCheckpoint gauges now carry {db="..."} label
  assert.match(r.text, /yaklog_wal_checkpoint_elapsed_ms\{db="yaklog"\} 123/);
  assert.match(r.text, /yaklog_wal_checkpoint_log_pages\{db="yaklog"\} 7/);
  assert.match(r.text, /yaklog_wal_checkpoint_pages_checkpointed\{db="yaklog"\} 5/);
  assert.match(r.text, /yaklog_wal_checkpoint_busy_flag\{db="yaklog"\} 0/);
  assert.match(r.text, /yaklog_wal_checkpoint_success\{db="yaklog"\} 1/);
});

test('emit.walCheckpoint per-db labels: yaklog-secure call does NOT overwrite yaklog gauge (task #221 fix verify)', async () => {
  // Sister-shape to ssw-devops cron loop: fire yaklog first, then yaklog-secure
  emit.walCheckpoint({ mode: 'TRUNCATE', db: 'yaklog',        elapsed_ms: 111, log: 0, checkpointed: 0, busy: 0, success: true });
  emit.walCheckpoint({ mode: 'TRUNCATE', db: 'yaklog-secure', elapsed_ms: 222, log: 0, checkpointed: 0, busy: 0, success: true });
  const r = await request(app).get('/api/v1/metrics').set(validAuth);
  assert.equal(r.statusCode, 200);
  // Both per-db gauge values present + distinguishable; neither overwrites the other
  assert.match(r.text, /yaklog_wal_checkpoint_elapsed_ms\{db="yaklog"\} 111/);
  assert.match(r.text, /yaklog_wal_checkpoint_elapsed_ms\{db="yaklog-secure"\} 222/);
});

test('emit.walCheckpoint default db label (backward-compat: omitted db → "yaklog")', async () => {
  emit.walCheckpoint({ mode: 'TRUNCATE', elapsed_ms: 99, log: 0, checkpointed: 0, busy: 0, success: true });
  const r = await request(app).get('/api/v1/metrics').set(validAuth);
  assert.match(r.text, /yaklog_wal_checkpoint_elapsed_ms\{db="yaklog"\} 99/);
});

test('emit.outputIngester updates gauges visible at GET /metrics', async () => {
  emit.outputIngester({
    elapsed_ms: 4567,
    commits_walked: 42,
    merges_walked: 8,
    prs_walked: 3,
    success: true,
  });
  const r = await request(app).get('/api/v1/metrics').set(validAuth);
  assert.equal(r.statusCode, 200);
  assert.match(r.text, /yaklog_output_ingester_elapsed_ms 4567/);
  assert.match(r.text, /yaklog_output_ingester_commits_walked 42/);
  assert.match(r.text, /yaklog_output_ingester_merges_walked 8/);
  assert.match(r.text, /yaklog_output_ingester_prs_walked 3/);
  assert.match(r.text, /yaklog_output_ingester_success 1/);
});

test('POST /ops/wal-checkpoint emits gauges (live-integration: handler → emit → /metrics roundtrip)', async () => {
  // Trigger the real handler (which calls emit.walCheckpoint internally)
  const post = await request(app).post('/api/v1/ops/wal-checkpoint').set(opsAuth).send({ mode: 'TRUNCATE' });
  assert.equal(post.statusCode, 200);
  assert.equal(post.body.ok, true);

  // Scrape /metrics + verify gauges reflect the handler's actual elapsed_ms
  // Per task #221: gauges now carry {db="..."} label; default db when handler omits is "yaklog"
  const scrape = await request(app).get('/api/v1/metrics').set(validAuth);
  assert.equal(scrape.statusCode, 200);
  assert.match(scrape.text, /yaklog_wal_checkpoint_success\{db="yaklog"\} 1/);
  // elapsed_ms should be a non-negative integer matching the actual handler timing
  const elapsedMatch = scrape.text.match(/yaklog_wal_checkpoint_elapsed_ms\{db="yaklog"\} (\d+)/);
  assert.ok(elapsedMatch, 'elapsed_ms gauge with db="yaklog" should be set after handler call');
  const elapsedMs = parseInt(elapsedMatch[1], 10);
  assert.ok(elapsedMs >= 0 && elapsedMs < 10000, `elapsed_ms should be reasonable (0-10000), got ${elapsedMs}`);
});

test('GET /metrics does NOT include nodejs_* / process_* default-collector metrics (per secops Gate (1) condition 3)', async () => {
  const r = await request(app).get('/api/v1/metrics').set(validAuth);
  assert.equal(r.statusCode, 200);
  // Custom Registry should NOT include default Node.js process metrics
  assert.doesNotMatch(r.text, /nodejs_/);
  assert.doesNotMatch(r.text, /process_cpu_seconds_total/);
  assert.doesNotMatch(r.text, /process_resident_memory_bytes/);
});

test('GET /metrics: invocations counter increments across repeated calls', async () => {
  // Reset state by emitting once with known values, then call again to verify increment
  // Per task #221: counter labelNames includes 'db' — match accepts db label as part of the label set
  emit.walCheckpoint({ mode: 'TRUNCATE', db: 'yaklog', elapsed_ms: 1, log: 0, checkpointed: 0, busy: 0, success: true });
  const r1 = await request(app).get('/api/v1/metrics').set(validAuth);
  const count1Match = r1.text.match(/yaklog_wal_checkpoint_invocations_total\{[^}]*mode="TRUNCATE"[^}]*outcome="ok"[^}]*db="yaklog"[^}]*\} (\d+)/);
  assert.ok(count1Match, 'invocations counter with {mode,outcome,db} labels should be present after emit');
  const count1 = parseInt(count1Match[1], 10);

  emit.walCheckpoint({ mode: 'TRUNCATE', db: 'yaklog', elapsed_ms: 2, log: 0, checkpointed: 0, busy: 0, success: true });
  const r2 = await request(app).get('/api/v1/metrics').set(validAuth);
  const count2Match = r2.text.match(/yaklog_wal_checkpoint_invocations_total\{[^}]*mode="TRUNCATE"[^}]*outcome="ok"[^}]*db="yaklog"[^}]*\} (\d+)/);
  const count2 = parseInt(count2Match[1], 10);
  assert.equal(count2, count1 + 1, 'invocations counter should increment by 1');
});
