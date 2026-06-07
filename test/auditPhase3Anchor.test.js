// CP12.12 Phase 3 (A) external integrity anchor per parch #7984 ratified
// shape: S3 Object Lock baseline + daily + 7y + public verify + dual-publish
// 12mo. Tests cover schema + helpers + ops endpoints + public read endpoints
// + dual-substrate uniqueness.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-cp1212-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-x';
process.env.YAKLOG_OPS_API_KEYS = 'ops-y';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const {
  closeDb,
  insertAuditToolInvocation,
  insertAuditCredentialChange,
  computeChainSnapshot,
  insertAuditAnchor,
  listAuditAnchors,
  getAuditAnchorByDay,
  verifyAuditAnchor,
  ANCHOR_SUBSTRATE_VOCAB,
  ANCHOR_CHAIN_TABLES,
} = require('../src/db');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

test.before(() => {
  // Seed some events so the chain isn't empty.
  insertAuditToolInvocation({
    agent_id: 'cp1212-agent', tool_name: 'Bash', tool_phase: 'pre', actor: 'cp1212-test',
  });
  insertAuditCredentialChange({
    credential_class: 'api_key', change_type: 'mint', actor: 'cp1212-test',
  });
});

// ── vocab + chain-table exports ────────────────────────────────────────────

test('ANCHOR_SUBSTRATE_VOCAB exports canonical 3 substrates', () => {
  assert.ok(ANCHOR_SUBSTRATE_VOCAB.has('s3-object-lock'));
  assert.ok(ANCHOR_SUBSTRATE_VOCAB.has('rfc3161-tsa'));
  assert.ok(ANCHOR_SUBSTRATE_VOCAB.has('ipfs'));
  assert.equal(ANCHOR_SUBSTRATE_VOCAB.size, 3);
});

test('ANCHOR_CHAIN_TABLES spans all 6 audit-chain tables', () => {
  assert.ok(ANCHOR_CHAIN_TABLES.includes('audit_tool_invocation'));
  assert.ok(ANCHOR_CHAIN_TABLES.includes('audit_file_access'));
  assert.ok(ANCHOR_CHAIN_TABLES.includes('audit_credential_change'));
  assert.ok(ANCHOR_CHAIN_TABLES.includes('audit_permission_change'));
  assert.ok(ANCHOR_CHAIN_TABLES.includes('audit_attestation'));
  assert.ok(ANCHOR_CHAIN_TABLES.includes('audit_channel_subscription_change'));
  assert.equal(ANCHOR_CHAIN_TABLES.length, 6);
});

// ── computeChainSnapshot ────────────────────────────────────────────────────

test('computeChainSnapshot: returns shape with event_id + table + digest + sample_size', () => {
  const s = computeChainSnapshot();
  assert.ok(s.chain_high_water_event_id);
  assert.ok(ANCHOR_CHAIN_TABLES.includes(s.chain_high_water_table));
  assert.match(s.digest_sha256, /^[0-9a-f]{64}$/);
  assert.ok(typeof s.sample_size === 'number');
});

test('computeChainSnapshot: deterministic for same chain state', () => {
  const s1 = computeChainSnapshot();
  const s2 = computeChainSnapshot();
  assert.equal(s1.digest_sha256, s2.digest_sha256);
  assert.equal(s1.chain_high_water_event_id, s2.chain_high_water_event_id);
});

test('computeChainSnapshot: digest changes when new event lands', () => {
  const before = computeChainSnapshot();
  insertAuditToolInvocation({
    agent_id: 'cp1212-agent', tool_name: 'NewTool', tool_phase: 'pre', actor: 'cp1212-test',
  });
  const after = computeChainSnapshot();
  assert.notEqual(before.digest_sha256, after.digest_sha256);
});

// ── insertAuditAnchor validation ────────────────────────────────────────────

test('insertAuditAnchor: persists row', () => {
  const snap = computeChainSnapshot();
  const r = insertAuditAnchor({
    anchor_day: '2026-04-15',
    chain_high_water_event_id: snap.chain_high_water_event_id,
    chain_high_water_table: snap.chain_high_water_table,
    digest_sha256: snap.digest_sha256,
    anchor_substrate: 's3-object-lock',
    anchor_uri: 's3://test-bucket/2026/04/15/digest.txt',
    published_by: 'a'.repeat(16),
  });
  assert.ok(r.id > 0);
});

test('insertAuditAnchor: rejects bad substrate', () => {
  const snap = computeChainSnapshot();
  assert.throws(() => insertAuditAnchor({
    anchor_day: '2026-04-16',
    chain_high_water_event_id: snap.chain_high_water_event_id,
    chain_high_water_table: snap.chain_high_water_table,
    digest_sha256: snap.digest_sha256,
    anchor_substrate: 'bogus',
    anchor_uri: 's3://x',
    published_by: 'a'.repeat(16),
  }), /anchor_substrate must be one of/);
});

test('insertAuditAnchor: rejects bad day format', () => {
  const snap = computeChainSnapshot();
  assert.throws(() => insertAuditAnchor({
    anchor_day: '04/15/2026',
    chain_high_water_event_id: snap.chain_high_water_event_id,
    chain_high_water_table: snap.chain_high_water_table,
    digest_sha256: snap.digest_sha256,
    anchor_substrate: 's3-object-lock',
    anchor_uri: 's3://x',
    published_by: 'a'.repeat(16),
  }), /anchor_day must be YYYY-MM-DD/);
});

test('insertAuditAnchor: rejects bad digest format', () => {
  assert.throws(() => insertAuditAnchor({
    anchor_day: '2026-04-17',
    chain_high_water_event_id: '0'.repeat(16),
    chain_high_water_table: 'audit_tool_invocation',
    digest_sha256: 'too-short',
    anchor_substrate: 's3-object-lock',
    anchor_uri: 's3://x',
    published_by: 'a'.repeat(16),
  }), /digest_sha256 must be 64-char/);
});

test('insertAuditAnchor: rejects duplicate (day + substrate)', () => {
  const snap = computeChainSnapshot();
  // First insert succeeds
  insertAuditAnchor({
    anchor_day: '2026-04-20',
    chain_high_water_event_id: snap.chain_high_water_event_id,
    chain_high_water_table: snap.chain_high_water_table,
    digest_sha256: snap.digest_sha256,
    anchor_substrate: 's3-object-lock',
    anchor_uri: 's3://x/2026/04/20/digest.txt',
    published_by: 'a'.repeat(16),
  });
  assert.throws(() => insertAuditAnchor({
    anchor_day: '2026-04-20',
    chain_high_water_event_id: snap.chain_high_water_event_id,
    chain_high_water_table: snap.chain_high_water_table,
    digest_sha256: snap.digest_sha256,
    anchor_substrate: 's3-object-lock',  // same substrate → duplicate
    anchor_uri: 's3://x/2026/04/20/digest2.txt',
    published_by: 'a'.repeat(16),
  }), /duplicate anchor/);
});

test('insertAuditAnchor: dual-substrate same day allowed (OQ-3.4 forward-track)', () => {
  const snap = computeChainSnapshot();
  // 2026-04-20 already has s3-object-lock; add rfc3161-tsa for same day → OK
  const r = insertAuditAnchor({
    anchor_day: '2026-04-20',
    chain_high_water_event_id: snap.chain_high_water_event_id,
    chain_high_water_table: snap.chain_high_water_table,
    digest_sha256: snap.digest_sha256,
    anchor_substrate: 'rfc3161-tsa',
    anchor_uri: 'tsa://digicert/tsr-abc123',
    published_by: 'a'.repeat(16),
  });
  assert.ok(r.id > 0);
});

// ── listAuditAnchors filtering ──────────────────────────────────────────────

test('listAuditAnchors: returns rows in DESC anchor_day order', () => {
  const rows = listAuditAnchors({});
  assert.ok(rows.length >= 3);
  for (let i = 0; i < rows.length - 1; i++) {
    assert.ok(rows[i].anchor_day >= rows[i + 1].anchor_day);
  }
});

test('listAuditAnchors: filters by anchor_substrate', () => {
  const tsa = listAuditAnchors({ anchor_substrate: 'rfc3161-tsa' });
  assert.ok(tsa.every(r => r.anchor_substrate === 'rfc3161-tsa'));
  assert.equal(tsa.length, 1);
});

// ── verifyAuditAnchor ───────────────────────────────────────────────────────

test('verifyAuditAnchor: returns found:false for missing day', () => {
  const r = verifyAuditAnchor('2099-01-01');
  assert.equal(r.found, false);
});

test('verifyAuditAnchor: returns found:true with match/mismatch boolean', () => {
  const r = verifyAuditAnchor('2026-04-15');
  assert.equal(r.found, true);
  assert.ok(typeof r.match === 'boolean');
  assert.ok(r.stored_digest);
  assert.ok(r.recomputed_digest);
});

// ── HTTP endpoints — public read ────────────────────────────────────────────

test('GET /audit/anchors: returns rows', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/anchors');
  assert.equal(r.status, 200);
  assert.ok(r.body.count >= 3);
});

test('GET /audit/anchors: filters by anchor_substrate', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/public/audit/anchors?anchor_substrate=rfc3161-tsa');
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 1);
});

test('GET /audit/anchors: 400 on bad anchor_substrate', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/public/audit/anchors?anchor_substrate=invalid');
  assert.equal(r.status, 400);
});

test('GET /audit/anchor/:day: returns single substrate when ?anchor_substrate set', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/public/audit/anchor/2026-04-15?anchor_substrate=s3-object-lock');
  assert.equal(r.status, 200);
  assert.equal(r.body.anchor_day, '2026-04-15');
  assert.equal(r.body.anchor_substrate, 's3-object-lock');
});

test('GET /audit/anchor/:day: returns array when day has dual-substrate anchors', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/public/audit/anchor/2026-04-20');
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 2);
  assert.equal(r.body.anchors.length, 2);
});

test('GET /audit/anchor/:day: 404 on missing day', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/public/audit/anchor/2099-12-31');
  assert.equal(r.status, 404);
});

test('GET /audit/anchor/:day: 400 on bad day format', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/public/audit/anchor/not-a-date');
  assert.equal(r.status, 400);
});

test('GET /audit/anchor-verify: returns found:true with match boolean', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/public/audit/anchor-verify?day=2026-04-15');
  assert.equal(r.status, 200);
  assert.equal(r.body.found, true);
  assert.ok(typeof r.body.match === 'boolean');
});

test('GET /audit/anchor-verify: 400 without day', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/public/audit/anchor-verify');
  assert.equal(r.status, 400);
});

// ── HTTP endpoints — ops ────────────────────────────────────────────────────

test('POST /ops/audit/anchor-snapshot: requires ops-key', async () => {
  const r = await request(app)
    .post('/api/v1/ops/audit/anchor-snapshot')
    .set('Content-Type', 'application/json')
    .send({});
  assert.ok(r.status === 401 || r.status === 403);
});

test('POST /ops/audit/anchor-snapshot: returns snapshot shape', async () => {
  const r = await request(app)
    .post('/api/v1/ops/audit/anchor-snapshot')
    .set('Authorization', 'Bearer ops-y')
    .set('Content-Type', 'application/json')
    .send({});
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.match(r.body.digest_sha256, /^[0-9a-f]{64}$/);
  assert.ok(r.body.chain_high_water_event_id);
});

test('POST /ops/audit/anchor-record: end-to-end ops-gated', async () => {
  const snap = await request(app)
    .post('/api/v1/ops/audit/anchor-snapshot')
    .set('Authorization', 'Bearer ops-y').send({});
  const r = await request(app)
    .post('/api/v1/ops/audit/anchor-record')
    .set('Authorization', 'Bearer ops-y')
    .set('Content-Type', 'application/json')
    .send({
      anchor_day: '2026-05-01',
      anchor_substrate: 's3-object-lock',
      anchor_uri: 's3://test/2026/05/01/digest.txt',
      chain_high_water_event_id: snap.body.chain_high_water_event_id,
      chain_high_water_table: snap.body.chain_high_water_table,
      digest_sha256: snap.body.digest_sha256,
    });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('POST /ops/audit/anchor-record: 400 on missing fields', async () => {
  const r = await request(app)
    .post('/api/v1/ops/audit/anchor-record')
    .set('Authorization', 'Bearer ops-y')
    .set('Content-Type', 'application/json')
    .send({ anchor_day: '2026-05-02' });
  assert.equal(r.status, 400);
});

test('POST /ops/audit/anchor-record: 409 on duplicate', async () => {
  const snap = await request(app)
    .post('/api/v1/ops/audit/anchor-snapshot')
    .set('Authorization', 'Bearer ops-y').send({});
  const r = await request(app)
    .post('/api/v1/ops/audit/anchor-record')
    .set('Authorization', 'Bearer ops-y')
    .set('Content-Type', 'application/json')
    .send({
      anchor_day: '2026-05-01',  // already recorded above
      anchor_substrate: 's3-object-lock',
      anchor_uri: 's3://test/2026/05/01/dup.txt',
      chain_high_water_event_id: snap.body.chain_high_water_event_id,
      chain_high_water_table: snap.body.chain_high_water_table,
      digest_sha256: snap.body.digest_sha256,
    });
  assert.equal(r.status, 409);
});
