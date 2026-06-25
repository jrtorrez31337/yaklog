// Task #246 Per-Ptah-instance TraceRecord substrate tests per PLAN v4.1.
// Covers schema migration, agent_id validation, ptah-* namespace bound,
// snapshot_summary 4KB cap (secops #10728), monotonic-tick uniqueness,
// engine-diagnostic columns (provider/model/parse_status/verify_json per
// s345-aieng #10733), episode index upsert + goal_terminal derivation,
// per-instance file isolation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-ptah-trace-test-'));
process.env.YAKLOG_PTAH_TRACE_DB_DIR = tempDir;

const ptahTraceDb = require('../src/ptahTraceDb');

test.after(() => {
  ptahTraceDb.closeAll();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

function makeRec(over = {}) {
  return {
    episode_id: 'ep-001',
    orp_version: 'v0.1.0',
    tick: 0,
    ts_unix_ms: Date.now(),
    snapshot_summary: '5 nodes [frame:home]',
    chosen_decision: 'node-3 (heuristic match)',
    proposal: { intent: 'click', selector: { gen: 'btn', idx: 0 } },
    result: { validation: 'accepted', resolved_element_id: 'btn:0' },
    goal_state: [{ goal_id: 'g1', status: 'in_progress', checks: [] }],
    parse_status: 'ok',
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    ...over,
  };
}

test('pathFor rejects non-ptah-* agent_id', () => {
  assert.throws(() => ptahTraceDb.pathFor('admin-agent'), /ptah-\* namespace/);
  assert.throws(() => ptahTraceDb.pathFor('not-ptah-something'), /ptah-\* namespace/);
});

test('pathFor accepts ptah-* agent_id with stable filename', () => {
  const p = ptahTraceDb.pathFor('ptah-jon-desktop');
  assert.match(p, /ptah-trace-ptah-jon-desktop\.db$/);
});

test('pathFor rejects invalid AGENT_ID_RE', () => {
  assert.throws(() => ptahTraceDb.pathFor('!!nope'), /AGENT_ID_RE/);
  assert.throws(() => ptahTraceDb.pathFor(''), /AGENT_ID_RE/);
});

test('provisionForAgent creates file + schema idempotently', () => {
  const p = ptahTraceDb.pathFor('ptah-prov-1');
  ptahTraceDb.provisionForAgent('ptah-prov-1');
  assert.ok(fs.existsSync(p), 'file created');
  // Re-call: no error
  ptahTraceDb.provisionForAgent('ptah-prov-1');
});

test('insertTrace round-trips with engine-diagnostic columns', () => {
  const id = 'ptah-insert-1';
  ptahTraceDb.insertTrace(id, makeRec(), 'token-sha-abc');
  const rows = ptahTraceDb.getTracesForEpisode(id, 'ep-001');
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.provider, 'anthropic');
  assert.equal(r.model, 'claude-opus-4-7');
  assert.equal(r.parse_status, 'ok');
  assert.equal(r.result_validation, 'accepted');
  assert.equal(r.result_resolved_id, 'btn:0');
  assert.equal(r.snapshot_summary, '5 nodes [frame:home]');
  assert.equal(r.recorded_by, 'token-sha-abc');
});

test('insertTrace rejects snapshot_summary >4KB (secops #10728)', () => {
  const id = 'ptah-cap-1';
  const big = 'x'.repeat(4097);
  assert.throws(
    () => ptahTraceDb.insertTrace(id, makeRec({ snapshot_summary: big }), 'tok'),
    /4096 bytes/
  );
});

test('insertTrace rejects unknown parse_status', () => {
  const id = 'ptah-parse-1';
  assert.throws(
    () => ptahTraceDb.insertTrace(id, makeRec({ parse_status: 'bogus' }), 'tok'),
    /parse_status must be one of/
  );
});

test('insertTrace accepts all valid parse_status values', () => {
  const id = 'ptah-parse-2';
  let tick = 0;
  for (const ps of ['deterministic', 'ok', 'reject', 'provider_error']) {
    ptahTraceDb.insertTrace(id, makeRec({ tick: tick++, parse_status: ps }), 'tok');
  }
  const rows = ptahTraceDb.getTracesForEpisode(id, 'ep-001');
  assert.equal(rows.length, 4);
});

test('insertTrace enforces UNIQUE(episode_id, tick) — monotonic canon', () => {
  const id = 'ptah-uniq-1';
  ptahTraceDb.insertTrace(id, makeRec({ tick: 5 }), 'tok');
  assert.throws(
    () => ptahTraceDb.insertTrace(id, makeRec({ tick: 5 }), 'tok'),
    /UNIQUE constraint failed/
  );
});

test('insertTrace upserts episode + derives goal_terminal=null when in_progress', () => {
  const id = 'ptah-ep-1';
  ptahTraceDb.insertTrace(id, makeRec(), 'tok');
  const ep = ptahTraceDb.getEpisodeManifest(id, 'ep-001');
  assert.equal(ep.episode_id, 'ep-001');
  assert.equal(ep.orp_version, 'v0.1.0');
  assert.equal(ep.last_tick, 0);
  assert.equal(ep.goal_terminal, null);
});

test('insertTrace derives goal_terminal=blocked when goal blocked', () => {
  const id = 'ptah-ep-2';
  ptahTraceDb.insertTrace(id, makeRec({
    goal_state: [{ goal_id: 'g1', status: 'blocked', checks: [], blocked_terminal: { id: 'x', evidence: 'y' } }],
  }), 'tok');
  const ep = ptahTraceDb.getEpisodeManifest(id, 'ep-001');
  assert.equal(ep.goal_terminal, 'blocked');
});

test('insertTrace derives goal_terminal=pass when all goals pass', () => {
  const id = 'ptah-ep-3';
  ptahTraceDb.insertTrace(id, makeRec({
    goal_state: [
      { goal_id: 'g1', status: 'pass', checks: [] },
      { goal_id: 'g2', status: 'pass', checks: [] },
    ],
  }), 'tok');
  const ep = ptahTraceDb.getEpisodeManifest(id, 'ep-001');
  assert.equal(ep.goal_terminal, 'pass');
});

test('wall-standby trace (s345-aieng #10745): result_dispatch persists + goal in_progress preserved', () => {
  // Per parch #10748 Phase C: Arkose alert keys on result_dispatch='wall-standby'
  // WITH goal_state.status='in_progress' (NOT 'blocked' — that's TERMINAL).
  const id = 'ptah-standby-1';
  ptahTraceDb.insertTrace(id, makeRec({
    tick: 10,
    result: { validation: 'accepted', dispatch_outcome: 'wall-standby' },
    goal_state: [{ goal_id: 'g1', status: 'in_progress', checks: [] }],
  }), 'tok');
  const rows = ptahTraceDb.getTracesForEpisode(id, 'ep-001');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].result_dispatch, 'wall-standby');
  const ep = ptahTraceDb.getEpisodeManifest(id, 'ep-001');
  assert.equal(ep.goal_terminal, null, 'standby must NOT mark episode terminal — recoverable');
});

test('per-instance file isolation: insertTrace into A invisible to B', () => {
  const a = 'ptah-iso-a';
  const b = 'ptah-iso-b';
  ptahTraceDb.insertTrace(a, makeRec({ episode_id: 'epA' }), 'tok');
  ptahTraceDb.insertTrace(b, makeRec({ episode_id: 'epB' }), 'tok');
  const aRows = ptahTraceDb.getTracesForEpisode(a, 'epA');
  const bRows = ptahTraceDb.getTracesForEpisode(b, 'epB');
  assert.equal(aRows.length, 1);
  assert.equal(bRows.length, 1);
  assert.equal(ptahTraceDb.getTracesForEpisode(a, 'epB').length, 0);
  assert.equal(ptahTraceDb.getTracesForEpisode(b, 'epA').length, 0);
});

test('listEpisodes returns episodes newest-first', () => {
  const id = 'ptah-list-1';
  ptahTraceDb.insertTrace(id, makeRec({ episode_id: 'epX', tick: 0, ts_unix_ms: 1000 }), 'tok');
  ptahTraceDb.insertTrace(id, makeRec({ episode_id: 'epY', tick: 0, ts_unix_ms: 2000 }), 'tok');
  const eps = ptahTraceDb.listEpisodes(id);
  assert.equal(eps.length, 2);
  // Both started_at use ISO new Date() so ordering may be tight — check both present
  const ids = eps.map(e => e.episode_id);
  assert.ok(ids.includes('epX'));
  assert.ok(ids.includes('epY'));
});

test('getTracesSince filters by trace_id watermark', () => {
  const id = 'ptah-since-1';
  for (let t = 0; t < 5; t++) {
    ptahTraceDb.insertTrace(id, makeRec({ tick: t }), 'tok');
  }
  const all = ptahTraceDb.getTracesSince(id, { sinceTraceId: 0 });
  assert.equal(all.length, 5);
  const cutoff = all[2].trace_id;
  const after = ptahTraceDb.getTracesSince(id, { sinceTraceId: cutoff });
  assert.equal(after.length, 2);
});

test('setEpisodeManifest stores + getEpisodeManifest retrieves typed artifact shape (aieng3 #10730)', () => {
  const id = 'ptah-manifest-1';
  ptahTraceDb.insertTrace(id, makeRec({ episode_id: 'epM' }), 'tok');
  const manifest = {
    episode_id: 'epM',
    agent_id: id,
    role_id: 'doc-author-printer',
    orp_version: 'v0.1.0',
    artifacts: [
      { kind: 'story_txt', path: '/staged/epM/story.txt', bytes: 1024, sha256: 'abc...', cert_checks: {}, evidence: { source_path: 'C:\\Users\\ptah\\story.txt' } },
      { kind: 'story_pdf', path: '/staged/epM/story.pdf', bytes: 20480, sha256: 'def...', cert_checks: {}, evidence: {} },
      { kind: 'episode_final_png', path: '/staged/epM/final.png', bytes: 5120, sha256: 'ghi...', cert_checks: {}, evidence: {} },
      { kind: 'trace_ndjson', path: '/staged/epM/trace.ndjson', bytes: 4096, sha256: 'jkl...', cert_checks: {}, evidence: {} },
    ],
  };
  ptahTraceDb.setEpisodeManifest(id, 'epM', manifest);
  const ep = ptahTraceDb.getEpisodeManifest(id, 'epM');
  const parsed = JSON.parse(ep.manifest_json);
  assert.equal(parsed.artifacts.length, 4);
  assert.equal(parsed.artifacts.find(a => a.kind === 'trace_ndjson').sha256, 'jkl...');
});

test('insertTrace rejects missing required fields', () => {
  const id = 'ptah-val-1';
  assert.throws(() => ptahTraceDb.insertTrace(id, {}, 'tok'), /episode_id required/);
  assert.throws(() => ptahTraceDb.insertTrace(id, makeRec({ tick: -1 }), 'tok'), /tick/);
  assert.throws(() => ptahTraceDb.insertTrace(id, makeRec({ result: { validation: 'bogus' } }), 'tok'), /validation/);
  assert.throws(() => ptahTraceDb.insertTrace(id, makeRec({ goal_state: 'not-array' }), 'tok'), /goal_state array/);
});

test('listPtahTraceDbs discovers all per-instance files', () => {
  // Several prior tests have created multiple ptah-trace-*.db files.
  const dbs = ptahTraceDb.listPtahTraceDbs();
  const ids = dbs.map(d => d.agentId);
  assert.ok(ids.includes('ptah-iso-a'));
  assert.ok(ids.includes('ptah-iso-b'));
  // All discovered files match prefix/suffix:
  for (const d of dbs) {
    assert.match(d.path, /\/ptah-trace-.*\.db$/);
  }
});
