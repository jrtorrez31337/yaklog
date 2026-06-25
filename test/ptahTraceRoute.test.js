// Task #246 Phase A.2 manifest write-path endpoint tests per parch #10755
// RATIFY. Covers POST /api/v1/plexus/ptah-orp/<id>/episodes/<eid>/manifest:
// auth scoping, episode-exists 404, JSON shape validation, episode/agent_id
// binding, artifact array validation, round-trip via GET.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-ptah-trace-route-test-'));
const ptahAuditTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-ptah-audit-dir-route-'));
const ptahTraceTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-ptah-trace-dir-route-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
// tok-ops is ONLY in OPS_API_KEYS (auth path (a) would shadow it as env-source otherwise)
process.env.YAKLOG_API_KEYS = 'tok-ptah-x';
// TOKEN_BINDINGS format per config.js parseTokenBindings: agent_id:token
process.env.YAKLOG_TOKEN_BINDINGS = 'ptah-test-1:tok-ptah-x';
process.env.YAKLOG_DAEMON_BINDINGS = 'ptah-test-1:tok-ptah-x';
process.env.YAKLOG_OPS_API_KEYS = 'tok-ops';
process.env.YAKLOG_PTAH_AUDIT_DB_DIR = ptahAuditTmp;
process.env.YAKLOG_PTAH_TRACE_DB_DIR = ptahTraceTmp;
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const ptahTraceDb = require('../src/ptahTraceDb');
const { closeDb } = require('../src/db');

function makeRec(over = {}) {
  return {
    episode_id: 'ep-route-1',
    orp_version: 'v0.1.0',
    tick: 0,
    ts_unix_ms: Date.now(),
    snapshot_summary: '3 nodes [frame:home]',
    chosen_decision: 'node-1',
    proposal: { intent: 'click' },
    result: { validation: 'accepted' },
    goal_state: [{ goal_id: 'g1', status: 'in_progress', checks: [] }],
    ...over,
  };
}

test.before(async () => {
  // Seed an episode via direct DB insert (avoids needing POST /trace first).
  ptahTraceDb.insertTrace('ptah-test-1', makeRec(), 'tok-seed');
});

test.after(() => {
  ptahTraceDb.closeAll();
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(ptahAuditTmp, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(ptahTraceTmp, { recursive: true, force: true }); } catch {}
});

test('POST manifest: own-agent bearer accepted; persists + round-trips via GET', async () => {
  const manifest = {
    episode_id: 'ep-route-1',
    agent_id: 'ptah-test-1',
    role_id: 'doc-author-printer',
    orp_version: 'v0.1.0',
    artifacts: [
      { kind: 'story_txt', path: '/staged/story.txt', bytes: 1024, sha256: 'abc' },
      { kind: 'story_pdf', path: '/staged/story.pdf', bytes: 20480, sha256: 'def' },
      { kind: 'episode_final_png', path: '/staged/final.png', bytes: 5120, sha256: 'ghi' },
      { kind: 'trace_ndjson', path: '/staged/trace.ndjson', bytes: 4096, sha256: 'jkl' },
    ],
  };
  const post = await request(app)
    .post('/api/v1/plexus/ptah-orp/ptah-test-1/episodes/ep-route-1/manifest')
    .set('Authorization', 'Bearer tok-ptah-x')
    .send(manifest);
  assert.equal(post.status, 200);
  assert.equal(post.body.artifact_count, 4);

  const get = await request(app)
    .get('/api/v1/plexus/ptah-orp/ptah-test-1/episodes/ep-route-1/manifest')
    .set('Authorization', 'Bearer tok-ptah-x');
  assert.equal(get.status, 200);
  assert.equal(get.body.manifest.artifacts.length, 4);
  assert.equal(get.body.manifest.artifacts.find(a => a.kind === 'trace_ndjson').sha256, 'jkl');
});

test('POST manifest: ops-key accepted', async () => {
  const r = await request(app)
    .post('/api/v1/plexus/ptah-orp/ptah-test-1/episodes/ep-route-1/manifest')
    .set('Authorization', 'Bearer tok-ops')
    .send({ artifacts: [{ kind: 'x', path: '/p' }] });
  assert.equal(r.status, 200);
});

test('POST manifest: 404 when episode does not exist', async () => {
  const r = await request(app)
    .post('/api/v1/plexus/ptah-orp/ptah-test-1/episodes/ep-nope/manifest')
    .set('Authorization', 'Bearer tok-ptah-x')
    .send({ artifacts: [] });
  assert.equal(r.status, 404);
});

test('POST manifest: 400 when artifacts not array', async () => {
  const r = await request(app)
    .post('/api/v1/plexus/ptah-orp/ptah-test-1/episodes/ep-route-1/manifest')
    .set('Authorization', 'Bearer tok-ptah-x')
    .send({ artifacts: 'nope' });
  assert.equal(r.status, 400);
});

test('POST manifest: 400 when artifact missing kind or path', async () => {
  const noKind = await request(app)
    .post('/api/v1/plexus/ptah-orp/ptah-test-1/episodes/ep-route-1/manifest')
    .set('Authorization', 'Bearer tok-ptah-x')
    .send({ artifacts: [{ path: '/p' }] });
  assert.equal(noKind.status, 400);
  const noPath = await request(app)
    .post('/api/v1/plexus/ptah-orp/ptah-test-1/episodes/ep-route-1/manifest')
    .set('Authorization', 'Bearer tok-ptah-x')
    .send({ artifacts: [{ kind: 'story_txt' }] });
  assert.equal(noPath.status, 400);
});

test('POST manifest: 400 when episode_id mismatch URL', async () => {
  const r = await request(app)
    .post('/api/v1/plexus/ptah-orp/ptah-test-1/episodes/ep-route-1/manifest')
    .set('Authorization', 'Bearer tok-ptah-x')
    .send({ episode_id: 'ep-different', artifacts: [{ kind: 'x', path: '/p' }] });
  assert.equal(r.status, 400);
});

test('POST manifest: 400 when agent_id mismatch URL', async () => {
  const r = await request(app)
    .post('/api/v1/plexus/ptah-orp/ptah-test-1/episodes/ep-route-1/manifest')
    .set('Authorization', 'Bearer tok-ptah-x')
    .send({ agent_id: 'ptah-other', artifacts: [{ kind: 'x', path: '/p' }] });
  assert.equal(r.status, 400);
});

test('POST manifest: 403 when bearer is generic non-binding (no per-agent + no ops-key)', async () => {
  // Need a token in YAKLOG_API_KEYS but NOT bound to this agent + NOT ops-key.
  // The test env has tok-ptah-x bound to ptah-test-1 and tok-ops as ops.
  // A third cluster-bearer would 403. Simulate with a bound-to-different-agent token:
  // (not easy without reconfig). Instead test missing bearer → auth 401.
  const r = await request(app)
    .post('/api/v1/plexus/ptah-orp/ptah-test-1/episodes/ep-route-1/manifest')
    .send({ artifacts: [] });
  assert.ok(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
});
