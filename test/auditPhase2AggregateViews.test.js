// CP12.13 Phase 2 aggregate views: registration-timeline + cluster summary
// + credential-rotation-aggregate + adr-change-history.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-cp1213-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-x';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const {
  closeDb,
  insertRegistrationEvent,
  insertAuditCredentialChange,
  aggregateRegistrationEventsByAgent,
  listRegistrationEventsByAgent,
  aggregateCredentialChanges,
} = require('../src/db');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// ── seed substrate ──────────────────────────────────────────────────────

function seed() {
  insertRegistrationEvent({
    registration_id: 'r-alpha', agent_id: 'alpha-agent', event_type: 'mint', actor: 'admin',
  });
  insertRegistrationEvent({
    registration_id: 'r-alpha', agent_id: 'alpha-agent', event_type: 'ratify', actor: 'jon',
  });
  insertRegistrationEvent({
    registration_id: 'r-alpha', agent_id: 'alpha-agent', event_type: 'activate', actor: 'admin',
  });
  insertRegistrationEvent({
    registration_id: 'r-beta', agent_id: 'beta-agent', event_type: 'mint', actor: 'admin',
  });
  insertRegistrationEvent({
    registration_id: 'r-beta', agent_id: 'beta-agent', event_type: 'revoke', actor: 'admin',
  });

  insertAuditCredentialChange({
    credential_class: 'api_key', change_type: 'mint', actor: 'admin', rule_text: 'tok-a',
  });
  insertAuditCredentialChange({
    credential_class: 'api_key', change_type: 'rotate', actor: 'admin', rule_text: 'tok-b',
  });
  insertAuditCredentialChange({
    credential_class: 'ops_key', change_type: 'mint', actor: 'secops', rule_text: 'ops-a',
  });
}

// ── pure helpers ───────────────────────────────────────────────────────

test('listRegistrationEventsByAgent: filters by agent_id, DESC by ts', () => {
  seed();
  const ev = listRegistrationEventsByAgent('alpha-agent');
  assert.equal(ev.length, 3);
  assert.ok(ev.every(e => e.agent_id === 'alpha-agent'));
  // DESC: ts[0] >= ts[1] >= ts[2]
  assert.ok(ev[0].ts >= ev[1].ts);
  assert.ok(ev[1].ts >= ev[2].ts);
});

test('aggregateRegistrationEventsByAgent: groups by agent + event_type', () => {
  const rows = aggregateRegistrationEventsByAgent({});
  const alphaMint = rows.find(r => r.agent_id === 'alpha-agent' && r.event_type === 'mint');
  const betaRevoke = rows.find(r => r.agent_id === 'beta-agent' && r.event_type === 'revoke');
  assert.equal(alphaMint.count, 1);
  assert.equal(betaRevoke.count, 1);
});

test('aggregateCredentialChanges: groups by credential_class', () => {
  const rows = aggregateCredentialChanges({ group_by: 'credential_class' });
  const apiKey = rows.find(r => r.bucket === 'api_key');
  const opsKey = rows.find(r => r.bucket === 'ops_key');
  assert.equal(apiKey.count, 2);
  assert.equal(opsKey.count, 1);
});

test('aggregateCredentialChanges: groups by change_type', () => {
  const rows = aggregateCredentialChanges({ group_by: 'change_type' });
  const mint = rows.find(r => r.bucket === 'mint');
  assert.equal(mint.count, 2);
});

test('aggregateCredentialChanges: rejects unknown group_by', () => {
  assert.throws(() => aggregateCredentialChanges({ group_by: 'bogus' }),
    /group_by must be/);
});

// ── HTTP endpoints ─────────────────────────────────────────────────────

test('GET /audit/registration-timeline: 400 without agent_id', async () => {
  const r = await request(app).get('/api/v1/yaklog/public/audit/registration-timeline');
  assert.equal(r.status, 400);
  assert.match(r.body.message, /agent_id/);
});

test('GET /audit/registration-timeline: returns events + transitions for agent', async () => {
  const r = await request(app)
    .get('/api/v1/yaklog/public/audit/registration-timeline?agent_id=alpha-agent');
  assert.equal(r.status, 200);
  assert.equal(r.body.agent_id, 'alpha-agent');
  assert.equal(r.body.count, 3);
  assert.equal(r.body.events.length, 3);
  assert.equal(r.body.transitions.length, 3);
  // First transition has no `from` (ascending order)
  assert.equal(r.body.transitions[0].from, null);
  assert.equal(r.body.transitions[0].to, 'mint');
  // Last transition is the most recent event
  assert.equal(r.body.transitions[2].to, 'activate');
});

test('GET /audit/registration-timeline-summary: aggregates across agents', async () => {
  const r = await request(app)
    .get('/api/v1/yaklog/public/audit/registration-timeline-summary');
  assert.equal(r.status, 200);
  assert.ok(r.body.agent_count >= 2);
  const alpha = r.body.agents.find(a => a.agent_id === 'alpha-agent');
  const beta = r.body.agents.find(a => a.agent_id === 'beta-agent');
  assert.equal(alpha.total, 3);
  assert.equal(alpha.by_event_type.mint, 1);
  assert.equal(alpha.by_event_type.ratify, 1);
  assert.equal(alpha.by_event_type.activate, 1);
  assert.equal(beta.total, 2);
});

test('GET /audit/credential-rotation-aggregate: default group_by=credential_class', async () => {
  const r = await request(app)
    .get('/api/v1/yaklog/public/audit/credential-rotation-aggregate');
  assert.equal(r.status, 200);
  assert.equal(r.body.group_by, 'credential_class');
  assert.equal(r.body.total, 3);
  const apiKey = r.body.buckets.find(b => b.bucket === 'api_key');
  assert.equal(apiKey.count, 2);
});

test('GET /audit/credential-rotation-aggregate: group_by=change_type', async () => {
  const r = await request(app)
    .get('/api/v1/yaklog/public/audit/credential-rotation-aggregate?group_by=change_type');
  assert.equal(r.status, 200);
  assert.equal(r.body.group_by, 'change_type');
  const mint = r.body.buckets.find(b => b.bucket === 'mint');
  const rotate = r.body.buckets.find(b => b.bucket === 'rotate');
  assert.equal(mint.count, 2);
  assert.equal(rotate.count, 1);
});

test('GET /audit/credential-rotation-aggregate: 400 on unknown group_by', async () => {
  const r = await request(app)
    .get('/api/v1/yaklog/public/audit/credential-rotation-aggregate?group_by=invalid');
  assert.equal(r.status, 400);
});

test('GET /audit/adr-change-history: 400 on disallowed repo', async () => {
  const r = await request(app)
    .get('/api/v1/yaklog/public/audit/adr-change-history?repo=evil-repo');
  assert.equal(r.status, 400);
  assert.match(r.body.message, /repo must be/);
});

test('GET /audit/adr-change-history: returns commits array with shape (agent-specs repo)', async () => {
  const r = await request(app)
    .get('/api/v1/yaklog/public/audit/adr-change-history?repo=agent-specs&limit=10');
  // 200 if bare repo accessible; 503 if not (test env may not have /srv/git)
  assert.ok(r.status === 200 || r.status === 503,
    `expected 200 or 503 got ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  assert.equal(r.body.repo, 'agent-specs');
  assert.ok(Array.isArray(r.body.commits));
  if (r.status === 200 && r.body.commits.length > 0) {
    const c = r.body.commits[0];
    assert.match(c.sha, /^[0-9a-f]{40}$/);
    assert.match(c.ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(typeof c.author === 'string');
    assert.ok(typeof c.subject === 'string');
    assert.ok(Array.isArray(c.files));
    assert.ok(c.files.length > 0, 'committed files filter must keep only ADR-touching commits');
  }
});
