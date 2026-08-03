// CP12.10 Phase 3 (ADR-0030): audit_attestation governance-tier substrate.
// Validates table + helper + ops endpoint + by-control-area routing for
// CC1/CC2/CC9 lift.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-cp1210-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-x';
process.env.YAKLOG_OPS_API_KEYS = 'ops-y';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const {
  closeDb,
  insertAuditAttestation,
  listAuditAttestations,
  ATTESTATION_CONTROL_AREAS,
} = require('../src/db');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// ── pure helper ────────────────────────────────────────────────────────────

test('ATTESTATION_CONTROL_AREAS exports canonical SOC 2 governance-tier set', () => {
  assert.ok(ATTESTATION_CONTROL_AREAS.has('CC1'));
  assert.ok(ATTESTATION_CONTROL_AREAS.has('CC2'));
  assert.ok(ATTESTATION_CONTROL_AREAS.has('CC9'));
  assert.equal(ATTESTATION_CONTROL_AREAS.size, 3);
});

test('insertAuditAttestation: persists row + computes event_id', () => {
  const r = insertAuditAttestation({
    control_area: 'CC1',
    attestation_class: 'org-chart-review',
    attestation_text: 'Reviewed org chart on 2026-06-07. Roles confirmed: parch (canon), secops (security), admin (ops). No changes since 2026-05-01.',
    actor: 'a'.repeat(16),
  });
  assert.ok(r.id > 0);
  assert.match(r.event_id, /^[a-f0-9]{16}$/);
});

test('insertAuditAttestation: rejects unknown control_area', () => {
  assert.throws(() =>
    insertAuditAttestation({
      control_area: 'CC99',
      attestation_class: 'x',
      attestation_text: 'x',
      actor: 'a'.repeat(16),
    }),
    /control_area must be one of/
  );
});

test('insertAuditAttestation: rejects missing required fields', () => {
  assert.throws(() =>
    insertAuditAttestation({ control_area: 'CC1', attestation_text: 'x', actor: 'a' }),
    /attestation_class.+required/i
  );
});

test('insertAuditAttestation: rejects oversized attestation_text', () => {
  assert.throws(() =>
    insertAuditAttestation({
      control_area: 'CC2',
      attestation_class: 'x',
      attestation_text: 'x'.repeat(20000),
      actor: 'a'.repeat(16),
    }),
    /max 16384/
  );
});

test('listAuditAttestations: filters by control_area', () => {
  insertAuditAttestation({
    control_area: 'CC2',
    attestation_class: 'comm-policy',
    attestation_text: 'Reviewed cluster comm policy 2026-Q2. Reporting cadence: monthly status to admin.',
    actor: 'a'.repeat(16),
  });
  insertAuditAttestation({
    control_area: 'CC9',
    attestation_class: 'risk-register-review',
    attestation_text: 'Reviewed risk register 2026-Q2. Top 3: token-rotation drift, daemon-restart cadence, bare-git push pattern.',
    actor: 'a'.repeat(16),
  });
  const cc1 = listAuditAttestations({ control_area: 'CC1' });
  const cc2 = listAuditAttestations({ control_area: 'CC2' });
  const cc9 = listAuditAttestations({ control_area: 'CC9' });
  assert.ok(cc1.length >= 1);
  assert.ok(cc2.length >= 1);
  assert.ok(cc9.length >= 1);
  assert.ok(cc1.every(r => r.control_area === 'CC1'));
  assert.ok(cc2.every(r => r.control_area === 'CC2'));
});

// ── HTTP: by-control-area reflects attestation counts per area ─────────────

test('by-control-area: CC1/CC2/CC9 now substrate-wired (audit_attestation)', async () => {
  const r = await request(app).get('/api/v1/yaklog/public/audit/by-control-area?control_framework=soc2&period=mtd');
  assert.equal(r.status, 200);
  const areas = r.body.control_areas || [];
  const cc1 = areas.find(a => a.id === 'CC1');
  const cc2 = areas.find(a => a.id === 'CC2');
  const cc9 = areas.find(a => a.id === 'CC9');
  assert.ok(cc1.audit_object_classes.includes('audit_attestation'),
    'CC1 must include audit_attestation in audit_object_classes (Phase 3 wiring)');
  assert.ok(cc2.audit_object_classes.includes('audit_attestation'));
  assert.ok(cc9.audit_object_classes.includes('audit_attestation'));
  // All 6 areas now wired (was 3 pre-CP12.10).
  const wired = areas.filter(a => a.audit_object_classes.length > 0).length;
  assert.equal(wired, 6, 'expected all 6 SOC 2 areas substrate-wired after CP12.10');
});

test('by-control-area: CC1 count reflects only CC1-area attestations (no cross-area inflation)', async () => {
  const r = await request(app).get('/api/v1/yaklog/public/audit/by-control-area?control_framework=soc2&period=mtd');
  const areas = r.body.control_areas || [];
  const cc1 = areas.find(a => a.id === 'CC1');
  const cc2 = areas.find(a => a.id === 'CC2');
  const cc9 = areas.find(a => a.id === 'CC9');
  // From prior tests: 1 row per area was seeded — totals should match exactly.
  assert.equal(cc1.counts.total, 1);
  assert.equal(cc2.counts.total, 1);
  assert.equal(cc9.counts.total, 1);
});

// ── HTTP: ops-key gated mutation ───────────────────────────────────────────

test('POST /ops/audit/attestation: requires ops-key (401 without)', async () => {
  const r = await request(app)
    .post('/api/v1/ops/audit/attestation')
    .set('Content-Type', 'application/json')
    .send({
      control_area: 'CC1',
      attestation_class: 'org-chart-review',
      attestation_text: 'no-auth test',
    });
  assert.ok(r.status === 401 || r.status === 403, `expected 401/403 got ${r.status}`);
});

test('POST /ops/audit/attestation: writes row + returns event_id', async () => {
  const r = await request(app)
    .post('/api/v1/ops/audit/attestation')
    .set('Authorization', 'Bearer ops-y')
    .set('Content-Type', 'application/json')
    .send({
      control_area: 'CC9',
      attestation_class: 'risk-register-review',
      attestation_text: 'HTTP attestation test 2026-06-07.',
      period_start: '2026-06-01',
      period_end: '2026-06-30',
    });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.match(r.body.event_id, /^[a-f0-9]{16}$/);
  assert.ok(r.body.id > 0);
});

test('POST /ops/audit/attestation: 400 on bad control_area', async () => {
  const r = await request(app)
    .post('/api/v1/ops/audit/attestation')
    .set('Authorization', 'Bearer ops-y')
    .set('Content-Type', 'application/json')
    .send({
      control_area: 'CC7',  // event-stream area, not governance-tier
      attestation_class: 'x',
      attestation_text: 'x',
    });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /control_area must be one of/);
});

test('POST /ops/audit/attestation: 400 on missing attestation_text', async () => {
  const r = await request(app)
    .post('/api/v1/ops/audit/attestation')
    .set('Authorization', 'Bearer ops-y')
    .set('Content-Type', 'application/json')
    .send({
      control_area: 'CC1',
      attestation_class: 'x',
    });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /attestation_text required/);
});

test('POST /ops/audit/attestation: 400 on oversized attestation_class', async () => {
  const r = await request(app)
    .post('/api/v1/ops/audit/attestation')
    .set('Authorization', 'Bearer ops-y')
    .set('Content-Type', 'application/json')
    .send({
      control_area: 'CC2',
      attestation_class: 'x'.repeat(200),
      attestation_text: 'x',
    });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /attestation_class/);
});
