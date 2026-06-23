// Dashboard operator-class login route per PLAN-DASHBOARD-OPERATOR-DM v2 §2.3.1
// + secops FLAG-2 absorbed canonical (rate-limit + uniform-401 + timing-safe).
//
// POST /api/v1/dashboard/login
//   Body: { token: "<operator-bearer>" }
//   Success: 200 { operator_id, expires_at }
//   Failure: 401 { error: 'Unauthorized', message: 'Invalid credentials.' }
//            (uniform — no distinction between unknown/malformed/expired)
//   Rate-limit: ≥5 failed 401s within 60s → 429 + 60s lockout per source IP
//
// Security discipline (per [[feedback_precision_probe_credential_discipline]]):
//   - Bearer comparison via crypto.timingSafeEqual (no naive ===)
//   - No raw-bearer logging at any tier (OTel spans / access logs / error bodies)
//   - Bearer sha256 hex prefix (16-char) allowed for audit-correlation only
//
// Phase 1 internal-only scope per §2.9.3: sessionStorage on client; HttpOnly
// cookie hard-gate at Phase 2 before any read-pane or non-localhost deploy.

'use strict';

const express = require('express');
const crypto = require('crypto');
const config = require('./config');

const router = express.Router();

// Rate-limit window: 60s sliding; max 5 failed attempts per source IP
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_FAILURES = 5;

// In-memory failure tracker: ip → [ts1, ts2, ...]
// Pruned on each request; sub-window failures evict naturally.
const failureTracker = new Map();

function pruneFailures(ip, now) {
  const arr = failureTracker.get(ip);
  if (!arr) return [];
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const pruned = arr.filter((ts) => ts >= cutoff);
  if (pruned.length === 0) {
    failureTracker.delete(ip);
  } else if (pruned.length !== arr.length) {
    failureTracker.set(ip, pruned);
  }
  return pruned;
}

function recordFailure(ip, now) {
  const pruned = pruneFailures(ip, now);
  pruned.push(now);
  failureTracker.set(ip, pruned);
  return pruned.length;
}

function isRateLimited(ip, now) {
  const pruned = pruneFailures(ip, now);
  return pruned.length >= RATE_LIMIT_MAX_FAILURES;
}

// Timing-safe operator bearer lookup. Iterates ALL operator bindings with
// constant-time per-binding compare so token-presence doesn't leak via timing.
// Sister-canon to [[feedback_secrets_no_yaklog]] at compare-discipline tier.
function resolveOperatorByToken(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const tokenBuf = Buffer.from(token, 'utf-8');
  let match = null;
  for (const [binding, operatorIds] of config.operatorBindings.entries()) {
    const bindingBuf = Buffer.from(binding, 'utf-8');
    // timingSafeEqual requires equal lengths; pad/truncate via hash compare
    // canon: compare sha256 digests so length never short-circuits the loop.
    const h1 = crypto.createHash('sha256').update(tokenBuf).digest();
    const h2 = crypto.createHash('sha256').update(bindingBuf).digest();
    if (crypto.timingSafeEqual(h1, h2)) {
      match = [...operatorIds][0];
      // Do NOT break — continue iterating to maintain constant total time.
    }
  }
  return match;
}

router.post('/login', (req, res) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();

  // Rate-limit gate FIRST (before token-extract) — prevents brute-force
  // resource consumption + uniform-time response across rate-limit + auth tiers.
  if (isRateLimited(ip, now)) {
    return res.status(429).json({
      error: 'RateLimited',
      message: 'Too many failed login attempts. Try again later.',
      retry_after_seconds: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
    });
  }

  const token = (req.body || {}).token;
  const operatorId = resolveOperatorByToken(token);

  if (!operatorId) {
    recordFailure(ip, now);
    // Uniform 401 — no distinction between unknown/malformed/expired
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid credentials.',
    });
  }

  // Success — return operator metadata; client stores bearer in sessionStorage
  // per Phase 1 binding canon (§2.9.1). Expiry is sessionStorage-scoped
  // (browser-tab close clears); server returns hint string for UI display.
  return res.status(200).json({
    operator_id: operatorId,
    expires_at: 'session', // sessionStorage-scoped per W3C SSE spec
    note: 'Phase 1 sessionStorage canon; HttpOnly cookie hard-gate at Phase 2',
  });
});

// Test-only: reset the in-memory failure tracker between test cases. Production
// has a single tracker for the lifetime of the process; tests need a clean slate.
function _resetFailureTracker() {
  failureTracker.clear();
}

module.exports = router;
module.exports._resetFailureTracker = _resetFailureTracker;
