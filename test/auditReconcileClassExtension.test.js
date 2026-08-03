// CP12.16 Phase 2: GRC reconcile-class vocab extension.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-cp1216-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-x';
process.env.YAKLOG_OPS_API_KEYS = 'ops-y';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const {
  closeDb,
  insertAuditReconciliation,
  listAuditReconciliations,
  aggregateAuditReconciliationsByClass,
  RECONCILE_CLASS_VOCAB,
} = require('../src/db');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

test.before(() => {
  insertAuditReconciliation({
    period_start: '2026-05-01', period_end: '2026-05-31',
    external_system_label: 'Vanta',
    reconcile_class: 'grc-platform',
    yaklog_count: 100, external_count: 100,
    reconciler_agent_id: 'admin-agent',
    reconciled_by: 'a'.repeat(16),
  });
  insertAuditReconciliation({
    period_start: '2026-05-01', period_end: '2026-05-31',
    external_system_label: 'Drata',
    reconcile_class: 'grc-platform',
    yaklog_count: 50, external_count: 52,
    reconciler_agent_id: 'admin-agent',
    reconciled_by: 'a'.repeat(16),
  });
  insertAuditReconciliation({
    period_start: '2026-05-01', period_end: '2026-05-31',
    external_system_label: 'Splunk',
    reconcile_class: 'siem',
    yaklog_count: 1000, external_count: 998,
    reconciler_agent_id: 'secops-agent',
    reconciled_by: 'a'.repeat(16),
  });
  insertAuditReconciliation({
    period_start: '2026-05-01', period_end: '2026-05-31',
    external_system_label: 'legacy-soc-export',
    // reconcile_class omitted → defaults to 'other'
    yaklog_count: 5, external_count: 5,
    reconciler_agent_id: 'admin-agent',
    reconciled_by: 'a'.repeat(16),
  });
});

// ── vocab exports ──────────────────────────────────────────────────────────

test('RECONCILE_CLASS_VOCAB contains canonical 5 classes', () => {
  assert.ok(RECONCILE_CLASS_VOCAB.has('grc-platform'));
  assert.ok(RECONCILE_CLASS_VOCAB.has('soc-tool'));
  assert.ok(RECONCILE_CLASS_VOCAB.has('siem'));
  assert.ok(RECONCILE_CLASS_VOCAB.has('internal-export'));
  assert.ok(RECONCILE_CLASS_VOCAB.has('other'));
  assert.equal(RECONCILE_CLASS_VOCAB.size, 5);
});

// ── insertAuditReconciliation validation ──────────────────────────────────

test('insertAuditReconciliation: default reconcile_class is "other"', () => {
  const rows = listAuditReconciliations({});
  const legacy = rows.find(r => r.external_system_label === 'legacy-soc-export');
  assert.equal(legacy.reconcile_class, 'other');
});

test('insertAuditReconciliation: rejects bad reconcile_class', () => {
  assert.throws(() => insertAuditReconciliation({
    period_start: '2026-05-01', period_end: '2026-05-31',
    external_system_label: 'bogus', reconcile_class: 'not-a-class',
    yaklog_count: 1, external_count: 1,
    reconciler_agent_id: 'a', reconciled_by: 'b',
  }), /reconcile_class must be one of/);
});

// ── listAuditReconciliations filtering ────────────────────────────────────

test('listAuditReconciliations: filters by reconcile_class', () => {
  const grc = listAuditReconciliations({ reconcile_class: 'grc-platform' });
  assert.equal(grc.length, 2);
  assert.ok(grc.every(r => r.reconcile_class === 'grc-platform'));
});

test('listAuditReconciliations: filters by external_system_label', () => {
  const vanta = listAuditReconciliations({ external_system_label: 'Vanta' });
  assert.equal(vanta.length, 1);
  assert.equal(vanta[0].external_system_label, 'Vanta');
});

// ── aggregateAuditReconciliationsByClass ──────────────────────────────────

test('aggregateAuditReconciliationsByClass: groups + counts correctly', () => {
  const buckets = aggregateAuditReconciliationsByClass({});
  const grc = buckets.find(b => b.reconcile_class === 'grc-platform');
  const siem = buckets.find(b => b.reconcile_class === 'siem');
  const other = buckets.find(b => b.reconcile_class === 'other');
  assert.equal(grc.count, 2);
  assert.equal(siem.count, 1);
  assert.equal(other.count, 1);
});

// ── HTTP endpoints ─────────────────────────────────────────────────────────

test('GET /audit/reconciliations: returns all rows by default', async () => {
  const r = await request(app).get('/api/v1/yaklog/public/audit/reconciliations');
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 4);
});

test('GET /audit/reconciliations: filters by reconcile_class', async () => {
  const r = await request(app)
    .get('/api/v1/yaklog/public/audit/reconciliations?reconcile_class=grc-platform');
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 2);
  assert.ok(r.body.rows.every(x => x.reconcile_class === 'grc-platform'));
});

test('GET /audit/reconciliations: 400 on bad reconcile_class', async () => {
  const r = await request(app)
    .get('/api/v1/yaklog/public/audit/reconciliations?reconcile_class=invalid');
  assert.equal(r.status, 400);
  assert.match(r.body.message, /reconcile_class must be one of/);
});

test('GET /audit/reconciliations: filters by external_system_label', async () => {
  const r = await request(app)
    .get('/api/v1/yaklog/public/audit/reconciliations?external_system_label=Splunk');
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 1);
});

test('GET /audit/reconciliations-by-class: returns aggregation', async () => {
  const r = await request(app)
    .get('/api/v1/yaklog/public/audit/reconciliations-by-class');
  assert.equal(r.status, 200);
  assert.ok(r.body.total >= 4);
  assert.ok(Array.isArray(r.body.buckets));
  const grc = r.body.buckets.find(b => b.reconcile_class === 'grc-platform');
  assert.equal(grc.count, 2);
});

// ── ops POST /audit/reconcile validation ──────────────────────────────────

test('POST /ops/audit/reconcile: requires ops-key', async () => {
  const r = await request(app)
    .post('/api/v1/ops/audit/reconcile')
    .set('Content-Type', 'application/json')
    .send({});
  assert.ok(r.status === 401 || r.status === 403);
});

test('POST /ops/audit/reconcile: accepts new reconcile_class field', async () => {
  const r = await request(app)
    .post('/api/v1/ops/audit/reconcile')
    .set('Authorization', 'Bearer ops-y')
    .set('Content-Type', 'application/json')
    .send({
      period_start: '2026-06-01', period_end: '2026-06-30',
      external_system_label: 'ServiceNow GRC',
      reconcile_class: 'grc-platform',
      yaklog_count: 200, external_count: 200,
      reconciler_agent_id: 'admin-agent',
    });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('POST /ops/audit/reconcile: 400 on bad reconcile_class', async () => {
  const r = await request(app)
    .post('/api/v1/ops/audit/reconcile')
    .set('Authorization', 'Bearer ops-y')
    .set('Content-Type', 'application/json')
    .send({
      period_start: '2026-06-01', period_end: '2026-06-30',
      external_system_label: 'X',
      reconcile_class: 'definitely-not-a-class',
      yaklog_count: 1, external_count: 1,
      reconciler_agent_id: 'admin-agent',
    });
  assert.equal(r.status, 400);
});

test('POST /ops/audit/reconcile: omitting reconcile_class defaults to other', async () => {
  const r = await request(app)
    .post('/api/v1/ops/audit/reconcile')
    .set('Authorization', 'Bearer ops-y')
    .set('Content-Type', 'application/json')
    .send({
      period_start: '2026-06-01', period_end: '2026-06-30',
      external_system_label: 'unknown-source',
      yaklog_count: 1, external_count: 1,
      reconciler_agent_id: 'admin-agent',
    });
  assert.equal(r.status, 200);
  const all = listAuditReconciliations({ external_system_label: 'unknown-source' });
  assert.equal(all[0].reconcile_class, 'other');
});
