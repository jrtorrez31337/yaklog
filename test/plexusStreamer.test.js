// Plan C Stage 2.5 CP5 — plexusStreamer SSE tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-test-streamer-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'test-key';
process.env.YAKLOG_PLEXUS_PROM_URL = 'http://prom-stub.invalid:9090';
process.env.YAKLOG_PLEXUS_QUERY_TIMEOUT_MS = '500';
process.env.NODE_ENV = 'test';

let nextFetchResponse = null;
let fetchCalls = [];
global.fetch = async (url) => {
  fetchCalls.push({ url: url.toString() });
  if (nextFetchResponse instanceof Error) throw nextFetchResponse;
  const { status = 200, body = { status: 'success', data: { resultType: 'matrix', result: [] } } } = nextFetchResponse || {};
  nextFetchResponse = null;
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
};

const { streamer, _internals } = require('../src/plexusStreamer');
const { hashFrame, PlexusStreamer } = _internals;

// ── hashFrame stability ───────────────────────────────────────────────

test('hashFrame: identical input → identical hash', () => {
  const a = { status: 'success', data: { result: [{ metric: { x: 'y' }, values: [[1, '2']] }] } };
  const b = JSON.parse(JSON.stringify(a));
  assert.equal(hashFrame(a), hashFrame(b));
});

test('hashFrame: different input → different hash', () => {
  const a = { data: { result: [] } };
  const b = { data: { result: [{}] } };
  assert.notEqual(hashFrame(a), hashFrame(b));
});

// ── PlexusStreamer behavior ───────────────────────────────────────────

test('streamer fans out frame events on first poll', async () => {
  const s = new PlexusStreamer();
  const received = [];
  s.on('frame', (e) => received.push(e));
  fetchCalls = [];
  nextFetchResponse = { status: 200, body: { status: 'success', data: { result: [{ metric: { plexus_agent_id: 'foo' }, values: [[1779000000, '5']] }] } } };
  // Force one poll manually (don't actually start the timer loop — flaky in tests)
  await s._pollFrame({ name: 'test.frame', kind: 'range', lookbackS: 60, step: '15s', promql: 'up' });
  assert.equal(received.length, 1);
  assert.equal(received[0].name, 'test.frame');
  assert.equal(received[0].snap.payload.template, 'test.frame');
});

test('streamer dedupes identical consecutive polls (no broadcast on no-change)', async () => {
  const s = new PlexusStreamer();
  const received = [];
  s.on('frame', (e) => received.push(e));
  const sameBody = { status: 'success', data: { result: [{ metric: { x: 'y' }, values: [[1, '1']] }] } };
  nextFetchResponse = { status: 200, body: sameBody };
  await s._pollFrame({ name: 't', kind: 'range', lookbackS: 60, step: '15s', promql: 'up' });
  nextFetchResponse = { status: 200, body: sameBody };
  await s._pollFrame({ name: 't', kind: 'range', lookbackS: 60, step: '15s', promql: 'up' });
  assert.equal(received.length, 1, 'second identical poll should NOT broadcast');
});

test('streamer re-broadcasts on content change', async () => {
  const s = new PlexusStreamer();
  const received = [];
  s.on('frame', (e) => received.push(e));
  nextFetchResponse = { status: 200, body: { status: 'success', data: { result: [{ metric: {}, values: [[1, '1']] }] } } };
  await s._pollFrame({ name: 't', kind: 'range', lookbackS: 60, step: '15s', promql: 'up' });
  nextFetchResponse = { status: 200, body: { status: 'success', data: { result: [{ metric: {}, values: [[2, '2']] }] } } };
  await s._pollFrame({ name: 't', kind: 'range', lookbackS: 60, step: '15s', promql: 'up' });
  assert.equal(received.length, 2);
});

test('streamer swallows fetch errors silently (no broadcast; no throw)', async () => {
  const s = new PlexusStreamer();
  const received = [];
  s.on('frame', (e) => received.push(e));
  nextFetchResponse = new Error('ECONNREFUSED');
  await s._pollFrame({ name: 't', kind: 'range', lookbackS: 60, step: '15s', promql: 'up' });
  assert.equal(received.length, 0);
});

test('streamer Prom non-2xx → no broadcast', async () => {
  const s = new PlexusStreamer();
  const received = [];
  s.on('frame', (e) => received.push(e));
  nextFetchResponse = { status: 500, body: { status: 'error', error: 'boom' } };
  await s._pollFrame({ name: 't', kind: 'range', lookbackS: 60, step: '15s', promql: 'up' });
  assert.equal(received.length, 0);
});

test('getSnapshot returns last cached snapshot (used for initial-connect)', async () => {
  const s = new PlexusStreamer();
  nextFetchResponse = { status: 200, body: { status: 'success', data: { result: [{ metric: {}, values: [[1, '1']] }] } } };
  await s._pollFrame({ name: 'cache.test', kind: 'range', lookbackS: 60, step: '15s', promql: 'up' });
  const snap = s.getSnapshot('cache.test');
  assert.ok(snap);
  assert.equal(snap.payload.template, 'cache.test');
  assert.equal(s.getSnapshot('nonexistent'), null);
});

// ── SSE handler smoke (raw http to avoid supertest's poor SSE story) ──

test('SSE handler writes initial snapshots + frame events', async () => {
  const http = require('http');
  const app = require('../src/app');
  // Pre-seed singleton streamer with one snapshot.
  nextFetchResponse = { status: 200, body: { status: 'success', data: { result: [{ metric: { plexus_agent_id: 'pre-seeded' }, values: [[1, '1']] }] } } };
  await streamer._pollFrame({ name: 'session.count.byAgent', kind: 'range', lookbackS: 60, step: '15s', promql: 'sum(claude_code_session_count_total)' });

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();

  const buf = await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/api/v1/plexus/public/stream`, (res) => {
      assert.equal(res.headers['content-type'], 'text/event-stream');
      let data = '';
      res.on('data', (chunk) => {
        data += chunk.toString();
        if (data.includes('event: frame')) {
          req.destroy();
          resolve(data);
        }
      });
      res.on('error', () => resolve(data));
    });
    req.on('error', (e) => {
      // Expected when we destroy(); other errors are real failures.
      if (e.code === 'ECONNRESET') resolve('');
      else reject(e);
    });
    setTimeout(() => { try { req.destroy(); } catch {} ; resolve(''); }, 1000);
  });

  await new Promise((r) => server.close(r));
  assert.match(buf, /: connected/);
  assert.match(buf, /event: frame/);
  assert.match(buf, /pre-seeded/);
});
