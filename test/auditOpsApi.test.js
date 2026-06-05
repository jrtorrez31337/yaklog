// CP12.2 (2026-06-04): ADR-0030 v1.1 §5.2 ops-key gated mutation endpoint
// tests. Six endpoints under /api/v1/ops/{policy,audit}/*. Tests mount the
// auditOpsRoutes router on a standalone Express app at /api/v1/ops so we
// don't depend on app.js wiring (which a sibling subagent may also be
// editing in parallel). Auth gate (enforceOpsKey) is router-level.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// MUST set env before requiring config-touching modules — config caches at
// require-time so YAKLOG_OPS_API_KEYS would be empty otherwise.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-auditops-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'test-key';
process.env.YAKLOG_OPS_API_KEYS = 'ops-key-secret';
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');

const auditOpsRoutes = require('../src/auditOpsRoutes');
const {
  closeDb,
  insertAuditToolInvocation,
  insertAuditPayload,
  getAuditPayload,
  upsertSubjectDirectory,
  getSubjectByHash,
  upsertPolicyRule,
  insertPolicyViolation,
  getPolicyRule,
  listAuditCredentialChanges,
} = require('../src/db');

// Standalone test-only mount. Real app.js mounts the same router via
// app.use('/api/v1/ops', auditOpsRoutes).
const app = express();
app.use(express.json());
app.use('/api/v1/ops', auditOpsRoutes);

const OPS_KEY = 'ops-key-secret';
const NON_OPS_KEY = 'test-key'; // valid YAKLOG_API_KEYS, but NOT ops
const EXPECTED_ACTOR = crypto.createHash('sha256').update(OPS_KEY).digest('hex').slice(0, 16);

const opsAuth = { Authorization: `Bearer ${OPS_KEY}` };
const nonOpsAuth = { Authorization: `Bearer ${NON_OPS_KEY}` };

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// ─── auth gate ──────────────────────────────────────────────────────────────

test('auth: missing Bearer → 401', async () => {
  const r = await request(app).put('/api/v1/ops/policy/rule').send({});
  assert.equal(r.statusCode, 401);
  assert.equal(r.body.error, 'Unauthorized');
});

test('auth: non-ops Bearer (YAKLOG_API_KEYS) → 403', async () => {
  const r = await request(app).put('/api/v1/ops/policy/rule').set(nonOpsAuth).send({});
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, 'Forbidden');
});

test('auth: valid ops Bearer + bad body → 400 (gate cleared)', async () => {
  const r = await request(app).put('/api/v1/ops/policy/rule').set(opsAuth).send({});
  assert.equal(r.statusCode, 400);
});

// ─── PUT /policy/rule (UPSERT + happy + validation) ─────────────────────────

test('PUT /policy/rule: happy path inserts draft, returns version=1', async () => {
  const r = await request(app).put('/api/v1/ops/policy/rule').set(opsAuth).send({
    rule_id: 'no-secrets-in-public-channels',
    name: 'No secrets in public channels',
    description: 'Block token-shaped strings outside DM lane',
    applicability_json: { channels: ['#status', '#handoff'] },
    predicate_dsl: 'body matches /sk-[A-Za-z0-9]{40,}/',
    severity_class: 'critical',
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.rule_id, 'no-secrets-in-public-channels');
  assert.equal(r.body.current_version, 1);
});

test('PUT /policy/rule: actor (authored_by) = sha256(opsKey).slice(0,16)', async () => {
  // Read back via direct db helper; verify the 16-char hex matches expectation.
  const row = getPolicyRule('no-secrets-in-public-channels');
  assert.ok(row);
  assert.equal(row.authored_by, EXPECTED_ACTOR);
  assert.equal(row.authored_by.length, 16);
  assert.match(row.authored_by, /^[0-9a-f]{16}$/);
});

test('PUT /policy/rule: bad severity_class → 400 (not 500)', async () => {
  const r = await request(app).put('/api/v1/ops/policy/rule').set(opsAuth).send({
    rule_id: 'r-bad-sev',
    name: 'x', description: 'y',
    applicability_json: {}, predicate_dsl: 'true',
    severity_class: 'CATASTROPHIC',
  });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.message, /severity_class/);
});

// ─── POST /policy/rule/:id/ratify ───────────────────────────────────────────

test('POST /policy/rule/:id/ratify: draft → active + ratified_by set', async () => {
  const r = await request(app).post('/api/v1/ops/policy/rule/no-secrets-in-public-channels/ratify').set(opsAuth);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.ratified, true);
  const row = getPolicyRule('no-secrets-in-public-channels');
  assert.equal(row.status, 'active');
  assert.equal(row.ratified_by, EXPECTED_ACTOR);
  assert.ok(row.ratified_at);
});

test('POST /policy/rule/UNKNOWN/ratify → 404', async () => {
  const r = await request(app).post('/api/v1/ops/policy/rule/does-not-exist/ratify').set(opsAuth);
  assert.equal(r.statusCode, 404);
});

// ─── POST /policy/rule/:id/deprecate ────────────────────────────────────────

test('POST /policy/rule/:id/deprecate: active → deprecated', async () => {
  upsertPolicyRule({
    rule_id: 'r-to-deprecate', name: 'x', description: 'y',
    applicability_json: '{}', predicate_dsl: 'true', severity_class: 'warn',
    authored_by: 'seed',
  });
  const r = await request(app).post('/api/v1/ops/policy/rule/r-to-deprecate/deprecate').set(opsAuth);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.deprecated, true);
  const row = getPolicyRule('r-to-deprecate');
  assert.equal(row.status, 'deprecated');
});

test('POST /policy/rule/UNKNOWN/deprecate → 404', async () => {
  const r = await request(app).post('/api/v1/ops/policy/rule/nope-nope/deprecate').set(opsAuth);
  assert.equal(r.statusCode, 404);
});

// ─── PATCH /policy/violation/:id ────────────────────────────────────────────

test('PATCH /policy/violation/:id: happy disposition update', async () => {
  // Seed a violation referencing an active rule.
  upsertPolicyRule({
    rule_id: 'r-for-violation', name: 'x', description: 'y',
    applicability_json: '{}', predicate_dsl: 'true', severity_class: 'violation',
    authored_by: 'seed',
  });
  const v = insertPolicyViolation({
    rule_id: 'r-for-violation', rule_version: 1,
    matched_object_class: 'message', matched_object_ref: 'msg#42',
    agent_id: 'agent-a',
  });
  const r = await request(app).patch(`/api/v1/ops/policy/violation/${v.id}`).set(opsAuth).send({
    disposition: 'remediated',
    disposition_note: 'rotated key + closed loop',
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.changed, 1);
});

test('PATCH /policy/violation/:id: invalid disposition → 400', async () => {
  const r = await request(app).patch('/api/v1/ops/policy/violation/1').set(opsAuth).send({
    disposition: 'whatever',
  });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.message, /disposition/);
});

test('PATCH /policy/violation/:id: unknown id → 404', async () => {
  const r = await request(app).patch('/api/v1/ops/policy/violation/999999').set(opsAuth).send({
    disposition: 'acknowledged',
  });
  assert.equal(r.statusCode, 404);
});

// ─── POST /audit/reconcile ──────────────────────────────────────────────────

test('POST /audit/reconcile: happy with positive delta', async () => {
  const r = await request(app).post('/api/v1/ops/audit/reconcile').set(opsAuth).send({
    period_start: '2026-06-01', period_end: '2026-06-04',
    external_system_label: 'anthropic-console-export',
    plexus_count: 100, external_count: 105,
    reconciler_agent_id: 'admin-agent',
    notes: 'expected: 5-row drift from late hook flushes',
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.ok(r.body.id);
  assert.equal(r.body.delta_count, 5);
  assert.equal(r.body.delta_pct, 5);
});

test('POST /audit/reconcile: negative delta (external < plexus)', async () => {
  const r = await request(app).post('/api/v1/ops/audit/reconcile').set(opsAuth).send({
    period_start: '2026-06-01', period_end: '2026-06-04',
    external_system_label: 'external-A',
    plexus_count: 100, external_count: 90,
    reconciler_agent_id: 'admin-agent',
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.delta_count, -10);
  assert.equal(r.body.delta_pct, -10);
});

test('POST /audit/reconcile: zero delta', async () => {
  const r = await request(app).post('/api/v1/ops/audit/reconcile').set(opsAuth).send({
    period_start: '2026-06-01', period_end: '2026-06-04',
    external_system_label: 'external-B',
    plexus_count: 50, external_count: 50,
    reconciler_agent_id: 'admin-agent',
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.delta_count, 0);
  assert.equal(r.body.delta_pct, 0);
});

test('POST /audit/reconcile: non-integer counts → 400', async () => {
  const r = await request(app).post('/api/v1/ops/audit/reconcile').set(opsAuth).send({
    period_start: '2026-06-01', period_end: '2026-06-04',
    external_system_label: 'external-bad',
    plexus_count: 100.5, external_count: 'not-a-number',
    reconciler_agent_id: 'admin-agent',
  });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.message, /integer/);
});

// ─── POST /audit/tombstone ──────────────────────────────────────────────────

test('POST /audit/tombstone: missing reason → 400', async () => {
  const r = await request(app).post('/api/v1/ops/audit/tombstone').set(opsAuth).send({
    kind: 'audit-payload', table_name: 'audit_tool_invocation', row_id: 1,
  });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.message, /reason/);
});

test('POST /audit/tombstone: bad kind → 400', async () => {
  const r = await request(app).post('/api/v1/ops/audit/tombstone').set(opsAuth).send({
    kind: 'all-the-things', reason: 'GDPR Art.17',
  });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.message, /kind/);
});

test('POST /audit/tombstone: audit-payload round-trip (payload deleted + tombstone_at set + meta-audit row)', async () => {
  // Seed: payload + audit_tool_invocation row pointing to it.
  const payload = insertAuditPayload(Buffer.from('sensitive output that should be tombstoned'));
  assert.ok(payload.payload_ref);
  const inv = insertAuditToolInvocation({
    agent_id: 'agent-x', tool_name: 'Bash', tool_phase: 'post',
    status: 'ok', payload_ref: payload.payload_ref,
  });

  const before = listAuditCredentialChanges({ credential_class: 'audit-payload-tombstone', limit: 200 }).length;
  const r = await request(app).post('/api/v1/ops/audit/tombstone').set(opsAuth).send({
    kind: 'audit-payload',
    table_name: 'audit_tool_invocation',
    row_id: inv.id,
    reason: 'GDPR Art.17 erasure request',
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.kind, 'audit-payload');
  assert.ok(r.body.tombstone_at);

  // Payload row gone
  assert.equal(getAuditPayload(payload.payload_ref), null);

  // Meta-audit row produced (credential-change with class audit-payload-tombstone,
  // actor = sha256-prefix of OPS key).
  const after = listAuditCredentialChanges({ credential_class: 'audit-payload-tombstone', limit: 200 });
  assert.equal(after.length, before + 1);
  const meta = after.find(row => row.actor === EXPECTED_ACTOR);
  assert.ok(meta, 'meta-audit row attributed to ops-key sha256-prefix');
});

test('POST /audit/tombstone: double-call (already tombstoned) → 409', async () => {
  const payload = insertAuditPayload(Buffer.from('x'));
  const inv = insertAuditToolInvocation({
    agent_id: 'agent-y', tool_name: 'Read', tool_phase: 'pre',
    payload_ref: payload.payload_ref,
  });
  // First tombstone — should 200
  const r1 = await request(app).post('/api/v1/ops/audit/tombstone').set(opsAuth).send({
    kind: 'audit-payload',
    table_name: 'audit_tool_invocation', row_id: inv.id,
    reason: 'GDPR Art.17',
  });
  assert.equal(r1.statusCode, 200);
  // Second tombstone — already tombstoned → 409
  const r2 = await request(app).post('/api/v1/ops/audit/tombstone').set(opsAuth).send({
    kind: 'audit-payload',
    table_name: 'audit_tool_invocation', row_id: inv.id,
    reason: 'GDPR Art.17',
  });
  assert.equal(r2.statusCode, 409);
  assert.match(r2.body.message, /already tombstoned/i);
});

test('POST /audit/tombstone: audit-payload with bad table_name → 400', async () => {
  const r = await request(app).post('/api/v1/ops/audit/tombstone').set(opsAuth).send({
    kind: 'audit-payload',
    table_name: 'messages', // not in ALLOWED set
    row_id: 1,
    reason: 'GDPR Art.17',
  });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.message, /table_name/);
});

test('POST /audit/tombstone: subject round-trip (cleartext nulled + tombstone_at set)', async () => {
  const subjectHash = upsertSubjectDirectory('forgotten-user@example.com');
  assert.ok(subjectHash);
  // Pre: cleartext present
  const pre = getSubjectByHash(subjectHash);
  assert.equal(pre.user_email_cleartext, 'forgotten-user@example.com');
  assert.equal(pre.tombstone_at, null);

  const r = await request(app).post('/api/v1/ops/audit/tombstone').set(opsAuth).send({
    kind: 'subject',
    subject_hash: subjectHash,
    reason: 'GDPR Art.17 verified erasure request 2026-06-04',
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.kind, 'subject');
  assert.equal(r.body.subject_hash, subjectHash);
  assert.ok(r.body.tombstone_at);

  // Post: cleartext nulled, tombstone_at set, tombstone_by = actor
  const post = getSubjectByHash(subjectHash);
  assert.equal(post.user_email_cleartext, null);
  assert.ok(post.tombstone_at);
  assert.equal(post.tombstone_by, EXPECTED_ACTOR);
});

test('POST /audit/tombstone: subject double-call → 409', async () => {
  const subjectHash = upsertSubjectDirectory('second-forgotten@example.com');
  const body = { kind: 'subject', subject_hash: subjectHash, reason: 'GDPR Art.17' };
  const r1 = await request(app).post('/api/v1/ops/audit/tombstone').set(opsAuth).send(body);
  assert.equal(r1.statusCode, 200);
  const r2 = await request(app).post('/api/v1/ops/audit/tombstone').set(opsAuth).send(body);
  assert.equal(r2.statusCode, 409);
});

test('POST /audit/tombstone: subject with unknown hash → 409 (helper conflates with already-tombstoned)', async () => {
  // tombstoneSubject UPDATE ... WHERE tombstone_at IS NULL returns changes=0
  // for BOTH "no such row" and "already tombstoned" — we surface 409 for both.
  // Documented spec ambiguity (see report).
  const fakeHash = 'a'.repeat(64);
  const r = await request(app).post('/api/v1/ops/audit/tombstone').set(opsAuth).send({
    kind: 'subject', subject_hash: fakeHash, reason: 'GDPR Art.17',
  });
  assert.equal(r.statusCode, 409);
});
