const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-spec-test-'));
const specPath = path.join(tempDir, 'spec.md');
const SPEC_BODY = '# yaklog spec\n\nv2026-04-27 canonical agent spec.\n';
fs.writeFileSync(specPath, SPEC_BODY);

process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'test-key';
process.env.NODE_ENV = 'test';
process.env.YAKLOG_SPEC_PATH = specPath;

const app = require('../src/app');
const { closeDb } = require('../src/db');

const TOKEN = 'test-key';

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function getSpec(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/v1/spec',
        method: 'GET',
        headers: { Authorization: `Bearer ${TOKEN}`, ...headers }
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const expectedEtag = `"${crypto.createHash('sha256').update(SPEC_BODY).digest('hex')}"`;

test('GET /spec returns 200 with markdown body and sha256 ETag', async () => {
  const server = await startServer();
  const { port } = server.address();
  const res = await getSpec(port);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/markdown/);
  assert.equal(res.headers.etag, expectedEtag);
  assert.equal(res.body, SPEC_BODY);
  server.close();
});

test('GET /spec with matching If-None-Match returns 304 and empty body', async () => {
  const server = await startServer();
  const { port } = server.address();
  const res = await getSpec(port, { 'If-None-Match': expectedEtag });
  assert.equal(res.status, 304);
  assert.equal(res.body, '');
  server.close();
});

test('GET /spec with mismatched If-None-Match returns 200 with body', async () => {
  const server = await startServer();
  const { port } = server.address();
  const res = await getSpec(port, { 'If-None-Match': '"stale-etag"' });
  assert.equal(res.status, 200);
  assert.equal(res.body, SPEC_BODY);
  server.close();
});

test('GET /spec rotates ETag when spec file changes', async () => {
  const server = await startServer();
  const { port } = server.address();
  const before = await getSpec(port);

  const newBody = SPEC_BODY + '\nappended.\n';
  fs.writeFileSync(specPath, newBody);
  const newEtag = `"${crypto.createHash('sha256').update(newBody).digest('hex')}"`;

  const after = await getSpec(port, { 'If-None-Match': before.headers.etag });
  assert.equal(after.status, 200);
  assert.equal(after.headers.etag, newEtag);
  assert.equal(after.body, newBody);

  // Restore for downstream tests.
  fs.writeFileSync(specPath, SPEC_BODY);
  server.close();
});

test('GET /spec returns 404 when spec file missing', async () => {
  const server = await startServer();
  const { port } = server.address();
  fs.unlinkSync(specPath);
  const res = await getSpec(port);
  assert.equal(res.status, 404);
  // Restore for cleanup.
  fs.writeFileSync(specPath, SPEC_BODY);
  server.close();
});

test('GET /spec without auth returns 401', async () => {
  const server = await startServer();
  const { port } = server.address();
  const res = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/v1/spec', method: 'GET' },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode }));
      }
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(res.status, 401);
  server.close();
});

test.after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
