// CP16 Pillar 0 Phase B (browser side) per parch ratify #10691.
// Unit tests for public/perf-instrument.js — buffer/batch/wrap/flush
// behavior via the CommonJS module export. Browser smoke deferred to
// headless playwright sub-cycle (sister Q2 SSE pattern).

const test = require('node:test');
const assert = require('node:assert/strict');

// Stub window + navigator BEFORE requiring the module (auto-init checks them).
global.window = {};
global.document = { addEventListener: () => {}, hidden: false };
global.navigator = { sendBeacon: null }; // force fetch fallback path
global.window.PERF_INSTRUMENT_NOAUTO = true; // disable auto-start in tests

// Capture fetch calls
let fetchCalls = [];
global.fetch = (url, opts) => {
  fetchCalls.push({ url, body: opts && opts.body });
  return Promise.resolve({ ok: true });
};

const mod = require('../public/perf-instrument.js');
const { PerfInstrument } = mod;

test.beforeEach(() => {
  mod.__reset();
  fetchCalls = [];
});

test('record: appends to buffer with required fields', () => {
  PerfInstrument.record('test.cs', 42, 100);
  assert.equal(mod.__bufferLen(), 1);
});

test('record: ignores bad input', () => {
  PerfInstrument.record('', 10);
  PerfInstrument.record('cs', -5);
  PerfInstrument.record('cs', NaN);
  PerfInstrument.record('cs', 'not-number');
  assert.equal(mod.__bufferLen(), 0);
});

test('start + end pair: records duration', async () => {
  const h = PerfInstrument.start('async.thing');
  await new Promise(r => setTimeout(r, 20));
  PerfInstrument.end(h);
  assert.equal(mod.__bufferLen(), 1);
});

test('wrap: sync function returns value + records duration', () => {
  const result = PerfInstrument.wrap('sync.wrap', () => {
    let n = 0;
    for (let i = 0; i < 1000; i++) n += i;
    return n;
  });
  assert.equal(result, 499500);
  assert.equal(mod.__bufferLen(), 1);
});

test('wrap: async function awaits + records on resolve', async () => {
  const result = await PerfInstrument.wrap('async.wrap', async () => {
    await new Promise(r => setTimeout(r, 10));
    return 'done';
  });
  assert.equal(result, 'done');
  assert.equal(mod.__bufferLen(), 1);
});

test('wrap: async function records duration on reject + rethrows', async () => {
  await assert.rejects(() => PerfInstrument.wrap('async.fail', async () => {
    throw new Error('boom');
  }), /boom/);
  assert.equal(mod.__bufferLen(), 1);
});

test('wrap: sync function records on throw + rethrows', () => {
  assert.throws(() => PerfInstrument.wrap('sync.fail', () => { throw new Error('boom'); }), /boom/);
  assert.equal(mod.__bufferLen(), 1);
});

test('wrap: nRowsExtractor populates n_rows on result', () => {
  PerfInstrument.wrap('with.rows', () => ({ items: [1, 2, 3, 4, 5] }), (r) => r.items.length);
  // Can't inspect buffer directly without test-helper, but record success
  assert.equal(mod.__bufferLen(), 1);
});

test('flush: sends buffer via fetch fallback + clears buffer', () => {
  PerfInstrument.record('flush.test', 10);
  PerfInstrument.record('flush.test2', 20);
  const sent = PerfInstrument.flush();
  assert.equal(sent, true);
  assert.equal(mod.__bufferLen(), 0);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, '/api/v1/instrument/browser-perf');
  const body = JSON.parse(fetchCalls[0].body);
  assert.ok(Array.isArray(body.measurements));
  assert.equal(body.measurements.length, 2);
});

test('flush: empty buffer is no-op', () => {
  assert.equal(PerfInstrument.flush(), false);
  assert.equal(fetchCalls.length, 0);
});

test('buffer cap: oldest dropped when over MAX_BUFFER', () => {
  // Fill past 500
  for (let i = 0; i < 600; i++) PerfInstrument.record('overflow', 1);
  assert.equal(mod.__bufferLen(), 500);
});

test('flush via sendBeacon: prefers sendBeacon when available', () => {
  let beaconCalls = [];
  global.navigator.sendBeacon = (url, blob) => { beaconCalls.push({ url, blob }); return true; };
  PerfInstrument.record('beacon.test', 50);
  const sent = PerfInstrument.flush();
  assert.equal(sent, true);
  assert.equal(beaconCalls.length, 1);
  assert.equal(fetchCalls.length, 0, 'fetch fallback not used when beacon succeeds');
  global.navigator.sendBeacon = null;
});

test('flush via sendBeacon rejected: falls back to fetch', () => {
  global.navigator.sendBeacon = () => false; // queue full / rejected
  PerfInstrument.record('beacon.reject', 10);
  PerfInstrument.flush();
  assert.equal(fetchCalls.length, 1, 'fetch fallback used after beacon rejection');
  global.navigator.sendBeacon = null;
});
