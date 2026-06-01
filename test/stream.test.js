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
process.env.YAKLOG_STREAM_KEEPALIVE_MS = '100';

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

test('min_quiet_ms=500 coalesces burst into one flush window', async () => {
  const server = await startServer();
  const port = server.address().port;
  const { events, close } = await openStream(port, '?channel=burst&min_quiet_ms=500');

  const t0 = Date.now();
  insertMessage({ channel: 'burst', sender: 'a', body: 'a1' });
  insertMessage({ channel: 'burst', sender: 'a', body: 'a2' });
  insertMessage({ channel: 'burst', sender: 'a', body: 'a3' });

  await waitFor(() => events.filter((e) => e.startsWith('id:')).length >= 3, 3000);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 400, `expected >=400ms delay, got ${elapsed}ms`);

  close();
  server.close();
});

test('min_quiet_ms=0 flushes immediately', async () => {
  const server = await startServer();
  const port = server.address().port;
  const { events, close } = await openStream(port, '?channel=immed&min_quiet_ms=0');

  const t0 = Date.now();
  insertMessage({ channel: 'immed', sender: 'a', body: 'fast' });
  await waitFor(() => events.some((e) => e.includes('fast')));
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 200, `expected <200ms, got ${elapsed}ms`);

  close();
  server.close();
});

test('mention filter accepts comma-separated list — matches any', async () => {
  const server = await startServer();
  const port = server.address().port;
  const { events, close } = await openStream(port, '?channel=multi&mention=claude,everyone&min_quiet_ms=0');

  insertMessage({ channel: 'multi', sender: 'bob', body: 'just chatter, no ping' });
  insertMessage({ channel: 'multi', sender: 'alice', body: 'heads up @everyone — deploy at 5' });
  insertMessage({ channel: 'multi', sender: 'dave', body: 'hi @claude please review' });
  insertMessage({ channel: 'multi', sender: 'eve', body: '@other-agent take it' });

  await waitFor(() => events.filter((e) => e.startsWith('id:')).length >= 2);
  const bodies = events.filter((e) => e.startsWith('id:')).map((e) => JSON.parse(e.split('data: ')[1]).body);
  assert.ok(bodies.some((b) => b.includes('@everyone')));
  assert.ok(bodies.some((b) => b.includes('@claude')));
  assert.ok(!bodies.some((b) => b.includes('just chatter')));
  assert.ok(!bodies.some((b) => b.includes('@other-agent')));

  close();
  server.close();
});

test('mention filter rejects list containing invalid token', async () => {
  const server = await startServer();
  const port = server.address().port;
  const res = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'GET',
      path: '/api/v1/stream?mention=claude,bad!token',
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    req.on('response', resolve);
    req.on('error', reject);
    req.end();
  });
  assert.equal(res.statusCode, 400);
  res.resume();
  server.close();
});

test('Last-Event-ID replay honors multi-mention filter', async () => {
  const server = await startServer();
  const port = server.address().port;

  const m1 = insertMessage({ channel: 'mreplay', sender: 'x', body: 'ignored' });
  const m2 = insertMessage({ channel: 'mreplay', sender: 'x', body: 'wake @everyone' });
  const m3 = insertMessage({ channel: 'mreplay', sender: 'x', body: 'poke @claude' });

  const { events, close } = await openStream(port, `?channel=mreplay&mention=claude,everyone&min_quiet_ms=0`, {
    'Last-Event-ID': String(m1.id)
  });

  await waitFor(() => events.filter((e) => e.startsWith('id:')).length >= 2);
  const ids = events.filter((e) => e.startsWith('id:')).map((e) => Number(e.match(/^id: (\d+)/)[1]));
  assert.deepEqual(ids, [m2.id, m3.id]);

  close();
  server.close();
});

// v0.5.10 channels plural CSV — lane-decomp substrate per #7301 / parch #7284.
// Pre-fix: `?channels=a,b` was silently dropped (server only read singular
// `?channel=`). Daemons advertising "subscribed to {a,b,c}" got the firehose.

test('channels CSV: only configured channels delivered', async () => {
  const server = await startServer();
  const port = server.address().port;
  const { events, close } = await openStream(port, '?channels=substrate,gamedev&min_quiet_ms=0');

  insertMessage({ channel: 'substrate', sender: 'a', body: 'sub-msg' });
  insertMessage({ channel: 'gamedev', sender: 'b', body: 'game-msg' });
  insertMessage({ channel: 'aieng', sender: 'c', body: 'aieng-msg' });
  insertMessage({ channel: 'bizdev', sender: 'd', body: 'biz-msg' });

  await waitFor(() => events.filter((e) => e.startsWith('id:')).length >= 2);
  const bodies = events.filter((e) => e.startsWith('id:')).map((e) => JSON.parse(e.split('data: ')[1]).body);
  assert.ok(bodies.includes('sub-msg'));
  assert.ok(bodies.includes('game-msg'));
  assert.ok(!bodies.includes('aieng-msg'));
  assert.ok(!bodies.includes('biz-msg'));

  close();
  server.close();
});

test('channels CSV: dedupes + whitespace-trims', async () => {
  const server = await startServer();
  const port = server.address().port;
  const { events, close } = await openStream(port, '?channels=alpha,%20alpha%20,beta,,alpha&min_quiet_ms=0');

  insertMessage({ channel: 'alpha', sender: 'a', body: 'a-msg' });
  insertMessage({ channel: 'beta', sender: 'b', body: 'b-msg' });
  insertMessage({ channel: 'gamma', sender: 'c', body: 'g-msg' });

  await waitFor(() => events.filter((e) => e.startsWith('id:')).length >= 2);
  const bodies = events.filter((e) => e.startsWith('id:')).map((e) => JSON.parse(e.split('data: ')[1]).body);
  assert.ok(bodies.includes('a-msg'));
  assert.ok(bodies.includes('b-msg'));
  assert.ok(!bodies.includes('g-msg'));

  close();
  server.close();
});

test('channels CSV: invalid token rejected with 400', async () => {
  const server = await startServer();
  const port = server.address().port;
  const res = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'GET',
      path: '/api/v1/stream?channels=good,bad!token',
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    req.on('response', resolve);
    req.on('error', reject);
    req.end();
  });
  assert.equal(res.statusCode, 400);
  res.resume();
  server.close();
});

test('channels CSV: combines with singular channel (union)', async () => {
  const server = await startServer();
  const port = server.address().port;
  const { events, close } = await openStream(port, '?channel=primary&channels=secondary&min_quiet_ms=0');

  insertMessage({ channel: 'primary', sender: 'a', body: 'p-msg' });
  insertMessage({ channel: 'secondary', sender: 'b', body: 's-msg' });
  insertMessage({ channel: 'other', sender: 'c', body: 'o-msg' });

  await waitFor(() => events.filter((e) => e.startsWith('id:')).length >= 2);
  const bodies = events.filter((e) => e.startsWith('id:')).map((e) => JSON.parse(e.split('data: ')[1]).body);
  assert.ok(bodies.includes('p-msg'));
  assert.ok(bodies.includes('s-msg'));
  assert.ok(!bodies.includes('o-msg'));

  close();
  server.close();
});

test('channels CSV: Last-Event-ID replay honors the set', async () => {
  const server = await startServer();
  const port = server.address().port;

  const m1 = insertMessage({ channel: 'cr-a', sender: 'x', body: 'a-one' });
  const m2 = insertMessage({ channel: 'cr-b', sender: 'x', body: 'b-one' });
  const m3 = insertMessage({ channel: 'cr-c', sender: 'x', body: 'c-one' });

  const { events, close } = await openStream(port, '?channels=cr-a,cr-c&min_quiet_ms=0', {
    'Last-Event-ID': String(m1.id - 1)
  });

  await waitFor(() => events.filter((e) => e.startsWith('id:')).length >= 2);
  const ids = events.filter((e) => e.startsWith('id:')).map((e) => Number(e.match(/^id: (\d+)/)[1]));
  assert.deepEqual(ids, [m1.id, m3.id], `b channel msg ${m2.id} should be excluded`);

  close();
  server.close();
});

test('no channel filter: all channels delivered (back-compat)', async () => {
  const server = await startServer();
  const port = server.address().port;
  const { events, close } = await openStream(port, '?min_quiet_ms=0');

  insertMessage({ channel: 'any-1', sender: 'a', body: 'a1' });
  insertMessage({ channel: 'any-2', sender: 'b', body: 'a2' });

  await waitFor(() => events.filter((e) => e.startsWith('id:')).length >= 2);
  close();
  server.close();
});

test('emits keepalive comments periodically', async () => {
  const server = await startServer();
  const port = server.address().port;
  const { events, close } = await openStream(port, '?channel=ka');
  await waitFor(() => events.some((e) => e.includes('keepalive')), 1500);
  close();
  server.close();
});

test.after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
