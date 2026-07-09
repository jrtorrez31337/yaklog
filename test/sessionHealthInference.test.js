// Task #280 / PLAN-SESSION-HEALTH-SUBSTRATE §3.3 + §3.5: sessionHealthInference
// unit tests. Exercises the pure functions without a full app instance.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  HEALTH_CLASS,
  VALID_HEALTH_VALUES,
  DEFAULT_IDLE_STALENESS_S,
  computeEffectiveHealth,
  classifyHealth,
} = require('../src/sessionHealthInference');

test('§3.5 classify — 3-color collapse (s345-aieng #12243)', () => {
  assert.equal(classifyHealth('honest_idle'), 'GREEN');
  assert.equal(classifyHealth('pending_input'), 'AMBER');
  assert.equal(classifyHealth('quota_exceeded'), 'AMBER');
  assert.equal(classifyHealth('session_expired'), 'RED');
  assert.equal(classifyHealth('context_exhausted'), 'RED');
  assert.equal(classifyHealth('error_loop'), 'RED');
  assert.equal(classifyHealth('daemon_only'), 'RED');
  assert.equal(classifyHealth(null), null);
  assert.equal(classifyHealth('bogus_class'), null);
});

test('§3.4 valid enum values — all 7 classes accepted', () => {
  const expected = ['honest_idle', 'pending_input', 'quota_exceeded',
    'session_expired', 'context_exhausted', 'error_loop', 'daemon_only'];
  for (const v of expected) assert.ok(VALID_HEALTH_VALUES.has(v));
  assert.equal(VALID_HEALTH_VALUES.size, expected.length);
});

test('§3.5 effective — decommissioned row → null', () => {
  const row = {
    session_health: 'honest_idle', daemon_state: 'up',
    session_state: 'idle', last_hook_at: new Date().toISOString(),
    decommissioned_at: '2026-01-01T00:00:00Z',
  };
  assert.equal(computeEffectiveHealth(row), null);
});

test('§3.5 effective — daemon down → null', () => {
  const row = {
    session_health: 'honest_idle', daemon_state: 'down',
    session_state: 'idle', last_hook_at: new Date().toISOString(),
    decommissioned_at: null,
  };
  assert.equal(computeEffectiveHealth(row), null);
});

test('§3.5 effective — wrapper honest_idle + fresh hook → honest_idle (no override)', () => {
  const nowMs = Date.parse('2026-07-09T12:00:00Z');
  const row = {
    session_health: 'honest_idle', daemon_state: 'up',
    session_state: 'idle',
    last_hook_at: '2026-07-09T11:59:30Z',  // 30s ago
    decommissioned_at: null,
  };
  assert.equal(computeEffectiveHealth(row, nowMs), 'honest_idle');
});

test('§3.5 OQ4 — structural daemon_only overrides stale wrapper claim', () => {
  const nowMs = Date.parse('2026-07-09T12:00:00Z');
  const row = {
    session_health: 'honest_idle', daemon_state: 'up',
    session_state: 'idle',
    last_hook_at: '2026-07-09T11:00:00Z',  // 3600s ago — well past default 600s
    decommissioned_at: null,
  };
  assert.equal(computeEffectiveHealth(row, nowMs), 'daemon_only');
});

test('§3.5 daemon_only ELIGIBLE — active session_state does NOT trip override', () => {
  const nowMs = Date.parse('2026-07-09T12:00:00Z');
  const row = {
    session_health: null, daemon_state: 'up',
    session_state: 'tool_running',   // not in eligible set
    last_hook_at: '2026-07-09T11:00:00Z',
    decommissioned_at: null,
  };
  // active session with stale hook is SSE-stale territory, not daemon_only
  assert.equal(computeEffectiveHealth(row, nowMs), null);
});

test('§3.5 wrapper RED reported → RED preserved (structural does not downgrade)', () => {
  const nowMs = Date.parse('2026-07-09T12:00:00Z');
  const row = {
    session_health: 'session_expired', daemon_state: 'up',
    session_state: 'idle',
    last_hook_at: '2026-07-09T11:59:00Z',  // fresh, no structural override
    decommissioned_at: null,
  };
  assert.equal(computeEffectiveHealth(row, nowMs), 'session_expired');
});

test('§3.5 no wrapper report + fresh hook → null (unreported)', () => {
  const nowMs = Date.parse('2026-07-09T12:00:00Z');
  const row = {
    session_health: null, daemon_state: 'up',
    session_state: 'idle',
    last_hook_at: '2026-07-09T11:59:00Z',
    decommissioned_at: null,
  };
  assert.equal(computeEffectiveHealth(row, nowMs), null);
});

test('§3.5 no wrapper report + stale hook → daemon_only', () => {
  const nowMs = Date.parse('2026-07-09T12:00:00Z');
  const row = {
    session_health: null, daemon_state: 'up',
    session_state: 'idle',
    last_hook_at: '2026-07-09T11:00:00Z',
    decommissioned_at: null,
  };
  assert.equal(computeEffectiveHealth(row, nowMs), 'daemon_only');
});

test('§3.5 default staleness constant', () => {
  assert.equal(DEFAULT_IDLE_STALENESS_S, 600);
});
