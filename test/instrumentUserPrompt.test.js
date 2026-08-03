// CP16 Pillar 0 Phase A test: POST /api/v1/instrument/user-prompt accepts
// UserPromptSubmit metadata + writes Prom textfile.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-instrument-test-'));
const textfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-textfile-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_TEXTFILE_DIR = textfileDir;
process.env.YAKLOG_API_KEYS = 'tok-x';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb } = require('../src/db');
const instrumentRoutes = require('../src/instrumentRoutes');

test.afterEach(() => instrumentRoutes.__resetForTest());
test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(textfileDir, { recursive: true, force: true }); } catch {}
});

const URL = '/api/v1/instrument/user-prompt';
const AUTH = 'Bearer tok-x';

test('POST /user-prompt: accepts valid metadata + writes textfile', async () => {
  const res = await request(app)
    .post(URL)
    .set('Authorization', AUTH)
    .send({ agent_id: 'test-agent-1', session_id: 'sess-A', prompt_char_length: 42, has_tool_calls: false });
  assert.equal(res.status, 201);
  assert.equal(res.body.ok, true);
  const tf = fs.readFileSync(path.join(textfileDir, 'user-prompts.prom'), 'utf-8');
  assert.match(tf, /yaklog_user_prompt_total\{agent_id="test-agent-1",session_id="sess-A",has_tool_calls="false"\} 1/);
  assert.match(tf, /yaklog_user_prompt_char_length_sum\{agent_id="test-agent-1",session_id="sess-A",has_tool_calls="false"\} 42/);
});

test('POST /user-prompt: counter increments + char_sum aggregates', async () => {
  await request(app).post(URL).set('Authorization', AUTH)
    .send({ agent_id: 'a2', session_id: 's1', prompt_char_length: 10, has_tool_calls: false });
  await request(app).post(URL).set('Authorization', AUTH)
    .send({ agent_id: 'a2', session_id: 's1', prompt_char_length: 30, has_tool_calls: false });
  await request(app).post(URL).set('Authorization', AUTH)
    .send({ agent_id: 'a2', session_id: 's1', prompt_char_length: 60, has_tool_calls: false });
  const tf = fs.readFileSync(path.join(textfileDir, 'user-prompts.prom'), 'utf-8');
  assert.match(tf, /yaklog_user_prompt_total\{agent_id="a2",session_id="s1",has_tool_calls="false"\} 3/);
  assert.match(tf, /yaklog_user_prompt_char_length_sum\{agent_id="a2",session_id="s1",has_tool_calls="false"\} 100/);
});

test('POST /user-prompt: has_tool_calls partitions counter', async () => {
  await request(app).post(URL).set('Authorization', AUTH)
    .send({ agent_id: 'a3', session_id: 's1', prompt_char_length: 50, has_tool_calls: false });
  await request(app).post(URL).set('Authorization', AUTH)
    .send({ agent_id: 'a3', session_id: 's1', prompt_char_length: 50, has_tool_calls: true });
  const tf = fs.readFileSync(path.join(textfileDir, 'user-prompts.prom'), 'utf-8');
  assert.match(tf, /yaklog_user_prompt_total\{agent_id="a3",session_id="s1",has_tool_calls="false"\} 1/);
  assert.match(tf, /yaklog_user_prompt_total\{agent_id="a3",session_id="s1",has_tool_calls="true"\} 1/);
});

test('POST /user-prompt: missing agent_id → 400', async () => {
  const res = await request(app).post(URL).set('Authorization', AUTH)
    .send({ prompt_char_length: 10 });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'BadRequest');
});

test('POST /user-prompt: missing prompt_char_length → 400', async () => {
  const res = await request(app).post(URL).set('Authorization', AUTH)
    .send({ agent_id: 'a' });
  assert.equal(res.status, 400);
});

test('POST /user-prompt: negative prompt_char_length → 400', async () => {
  const res = await request(app).post(URL).set('Authorization', AUTH)
    .send({ agent_id: 'a', prompt_char_length: -5 });
  assert.equal(res.status, 400);
});

test('POST /user-prompt: no Bearer → 401', async () => {
  const res = await request(app).post(URL)
    .send({ agent_id: 'a', prompt_char_length: 10 });
  assert.equal(res.status, 401);
});

test('POST /user-prompt: session_id optional (empty session works)', async () => {
  const res = await request(app).post(URL).set('Authorization', AUTH)
    .send({ agent_id: 'no-session-agent', prompt_char_length: 5 });
  assert.equal(res.status, 201);
  const tf = fs.readFileSync(path.join(textfileDir, 'user-prompts.prom'), 'utf-8');
  assert.match(tf, /yaklog_user_prompt_total\{agent_id="no-session-agent",session_id="",has_tool_calls="false"\} 1/);
});

test('POST /user-prompt: prom textfile is atomic (no .tmp left behind)', async () => {
  await request(app).post(URL).set('Authorization', AUTH)
    .send({ agent_id: 'atomic-test', prompt_char_length: 10 });
  const files = fs.readdirSync(textfileDir);
  assert.ok(files.includes('user-prompts.prom'));
  assert.ok(!files.includes('user-prompts.prom.tmp'), 'atomic write leaves no .tmp file');
});

test('POST /user-prompt: pipe-char in agent_id → 400 (counterKey defense per secops #10703)', async () => {
  const res = await request(app).post(URL).set('Authorization', AUTH)
    .send({ agent_id: 'bad|agent', prompt_char_length: 5 });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /must not contain \| character/);
});

test('POST /user-prompt: pipe-char in session_id → 400', async () => {
  const res = await request(app).post(URL).set('Authorization', AUTH)
    .send({ agent_id: 'a', session_id: 's|x', prompt_char_length: 5 });
  assert.equal(res.status, 400);
});

test('POST /user-prompt: label-escape special chars in agent_id', async () => {
  // Label-escape covers quote + backslash; pipe is now rejected at 400 per defense above
  await request(app).post(URL).set('Authorization', AUTH)
    .send({ agent_id: 'a"b\\c', session_id: 's', prompt_char_length: 1 });
  const tf = fs.readFileSync(path.join(textfileDir, 'user-prompts.prom'), 'utf-8');
  assert.match(tf, /agent_id="a\\"b\\\\c"/);
});

// ──────────────────────────────────────────────────────────────────────
// CP16 Pillar 0 Phase B: /browser-perf endpoint + rollup tick tests
// ──────────────────────────────────────────────────────────────────────

const BP_URL = '/api/v1/instrument/browser-perf';

test('POST /browser-perf: accepts batched measurements + inserts rows', async () => {
  const now = Date.now();
  const res = await request(app).post(BP_URL).set('Authorization', AUTH).send({
    measurements: [
      { ts_unix_ms: now - 1000, callsite: 'cost.mean7d', duration_ms: 25 },
      { ts_unix_ms: now - 500, callsite: 'cost.mean7d', duration_ms: 30 },
      { ts_unix_ms: now, callsite: 'bus.thread', duration_ms: 100, n_rows: 50 }
    ]
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.inserted, 3);
});

test('POST /browser-perf: empty array → 400', async () => {
  const res = await request(app).post(BP_URL).set('Authorization', AUTH).send({ measurements: [] });
  assert.equal(res.status, 400);
});

test('POST /browser-perf: missing measurements → 400', async () => {
  const res = await request(app).post(BP_URL).set('Authorization', AUTH).send({});
  assert.equal(res.status, 400);
});

test('POST /browser-perf: batch > 500 → 400', async () => {
  const measurements = Array.from({ length: 501 }, (_, i) => ({
    ts_unix_ms: Date.now() - i, callsite: 'cost.mean7d', duration_ms: 1
  }));
  const res = await request(app).post(BP_URL).set('Authorization', AUTH).send({ measurements });
  assert.equal(res.status, 400);
});

test('POST /browser-perf: bad callsite (special chars) → 400', async () => {
  const res = await request(app).post(BP_URL).set('Authorization', AUTH).send({
    measurements: [{ ts_unix_ms: Date.now(), callsite: 'bad callsite with spaces', duration_ms: 1 }]
  });
  assert.equal(res.status, 400);
});

test('POST /browser-perf: negative duration_ms → 400', async () => {
  const res = await request(app).post(BP_URL).set('Authorization', AUTH).send({
    measurements: [{ ts_unix_ms: Date.now(), callsite: 'cost.mean7d', duration_ms: -5 }]
  });
  assert.equal(res.status, 400);
});

test('POST /browser-perf: no Bearer → 401', async () => {
  const res = await request(app).post(BP_URL).send({
    measurements: [{ ts_unix_ms: Date.now(), callsite: 'cost.mean7d', duration_ms: 1 }]
  });
  assert.equal(res.status, 401);
});

test('rollupCallsites + textfile: computes per-callsite P50/P95/P99', async () => {
  // Insert 100 measurements for one callsite
  const now = Date.now();
  const measurements = Array.from({ length: 100 }, (_, i) => ({
    ts_unix_ms: now - i, callsite: 'test.rollup', duration_ms: i + 1
  }));
  await request(app).post(BP_URL).set('Authorization', AUTH).send({ measurements });
  const stats = instrumentRoutes.__rollupCallsites();
  const s = stats.get('test.rollup');
  assert.ok(s, 'rollup must have test.rollup callsite');
  assert.equal(s.count, 100);
  assert.ok(s.p50 >= 49 && s.p50 <= 51, `p50 ~50, got ${s.p50}`);
  assert.ok(s.p95 >= 94 && s.p95 <= 96, `p95 ~95, got ${s.p95}`);
  assert.ok(s.p99 >= 98 && s.p99 <= 100, `p99 ~99, got ${s.p99}`);
});

test('writeBrowserPerfTextfile: emits Prom metric lines per callsite', async () => {
  const now = Date.now();
  await request(app).post(BP_URL).set('Authorization', AUTH).send({
    measurements: [
      { ts_unix_ms: now, callsite: 'tf.test', duration_ms: 100 },
      { ts_unix_ms: now, callsite: 'tf.test', duration_ms: 200 }
    ]
  });
  instrumentRoutes.__writeBrowserPerfTextfile();
  const tf = fs.readFileSync(path.join(textfileDir, 'browser-perf.prom'), 'utf-8');
  assert.match(tf, /yaklog_browser_perf_p50_seconds\{callsite="tf\.test"\}/);
  assert.match(tf, /yaklog_browser_perf_p95_seconds\{callsite="tf\.test"\}/);
  assert.match(tf, /yaklog_browser_perf_p99_seconds\{callsite="tf\.test"\}/);
  assert.match(tf, /yaklog_browser_perf_count\{callsite="tf\.test"\} 2/);
});
