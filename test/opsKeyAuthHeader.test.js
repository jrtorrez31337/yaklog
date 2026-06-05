// ADR-0030 v1.1 R1 acceptance tests — opsKeyAuditMiddleware redaction.
//
// Mandatory negative test (admin Refinement 1): assert the raw Bearer token
// literal does NOT appear in captured morgan output, and the masked
// `Bearer sha256:` form DOES appear. This is the binding ship-gate.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Writable } = require('stream');
const express = require('express');
const morgan = require('morgan');
const request = require('supertest');

const { opsKeyAuditMiddleware, sha256Prefix } = require('../src/middleware/opsKeyAudit');

function bufferStream() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, enc, cb) {
      chunks.push(Buffer.from(chunk).toString('utf-8'));
      cb();
    }
  });
  stream.getOutput = () => chunks.join('');
  return stream;
}

function makeApp({ captureBody = false } = {}) {
  const app = express();
  const logStream = bufferStream();
  app.use(opsKeyAuditMiddleware);
  app.use(morgan(':method :url :req[authorization] :status', { stream: logStream }));
  app.use(express.json());
  app.post('/probe', (req, res) => {
    if (captureBody) {
      // Simulate an OTel-style request-body capture handler reading the
      // (now-masked) Authorization header.
      logStream.write(`BODYCAP auth=${req.headers.authorization} body=${JSON.stringify(req.body)}\n`);
    }
    res.json({
      authHeader: req.headers.authorization,
      rawBearer: req.rawBearer || null,
      opsKeySha256: req.opsKeySha256 || null
    });
  });
  return { app, logStream };
}

test('redacts req.headers.authorization to Bearer sha256:<prefix>', async () => {
  const { app } = makeApp();
  const token = 'opskey-redact-target-xyz';
  const res = await request(app).post('/probe').set('Authorization', `Bearer ${token}`).send({});
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.authHeader, `Bearer sha256:${sha256Prefix(token)}`);
});

test('sets req.rawBearer to the original token', async () => {
  const { app } = makeApp();
  const token = 'opskey-raw-preserve-abc';
  const res = await request(app).post('/probe').set('Authorization', `Bearer ${token}`).send({});
  assert.equal(res.body.rawBearer, token);
});

test('sets req.opsKeySha256 to 16-char hex prefix matching sha256(token)', async () => {
  const { app } = makeApp();
  const token = 'opskey-prefix-validate';
  const expected = crypto.createHash('sha256').update(token, 'utf-8').digest('hex').slice(0, 16);
  const res = await request(app).post('/probe').set('Authorization', `Bearer ${token}`).send({});
  assert.equal(res.body.opsKeySha256, expected);
  assert.equal(res.body.opsKeySha256.length, 16);
  assert.match(res.body.opsKeySha256, /^[0-9a-f]{16}$/);
});

test('request without Authorization header passes through cleanly', async () => {
  const { app } = makeApp();
  const res = await request(app).post('/probe').send({});
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.authHeader, undefined);
  assert.equal(res.body.rawBearer, null);
  assert.equal(res.body.opsKeySha256, null);
});

test('non-Bearer Authorization (e.g., Basic) passes through unchanged', async () => {
  const { app } = makeApp();
  const basic = 'Basic dXNlcjpwYXNz';
  const res = await request(app).post('/probe').set('Authorization', basic).send({});
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.authHeader, basic);
  assert.equal(res.body.rawBearer, null);
  assert.equal(res.body.opsKeySha256, null);
});

test('MANDATORY R1: raw bearer literal does NOT appear in morgan captured output', async () => {
  const { app, logStream } = makeApp();
  const token = 'my-super-secret-ops-key-do-not-leak';
  const res = await request(app).post('/probe').set('Authorization', `Bearer ${token}`).send({});
  assert.equal(res.statusCode, 200);
  // Give morgan a tick to flush (it logs on res 'finish').
  await new Promise((r) => setImmediate(r));
  const captured = logStream.getOutput();
  assert.ok(captured.length > 0, 'morgan should have produced log output');
  assert.ok(
    !captured.includes(token),
    `LEAK: raw bearer "${token}" found in morgan output: ${captured}`
  );
  assert.ok(
    captured.includes('Bearer sha256:'),
    `EXPECTED masked form not in morgan output: ${captured}`
  );
});

test('MANDATORY R1: raw bearer literal does NOT appear in body-capture path output', async () => {
  const { app, logStream } = makeApp({ captureBody: true });
  const token = 'my-super-secret-ops-key-do-not-leak';
  const res = await request(app)
    .post('/probe')
    .set('Authorization', `Bearer ${token}`)
    .send({ payload: 'reconcile-request' });
  assert.equal(res.statusCode, 200);
  await new Promise((r) => setImmediate(r));
  const captured = logStream.getOutput();
  assert.ok(captured.includes('BODYCAP'), 'body-capture handler should have written its line');
  assert.ok(
    !captured.includes(token),
    `LEAK in body-capture path: raw bearer "${token}" found: ${captured}`
  );
  assert.ok(
    captured.includes('Bearer sha256:'),
    `EXPECTED masked form not in body-capture output: ${captured}`
  );
});

test('downstream auth.js validates handed-off req.rawBearer end-to-end', async () => {
  // Sandbox env BEFORE loading config/auth — config reads env at require time.
  process.env.YAKLOG_API_KEYS = 'test-key';
  // Bust the require cache so config + auth re-read with our env.
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/middleware/auth')];
  // auth requires ../db (getActiveRegistrationByMintedTokenHash); stub so we
  // don't need to initialize the DB just for this hand-off probe.
  const dbPath = require.resolve('../src/db');
  const origDb = require.cache[dbPath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { getActiveRegistrationByMintedTokenHash: () => null }
  };

  const auth = require('../src/middleware/auth');

  const app = express();
  app.use(opsKeyAuditMiddleware);
  app.use(auth);
  app.get('/handoff', (req, res) => {
    res.json({
      source: req.auth.source,
      tokenMatches: req.auth.token === 'test-key',
      authHeader: req.headers.authorization
    });
  });

  const res = await request(app).get('/handoff').set('Authorization', 'Bearer test-key');
  assert.equal(res.statusCode, 200, `expected 200; got ${res.statusCode} body=${JSON.stringify(res.body)}`);
  assert.equal(res.body.source, 'env');
  assert.equal(res.body.tokenMatches, true);
  assert.equal(res.body.authHeader, `Bearer sha256:${sha256Prefix('test-key')}`);

  // Restore db cache + clean env so this test doesn't poison sibling tests.
  if (origDb) require.cache[dbPath] = origDb; else delete require.cache[dbPath];
  delete require.cache[require.resolve('../src/middleware/auth')];
  delete require.cache[require.resolve('../src/config')];
});
