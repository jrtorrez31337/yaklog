/**
 * yaklog-sub daemon end-to-end tests.
 *
 * Spawns the real Python daemon as a subprocess against a real yaklog
 * Express server bound to an ephemeral port and an ephemeral SQLite DB.
 * Verifies the eight behaviours documented in scripts/yaklog-sub.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-sub-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'test-key';
process.env.NODE_ENV = 'test';
process.env.YAKLOG_STREAM_KEEPALIVE_MS = '100';

const app = require('../src/app');
const { listMessages } = require('../src/db');

const TOKEN = 'test-key';
const TOKEN_FILE = path.join(tempDir, 'token');
fs.writeFileSync(TOKEN_FILE, TOKEN);

const DAEMON = path.resolve(__dirname, '..', 'scripts', 'yaklog-sub');

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function postMessage(port, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/v1/messages',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf));
          } catch (e) {
            reject(new Error(`bad post response: ${buf}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function spawnDaemon({ agentId, port, runtimeDir, aliases = '' }) {
  const env = {
    ...process.env,
    XDG_RUNTIME_DIR: runtimeDir
  };
  const child = spawn(
    'python3',
    [
      DAEMON,
      '--agent-id', agentId,
      '--aliases', aliases,
      '--url', `http://127.0.0.1:${port}/api/v1`,
      '--token-file', TOKEN_FILE
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stderr.on('data', (b) => process.stderr.write(`[daemon ${agentId}] ${b}`));
  return child;
}

function readEvents(stateDir) {
  const p = path.join(stateDir, 'events.ndjson');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

function readCursor(stateDir) {
  const p = path.join(stateDir, 'cursor');
  if (!fs.existsSync(p)) return 0;
  return parseInt(fs.readFileSync(p, 'utf8').trim(), 10);
}

function waitFor(predicate, timeoutMs = 3000, label = '') {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (predicate()) return resolve();
      } catch (e) { /* keep polling */ }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`waitFor timeout: ${label}`));
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

function setupAgentDir(agentId) {
  const runtimeDir = fs.mkdtempSync(path.join(tempDir, `xdg-${agentId}-`));
  const stateDir = path.join(runtimeDir, 'yaklog', agentId);
  fs.mkdirSync(stateDir, { recursive: true });
  // Seed cursor at current high-water-mark so tests are isolated from prior
  // messages in the shared DB. Daemon will only see messages posted after this.
  const recent = listMessages({ limit: 1 });
  const hwm = recent.length > 0 ? recent[0].id : 0;
  fs.writeFileSync(path.join(stateDir, 'cursor'), String(hwm));
  return { runtimeDir, stateDir, hwm };
}

async function killAndWait(child, signal = 'SIGTERM') {
  if (child.exitCode !== null) return;
  child.kill(signal);
  await new Promise((res) => child.on('exit', res));
}

test('T1: daemon writes events.ndjson and advances cursor', async () => {
  const server = await startServer();
  const { port } = server.address();
  const agentId = 't1-agent';
  const { runtimeDir, stateDir } = setupAgentDir(agentId);
  const daemon = spawnDaemon({ agentId, port, runtimeDir });

  await postMessage(port, { channel: 'work', sender: 'peer', body: `ping @${agentId}` });

  await waitFor(() => readEvents(stateDir).length >= 1, 3000, 'event in log');
  const events = readEvents(stateDir);
  assert.equal(events[0].body, `ping @${agentId}`);
  assert.equal(events[0].sender, 'peer');
  assert.ok(readCursor(stateDir) >= events[0].id, 'cursor advanced');

  await killAndWait(daemon);
  server.close();
});

test('T2: cursor does NOT advance for messages that were not appended (kill mid-flight is safe)', async () => {
  const server = await startServer();
  const { port } = server.address();
  const agentId = 't2-agent';
  const { runtimeDir, stateDir, hwm } = setupAgentDir(agentId);

  // First daemon catches one event then dies hard.
  const d1 = spawnDaemon({ agentId, port, runtimeDir });
  await postMessage(port, { channel: 'work', sender: 'peer', body: `first @${agentId}` });
  await waitFor(() => readCursor(stateDir) > hwm, 3000, 'first cursor');
  const cursorAfterFirst = readCursor(stateDir);
  assert.equal(readEvents(stateDir).length, 1);
  await killAndWait(d1, 'SIGKILL');

  // Send a second message while no daemon is running.
  const second = await postMessage(port, { channel: 'work', sender: 'peer', body: `second @${agentId}` });
  assert.ok(second.message.id > cursorAfterFirst);

  // Restart daemon — it should pick up exactly the missed message via since=cursor.
  const d2 = spawnDaemon({ agentId, port, runtimeDir });
  await waitFor(() => readEvents(stateDir).length === 2, 3000, 'second event in log after restart');
  const events = readEvents(stateDir);
  assert.equal(events.length, 2, 'no duplicate of first message on restart');
  assert.equal(events[0].body, `first @${agentId}`);
  assert.equal(events[1].body, `second @${agentId}`);

  await killAndWait(d2);
  server.close();
});

test('T3: second daemon for same agent-id refuses to start', async () => {
  const server = await startServer();
  const { port } = server.address();
  const agentId = 't3-agent';
  const { runtimeDir, stateDir } = setupAgentDir(agentId);

  const d1 = spawnDaemon({ agentId, port, runtimeDir });
  await waitFor(() => fs.existsSync(path.join(stateDir, 'lock')), 2000, 'lock created');

  const d2 = spawnDaemon({ agentId, port, runtimeDir });
  const exitCode = await new Promise((res) => d2.on('exit', res));
  assert.notEqual(exitCode, 0, 'second daemon should exit non-zero');

  await killAndWait(d1);
  // After d1 exits, a fresh daemon SHOULD be able to start (lock released).
  const d3 = spawnDaemon({ agentId, port, runtimeDir });
  await postMessage(port, { channel: 'work', sender: 'peer', body: `relaunch @${agentId}` });
  await waitFor(() => readEvents(stateDir).length >= 1, 3000, 'd3 caught event');

  await killAndWait(d3);
  server.close();
});

test('T4: clean SIGTERM exits 0 and releases lock', async () => {
  const server = await startServer();
  const { port } = server.address();
  const agentId = 't4-agent';
  const { runtimeDir, stateDir } = setupAgentDir(agentId);

  const d1 = spawnDaemon({ agentId, port, runtimeDir });
  await waitFor(() => fs.existsSync(path.join(stateDir, 'lock')), 2000, 'lock created');
  d1.kill('SIGTERM');
  const exitCode = await new Promise((res) => d1.on('exit', res));
  assert.equal(exitCode, 0, 'SIGTERM should exit 0');

  // Lock must be released — a successor must start cleanly.
  const d2 = spawnDaemon({ agentId, port, runtimeDir });
  await postMessage(port, { channel: 'work', sender: 'peer', body: `after-sigterm @${agentId}` });
  await waitFor(() => readEvents(stateDir).length >= 1, 3000, 'd2 caught event');

  await killAndWait(d2);
  server.close();
});

test('T5: mention filter is applied — non-matching messages do not appear', async () => {
  const server = await startServer();
  const { port } = server.address();
  const agentId = 't5-agent';
  const { runtimeDir, stateDir } = setupAgentDir(agentId);

  const daemon = spawnDaemon({ agentId, port, runtimeDir, aliases: 't5,t5alias' });

  await postMessage(port, { channel: 'work', sender: 'peer', body: 'no mention here' });
  await postMessage(port, { channel: 'work', sender: 'peer', body: `please @${agentId}` });
  await postMessage(port, { channel: 'work', sender: 'peer', body: 'hey @everyone' });

  await waitFor(() => readEvents(stateDir).length >= 2, 3000, 'mentions delivered');
  await new Promise((r) => setTimeout(r, 200)); // drain any extras
  const events = readEvents(stateDir);
  assert.equal(events.length, 2, 'only the two mention-matching messages');
  assert.ok(events.some((e) => e.body.includes(`@${agentId}`)));
  assert.ok(events.some((e) => e.body.includes('@everyone')));
  assert.ok(!events.some((e) => e.body === 'no mention here'));

  await killAndWait(daemon);
  server.close();
});

test('T6: exclude_sender prevents self-wake', async () => {
  const server = await startServer();
  const { port } = server.address();
  const agentId = 't6-agent';
  const { runtimeDir, stateDir } = setupAgentDir(agentId);

  const daemon = spawnDaemon({ agentId, port, runtimeDir });

  // A message *from* the agent itself, mentioning itself.
  await postMessage(port, { channel: 'work', sender: agentId, body: `self-talk @${agentId}` });
  // A message *from* another sender mentioning the agent.
  await postMessage(port, { channel: 'work', sender: 'peer', body: `peer @${agentId}` });

  await waitFor(() => readEvents(stateDir).length >= 1, 3000, 'peer message delivered');
  await new Promise((r) => setTimeout(r, 200));
  const events = readEvents(stateDir);
  assert.equal(events.length, 1, 'self-mention must not wake');
  assert.equal(events[0].sender, 'peer');

  await killAndWait(daemon);
  server.close();
});

test('T7: events.ndjson lines are parseable JSON with id/seq monotonic', async () => {
  const server = await startServer();
  const { port } = server.address();
  const agentId = 't7-agent';
  const { runtimeDir, stateDir } = setupAgentDir(agentId);

  const daemon = spawnDaemon({ agentId, port, runtimeDir });

  for (let i = 0; i < 5; i += 1) {
    await postMessage(port, { channel: 'work', sender: 'peer', body: `n${i} @${agentId}` });
  }
  await waitFor(() => readEvents(stateDir).length === 5, 4000, 'all 5 events delivered');
  const events = readEvents(stateDir);
  for (let i = 0; i < events.length; i += 1) {
    assert.equal(typeof events[i].id, 'number');
    assert.equal(typeof events[i].body, 'string');
    if (i > 0) assert.ok(events[i].id > events[i - 1].id, 'monotonic id');
  }
  assert.equal(readCursor(stateDir), events[events.length - 1].id);

  await killAndWait(daemon);
  server.close();
});
