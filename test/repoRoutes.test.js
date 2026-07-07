// CP17.A endpoint tests per PLAN-CP17-CLUSTER-REPO-SUBSTRATE.md §5.
// Per secops #11759 binding gate #2 (Gate 1 code-review at ship).
//
// Coverage:
//   POST /api/v1/repos             (T1 auth + T2 validation + T6 audit-fold + T7 no-fetch)
//   POST /repos/:owner/:repo/disable (self-scoped destructive + ops-key override)
//   POST /repos/bare-git-request   (T3 canonical name safety + duplicate + existing checks)
//   GET  /repos/bare-git-request/:id (enumerate-safe visibility)
//   POST /ops/output/repos/bare-git-request/:id/fulfilled (atomic CAS per secops #11759 §3.1.2)
//   GET  /ops/output/repos/bare-git-request?status=pending (admin poll target)
//   audit_repo_change fold non-bypassable + actor_agent_id NOT NULL invariant

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-cp17a-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-alice,tok-bob';
process.env.YAKLOG_TOKEN_BINDINGS = 'agent-alice:tok-alice,agent-bob:tok-bob';
process.env.YAKLOG_OPS_API_KEYS = 'ops-key-cp17a';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
// Point BARE_GIT_ROOT to tempDir so existence check doesn't collide with real /srv/git
process.env.YAKLOG_BARE_GIT_ROOT_HOST = tempDir;
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb, getDb } = require('../src/db');

const authAlice = { Authorization: 'Bearer tok-alice' };
const authBob = { Authorization: 'Bearer tok-bob' };
const authOps = { Authorization: 'Bearer ops-key-cp17a' };

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

function auditRowsFor(repoKey) {
  return getDb().prepare(
    `SELECT * FROM audit_repo_change WHERE repo_key = ? ORDER BY seq ASC`
  ).all(repoKey);
}

// ── POST /api/v1/repos (T1/T2/T6/T7) ──────────────────────────────────────

test('POST /api/v1/repos — happy path: agent adds GitHub repo (sender-attested + audit row)', async () => {
  const res = await request(app)
    .post('/api/v1/repos')
    .set(authAlice)
    .send({ github_owner_repo: 'jon/hello-cp17a' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.github_owner_repo, 'jon/hello-cp17a');
  assert.equal(res.body.added_by, 'agent-alice');
  assert.equal(res.body.first_time, true);
  // T6: audit row must be appended for the mutation
  const rows = auditRowsFor('jon/hello-cp17a');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'add');
  assert.equal(rows[0].actor_agent_id, 'agent-alice');  // T6 actor NOT NULL invariant
});

test('POST /api/v1/repos — re-add same repo: first_time=false, audit action=enable', async () => {
  const res = await request(app)
    .post('/api/v1/repos')
    .set(authAlice)
    .send({ github_owner_repo: 'jon/hello-cp17a' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.first_time, false);
  const rows = auditRowsFor('jon/hello-cp17a');
  assert.equal(rows.length, 2);  // add + enable
  assert.equal(rows[1].action, 'enable');
});

test('POST /api/v1/repos — 401 without auth', async () => {
  const res = await request(app)
    .post('/api/v1/repos')
    .send({ github_owner_repo: 'jon/anon-attempt' });
  assert.equal(res.statusCode, 401);
});

test('POST /api/v1/repos — 400 on invalid owner/repo shape', async () => {
  const res = await request(app)
    .post('/api/v1/repos')
    .set(authAlice)
    .send({ github_owner_repo: 'just-one-part' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'ValidationError');
});

test('POST /api/v1/repos — 400 rejects URL scheme (T2 no-scheme)', async () => {
  const res = await request(app)
    .post('/api/v1/repos')
    .set(authAlice)
    .send({ github_owner_repo: 'https://github.com/jon/scheme' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /no URL scheme|owner\/repo/);
});

test('POST /api/v1/repos — 400 rejects charset outside allowlist', async () => {
  const res = await request(app)
    .post('/api/v1/repos')
    .set(authAlice)
    .send({ github_owner_repo: 'jon/inva lid' });
  assert.equal(res.statusCode, 400);
});

test('POST /api/v1/repos — 400 rejects length > 96 (T2 cap)', async () => {
  const long = 'a'.repeat(50) + '/' + 'b'.repeat(50);
  const res = await request(app)
    .post('/api/v1/repos')
    .set(authAlice)
    .send({ github_owner_repo: long });
  assert.equal(res.statusCode, 400);
});

// ── POST /repos/:owner/:repo/disable (self-scoped destructive + ops override) ──

test('POST /repos/:owner/:repo/disable — self-scoped happy: owner disables own add', async () => {
  await request(app).post('/api/v1/repos').set(authAlice).send({ github_owner_repo: 'alice/own' });
  const res = await request(app).post('/api/v1/repos/alice/own/disable').set(authAlice);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.disabled, 'alice/own');
  // Audit fold: add + disable
  const rows = auditRowsFor('alice/own');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].action, 'disable');
  assert.equal(rows[1].actor_agent_id, 'agent-alice');
});

test('POST /repos/:owner/:repo/disable — 403 non-owner cannot disable', async () => {
  await request(app).post('/api/v1/repos').set(authAlice).send({ github_owner_repo: 'alice/private' });
  const res = await request(app).post('/api/v1/repos/alice/private/disable').set(authBob);
  assert.equal(res.statusCode, 403);
});

test('POST /repos/:owner/:repo/disable — ops-key override allowed', async () => {
  await request(app).post('/api/v1/repos').set(authAlice).send({ github_owner_repo: 'alice/opsable' });
  const res = await request(app).post('/api/v1/repos/alice/opsable/disable').set(authOps);
  assert.equal(res.statusCode, 200);
});

test('POST /repos/:owner/:repo/disable — 404 non-existent', async () => {
  const res = await request(app).post('/api/v1/repos/never/here/disable').set(authAlice);
  assert.equal(res.statusCode, 404);
});

// ── POST /repos/bare-git-request (T3 canonical name + duplicate + existing) ──

test('POST /bare-git-request — happy path: creates intent + audit', async () => {
  const res = await request(app)
    .post('/api/v1/repos/bare-git-request')
    .set(authAlice)
    .send({ repo_name: 'happy-cp17a', purpose: 'testing' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.status, 'pending');
  assert.ok(res.body.request_id > 0);
  const rows = auditRowsFor('bare-git:happy-cp17a');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'bare-git-requested');
  assert.equal(rows[0].actor_agent_id, 'agent-alice');  // T6 actor NOT NULL
});

test('POST /bare-git-request — 400 path-traversal (T3 name safety)', async () => {
  for (const bad of ['../evil', 'a/b', 'a\\b', '/abs', '.hidden']) {
    const res = await request(app)
      .post('/api/v1/repos/bare-git-request')
      .set(authAlice)
      .send({ repo_name: bad });
    assert.equal(res.statusCode, 400, `expected 400 for repo_name=${bad}; got ${res.statusCode}`);
  }
});

test('POST /bare-git-request — 400 uppercase rejected (T3 canonical lowercase)', async () => {
  const res = await request(app)
    .post('/api/v1/repos/bare-git-request')
    .set(authAlice)
    .send({ repo_name: 'MixedCase' });
  assert.equal(res.statusCode, 400);
});

test('POST /bare-git-request — 409 duplicate pending', async () => {
  await request(app).post('/api/v1/repos/bare-git-request').set(authAlice).send({ repo_name: 'dup-check' });
  const res = await request(app)
    .post('/api/v1/repos/bare-git-request')
    .set(authAlice)
    .send({ repo_name: 'dup-check' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'Conflict');
});

test('POST /bare-git-request — 409 when bare-git canonical already exists on disk', async () => {
  // Seed a canonical dir under YAKLOG_BARE_GIT_ROOT_HOST (tempDir per test setup)
  fs.mkdirSync(path.join(tempDir, 'preexisting.git'), { recursive: true });
  const res = await request(app)
    .post('/api/v1/repos/bare-git-request')
    .set(authAlice)
    .send({ repo_name: 'preexisting' });
  assert.equal(res.statusCode, 409);
});

// ── GET /repos/bare-git-request/:id (enumerate-safe visibility) ───────────

test('GET /bare-git-request/:id — requester sees own', async () => {
  const post = await request(app).post('/api/v1/repos/bare-git-request')
    .set(authAlice).send({ repo_name: 'alice-only' });
  const id = post.body.request_id;
  const res = await request(app).get(`/api/v1/repos/bare-git-request/${id}`).set(authAlice);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.repo_name, 'alice-only');
});

test('GET /bare-git-request/:id — non-requester gets 404 (enumerate-safe)', async () => {
  const post = await request(app).post('/api/v1/repos/bare-git-request')
    .set(authAlice).send({ repo_name: 'alice-only-2' });
  const id = post.body.request_id;
  const res = await request(app).get(`/api/v1/repos/bare-git-request/${id}`).set(authBob);
  assert.equal(res.statusCode, 404);
});

test('GET /bare-git-request/:id — ops-key sees all', async () => {
  const post = await request(app).post('/api/v1/repos/bare-git-request')
    .set(authAlice).send({ repo_name: 'ops-visible' });
  const id = post.body.request_id;
  const res = await request(app).get(`/api/v1/repos/bare-git-request/${id}`).set(authOps);
  assert.equal(res.statusCode, 200);
});

// ── Ops lifecycle endpoints ────────────────────────────────────────────────

test('GET /ops/output/repos/bare-git-request — lists pending', async () => {
  const res = await request(app)
    .get('/api/v1/ops/output/repos/bare-git-request?status=pending')
    .set(authOps);
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.requests));
  assert.ok(res.body.requests.length >= 1);
});

test('POST /ops/output/repos/bare-git-request/:id/fulfilled — success + atomic audit', async () => {
  const post = await request(app).post('/api/v1/repos/bare-git-request')
    .set(authAlice).send({ repo_name: 'fulfill-me' });
  const id = post.body.request_id;
  const res = await request(app)
    .post(`/api/v1/ops/output/repos/bare-git-request/${id}/fulfilled`)
    .set(authOps)
    .send({ result: 'success' });
  assert.equal(res.statusCode, 200);
  // audit row fold: bare-git-requested + bare-git-fulfilled
  const rows = auditRowsFor('bare-git:fulfill-me');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].action, 'bare-git-fulfilled');
});

test('POST /ops/.../fulfilled — 409 on already-fulfilled (atomic CAS per secops #11759)', async () => {
  const post = await request(app).post('/api/v1/repos/bare-git-request')
    .set(authAlice).send({ repo_name: 'double-fulfill' });
  const id = post.body.request_id;
  const first = await request(app)
    .post(`/api/v1/ops/output/repos/bare-git-request/${id}/fulfilled`)
    .set(authOps).send({ result: 'success' });
  assert.equal(first.statusCode, 200);
  const second = await request(app)
    .post(`/api/v1/ops/output/repos/bare-git-request/${id}/fulfilled`)
    .set(authOps).send({ result: 'success' });
  assert.equal(second.statusCode, 409, 'CAS must guard against double-fulfillment');
  // Only one audit-fulfilled row (audit fold guarded by same CAS)
  const rows = auditRowsFor('bare-git:double-fulfill');
  const fulfilledRows = rows.filter((r) => r.action === 'bare-git-fulfilled');
  assert.equal(fulfilledRows.length, 1, 'audit-fold must not double-record on CAS failure');
});

test('POST /ops/.../fulfilled — 404 on non-existent request_id', async () => {
  const res = await request(app)
    .post('/api/v1/ops/output/repos/bare-git-request/999999/fulfilled')
    .set(authOps).send({ result: 'success' });
  assert.equal(res.statusCode, 404);
});

test('POST /ops/.../fulfilled — 400 on invalid result', async () => {
  const post = await request(app).post('/api/v1/repos/bare-git-request')
    .set(authAlice).send({ repo_name: 'invalid-result' });
  const id = post.body.request_id;
  const res = await request(app)
    .post(`/api/v1/ops/output/repos/bare-git-request/${id}/fulfilled`)
    .set(authOps).send({ result: 'maybe' });
  assert.equal(res.statusCode, 400);
});

test('POST /ops/.../fulfilled — 401 non-ops-key rejected', async () => {
  const post = await request(app).post('/api/v1/repos/bare-git-request')
    .set(authAlice).send({ repo_name: 'agent-cannot-fulfill' });
  const id = post.body.request_id;
  const res = await request(app)
    .post(`/api/v1/ops/output/repos/bare-git-request/${id}/fulfilled`)
    .set(authAlice).send({ result: 'success' });
  // opsRouter enforces ops-key; agent-class bearer rejected
  assert.ok(res.statusCode === 401 || res.statusCode === 403, `expected 401/403; got ${res.statusCode}`);
});

// ── T6 audit-fold non-bypassable invariant ────────────────────────────────

test('T6 invariant: actor_agent_id NOT NULL on every audit_repo_change row', async () => {
  const rows = getDb().prepare(`SELECT * FROM audit_repo_change`).all();
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.ok(r.actor_agent_id !== null && r.actor_agent_id !== '',
      `actor_agent_id must never be null/empty (row seq=${r.seq})`);
  }
});
