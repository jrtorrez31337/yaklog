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
  DEFAULT_RUNTIME_BLOCKED_MAX_DAYS,
  sanitizeRuntimeBlockedUntil,
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

test('§3.5 effective — wrapper honest_idle + fresh session_health_at → honest_idle (no override)', () => {
  const nowMs = Date.parse('2026-07-09T12:00:00Z');
  const row = {
    session_health: 'honest_idle', session_health_at: '2026-07-09T11:59:30Z',
    daemon_state: 'up', session_state: 'idle',
    decommissioned_at: null,
  };
  assert.equal(computeEffectiveHealth(row, nowMs), 'honest_idle');
});

test('§3.5 OQ4 — structural daemon_only overrides stale wrapper claim', () => {
  const nowMs = Date.parse('2026-07-09T12:00:00Z');
  const row = {
    session_health: 'honest_idle', session_health_at: '2026-07-09T11:00:00Z',  // 3600s ago
    daemon_state: 'up', session_state: 'idle',
    decommissioned_at: null,
  };
  assert.equal(computeEffectiveHealth(row, nowMs), 'daemon_only');
});

test('§3.5 daemon_only ELIGIBLE — active session_state does NOT trip override', () => {
  const nowMs = Date.parse('2026-07-09T12:00:00Z');
  const row = {
    session_health: 'honest_idle', session_health_at: '2026-07-09T11:00:00Z',
    daemon_state: 'up',
    session_state: 'tool_running',   // not in eligible set
    decommissioned_at: null,
  };
  // active session with stale hook is SSE-stale territory, not daemon_only
  assert.equal(computeEffectiveHealth(row, nowMs), 'honest_idle');
});

test('§3.5 wrapper RED reported (fresh) → RED preserved (structural does not downgrade)', () => {
  const nowMs = Date.parse('2026-07-09T12:00:00Z');
  const row = {
    session_health: 'session_expired', session_health_at: '2026-07-09T11:59:00Z',
    daemon_state: 'up', session_state: 'idle',
    decommissioned_at: null,
  };
  assert.equal(computeEffectiveHealth(row, nowMs), 'session_expired');
});

test('§3.5 no wrapper report → null (never trip daemon_only on first-time silence)', () => {
  const nowMs = Date.parse('2026-07-09T12:00:00Z');
  const row = {
    session_health: null, session_health_at: null,
    daemon_state: 'up', session_state: 'idle',
    decommissioned_at: null,
  };
  // Un-observed agent may be honest_idle / install-gap / dead — don't
  // cry-wolf RED. Fail-safe to null per s345-aieng #12245.
  assert.equal(computeEffectiveHealth(row, nowMs), null);
});

test('§3.5 no wrapper report + very old hook → still null (no structural cry-wolf)', () => {
  const nowMs = Date.parse('2026-07-09T12:00:00Z');
  const row = {
    session_health: null, session_health_at: null,
    daemon_state: 'up', session_state: 'idle',
    decommissioned_at: null,
  };
  assert.equal(computeEffectiveHealth(row, nowMs), null);
});

test('§3.5 default staleness constant', () => {
  assert.equal(DEFAULT_IDLE_STALENESS_S, 600);
});

test('Task #282 — sanitizeRuntimeBlockedUntil clamps 2099 sentinel to null', () => {
  const nowMs = Date.parse('2026-07-09T12:00:00Z');
  assert.equal(
    sanitizeRuntimeBlockedUntil('2099-12-01T15:04:00+00:00', nowMs),
    null,
    '2099-year placeholder = sentinel, should clamp'
  );
});

test('Task #282 — near-future timestamp (within 30d) passes through', () => {
  const nowMs = Date.parse('2026-07-09T12:00:00Z');
  const in7d = '2026-07-16T12:00:00Z';
  assert.equal(sanitizeRuntimeBlockedUntil(in7d, nowMs), in7d);
});

test('Task #282 — past timestamp passes through (already-cleared block)', () => {
  const nowMs = Date.parse('2026-07-09T12:00:00Z');
  const yesterday = '2026-07-08T12:00:00Z';
  assert.equal(sanitizeRuntimeBlockedUntil(yesterday, nowMs), yesterday);
});

test('Task #282 — null / non-string / unparseable → null (fail-safe)', () => {
  assert.equal(sanitizeRuntimeBlockedUntil(null), null);
  assert.equal(sanitizeRuntimeBlockedUntil(undefined), null);
  assert.equal(sanitizeRuntimeBlockedUntil(1234567890), null);
  assert.equal(sanitizeRuntimeBlockedUntil('not-a-date'), null);
});

test('Task #282 — default max-days constant', () => {
  assert.equal(DEFAULT_RUNTIME_BLOCKED_MAX_DAYS, 30);
});
