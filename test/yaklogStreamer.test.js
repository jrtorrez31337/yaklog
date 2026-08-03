// Plan C Stage 2.5 CP5 — yaklogStreamer SSE tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-test-streamer-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'test-key';
process.env.YAKLOG_YAKLOG_PROM_URL = 'http://prom-stub.invalid:9090';
process.env.YAKLOG_YAKLOG_QUERY_TIMEOUT_MS = '500';
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

const { streamer, _internals } = require('../src/yaklogStreamer');
const { hashFrame, YaklogStreamer } = _internals;

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

// ── YaklogStreamer behavior ───────────────────────────────────────────

test('streamer fans out frame events on first poll', async () => {
  const s = new YaklogStreamer();
  const received = [];
  s.on('frame', (e) => received.push(e));
  fetchCalls = [];
  nextFetchResponse = { status: 200, body: { status: 'success', data: { result: [{ metric: { yaklog_agent_id: 'foo' }, values: [[1779000000, '5']] }] } } };
  // Force one poll manually (don't actually start the timer loop — flaky in tests)
  await s._pollFrame({ name: 'test.frame', kind: 'range', lookbackS: 60, step: '15s', promql: 'up' });
  assert.equal(received.length, 1);
  assert.equal(received[0].name, 'test.frame');
  assert.equal(received[0].snap.payload.template, 'test.frame');
});

test('streamer dedupes identical consecutive polls (no broadcast on no-change)', async () => {
  const s = new YaklogStreamer();
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
  const s = new YaklogStreamer();
  const received = [];
  s.on('frame', (e) => received.push(e));
  nextFetchResponse = { status: 200, body: { status: 'success', data: { result: [{ metric: {}, values: [[1, '1']] }] } } };
  await s._pollFrame({ name: 't', kind: 'range', lookbackS: 60, step: '15s', promql: 'up' });
  nextFetchResponse = { status: 200, body: { status: 'success', data: { result: [{ metric: {}, values: [[2, '2']] }] } } };
  await s._pollFrame({ name: 't', kind: 'range', lookbackS: 60, step: '15s', promql: 'up' });
  assert.equal(received.length, 2);
});

test('streamer swallows fetch errors silently (no broadcast; no throw)', async () => {
  const s = new YaklogStreamer();
  const received = [];
  s.on('frame', (e) => received.push(e));
  nextFetchResponse = new Error('ECONNREFUSED');
  await s._pollFrame({ name: 't', kind: 'range', lookbackS: 60, step: '15s', promql: 'up' });
  assert.equal(received.length, 0);
});

test('streamer Prom non-2xx → no broadcast', async () => {
  const s = new YaklogStreamer();
  const received = [];
  s.on('frame', (e) => received.push(e));
  nextFetchResponse = { status: 500, body: { status: 'error', error: 'boom' } };
  await s._pollFrame({ name: 't', kind: 'range', lookbackS: 60, step: '15s', promql: 'up' });
  assert.equal(received.length, 0);
});

test('getSnapshot returns last cached snapshot (used for initial-connect)', async () => {
  const s = new YaklogStreamer();
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
  nextFetchResponse = { status: 200, body: { status: 'success', data: { result: [{ metric: { yaklog_agent_id: 'pre-seeded' }, values: [[1, '1']] }] } } };
  await streamer._pollFrame({ name: 'session.count.byAgent', kind: 'range', lookbackS: 60, step: '15s', promql: 'sum(claude_code_session_count_total)' });

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();

  const buf = await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/api/v1/yaklog/public/stream`, (res) => {
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

// ── CP6.1: instant-query support + buildPromql ────────────────────────

test('streamer instant frame: hits /api/v1/query not /api/v1/query_range', async () => {
  const s = new YaklogStreamer();
  fetchCalls = [];
  nextFetchResponse = { status: 200, body: { status: 'success', data: { resultType: 'vector', result: [{ metric: {}, value: [1, '42'] }] } } };
  await s._pollFrame({ name: 'inst.frame', kind: 'instant', promql: 'sum(up)' });
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /\/api\/v1\/query\?/);
  assert.doesNotMatch(fetchCalls[0].url, /query_range/);
  assert.match(fetchCalls[0].url, /query=sum%28up%29/);
  // No start/end/step on instant queries
  assert.doesNotMatch(fetchCalls[0].url, /start=/);
});

test('streamer instant frame: payload carries instant_at not range', async () => {
  const s = new YaklogStreamer();
  const received = [];
  s.on('frame', (e) => received.push(e));
  nextFetchResponse = { status: 200, body: { status: 'success', data: { resultType: 'vector', result: [{ metric: {}, value: [1779000000, '3.14'] }] } } };
  await s._pollFrame({ name: 'inst.payload', kind: 'instant', promql: 'sum(x)' });
  assert.equal(received.length, 1);
  const p = received[0].snap.payload;
  assert.equal(p.kind, 'instant');
  assert.ok(p.instant_at);
  assert.ok(!p.range, 'instant payload should NOT carry range');
  assert.equal(p.data.result[0].value[1], '3.14');
});

test('streamer buildPromql: function evaluated at poll time', async () => {
  const s = new YaklogStreamer();
  let buildCallCount = 0;
  const frame = {
    name: 'dynamic.q',
    kind: 'instant',
    buildPromql: () => {
      buildCallCount++;
      return `up @ ${1000000 + buildCallCount}`;
    },
  };
  fetchCalls = [];
  nextFetchResponse = { status: 200, body: { status: 'success', data: { resultType: 'vector', result: [{ metric: {}, value: [1, '1'] }] } } };
  await s._pollFrame(frame);
  nextFetchResponse = { status: 200, body: { status: 'success', data: { resultType: 'vector', result: [{ metric: {}, value: [2, '2'] }] } } };
  await s._pollFrame(frame);
  assert.equal(buildCallCount, 2, 'buildPromql should be called once per poll');
  // Each poll should have used the freshly-built query (URLSearchParams
  // uses `+` for space, not %20; just check the dynamic timestamp shows up)
  assert.match(fetchCalls[0].url, /1000001/);
  assert.match(fetchCalls[1].url, /1000002/);
});

test('streamer range frame: unchanged behavior (regression check)', async () => {
  const s = new YaklogStreamer();
  fetchCalls = [];
  nextFetchResponse = { status: 200, body: { status: 'success', data: { resultType: 'matrix', result: [] } } };
  await s._pollFrame({ name: 'range.frame', kind: 'range', lookbackS: 300, step: '15s', promql: 'up' });
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /query_range/);
  assert.match(fetchCalls[0].url, /step=15s/);
});

test('registered FRAMES includes the new cluster.cost.* templates', () => {
  const { FRAMES } = require('../src/yaklogStreamer');
  const names = FRAMES.map(f => f.name);
  for (const n of ['cluster.cost.today', 'cluster.cost.7d', 'cluster.cost.mtd',
                    'cluster.cost.topAgents', 'cluster.cost.byAccount',
                    'cluster.cost.spark24h']) {
    assert.ok(names.includes(n), `expected ${n} in FRAMES, got: ${names.join(', ')}`);
  }
});

// CP11.0 (2026-06-03): the @-anchor subtraction approach was replaced
// with sum(increase(metric[<elapsed-window>s])) per-frame because the
// previous shape broke under counter-reset within the window (produced
// negative "today" values when agents restarted mid-day). Test now
// asserts the new shape: increase() over a dynamic seconds-window
// matching elapsed-since-start-of-period.
test('cluster.cost.today + cluster.cost.mtd buildPromql use increase() over elapsed-since-period-start', () => {
  const { FRAMES } = require('../src/yaklogStreamer');
  const today = FRAMES.find(f => f.name === 'cluster.cost.today');
  const mtd = FRAMES.find(f => f.name === 'cluster.cost.mtd');
  const q1 = today.buildPromql();
  const q2 = mtd.buildPromql();
  // Both must use increase() over a dynamic [Ns] window (handles counter-reset)
  assert.match(q1, /sum\(increase\(claude_code_cost_usage_USD_total\[\d+s\]\)\)/);
  assert.match(q2, /sum\(increase\(claude_code_cost_usage_USD_total\[\d+s\]\)\)/);
  // MTD window should be ≥ today's window (MTD covers today + earlier days)
  const todayWindow = parseInt(q1.match(/\[(\d+)s\]/)[1], 10);
  const mtdWindow = parseInt(q2.match(/\[(\d+)s\]/)[1], 10);
  assert.ok(mtdWindow >= todayWindow, `MTD window (${mtdWindow}s) must be ≥ today window (${todayWindow}s)`);
  // Both must be at least 60s (the floor in buildPromql)
  assert.ok(todayWindow >= 60, 'today window must be ≥ 60s floor');
  assert.ok(mtdWindow >= 60, 'mtd window must be ≥ 60s floor');
  // today window must be ≤ 24h (it's elapsed-since-midnight)
  assert.ok(todayWindow <= 86400, `today window (${todayWindow}s) must be ≤ 86400s (24h)`);
  // mtd window must be ≤ 32d (it's elapsed-since-month-start, capped by longest month + safety)
  assert.ok(mtdWindow <= 32 * 86400, `mtd window (${mtdWindow}s) must be ≤ 32d`);
});
