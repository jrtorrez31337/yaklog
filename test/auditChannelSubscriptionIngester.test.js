// CP12.15 Phase 2: channel-subscription change history substrate + ingester.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-cp1215-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-x';
process.env.YAKLOG_OPS_API_KEYS = 'ops-y';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const {
  closeDb,
  insertAuditChannelSubscriptionChange,
  listAuditChannelSubscriptionChanges,
  processChannelSubscriptionScan,
  diffChannelSubscriptions,
} = require('../src/db');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// ── Pure diff ──────────────────────────────────────────────────────────

test('diffChannelSubscriptions: empty prior → all subscribes', () => {
  const d = diffChannelSubscriptions(null, [
    { agent_id: 'alpha', channels: ['handoff', 'status'] },
  ]);
  assert.equal(d.subscribes.length, 2);
  assert.equal(d.unsubscribes.length, 0);
});

test('diffChannelSubscriptions: identical → empty diff', () => {
  const same = [{ agent_id: 'alpha', channels: ['handoff'] }];
  const d = diffChannelSubscriptions(same, same);
  assert.equal(d.subscribes.length, 0);
  assert.equal(d.unsubscribes.length, 0);
});

test('diffChannelSubscriptions: agent added a channel → subscribe', () => {
  const prior = [{ agent_id: 'alpha', channels: ['handoff'] }];
  const current = [{ agent_id: 'alpha', channels: ['handoff', 'status'] }];
  const d = diffChannelSubscriptions(prior, current);
  assert.equal(d.subscribes.length, 1);
  assert.equal(d.subscribes[0].channel_name, 'status');
});

test('diffChannelSubscriptions: agent removed a channel → unsubscribe', () => {
  const prior = [{ agent_id: 'alpha', channels: ['handoff', 'status'] }];
  const current = [{ agent_id: 'alpha', channels: ['handoff'] }];
  const d = diffChannelSubscriptions(prior, current);
  assert.equal(d.unsubscribes.length, 1);
  assert.equal(d.unsubscribes[0].channel_name, 'status');
});

test('diffChannelSubscriptions: agent vanished → all channels unsubscribe', () => {
  const prior = [{ agent_id: 'beta', channels: ['handoff', 'status'] }];
  const current = [];
  const d = diffChannelSubscriptions(prior, current);
  assert.equal(d.unsubscribes.length, 2);
  assert.ok(d.unsubscribes.every(u => u.agent_id === 'beta'));
});

// ── insertAuditChannelSubscriptionChange validation ────────────────────

test('insertAuditChannelSubscriptionChange: persists row + computes event_id', () => {
  const r = insertAuditChannelSubscriptionChange({
    agent_id: 'gamma',
    change_type: 'subscribe',
    channel_name: 'handoff',
    actor: 'a'.repeat(16),
  });
  assert.ok(r.id > 0);
  assert.match(r.event_id, /^[a-f0-9]{16}$/);
});

test('insertAuditChannelSubscriptionChange: rejects bad change_type', () => {
  assert.throws(() => insertAuditChannelSubscriptionChange({
    agent_id: 'g', change_type: 'flip', channel_name: 'handoff', actor: 'a',
  }), /change_type must be/);
});

test('insertAuditChannelSubscriptionChange: rejects bad channel_name regex', () => {
  assert.throws(() => insertAuditChannelSubscriptionChange({
    agent_id: 'g', change_type: 'subscribe', channel_name: 'bad name!', actor: 'a',
  }), /channel_name must match/);
});

// ── processChannelSubscriptionScan e2e ─────────────────────────────────

test('processChannelSubscriptionScan: first-scan silent baseline', () => {
  const before = listAuditChannelSubscriptionChanges({}).length;
  const r = processChannelSubscriptionScan({
    subscriptions: [
      { agent_id: 'scan-a', channels: ['handoff', 'status'], source_path: '/home/scan-a/.config/yaklog/channels' },
      { agent_id: 'scan-b', channels: ['aieng'], source_path: '/home/scan-b/.config/yaklog/channels' },
    ],
    actor: 'cp1215-test',
  });
  assert.equal(r.first_scan, true);
  assert.equal(r.subscriptions_count, 2);
  assert.equal(r.total_emitted, 0);
  assert.equal(listAuditChannelSubscriptionChanges({}).length, before);
});

test('processChannelSubscriptionScan: second-scan emits subscribe + unsubscribe diffs', () => {
  const before = listAuditChannelSubscriptionChanges({}).length;
  const r = processChannelSubscriptionScan({
    subscriptions: [
      // scan-a: gained 'aieng', lost 'status'
      { agent_id: 'scan-a', channels: ['handoff', 'aieng'], source_path: '/home/scan-a/.config/yaklog/channels' },
      // scan-b: unchanged
      { agent_id: 'scan-b', channels: ['aieng'], source_path: '/home/scan-b/.config/yaklog/channels' },
    ],
    actor: 'cp1215-test',
  });
  assert.equal(r.first_scan, false);
  assert.equal(r.subscribes, 1);
  assert.equal(r.unsubscribes, 1);
  assert.equal(r.total_emitted, 2);
  const after = listAuditChannelSubscriptionChanges({});
  assert.equal(after.length, before + 2);
});

test('processChannelSubscriptionScan: third-scan idempotent', () => {
  const before = listAuditChannelSubscriptionChanges({}).length;
  const r = processChannelSubscriptionScan({
    subscriptions: [
      { agent_id: 'scan-a', channels: ['handoff', 'aieng'] },
      { agent_id: 'scan-b', channels: ['aieng'] },
    ],
    actor: 'cp1215-test',
  });
  assert.equal(r.total_emitted, 0);
  assert.equal(listAuditChannelSubscriptionChanges({}).length, before);
});

test('processChannelSubscriptionScan: drops malformed subscription rows', () => {
  // Pre-scan baseline exists; bad rows should be ignored without changing state.
  const before = listAuditChannelSubscriptionChanges({}).length;
  const r = processChannelSubscriptionScan({
    subscriptions: [
      // valid
      { agent_id: 'scan-a', channels: ['handoff', 'aieng'] },
      { agent_id: 'scan-b', channels: ['aieng'] },
      // bad: malformed channel name
      { agent_id: 'scan-c', channels: ['bad name!'] },
      // bad: channels not array
      { agent_id: 'scan-d', channels: 'handoff' },
    ],
    actor: 'cp1215-test',
  });
  // Only the 2 valid + already-known rows survive; should be a no-op diff.
  assert.equal(r.total_emitted, 0);
  assert.equal(listAuditChannelSubscriptionChanges({}).length, before);
});

test('processChannelSubscriptionScan: validates actor required', () => {
  assert.throws(() => processChannelSubscriptionScan({ subscriptions: [] }),
    /actor.+required/);
});

// ── HTTP endpoints ──────────────────────────────────────────────────────

test('GET /audit/channel-subscriptions: lists recent rows', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/channel-subscriptions');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.rows));
  assert.ok(r.body.count >= 2);  // from second-scan diff
});

test('GET /audit/channel-subscriptions: filters by agent', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/channel-subscriptions?agent=scan-a');
  assert.equal(r.status, 200);
  assert.ok(r.body.rows.every(x => x.agent_id === 'scan-a'));
});

test('GET /audit/channel-subscriptions: filters by channel', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/channel-subscriptions?channel=status');
  assert.equal(r.status, 200);
  assert.ok(r.body.rows.every(x => x.channel_name === 'status'));
});

test('POST /ops/audit/channel-subscription/scan: requires ops-key', async () => {
  const r = await request(app)
    .post('/api/v1/ops/audit/channel-subscription/scan')
    .set('Content-Type', 'application/json')
    .send({ subscriptions: [] });
  assert.ok(r.status === 401 || r.status === 403);
});

test('POST /ops/audit/channel-subscription/scan: end-to-end ops-gated', async () => {
  const r = await request(app)
    .post('/api/v1/ops/audit/channel-subscription/scan')
    .set('Authorization', 'Bearer ops-y')
    .set('Content-Type', 'application/json')
    .send({
      subscriptions: [
        { agent_id: 'scan-a', channels: ['handoff', 'aieng'] },
        { agent_id: 'scan-b', channels: ['aieng'] },
      ],
    });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  // idempotent re-scan; total_emitted=0 since data unchanged
  assert.equal(r.body.total_emitted, 0);
});

test('POST /ops/audit/channel-subscription/scan: 400 on bad shape', async () => {
  const r = await request(app)
    .post('/api/v1/ops/audit/channel-subscription/scan')
    .set('Authorization', 'Bearer ops-y')
    .set('Content-Type', 'application/json')
    .send({ subscriptions: 'not-an-array' });
  assert.equal(r.status, 400);
});

// ── by-control-area wiring ─────────────────────────────────────────────

test('by-control-area: CC6 + A.9 include audit_channel_subscription_change', async () => {
  const r1 = await request(app).get('/api/v1/plexus/public/audit/by-control-area?control_framework=soc2');
  const cc6 = r1.body.control_areas.find(a => a.id === 'CC6');
  assert.ok(cc6.audit_object_classes.includes('audit_channel_subscription_change'),
    'CC6 must include audit_channel_subscription_change');

  const r2 = await request(app).get('/api/v1/plexus/public/audit/by-control-area?control_framework=iso27001');
  const a9 = r2.body.control_areas.find(a => a.id === 'A.9');
  assert.ok(a9.audit_object_classes.includes('audit_channel_subscription_change'),
    'A.9 must include audit_channel_subscription_change');
});

// CP12.A (parch #8011 Gate 2 RATIFIED + bizmodel #8008 positional): channels
// ARE the cluster's primary inter-agent communication substrate; mapping to
// CC2 alongside the existing audit_attestation governance-tier substrate is
// aspectually clean (same event in CC6 + CC2 since channels are both
// access-control and communication infrastructure).
test('by-control-area: CC2 enrichment with audit_channel_subscription_change', async () => {
  const r = await request(app).get('/api/v1/plexus/public/audit/by-control-area?control_framework=soc2');
  const cc2 = r.body.control_areas.find(a => a.id === 'CC2');
  assert.ok(cc2.audit_object_classes.includes('audit_attestation'),
    'CC2 must retain audit_attestation (CP12.10)');
  assert.ok(cc2.audit_object_classes.includes('audit_channel_subscription_change'),
    'CC2 must include audit_channel_subscription_change (CP12.A enrichment)');
});
