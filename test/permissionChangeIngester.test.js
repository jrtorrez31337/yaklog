// CP12.8 Phase 2 admin-R4 source-coverage: permission-change scan processor
// + diff function. Mirror of credentialChangeIngester.test.js for Phase B.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-cp128-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-x';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

require('../src/app'); // init schema
const {
  closeDb,
  processPermissionScan,
  diffPermissionSources,
  listAuditPermissionChanges,
} = require('../src/db');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

const fp = (s) => 'a'.repeat(16).substring(0, 8) + s.padEnd(8, '0');
function src(cls, p, agent, fingerprint) {
  return { source_class: cls, source_path: p, agent_id: agent, fingerprint };
}

// ─── Pure diff ──────────────────────────────────────────────────────────

test('diffPermissionSources: empty prior → all adds', () => {
  const current = [
    src('settings.local.json', '/a', 'agent1', '1111111111111111'),
    src('authorized_keys', '/b', 'user1', '2222222222222222'),
  ];
  const d = diffPermissionSources(null, current);
  assert.equal(d.adds.length, 2);
  assert.equal(d.modifies.length, 0);
  assert.equal(d.removes.length, 0);
});

test('diffPermissionSources: identical → empty diff', () => {
  const set = [src('settings.local.json', '/a', 'agent1', '1111111111111111')];
  const d = diffPermissionSources(set, set);
  assert.equal(d.adds.length, 0);
  assert.equal(d.modifies.length, 0);
  assert.equal(d.removes.length, 0);
});

test('diffPermissionSources: same identity new fingerprint → modify', () => {
  const prior = [src('settings.local.json', '/a', 'agent1', '1111111111111111')];
  const current = [src('settings.local.json', '/a', 'agent1', 'AAAAAAAAAAAAAAAA'.toLowerCase())];
  const d = diffPermissionSources(prior, current);
  assert.equal(d.adds.length, 0);
  assert.equal(d.modifies.length, 1);
  assert.equal(d.modifies[0].prior_fingerprint, '1111111111111111');
  assert.equal(d.removes.length, 0);
});

test('diffPermissionSources: removed identity → remove', () => {
  const prior = [
    src('settings.local.json', '/a', 'agent1', '1111111111111111'),
    src('authorized_keys', '/b', 'user1', '2222222222222222'),
  ];
  const current = [src('settings.local.json', '/a', 'agent1', '1111111111111111')];
  const d = diffPermissionSources(prior, current);
  assert.equal(d.adds.length, 0);
  assert.equal(d.modifies.length, 0);
  assert.equal(d.removes.length, 1);
  assert.equal(d.removes[0].source_path, '/b');
});

test('diffPermissionSources: distinct agent_ids on same path counted separately', () => {
  // Path is part of the identity key; same path with two agent_ids
  // counts as two separate rows (catches systemd override per-agent variants).
  const prior = [];
  const current = [
    src('systemd-override', '/etc/x.conf', 'a', '1111111111111111'),
    src('systemd-override', '/etc/x.conf', 'b', '2222222222222222'),
  ];
  const d = diffPermissionSources(prior, current);
  assert.equal(d.adds.length, 2);
});

// ─── processPermissionScan e2e ──────────────────────────────────────────

test('processPermissionScan: first-scan silent (no audit_permission_change rows)', () => {
  const before = listAuditPermissionChanges({}).length;
  const r = processPermissionScan({
    sources: [
      src('settings.local.json', '/home/jon/x', 'yaklog-dev-agent', '1111111111111111'),
      src('authorized_keys', '/home/jon/.ssh/authorized_keys', 'jon', '2222222222222222'),
    ],
    actor: 'cp128-test',
  });
  assert.equal(r.first_scan, true);
  assert.equal(r.sources_count, 2);
  assert.equal(r.total_emitted, 0);
  assert.equal(listAuditPermissionChanges({}).length, before);
});

test('processPermissionScan: second-scan with diff emits add+modify+remove', () => {
  const before = listAuditPermissionChanges({}).length;
  const r = processPermissionScan({
    sources: [
      // settings unchanged
      src('settings.local.json', '/home/jon/x', 'yaklog-dev-agent', '1111111111111111'),
      // authorized_keys modified (different fingerprint)
      src('authorized_keys', '/home/jon/.ssh/authorized_keys', 'jon', 'cccccccccccccccc'),
      // new gh hosts.yml (add)
      src('gh-hosts.yml', '/home/jon/.config/gh/hosts.yml', 'jon', 'dddddddddddddddd'),
    ],
    actor: 'cp128-test',
  });
  assert.equal(r.first_scan, false);
  assert.equal(r.adds, 1);
  assert.equal(r.modifies, 1);
  assert.equal(r.removes, 0);
  assert.equal(r.total_emitted, 2);
  const after = listAuditPermissionChanges({});
  assert.equal(after.length, before + 2);
  const adds = after.filter(r => r.change_type === 'add');
  const mods = after.filter(r => r.change_type === 'modify');
  assert.equal(adds.length, 1);
  assert.equal(mods.length, 1);
  assert.equal(adds[0].source_path, '/home/jon/.config/gh/hosts.yml');
  assert.equal(mods[0].source_path, '/home/jon/.ssh/authorized_keys');
});

test('processPermissionScan: third-scan idempotent (no diff → zero emit)', () => {
  const before = listAuditPermissionChanges({}).length;
  const r = processPermissionScan({
    sources: [
      src('settings.local.json', '/home/jon/x', 'yaklog-dev-agent', '1111111111111111'),
      src('authorized_keys', '/home/jon/.ssh/authorized_keys', 'jon', 'cccccccccccccccc'),
      src('gh-hosts.yml', '/home/jon/.config/gh/hosts.yml', 'jon', 'dddddddddddddddd'),
    ],
    actor: 'cp128-test',
  });
  assert.equal(r.first_scan, false);
  assert.equal(r.total_emitted, 0);
  assert.equal(listAuditPermissionChanges({}).length, before);
});

test('processPermissionScan: removed source emits remove event', () => {
  const before = listAuditPermissionChanges({}).length;
  const r = processPermissionScan({
    sources: [
      src('settings.local.json', '/home/jon/x', 'yaklog-dev-agent', '1111111111111111'),
      // dropped: authorized_keys + gh-hosts.yml
    ],
    actor: 'cp128-test',
  });
  assert.equal(r.removes, 2);
  assert.equal(r.adds, 0);
  assert.equal(r.modifies, 0);
  assert.equal(r.total_emitted, 2);
  const after = listAuditPermissionChanges({});
  const removes = after.filter(r => r.change_type === 'remove');
  assert.equal(removes.length, 2);
});

test('processPermissionScan: rejects malformed source rows (silently drops)', () => {
  const before = listAuditPermissionChanges({}).length;
  const r = processPermissionScan({
    sources: [
      // valid
      src('settings.local.json', '/home/jon/x', 'yaklog-dev-agent', '1111111111111111'),
      // invalid: bad source_class
      { source_class: 'unknown-class', source_path: '/x', agent_id: 'a', fingerprint: '1111111111111111' },
      // invalid: bad fingerprint shape
      { source_class: 'settings.local.json', source_path: '/x', agent_id: 'a', fingerprint: 'too-short' },
      // invalid: missing field
      { source_class: 'settings.local.json', source_path: '/x', agent_id: 'a' },
    ],
    actor: 'cp128-test',
  });
  // No diff vs prior (which has the valid entry already) — should emit 0
  assert.equal(r.total_emitted, 0);
  assert.equal(listAuditPermissionChanges({}).length, before);
});

test('processPermissionScan: validates actor required', () => {
  assert.throws(() =>
    processPermissionScan({ sources: [], /* missing actor */ }),
    /actor.+required/i
  );
});

test('processPermissionScan: validates sources array required', () => {
  assert.throws(() =>
    processPermissionScan({ sources: null, actor: 'cp128-test' }),
    /sources array required/i
  );
});
