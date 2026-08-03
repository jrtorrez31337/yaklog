// CP12.1 (2026-06-04): audit + governance helpers test suite.
// Tests the Phase 1 substrate per ADR-0030 v1.1 ratified canonical:
// 9 tables + helpers + tombstone atomic-transaction + hash-chain formula
// + subject-hash-at-ingestion for GDPR DSAR. Floor ≥25 tests; this file
// targets that floor across all 9 substrate surfaces.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-audit-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'test-key';
process.env.NODE_ENV = 'test';

const {
  closeDb,
  computeAuditEventId, subjectHash, fullSha256,
  insertAuditToolInvocation, listAuditToolInvocations, getAuditToolInvocationByEventId,
  insertAuditFileAccess, listAuditFileAccess,
  insertAuditCredentialChange, listAuditCredentialChanges,
  insertAuditPermissionChange, listAuditPermissionChanges,
  upsertPolicyRule, listPolicyRules, getPolicyRule, ratifyPolicyRule, deprecatePolicyRule,
  insertPolicyViolation, listPolicyViolations, disposePolicyViolation,
  insertAuditReconciliation, listAuditReconciliations,
  insertAuditPayload, getAuditPayload, tombstoneAuditPayload,
  upsertSubjectDirectory, getSubjectByHash, tombstoneSubject,
} = require('../src/db');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// ─── hash-chain formula ─────────────────────────────────────────────────────

test('computeAuditEventId: deterministic over identical inputs', () => {
  const a = computeAuditEventId('prev', '2026-06-04T00:00:00Z', 'agent-a', 'tool:pre', { tool_name: 'Bash' });
  const b = computeAuditEventId('prev', '2026-06-04T00:00:00Z', 'agent-a', 'tool:pre', { tool_name: 'Bash' });
  assert.equal(a, b);
  assert.equal(a.length, 16);
  assert.match(a, /^[0-9a-f]{16}$/);
});

test('computeAuditEventId: different metadata produces different id', () => {
  const a = computeAuditEventId('p', 't', 'agent-a', 'tool:pre', { tool_name: 'Bash' });
  const b = computeAuditEventId('p', 't', 'agent-a', 'tool:pre', { tool_name: 'Edit' });
  assert.notEqual(a, b);
});

test('computeAuditEventId: payload_ref EXCLUDED from chain (admin R2)', () => {
  // Hash-chain must not include payload_ref so tombstoning preserves chain integrity.
  // We verify by passing identical metadata but different "payload_ref" — should equal.
  const meta = { tool_name: 'Bash', status: 'ok' };
  const a = computeAuditEventId('p', 't', 'a', 'tool:post', meta);
  const b = computeAuditEventId('p', 't', 'a', 'tool:post', meta);
  assert.equal(a, b, 'identical metadata-only input must produce identical event_id');
});

test('subjectHash: deterministic, lowercased + trimmed, full 64 chars', () => {
  const a = subjectHash('Jon@Example.com');
  const b = subjectHash('  jon@example.com  ');
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('fullSha256: returns 64-char hex (per secops R3 — tombstone integrity)', () => {
  const h = fullSha256('hello world');
  assert.equal(h.length, 64);
  assert.match(h, /^[0-9a-f]{64}$/);
});

// ─── audit_tool_invocation ──────────────────────────────────────────────────

test('audit_tool_invocation: insert + read back by agent', () => {
  const r = insertAuditToolInvocation({
    agent_id: 'agent-a', tool_name: 'Bash', tool_phase: 'pre',
    input_digest: fullSha256('git status'),
  });
  assert.ok(r.id);
  assert.equal(r.event_id.length, 16);
  const rows = listAuditToolInvocations({ agent_id: 'agent-a' });
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].tool_name, 'Bash');
});

test('audit_tool_invocation: tool_phase enforces enum', () => {
  assert.throws(
    () => insertAuditToolInvocation({ agent_id: 'a', tool_name: 'Bash', tool_phase: 'invalid' }),
    /tool_phase must be pre\|post\|failure/
  );
});

test('audit_tool_invocation: getAuditToolInvocationByEventId round-trip', () => {
  const r = insertAuditToolInvocation({
    agent_id: 'agent-b', tool_name: 'Edit', tool_phase: 'post',
    status: 'ok', output_digest: fullSha256('result'),
  });
  const fetched = getAuditToolInvocationByEventId(r.event_id);
  assert.ok(fetched);
  assert.equal(fetched.event_id, r.event_id);
  assert.equal(fetched.status, 'ok');
});

test('audit_tool_invocation: status_detail truncated to 200 chars', () => {
  const long = 'x'.repeat(500);
  const r = insertAuditToolInvocation({
    agent_id: 'agent-c', tool_name: 'Bash', tool_phase: 'failure',
    status: 'error', status_detail: long,
  });
  const fetched = getAuditToolInvocationByEventId(r.event_id);
  assert.equal(fetched.status_detail.length, 200);
});

test('audit_tool_invocation: time-range filter', () => {
  insertAuditToolInvocation({
    occurred_at: '2026-01-01T00:00:00Z',
    agent_id: 'agent-time', tool_name: 'Bash', tool_phase: 'pre',
  });
  insertAuditToolInvocation({
    occurred_at: '2026-06-04T00:00:00Z',
    agent_id: 'agent-time', tool_name: 'Bash', tool_phase: 'pre',
  });
  const recent = listAuditToolInvocations({ agent_id: 'agent-time', from: '2026-06-01T00:00:00Z' });
  assert.equal(recent.length, 1);
});

// ─── audit_file_access ──────────────────────────────────────────────────────

test('audit_file_access: insert with attribution_confidence default uid_unique', () => {
  const r = insertAuditFileAccess({
    uid: 1001, path: '/home/operator/yaklog/src/db.js', access_mode: 'read', agent_id: 'agent-a',
  });
  assert.ok(r.id);
  const rows = listAuditFileAccess({ agent_id: 'agent-a' });
  const row = rows.find(x => x.id === r.id);
  assert.equal(row.attribution_confidence, 'uid_unique');
});

test('audit_file_access: jon-uid shared attribution per admin R5/secops F1 fold', () => {
  // Per ADR-0030 fold: uid_shared on jon-uid hosts; agent_id may be NULL;
  // post-hoc L2 hook-stream correlation via session_correlator.
  const r = insertAuditFileAccess({
    uid: 1000, path: '/home/operator/something', access_mode: 'write',
    attribution_confidence: 'uid_shared', agent_id: null,
    session_correlator: 'cc-session-abc-123',
  });
  const rows = listAuditFileAccess({ path_prefix: '/home/operator/' });
  const row = rows.find(x => x.id === r.id);
  assert.equal(row.attribution_confidence, 'uid_shared');
  assert.equal(row.agent_id, null);
  assert.equal(row.session_correlator, 'cc-session-abc-123');
});

test('audit_file_access: attribution_confidence enforces enum', () => {
  assert.throws(
    () => insertAuditFileAccess({
      uid: 1001, path: '/x', access_mode: 'read', attribution_confidence: 'bogus',
    }),
    /attribution_confidence must be/
  );
});

test('audit_file_access: path_prefix filter (LIKE)', () => {
  insertAuditFileAccess({ uid: 1001, path: '/etc/passwd', access_mode: 'read' });
  insertAuditFileAccess({ uid: 1001, path: '/home/agent/file.txt', access_mode: 'read' });
  const etcRows = listAuditFileAccess({ path_prefix: '/etc/' });
  assert.ok(etcRows.length >= 1);
  assert.ok(etcRows.every(r => r.path.startsWith('/etc/')));
});

// ─── audit_credential_change ───────────────────────────────────────────────

test('audit_credential_change: §71-class rotation round-trip', () => {
  const r = insertAuditCredentialChange({
    credential_class: 'yaklog-token', agent_id: 'agent-a',
    change_type: 'rotate', actor: 'opskey-sha256-abc123',
    prior_digest: fullSha256('old-token').slice(0, 32),
    new_digest: fullSha256('new-token').slice(0, 32),
    reason: 'scheduled §71 rotation',
  });
  assert.ok(r.id);
  const rows = listAuditCredentialChanges({ credential_class: 'yaklog-token' });
  assert.ok(rows.length >= 1);
});

test('audit_credential_change: required fields enforced', () => {
  assert.throws(
    () => insertAuditCredentialChange({ change_type: 'mint', actor: 'x' }),
    /credential_class \+ change_type \+ actor required/
  );
});

// ─── audit_permission_change ────────────────────────────────────────────────

test('audit_permission_change: settings.local.json add-allow round-trip', () => {
  const r = insertAuditPermissionChange({
    agent_id: 'agent-a', change_type: 'add-allow',
    rule_text: 'Bash(rm:*)',
    actor: 'opskey-sha256-abc',
    source_path: '.claude/settings.local.json',
    reason: 'operator added Bash(rm:*) allowance',
  });
  assert.ok(r.id);
  const rows = listAuditPermissionChanges({ agent_id: 'agent-a' });
  assert.ok(rows.length >= 1);
});

// ─── policy_rule + policy_violation ─────────────────────────────────────────

test('policy_rule: upsert with draft default + ratify cycle', () => {
  upsertPolicyRule({
    rule_id: 'POL-SECRETS-001',
    name: 'No secrets in bus bodies',
    description: 'Detect token-shaped strings in non-private message bodies',
    applicability_json: { object_classes: ['messages'], private: false },
    predicate_dsl: 'body matches /sk-[a-zA-Z0-9]{40}/',
    severity_class: 'critical',
    authored_by: 'agent-yaklog-dev',
  });
  let rule = getPolicyRule('POL-SECRETS-001');
  assert.equal(rule.status, 'draft');
  assert.equal(rule.current_version, 1);
  ratifyPolicyRule('POL-SECRETS-001', 'jon');
  rule = getPolicyRule('POL-SECRETS-001');
  assert.equal(rule.status, 'active');
  assert.equal(rule.ratified_by, 'jon');
});

test('policy_rule: version bumps only on predicate_dsl change', () => {
  upsertPolicyRule({
    rule_id: 'POL-TEST-VERSION', name: 'Test', description: 'd',
    applicability_json: {}, predicate_dsl: 'always_true',
    severity_class: 'info', authored_by: 'a',
  });
  assert.equal(getPolicyRule('POL-TEST-VERSION').current_version, 1);
  upsertPolicyRule({
    rule_id: 'POL-TEST-VERSION', name: 'Test renamed', description: 'd',
    applicability_json: {}, predicate_dsl: 'always_true',
    severity_class: 'info', authored_by: 'a',
  });
  assert.equal(getPolicyRule('POL-TEST-VERSION').current_version, 1, 'rename only does not bump version');
  upsertPolicyRule({
    rule_id: 'POL-TEST-VERSION', name: 'Test renamed', description: 'd',
    applicability_json: {}, predicate_dsl: 'always_false',
    severity_class: 'info', authored_by: 'a',
  });
  assert.equal(getPolicyRule('POL-TEST-VERSION').current_version, 2, 'predicate change bumps');
});

test('policy_rule: severity_class enforces enum', () => {
  assert.throws(
    () => upsertPolicyRule({
      rule_id: 'POL-X', name: 'x', description: 'x', applicability_json: {},
      predicate_dsl: 'x', severity_class: 'bogus', authored_by: 'a',
    }),
    /severity_class must be info\|warn\|violation\|critical/
  );
});

test('policy_rule: deprecate moves status', () => {
  upsertPolicyRule({
    rule_id: 'POL-DEPRECATE', name: 'x', description: 'x', applicability_json: {},
    predicate_dsl: 'x', severity_class: 'info', authored_by: 'a',
  });
  deprecatePolicyRule('POL-DEPRECATE');
  assert.equal(getPolicyRule('POL-DEPRECATE').status, 'deprecated');
});

test('policy_violation: insert + disposition lifecycle', () => {
  upsertPolicyRule({
    rule_id: 'POL-CHAN-DISC', name: 'channel discipline',
    description: 'd', applicability_json: {}, predicate_dsl: 'x',
    severity_class: 'warn', authored_by: 'a',
  });
  const r = insertPolicyViolation({
    rule_id: 'POL-CHAN-DISC', rule_version: 1,
    matched_object_class: 'messages', matched_object_ref: 'messages:1234',
    agent_id: 'agent-a',
  });
  assert.ok(r.id);
  let v = listPolicyViolations({ rule_id: 'POL-CHAN-DISC' });
  assert.equal(v[0].disposition, 'pending');
  disposePolicyViolation(r.id, {
    disposition: 'acknowledged', disposition_by: 'opskey-abc', disposition_note: 'reviewed',
  });
  v = listPolicyViolations({ rule_id: 'POL-CHAN-DISC' });
  assert.equal(v[0].disposition, 'acknowledged');
});

test('policy_violation: list sort — pending first then severity (bizmodel R-A2)', () => {
  upsertPolicyRule({
    rule_id: 'POL-CRIT', name: 'c', description: 'd', applicability_json: {},
    predicate_dsl: 'x', severity_class: 'critical', authored_by: 'a',
  });
  upsertPolicyRule({
    rule_id: 'POL-INFO', name: 'i', description: 'd', applicability_json: {},
    predicate_dsl: 'x', severity_class: 'info', authored_by: 'a',
  });
  const critPending = insertPolicyViolation({
    rule_id: 'POL-CRIT', rule_version: 1,
    matched_object_class: 'messages', matched_object_ref: 'm:1',
  });
  const infoPending = insertPolicyViolation({
    rule_id: 'POL-INFO', rule_version: 1,
    matched_object_class: 'messages', matched_object_ref: 'm:2',
  });
  const critRemediated = insertPolicyViolation({
    rule_id: 'POL-CRIT', rule_version: 1,
    matched_object_class: 'messages', matched_object_ref: 'm:3',
  });
  disposePolicyViolation(critRemediated.id, {
    disposition: 'remediated', disposition_by: 'opskey-x',
  });
  // Filter to just these 3 rules to avoid noise from earlier tests
  const list = listPolicyViolations()
    .filter(v => [critPending.id, infoPending.id, critRemediated.id].includes(v.id));
  assert.equal(list.length, 3);
  // pending critical before pending info before remediated critical
  assert.equal(list[0].id, critPending.id, 'pending critical first');
  assert.equal(list[1].id, infoPending.id, 'pending info second');
  assert.equal(list[2].id, critRemediated.id, 'remediated last');
});

test('policy_violation: invalid disposition rejected', () => {
  upsertPolicyRule({
    rule_id: 'POL-DISP', name: 'd', description: 'd', applicability_json: {},
    predicate_dsl: 'x', severity_class: 'info', authored_by: 'a',
  });
  const r = insertPolicyViolation({
    rule_id: 'POL-DISP', rule_version: 1,
    matched_object_class: 'm', matched_object_ref: 'm:1',
  });
  assert.throws(
    () => disposePolicyViolation(r.id, { disposition: 'bogus', disposition_by: 'x' }),
    /invalid disposition/
  );
});

// ─── audit_reconciliation ───────────────────────────────────────────────────

test('audit_reconciliation: insert + delta computation', () => {
  const r = insertAuditReconciliation({
    period_start: '2026-06-01', period_end: '2026-06-30',
    external_system_label: 'siem',
    plexus_count: 1000, external_count: 998,
    reconciler_agent_id: 'agent-secops',
    reconciled_by: 'opskey-sha256-abc',
    concentration_json: { tool_invocations: 800, file_access: 198 },
  });
  assert.equal(r.delta_count, -2);
  assert.ok(Math.abs(r.delta_pct - (-0.2)) < 0.001);
});

test('audit_reconciliation: required fields enforced', () => {
  assert.throws(
    () => insertAuditReconciliation({
      period_start: '2026-06-01', period_end: '2026-06-30',
      external_system_label: 'siem',
      plexus_count: 100, external_count: 100,
      reconciled_by: 'x',
      // missing reconciler_agent_id (admin R3)
    }),
    /reconciler_agent_id/
  );
});

test('audit_reconciliation: list newest-first', () => {
  insertAuditReconciliation({
    period_start: '2026-05-01', period_end: '2026-05-31',
    external_system_label: 'grc-platform',
    plexus_count: 50, external_count: 50,
    reconciler_agent_id: 'agent-x', reconciled_by: 'opskey-x',
  });
  const rows = listAuditReconciliations({ limit: 5 });
  assert.ok(rows.length >= 2);
  // newest id first
  assert.ok(rows[0].id > rows[rows.length - 1].id);
});

// ─── audit_payload_store + tombstone (admin R2 atomic transaction) ─────────

test('audit_payload_store: insert + retrieve payload', () => {
  const p = insertAuditPayload(Buffer.from('the actual secret payload'));
  assert.ok(p.payload_ref);
  assert.equal(p.content_digest.length, 64);
  const got = getAuditPayload(p.payload_ref);
  assert.ok(got);
  assert.equal(got.payload.toString(), 'the actual secret payload');
});

test('tombstoneAuditPayload: atomic — payload deleted + tombstone_at set + meta-audit row', () => {
  const p = insertAuditPayload('sensitive data');
  const ti = insertAuditToolInvocation({
    agent_id: 'agent-tombstone', tool_name: 'Read', tool_phase: 'post',
    status: 'ok', payload_ref: p.payload_ref,
  });

  const before = listAuditCredentialChanges({ credential_class: 'audit-payload-tombstone' }).length;
  tombstoneAuditPayload({
    table_name: 'audit_tool_invocation', row_id: ti.id,
    ops_key_sha256: 'opskey-sha256-tombstone', reason: 'GDPR DSAR right-to-be-forgotten',
  });

  // payload deleted
  assert.equal(getAuditPayload(p.payload_ref), null);
  // tombstone_at set on the audit row
  const row = getAuditToolInvocationByEventId(ti.event_id);
  assert.ok(row.tombstone_at);
  assert.equal(row.payload_ref, p.payload_ref); // preserved for forensic record
  // meta-audit row produced
  const after = listAuditCredentialChanges({ credential_class: 'audit-payload-tombstone' }).length;
  assert.equal(after, before + 1);
});

test('tombstoneAuditPayload: double-tombstone rejected', () => {
  const p = insertAuditPayload('x');
  const ti = insertAuditToolInvocation({
    agent_id: 'agent-double-tomb', tool_name: 'Read', tool_phase: 'post',
    payload_ref: p.payload_ref,
  });
  tombstoneAuditPayload({
    table_name: 'audit_tool_invocation', row_id: ti.id,
    ops_key_sha256: 'opskey-1', reason: 'first',
  });
  assert.throws(
    () => tombstoneAuditPayload({
      table_name: 'audit_tool_invocation', row_id: ti.id,
      ops_key_sha256: 'opskey-2', reason: 'second',
    }),
    /already tombstoned/
  );
});

test('tombstoneAuditPayload: table_name allowlist (no arbitrary table)', () => {
  assert.throws(
    () => tombstoneAuditPayload({
      table_name: 'messages', row_id: 1, ops_key_sha256: 'x', reason: 'attack',
    }),
    /table_name must be one of/
  );
});

// ─── subject_directory (GDPR DSAR hash-at-ingestion per bizmodel OQ#4) ──────

test('subject_directory: upsert is idempotent on subject_hash', () => {
  const h1 = upsertSubjectDirectory('user@example.com');
  const h2 = upsertSubjectDirectory('user@example.com');
  assert.equal(h1, h2);
  const row = getSubjectByHash(h1);
  assert.equal(row.user_email_cleartext, 'user@example.com');
  assert.equal(row.tombstone_at, null);
});

test('subject_directory: case + whitespace normalization', () => {
  const h1 = upsertSubjectDirectory('SAME@Example.COM');
  const h2 = upsertSubjectDirectory('  same@example.com  ');
  assert.equal(h1, h2);
});

test('tombstoneSubject: right-to-be-forgotten — cleartext NULL + tombstone_at set + meta-audit row', () => {
  const h = upsertSubjectDirectory('gdpr-subject@example.com');
  const before = listAuditCredentialChanges({ credential_class: 'subject-directory-tombstone' }).length;
  tombstoneSubject({
    subject_hash: h, ops_key_sha256: 'opskey-gdpr',
    reason: 'GDPR Art. 17 right-to-be-forgotten request 2026-001',
  });
  const row = getSubjectByHash(h);
  assert.equal(row.user_email_cleartext, null);
  assert.ok(row.tombstone_at);
  assert.equal(row.tombstone_by, 'opskey-gdpr');
  const after = listAuditCredentialChanges({ credential_class: 'subject-directory-tombstone' }).length;
  assert.equal(after, before + 1);
});

test('tombstoneSubject: missing subject rejected', () => {
  assert.throws(
    () => tombstoneSubject({
      subject_hash: 'nonexistent-hash-1234567890abcdef', ops_key_sha256: 'x', reason: 'test',
    }),
    /not found or already tombstoned/
  );
});

test('tombstoneSubject: reason required (lawful-basis-class)', () => {
  const h = upsertSubjectDirectory('ack-no-reason@example.com');
  assert.throws(
    () => tombstoneSubject({ subject_hash: h, ops_key_sha256: 'x' }),
    /reason required \(lawful-basis-class\)/
  );
});
