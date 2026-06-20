// SSE query-token auth shim test
// Per [[feedback_browser_eventsource_no_authorization_header_query_token_canonical]]
// banked from s345-aieng #10039 Ptah dashboard substrate-finding.
//
// Browser EventSource cannot set Authorization header. The query-token shim
// in src/middleware/auth.js accepts ?token=<value> ONLY when Accept header
// includes text/event-stream (defense-in-depth scoping).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-auth-sse-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'test-key-sse';
process.env.NODE_ENV = 'test';
process.env.YAKLOG_STREAM_KEEPALIVE_MS = '100';

const app = require('../src/app');
const { closeDb } = require('../src/db');

const TOKEN = 'test-key-sse';

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(port, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method: 'GET', headers });
    let resolved = false;
    const finish = (statusCode, body) => { if (!resolved) { resolved = true; resolve({ statusCode, body }); } };
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => { body += c.toString('utf8'); });
      res.on('end', () => finish(res.statusCode, body));
      setTimeout(() => { try { req.destroy(); finish(res.statusCode, body); } catch {} }, 250);
    });
    req.on('error', reject);
    req.end();
  });
}

let server, port;
test.before(async () => { server = await startServer(); port = server.address().port; });
test.after(() => { server.close(); closeDb(); try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {} });

test('?token= accepted on SSE route (Accept: text/event-stream)', async () => {
  const { statusCode } = await request(port, `/api/v1/stream?token=${TOKEN}`, {
    'Accept': 'text/event-stream',
  });
  assert.equal(statusCode, 200, 'SSE route with ?token= + Accept event-stream should auth-pass');
});

test('?token= REJECTED on non-SSE route (no Accept event-stream header)', async () => {
  const { statusCode } = await request(port, `/api/v1/messages?token=${TOKEN}`, {
    'Accept': 'application/json',
  });
  assert.equal(statusCode, 401, '?token= must NOT auth on non-SSE routes (Accept JSON)');
});

test('?token= REJECTED on SSE route when token is wrong', async () => {
  const { statusCode } = await request(port, `/api/v1/stream?token=wrong-token`, {
    'Accept': 'text/event-stream',
  });
  assert.equal(statusCode, 401, 'wrong ?token= must fail auth even with Accept event-stream');
});

test('Bearer-header takes precedence over wrong ?token= on SSE route', async () => {
  const { statusCode } = await request(port, `/api/v1/stream?token=wrong-token`, {
    'Accept': 'text/event-stream',
    'Authorization': `Bearer ${TOKEN}`,
  });
  assert.equal(statusCode, 200, 'Bearer-header should take precedence over wrong ?token=');
});
