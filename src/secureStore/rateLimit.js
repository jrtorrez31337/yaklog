// Task #138 Phase 2A per-agent rate-limit per secops #10249 Cond 6 + OQ-4 lean
// (10/hr/agent default per secops). Tier-1 bearer + repeated GET = key-exposure
// amplifier; rate-limit protects against compromised-token mass-fetch scenario.
//
// In-memory token-bucket per agent_id. NOT shared across yaklog replicas (single
// yaklog instance assumption; if horizontally-scaled, would need Redis or shared
// store — forward-track per OQ-4 horizontal-scale forward-track).
//
// Window: rolling 1-hour (3600s). Refill: each request consumes 1 token from
// bucket of size=DEFAULT_LIMIT; bucket refills proportionally with time.

'use strict';

const DEFAULT_LIMIT = Number(process.env.YAKLOG_VENDOR_KEY_RATE_LIMIT) || 10;
const WINDOW_MS = 3600 * 1000;  // 1 hour rolling window

// agent_id -> { tokens, lastRefillAt }
const buckets = new Map();

function consumeToken(agentId, now = Date.now()) {
  if (typeof agentId !== 'string' || agentId.length === 0) {
    return { allowed: false, reason: 'invalid-agent-id', remaining: 0 };
  }
  let bucket = buckets.get(agentId);
  if (!bucket) {
    bucket = { tokens: DEFAULT_LIMIT, lastRefillAt: now };
    buckets.set(agentId, bucket);
  }
  // Refill: proportional to elapsed time
  const elapsed = now - bucket.lastRefillAt;
  if (elapsed > 0) {
    const refilled = (elapsed / WINDOW_MS) * DEFAULT_LIMIT;
    bucket.tokens = Math.min(DEFAULT_LIMIT, bucket.tokens + refilled);
    bucket.lastRefillAt = now;
  }
  if (bucket.tokens < 1) {
    return {
      allowed: false,
      reason: 'rate-limit-exceeded',
      remaining: 0,
      limit: DEFAULT_LIMIT,
      window_ms: WINDOW_MS,
    };
  }
  bucket.tokens -= 1;
  return {
    allowed: true,
    remaining: Math.floor(bucket.tokens),
    limit: DEFAULT_LIMIT,
    window_ms: WINDOW_MS,
  };
}

// Test-only: reset all buckets.
function _resetForTests() {
  buckets.clear();
}

module.exports = {
  consumeToken,
  _resetForTests,
  _internals: { DEFAULT_LIMIT, WINDOW_MS },
};
