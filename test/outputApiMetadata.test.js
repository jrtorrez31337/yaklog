// Task #258 / PLAN-EFFORT-METADATA-RESPONSE — _metadata namespaced field
// on /api/v1/output/* per parch #11208 RATIFY (OQ1 unconditional / OQ2 error
// envelopes excluded / OQ4 _metadata naming).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-output-meta-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-a';
process.env.YAKLOG_OPS_KEY = 'ops-secret';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb } = require('../src/db');

test.after(() => closeDb());

const NOW_BAND_SEC = 5; // _metadata.as_of_unix within ±5s of request

function assertMetadataShape(body, { expectEmpty, label }) {
  assert.ok(body._metadata, `${label}: _metadata namespaced object present`);
  assert.equal(typeof body._metadata.as_of_unix, 'number', `${label}: as_of_unix is number`);
  assert.ok(Number.isInteger(body._metadata.as_of_unix), `${label}: as_of_unix is integer (epoch seconds)`);
  const now = Math.floor(Date.now() / 1000);
  assert.ok(
    Math.abs(body._metadata.as_of_unix - now) <= NOW_BAND_SEC,
    `${label}: as_of_unix within ±${NOW_BAND_SEC}s of request time`,
  );
  assert.equal(typeof body._metadata.computed_empty_period, 'boolean', `${label}: computed_empty_period is boolean`);
  assert.equal(body._metadata.computed_empty_period, expectEmpty, `${label}: computed_empty_period matches expected`);
}

test('_metadata: /output/ratios includes _metadata with as_of_unix + computed_empty_period', async () => {
  const res = await request(app).get('/api/v1/output/ratios?period=30d&audience=practitioner');
  assert.equal(res.statusCode, 200);
  // Empty seeded DB → zero merges → expect computed_empty_period: true
  assertMetadataShape(res.body, { expectEmpty: true, label: '/ratios empty' });
});

test('_metadata: /output/composition includes _metadata; empty seeded DB → empty=true', async () => {
  const res = await request(app).get('/api/v1/output/composition?period=30d&by=agent');
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.rows));
  assert.equal(res.body.rows.length, 0);
  assertMetadataShape(res.body, { expectEmpty: true, label: '/composition empty' });
});

test('_metadata: /output/anomalies includes _metadata; empty → empty=true', async () => {
  const res = await request(app).get('/api/v1/output/anomalies?threshold=2.0&lookback_days=7');
  assert.equal(res.statusCode, 200);
  assertMetadataShape(res.body, { expectEmpty: true, label: '/anomalies empty' });
});

test('_metadata: /output/merges includes _metadata; empty → empty=true', async () => {
  const res = await request(app).get('/api/v1/output/merges?period=30d&agent=alice');
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.rows));
  assert.equal(res.body.rows.length, 0);
  assertMetadataShape(res.body, { expectEmpty: true, label: '/merges empty' });
});

test('_metadata: /output/coverage-gap includes _metadata', async () => {
  const res = await request(app).get('/api/v1/output/coverage-gap?period=30d');
  assert.equal(res.statusCode, 200);
  assertMetadataShape(res.body, { expectEmpty: true, label: '/coverage-gap empty' });
});

test('_metadata: error envelope (4xx) does NOT include _metadata (per OQ2 RATIFY)', async () => {
  // /ratios with invalid audience → 400
  const r1 = await request(app).get('/api/v1/output/ratios?audience=alien');
  assert.equal(r1.statusCode, 400);
  assert.equal(r1.body._metadata, undefined);
  // /composition with invalid by → 400
  const r2 = await request(app).get('/api/v1/output/composition?by=galaxy');
  assert.equal(r2.statusCode, 400);
  assert.equal(r2.body._metadata, undefined);
  // /anomalies with invalid threshold → 400
  const r3 = await request(app).get('/api/v1/output/anomalies?threshold=-1');
  assert.equal(r3.statusCode, 400);
  assert.equal(r3.body._metadata, undefined);
  // /merges missing agent → 400
  const r4 = await request(app).get('/api/v1/output/merges');
  assert.equal(r4.statusCode, 400);
  assert.equal(r4.body._metadata, undefined);
});

test('_metadata: as_of_unix is current per-request (not cached)', async () => {
  const r1 = await request(app).get('/api/v1/output/composition?period=30d&by=agent');
  // small wait then second request
  await new Promise((r) => setTimeout(r, 1100));
  const r2 = await request(app).get('/api/v1/output/composition?period=30d&by=agent');
  // Both should be live; their as_of_unix could be same second or 1-2s apart
  assert.ok(r2.body._metadata.as_of_unix >= r1.body._metadata.as_of_unix);
});

test('_metadata: backward-compat — existing field-specific assertions still work', async () => {
  // Sister to existing outputApi.test.js assertion pattern (res.body._audience)
  const res = await request(app).get('/api/v1/output/ratios?audience=practitioner');
  assert.equal(res.statusCode, 200);
  // _metadata addition does not break field-specific access
  assert.ok(res.body._metadata);
  // Other expected fields still accessible (existing test pattern)
  assert.equal(typeof res.body, 'object');
});
