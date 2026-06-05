// CP12.5 (2026-06-05): server-side file-access ingester intake handler tests.
// Per ADR-0030 v1.1 Phase 1.5 + secops #7810 FULL CONCUR.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-ingester-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'test-key,unbound-key';
process.env.YAKLOG_HOST_INGESTER_BINDINGS = 'devel:test-key,traptop10k:test-key';
process.env.NODE_ENV = 'test';
process.env.YAKLOG_COST_ROLLUP_DISABLED = '1';
process.env.YAKLOG_AUDIT_INGESTER_DISABLED = '1';

const request = require('supertest');
const app = require('../src/app');
const { closeDb, listAuditFileAccess } = require('../src/db');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

const sha256_64 = (s) => require('crypto').createHash('sha256').update(s).digest('hex');

// ─── auth: bearer + host-binding gating ─────────────────────────────────────

test('intake: missing Bearer → 401', async () => {
  const r = await request(app)
    .post('/api/v1/ingester/file-access')
    .send({ host: 'devel', events: [] });
  assert.equal(r.status, 401);
});

test('intake: valid Bearer + valid host-binding → 200', async () => {
  const r = await request(app)
    .post('/api/v1/ingester/file-access')
    .set('Authorization', 'Bearer test-key')
    .send({ host: 'devel', events: [] });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.ingested, 0);
  assert.equal(r.body.host, 'devel');
});

test('intake: valid Bearer but NOT bound to the claimed host → 403', async () => {
  const r = await request(app)
    .post('/api/v1/ingester/file-access')
    .set('Authorization', 'Bearer test-key')
    .send({ host: 'unauthorized-host', events: [] });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'HostIngesterBindingViolation');
});

test('intake: valid Bearer but unbound (no host bindings at all) → 403', async () => {
  const r = await request(app)
    .post('/api/v1/ingester/file-access')
    .set('Authorization', 'Bearer unbound-key')
    .send({ host: 'devel', events: [] });
  assert.equal(r.status, 403);
});

// ─── envelope validation ───────────────────────────────────────────────────

test('intake: missing host → 400', async () => {
  const r = await request(app)
    .post('/api/v1/ingester/file-access')
    .set('Authorization', 'Bearer test-key')
    .send({ events: [] });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /host/);
});

test('intake: missing events array → 400', async () => {
  const r = await request(app)
    .post('/api/v1/ingester/file-access')
    .set('Authorization', 'Bearer test-key')
    .send({ host: 'devel' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /events/);
});

test('intake: batch exceeds MAX_BATCH → 400', async () => {
  const big = Array.from({ length: 501 }, (_, i) => ({
    uid: 1001, path: `/tmp/x${i}`, access_mode: 'read',
  }));
  const r = await request(app)
    .post('/api/v1/ingester/file-access')
    .set('Authorization', 'Bearer test-key')
    .send({ host: 'devel', events: big });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /MAX_BATCH|split/);
});

// ─── per-event validation ──────────────────────────────────────────────────

test('intake: event missing uid → 400', async () => {
  const r = await request(app)
    .post('/api/v1/ingester/file-access')
    .set('Authorization', 'Bearer test-key')
    .send({ host: 'devel', events: [{ path: '/tmp/x', access_mode: 'read' }] });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /uid/);
});

test('intake: event missing path → 400', async () => {
  const r = await request(app)
    .post('/api/v1/ingester/file-access')
    .set('Authorization', 'Bearer test-key')
    .send({ host: 'devel', events: [{ uid: 1001, access_mode: 'read' }] });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /path/);
});

test('intake: event invalid access_mode → 400', async () => {
  const r = await request(app)
    .post('/api/v1/ingester/file-access')
    .set('Authorization', 'Bearer test-key')
    .send({ host: 'devel', events: [{ uid: 1001, path: '/tmp/x', access_mode: 'bogus' }] });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /access_mode/);
});

test('intake: event invalid attribution_confidence → 400', async () => {
  const r = await request(app)
    .post('/api/v1/ingester/file-access')
    .set('Authorization', 'Bearer test-key')
    .send({ host: 'devel', events: [{ uid: 1001, path: '/tmp/x', access_mode: 'read', attribution_confidence: 'wat' }] });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /attribution_confidence/);
});

test('intake: content_digest must be 64-char hex (secops OQ#6 — no partial hashes)', async () => {
  const r = await request(app)
    .post('/api/v1/ingester/file-access')
    .set('Authorization', 'Bearer test-key')
    .send({
      host: 'devel',
      events: [{ uid: 1001, path: '/tmp/x', access_mode: 'read', content_digest: 'abcd' }]
    });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /partial hashes|sha256/);
});

test('intake: content_digest valid 64-char hex → 200', async () => {
  const digest = sha256_64('hello world');
  const r = await request(app)
    .post('/api/v1/ingester/file-access')
    .set('Authorization', 'Bearer test-key')
    .send({
      host: 'devel',
      events: [{ uid: 1001, path: '/tmp/x', access_mode: 'read', content_digest: digest }]
    });
  assert.equal(r.status, 200);
  assert.equal(r.body.ingested, 1);
});

test('intake: validation rejects WHOLE batch on first bad row (atomic-batch semantics)', async () => {
  const before = listAuditFileAccess({ agent_id: 'atomic-batch-test' }).length;
  const events = [
    { uid: 1001, path: '/tmp/a', access_mode: 'read', agent_id: 'atomic-batch-test' },
    { uid: 1001, path: '/tmp/b', access_mode: 'bogus', agent_id: 'atomic-batch-test' },  // bad
    { uid: 1001, path: '/tmp/c', access_mode: 'read', agent_id: 'atomic-batch-test' },
  ];
  const r = await request(app)
    .post('/api/v1/ingester/file-access')
    .set('Authorization', 'Bearer test-key')
    .send({ host: 'devel', events });
  assert.equal(r.status, 400);
  const after = listAuditFileAccess({ agent_id: 'atomic-batch-test' }).length;
  assert.equal(after, before, 'no rows should have been inserted on validation-fail');
});

// ─── happy paths ───────────────────────────────────────────────────────────

test('intake: uid_unique host (devel) — agent_id preserved', async () => {
  const events = [
    {
      uid: 1001, path: '/home/jon/yaklog/src/db.js', access_mode: 'read',
      agent_id: 'yaklog-dev-agent', attribution_confidence: 'uid_unique',
    },
  ];
  const r = await request(app)
    .post('/api/v1/ingester/file-access')
    .set('Authorization', 'Bearer test-key')
    .send({ host: 'devel', events, ingester_version: 'phase-1.5d-v0.1.0' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ingested, 1);
  assert.equal(r.body.host, 'devel');
  assert.equal(r.body.ingester_version, 'phase-1.5d-v0.1.0');
  assert.equal(r.body.inserted_event_ids.length, 1);
  assert.match(r.body.inserted_event_ids[0], /^[0-9a-f]{16}$/);

  const rows = listAuditFileAccess({ agent_id: 'yaklog-dev-agent' });
  const row = rows.find(x => x.event_id === r.body.inserted_event_ids[0]);
  assert.ok(row);
  assert.equal(row.attribution_confidence, 'uid_unique');
});

test('intake: uid_shared host (traptop10k) — process_class correlator prefix preserved (secops OQ#2)', async () => {
  const events = [
    {
      uid: 1000, path: '/home/jon/agent-workspace/file.md', access_mode: 'write',
      attribution_confidence: 'uid_shared',
      session_correlator: 'cc-agent:session-abc-123',
      // NOTE: agent_id NULL per admin R5 — don't fabricate attribution from uid alone
    },
    {
      uid: 1000, path: '/home/jon/other/file.txt', access_mode: 'read',
      attribution_confidence: 'uid_shared',
      session_correlator: 'cron:nightly-backup',  // non-CC process-class
    },
    {
      uid: 1000, path: '/var/lib/something', access_mode: 'read',
      attribution_confidence: 'uid_shared',
      session_correlator: 'daemon:yaklog-sub@parch-agent',
    },
  ];
  const r = await request(app)
    .post('/api/v1/ingester/file-access')
    .set('Authorization', 'Bearer test-key')
    .send({ host: 'traptop10k', events });
  assert.equal(r.status, 200);
  assert.equal(r.body.ingested, 3);

  // Verify each event was written with correct attribution + correlator prefix.
  for (const event_id of r.body.inserted_event_ids) {
    const all = listAuditFileAccess({ path_prefix: '/' });
    const row = all.find(x => x.event_id === event_id);
    assert.ok(row);
    assert.equal(row.attribution_confidence, 'uid_shared');
    assert.equal(row.agent_id, null);
    assert.ok(row.session_correlator, 'session_correlator should be present');
    // Process-class prefix validation per OQ#2 fold
    assert.match(row.session_correlator, /^(cc-agent|cc-agent-idle|daemon|cron|shell|unknown):/);
  }
});

test('intake: full sha256 content_digest is stored exactly as supplied', async () => {
  const digest = sha256_64('the actual file content');
  const events = [
    {
      uid: 1001, path: '/tmp/digested.txt', access_mode: 'read',
      content_digest: digest, bytes_in: 23,
      agent_id: 'digest-test-agent',
    },
  ];
  const r = await request(app)
    .post('/api/v1/ingester/file-access')
    .set('Authorization', 'Bearer test-key')
    .send({ host: 'devel', events });
  assert.equal(r.status, 200);
  const rows = listAuditFileAccess({ agent_id: 'digest-test-agent' });
  const row = rows.find(x => x.event_id === r.body.inserted_event_ids[0]);
  assert.equal(row.content_digest, digest);
  assert.equal(row.bytes_in, 23);
});

test('intake: empty events batch returns ok=true ingested=0 (no-op friendly)', async () => {
  const r = await request(app)
    .post('/api/v1/ingester/file-access')
    .set('Authorization', 'Bearer test-key')
    .send({ host: 'devel', events: [] });
  assert.equal(r.status, 200);
  assert.equal(r.body.ingested, 0);
});
