// CP12.2 (2026-06-04): tests for Phase 1 audit + governance read API.
// Mounts auditRoutes onto a minimal Express app (no global middleware) so
// these tests stay isolated from the full src/app.js auth/middleware chain
// that the cost suite exercises. Network-isolation trust model means no
// auth header required.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-auditapi-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'test-key';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');

const {
  closeDb,
  insertAuditToolInvocation,
  insertAuditFileAccess,
  insertAuditCredentialChange,
  insertAuditPermissionChange,
  upsertPolicyRule,
  ratifyPolicyRule,
  deprecatePolicyRule,
  insertPolicyViolation,
  upsertPresence,
  fullSha256,
} = require('../src/db');

const auditRoutes = require('../src/auditRoutes');

// Minimal Express app — mirrors how src/app.js mounts publicRouter.
const app = express();
app.use('/api/v1/plexus/public', auditRoutes);

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// ── seed ──────────────────────────────────────────────────────────────────

// Anchor NOW to current-date-at-noon-UTC (was fixed '2026-06-04' — broke on
// month rollover per secops #11256 root-cause: fixtures fell outside July mtd
// window on 2026-07-01, cascading to 6 failing mtd-scoped assertions).
// Live endpoints correct; test-fixture hygiene per Jon-direct #11262.
const _nowD = new Date();
const NOW = new Date(Date.UTC(_nowD.getUTCFullYear(), _nowD.getUTCMonth(), _nowD.getUTCDate(), 12, 0, 0, 0));
const iso = (offsetMs) => new Date(NOW.getTime() + offsetMs).toISOString();

test('seed: insert audit fixture rows', () => {
  // Tool invocations spanning 3 agents
  insertAuditToolInvocation({ agent_id: 'agent-a', tool_name: 'Bash', tool_phase: 'pre',
    occurred_at: iso(-1000), status: 'ok' });
  insertAuditToolInvocation({ agent_id: 'agent-a', tool_name: 'Edit', tool_phase: 'post',
    occurred_at: iso(-2000), status: 'ok' });
  insertAuditToolInvocation({ agent_id: 'agent-a', tool_name: 'Bash', tool_phase: 'failure',
    occurred_at: iso(-3000), status: 'error' });
  insertAuditToolInvocation({ agent_id: 'agent-b', tool_name: 'Read', tool_phase: 'pre',
    occurred_at: iso(-4000), status: 'ok' });
  insertAuditToolInvocation({ agent_id: 'agent-c', tool_name: 'Bash', tool_phase: 'pre',
    occurred_at: iso(-5000), status: 'ok' });

  // File access events
  insertAuditFileAccess({ agent_id: 'agent-a', uid: 1001, path: '/home/jon/yaklog/src/app.js',
    access_mode: 'read', occurred_at: iso(-6000) });
  insertAuditFileAccess({ agent_id: 'agent-b', uid: 1002, path: '/etc/passwd',
    access_mode: 'read', occurred_at: iso(-7000) });

  // Credential change events
  insertAuditCredentialChange({ credential_class: 'yaklog_token', change_type: 'rotate',
    actor: 'parch', agent_id: 'agent-a', occurred_at: iso(-8000) });
  insertAuditCredentialChange({ credential_class: 'ops_key', change_type: 'add',
    actor: 'parch', occurred_at: iso(-9000) });

  // Permission change events
  insertAuditPermissionChange({ agent_id: 'agent-a', change_type: 'add',
    rule_text: 'Bash(npm test:*)', actor: 'jon', occurred_at: iso(-10000) });
  insertAuditPermissionChange({ agent_id: 'agent-b', change_type: 'remove',
    rule_text: 'Bash(rm -rf:*)', actor: 'jon', occurred_at: iso(-11000) });

  // Policy rules across all statuses
  upsertPolicyRule({ rule_id: 'no-secrets-yaklog', name: 'no secrets via yaklog',
    description: 'token-like patterns flagged', applicability_json: '{"channel":"*"}',
    predicate_dsl: 'body matches /sk-[a-z0-9]/', severity_class: 'violation',
    authored_by: 'parch' });
  ratifyPolicyRule('no-secrets-yaklog', 'jon');

  upsertPolicyRule({ rule_id: 'pii-in-broadcast', name: 'PII in broadcast',
    description: 'flag PII in #status', applicability_json: '{"channel":"status"}',
    predicate_dsl: 'body matches /\\b\\d{3}-\\d{2}-\\d{4}\\b/', severity_class: 'critical',
    authored_by: 'parch' });
  ratifyPolicyRule('pii-in-broadcast', 'jon');

  upsertPolicyRule({ rule_id: 'draft-rule', name: 'draft rule',
    description: 'still in draft', applicability_json: '{}',
    predicate_dsl: 'false', severity_class: 'info', authored_by: 'parch' });

  upsertPolicyRule({ rule_id: 'old-rule', name: 'deprecated',
    description: 'no longer applies', applicability_json: '{}',
    predicate_dsl: 'false', severity_class: 'warn', authored_by: 'parch' });
  deprecatePolicyRule('old-rule');

  // Policy violations — concentrate on agent-a for anomaly-detail ordering
  insertPolicyViolation({ rule_id: 'no-secrets-yaklog', rule_version: 1,
    matched_object_class: 'message', matched_object_ref: 'msg:123',
    agent_id: 'agent-a', occurred_at: iso(-2500) });
  insertPolicyViolation({ rule_id: 'no-secrets-yaklog', rule_version: 1,
    matched_object_class: 'message', matched_object_ref: 'msg:124',
    agent_id: 'agent-a', occurred_at: iso(-2600) });
  insertPolicyViolation({ rule_id: 'pii-in-broadcast', rule_version: 1,
    matched_object_class: 'message', matched_object_ref: 'msg:200',
    agent_id: 'agent-b', occurred_at: iso(-2700) });

  // Presence — agent-d has NO audit trail (coverage gap)
  upsertPresence({ agent_id: 'agent-a', daemon_state: 'up', session_state: 'active' });
  upsertPresence({ agent_id: 'agent-b', daemon_state: 'up', session_state: 'active' });
  upsertPresence({ agent_id: 'agent-d', daemon_state: 'up', session_state: 'idle' });

  assert.ok(true);
});

// ── 1. /audit/summary ─────────────────────────────────────────────────────

test('GET /audit/summary?period=mtd → returns counts struct', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/summary?period=mtd');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.period, 'mtd');
  assert.ok(r.body.counts.tool_invocations >= 5);
  assert.ok(r.body.counts.file_accesses >= 2);
  assert.ok(r.body.counts.credential_changes >= 2);
  assert.ok(r.body.counts.permission_changes >= 2);
  assert.ok(r.body.counts.policy_violations >= 3);
  assert.equal(r.body.source, 'persisted');
  assert.ok(r.body.computed_at);
});

test('GET /audit/summary?period=invalid → 400 BadRequest', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/summary?period=bogus');
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, 'BadRequest');
});

test('GET /audit/summary period vocabulary: 7d / 30d / today all parse', async () => {
  for (const period of ['7d', '30d', 'today', 'ytd']) {
    const r = await request(app).get(`/api/v1/plexus/public/audit/summary?period=${period}`);
    assert.equal(r.statusCode, 200, `${period} failed`);
    assert.equal(r.body.period, period);
  }
});

// ── 2. /audit/tool-invocations ────────────────────────────────────────────

test('GET /audit/tool-invocations → returns rows DESC by occurred_at', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/tool-invocations');
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.count >= 5);
  // verify DESC
  for (let i = 1; i < r.body.rows.length; i++) {
    assert.ok(r.body.rows[i - 1].occurred_at >= r.body.rows[i].occurred_at);
  }
});

test('GET /audit/tool-invocations?agent=agent-a&tool=Bash → filter combo', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/tool-invocations?agent=agent-a&tool=Bash');
  assert.equal(r.statusCode, 200);
  for (const row of r.body.rows) {
    assert.equal(row.agent_id, 'agent-a');
    assert.equal(row.tool_name, 'Bash');
  }
});

test('GET /audit/tool-invocations?status=error → status filter', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/tool-invocations?status=error');
  assert.equal(r.statusCode, 200);
  for (const row of r.body.rows) {
    assert.equal(row.status, 'error');
  }
});

// ── 3. /audit/file-access ─────────────────────────────────────────────────

test('GET /audit/file-access?path_prefix=/home/jon → prefix filter', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/file-access?path_prefix=/home/jon');
  assert.equal(r.statusCode, 200);
  for (const row of r.body.rows) {
    assert.ok(row.path.startsWith('/home/jon'));
  }
});

// ── 4. /audit/credential-changes ──────────────────────────────────────────

test('GET /audit/credential-changes?credential_class=ops_key → class filter', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/credential-changes?credential_class=ops_key');
  assert.equal(r.statusCode, 200);
  for (const row of r.body.rows) {
    assert.equal(row.credential_class, 'ops_key');
  }
});

// ── 5. /audit/permission-changes ──────────────────────────────────────────

test('GET /audit/permission-changes?agent=agent-a → agent filter', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/permission-changes?agent=agent-a');
  assert.equal(r.statusCode, 200);
  for (const row of r.body.rows) {
    assert.equal(row.agent_id, 'agent-a');
  }
});

// ── 6. /audit/event/:event_id ─────────────────────────────────────────────

test('GET /audit/event/:event_id → 200 when present', async () => {
  // Insert one with known data; reuse its event_id from list
  const list = await request(app).get('/api/v1/plexus/public/audit/tool-invocations?limit=1');
  const eid = list.body.rows[0].event_id;
  const r = await request(app).get(`/api/v1/plexus/public/audit/event/${eid}`);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.event_id, eid);
  assert.ok(r.body.source_event_id === null || typeof r.body.source_event_id === 'number');
});

test('GET /audit/event/:event_id → 404 when missing', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/event/deadbeefcafebabe');
  assert.equal(r.statusCode, 404);
  assert.equal(r.body.error, 'NotFound');
});

// ── 7. /audit/agent-timeline ──────────────────────────────────────────────

test('GET /audit/agent-timeline?agent=agent-a → merges 4 classes, DESC', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/agent-timeline?agent=agent-a');
  assert.equal(r.statusCode, 200);
  // agent-a has 3 tool_invocations + 1 file_access + 1 cred_change + 1 perm_change = 6
  assert.ok(r.body.count >= 6);
  const classes = new Set(r.body.rows.map(x => x._class));
  assert.ok(classes.has('audit_tool_invocation'));
  assert.ok(classes.has('audit_file_access'));
  assert.ok(classes.has('audit_credential_change'));
  assert.ok(classes.has('audit_permission_change'));
  // DESC order
  for (let i = 1; i < r.body.rows.length; i++) {
    assert.ok(r.body.rows[i - 1].occurred_at >= r.body.rows[i].occurred_at);
  }
});

test('GET /audit/agent-timeline missing agent param → 400', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/agent-timeline');
  assert.equal(r.statusCode, 400);
});

// ── 8. /audit/by-control-area ─────────────────────────────────────────────

test('GET /audit/by-control-area?control_framework=soc2 → SOC2 control areas', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/by-control-area?control_framework=soc2&period=mtd');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.control_framework, 'soc2');
  const ids = r.body.control_areas.map(a => a.id);
  for (const want of ['CC1', 'CC2', 'CC6', 'CC7', 'CC8', 'CC9']) {
    assert.ok(ids.includes(want), `missing ${want}`);
  }
  // CC7 wraps tool_invocations + file_access → non-zero count
  const cc7 = r.body.control_areas.find(a => a.id === 'CC7');
  assert.ok(cc7.counts.total > 0);
});

test('GET /audit/by-control-area?control_framework=iso27001 → ISO control areas', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/by-control-area?control_framework=iso27001&period=mtd');
  assert.equal(r.statusCode, 200);
  const ids = r.body.control_areas.map(a => a.id);
  for (const want of ['A.5', 'A.8', 'A.9', 'A.12', 'A.13', 'A.16', 'A.18']) {
    assert.ok(ids.includes(want), `missing ${want}`);
  }
});

test('GET /audit/by-control-area?control_framework=gdpr → GDPR articles', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/by-control-area?control_framework=gdpr&period=mtd');
  assert.equal(r.statusCode, 200);
  const ids = r.body.control_areas.map(a => a.id);
  for (const want of ['Art.6', 'Art.15', 'Art.17', 'Art.30']) {
    assert.ok(ids.includes(want), `missing ${want}`);
  }
});

test('GET /audit/by-control-area?control_framework=invalid → 400', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/by-control-area?control_framework=hipaa');
  assert.equal(r.statusCode, 400);
});

// ── 9. /audit/anomaly-detail ──────────────────────────────────────────────

test('GET /audit/anomaly-detail → sorted DESC by policy_violation_count', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/anomaly-detail?period=mtd');
  assert.equal(r.statusCode, 200);
  assert.ok(Array.isArray(r.body.anomalies));
  for (let i = 1; i < r.body.anomalies.length; i++) {
    assert.ok(r.body.anomalies[i - 1].policy_violation_count >=
      r.body.anomalies[i].policy_violation_count);
  }
  // agent-a has 2 violations, agent-b has 1 → agent-a is first violator
  const violators = r.body.anomalies.filter(a => a.policy_violation_count > 0);
  assert.equal(violators[0].agent_id, 'agent-a');
});

// ── 10. /policy/rules ─────────────────────────────────────────────────────

test('GET /policy/rules → all rules', async () => {
  const r = await request(app).get('/api/v1/plexus/public/policy/rules');
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.count >= 4);
});

test('GET /policy/rules?status=active → active only', async () => {
  const r = await request(app).get('/api/v1/plexus/public/policy/rules?status=active');
  assert.equal(r.statusCode, 200);
  for (const rule of r.body.rules) {
    assert.equal(rule.status, 'active');
  }
});

test('GET /policy/rules?status=invalid → 400', async () => {
  const r = await request(app).get('/api/v1/plexus/public/policy/rules?status=bogus');
  assert.equal(r.statusCode, 400);
});

// ── 11. /policy/rules/:rule_id ────────────────────────────────────────────

test('GET /policy/rules/:rule_id → 200', async () => {
  const r = await request(app).get('/api/v1/plexus/public/policy/rules/no-secrets-yaklog');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.rule_id, 'no-secrets-yaklog');
});

test('GET /policy/rules/:unknown → 404', async () => {
  const r = await request(app).get('/api/v1/plexus/public/policy/rules/nope-not-a-rule');
  assert.equal(r.statusCode, 404);
  assert.equal(r.body.error, 'NotFound');
});

// ── 12. /policy/violations ────────────────────────────────────────────────

test('GET /policy/violations → returns rows with bizmodel R-A2 sort', async () => {
  const r = await request(app).get('/api/v1/plexus/public/policy/violations');
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.count >= 3);
  // pending first per helper sort
  assert.equal(r.body.rows[0].disposition, 'pending');
});

test('GET /policy/violations?rule_id=pii-in-broadcast → rule filter', async () => {
  const r = await request(app).get('/api/v1/plexus/public/policy/violations?rule_id=pii-in-broadcast');
  assert.equal(r.statusCode, 200);
  for (const row of r.body.rows) {
    assert.equal(row.rule_id, 'pii-in-broadcast');
  }
});

// ── 13. /policy/divergence ────────────────────────────────────────────────

test('GET /policy/divergence → counts struct', async () => {
  const r = await request(app).get('/api/v1/plexus/public/policy/divergence');
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.policies_codified >= 4);
  assert.ok(r.body.policies_active >= 2);  // no-secrets + pii
  assert.ok(r.body.policies_draft >= 1);   // draft-rule
  assert.ok(r.body.policies_deprecated >= 1);  // old-rule
  assert.equal(
    r.body.policies_codified,
    r.body.policies_active + r.body.policies_draft + r.body.policies_deprecated
  );
});

// ── 14. /audit/coverage-gap ───────────────────────────────────────────────

test('GET /audit/coverage-gap → finds presence-only agents (agent-d)', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/coverage-gap');
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.missing_agent_ids.includes('agent-d'));
  // agent-a + agent-b are wired up; should NOT be in missing list
  assert.ok(!r.body.missing_agent_ids.includes('agent-a'));
  assert.ok(!r.body.missing_agent_ids.includes('agent-b'));
  assert.equal(r.body.agents_missing_trail_7d, r.body.missing_agent_ids.length);
});

// ── 15. /audit/export ─────────────────────────────────────────────────────

test('GET /audit/export?format=csv&schema=generic → text/csv with attachment', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/export?format=csv&schema=generic&period=mtd');
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'], /text\/csv/);
  assert.match(r.headers['content-disposition'], /attachment.*audit-export-mtd\.csv/);
  const lines = r.text.trim().split('\n');
  assert.ok(lines[0].startsWith('event_id,agent_id,occurred_at,'));
  assert.ok(lines.length >= 2);  // header + at least 1 row
});

test('GET /audit/export?schema=soc2-bundle → 501 NotImplemented', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/export?schema=soc2-bundle');
  assert.equal(r.statusCode, 501);
  assert.equal(r.body.error, 'NotImplemented');
});

test('GET /audit/export?schema=iso27001-bundle / gdpr-dsar → 501', async () => {
  for (const schema of ['iso27001-bundle', 'gdpr-dsar']) {
    const r = await request(app).get(`/api/v1/plexus/public/audit/export?schema=${schema}`);
    assert.equal(r.statusCode, 501, `${schema} expected 501`);
  }
});

test('GET /audit/export?schema=unknown → 400', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/export?schema=mystery');
  assert.equal(r.statusCode, 400);
});

test('GET /audit/export → CSV escaping: comma + quote + newline preserved', async () => {
  // Insert a row whose status_detail contains nasty CSV characters via
  // tool_phase=failure path. status_detail is truncated to 200 by helper,
  // but our 60-char fixture fits below the cap so the escape path is what
  // gets exercised here.
  insertAuditToolInvocation({
    agent_id: 'agent-csv', tool_name: 'csv,"weird"\ntool', tool_phase: 'failure',
    status: 'error',
    status_detail: 'oh,no "danger"\nline2',
    occurred_at: iso(-100),
  });
  const r = await request(app).get('/api/v1/plexus/public/audit/export?format=csv&schema=generic&period=mtd');
  assert.equal(r.statusCode, 200);
  // The status_detail value must appear wrapped in quotes with doubled
  // quotes inside; tool_name similarly.
  assert.ok(r.text.includes('"oh,no ""danger""\nline2"') || r.text.includes('"oh,no ""danger""'),
    `expected escaped status_detail in: ${r.text.slice(0, 400)}`);
  assert.ok(r.text.includes('"csv,""weird""\ntool"') || r.text.includes('"csv,""weird""'),
    `expected escaped tool_name in: ${r.text.slice(0, 400)}`);
});

test('GET /audit/export?format=json&schema=generic → JSON payload', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/export?format=json&schema=generic&period=mtd');
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'], /application\/json/);
  assert.equal(r.body.schema, 'generic');
  assert.ok(Array.isArray(r.body.rows));
});

test('GET /audit/export?format=xml → 400 (unsupported format)', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/export?format=xml');
  assert.equal(r.statusCode, 400);
});
