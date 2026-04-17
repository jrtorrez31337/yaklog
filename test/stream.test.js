const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-stream-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'test-key';
process.env.NODE_ENV = 'test';

const app = require('../src/app');
const { closeDb, insertMessage } = require('../src/db');

const TOKEN = 'test-key';

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function openStream(port, query, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: `/api/v1/stream${query}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${TOKEN}`, ...headers }
    });
    req.on('response', (res) => {
      const events = [];
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          events.push(buf.slice(0, idx));
          buf = buf.slice(idx + 2);
        }
      });
      resolve({ res, events, close: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}

function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

test('stream delivers live events after connect', async () => {
  const server = await startServer();
  const port = server.address().port;
  const { events, close } = await openStream(port, '?min_quiet_ms=0');

  insertMessage({ channel: 'live', sender: 'agent', body: 'hello' });

  await waitFor(() => events.some((e) => e.includes('hello')));
  const msgEvent = events.find((e) => e.startsWith('id:'));
  assert.match(msgEvent, /^id: \d+/m);
  assert.match(msgEvent, /event: message/);
  assert.match(msgEvent, /"body":"hello"/);

  close();
  server.close();
});

test('exclude_sender suppresses matching sender', async () => {
  const server = await startServer();
  const port = server.address().port;
  const { events, close } = await openStream(port, '?exclude_sender=self&min_quiet_ms=0');

  insertMessage({ channel: 'filter', sender: 'self', body: 'from self' });
  insertMessage({ channel: 'filter', sender: 'other', body: 'from other' });

  await waitFor(() => events.some((e) => e.includes('from other')));
  assert.ok(!events.some((e) => e.includes('from self')));

  close();
  server.close();
});

test('mention filter only emits matching messages', async () => {
  const server = await startServer();
  const port = server.address().port;
  const { events, close } = await openStream(port, '?mention=alice&min_quiet_ms=0');

  insertMessage({ channel: 'mentions', sender: 'a', body: 'hi bob' });
  insertMessage({ channel: 'mentions', sender: 'b', body: 'hi @alice' });

  await waitFor(() => events.some((e) => e.includes('hi @alice')));
  assert.ok(!events.some((e) => e.includes('hi bob')));

  close();
  server.close();
});

test('Last-Event-ID replays missed messages in order', async () => {
  const server = await startServer();
  const port = server.address().port;

  const m1 = insertMessage({ channel: 'replay', sender: 'x', body: 'one' });
  const m2 = insertMessage({ channel: 'replay', sender: 'x', body: 'two' });
  const m3 = insertMessage({ channel: 'replay', sender: 'x', body: 'three' });

  const { events, close } = await openStream(port, `?channel=replay&min_quiet_ms=0`, {
    'Last-Event-ID': String(m1.id)
  });

  await waitFor(() => events.filter((e) => e.startsWith('id:')).length >= 2);
  const ids = events
    .filter((e) => e.startsWith('id:'))
    .map((e) => Number(e.match(/^id: (\d+)/)[1]));
  assert.deepEqual(ids, [m2.id, m3.id]);

  close();
  server.close();
});

test.after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
