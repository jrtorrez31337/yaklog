// Per-route-family concurrency limit middleware per PLAN-DASHBOARD-OPERATOR-DM
// banking #10535 + cascade-prevention substrate-design Option (b).
//
// Rationale: dashboard #audit poll-storm + yaklog-streamer Prom queries
// combined saturate the main event loop → writer-lock starvation →
// cascade. Per-route in-flight cap eliminates this by-construction:
// excess requests get 429 + Retry-After instead of queueing on the event
// loop. Sister-canon to dashboardLoginRoute rate-limit (request-rate);
// this is in-flight-concurrency, distinct + complementary.
//
// Defense pattern: count requests entering each route-family; reject when
// already-N in-flight; decrement on res.finish or res.close.

'use strict';

function createConcurrencyLimiter({ maxInFlight = 4, retryAfterS = 5, name = 'route' } = {}) {
  let inFlight = 0;
  let totalRejected = 0;
  let totalAccepted = 0;

  function middleware(req, res, next) {
    if (inFlight >= maxInFlight) {
      totalRejected += 1;
      res.setHeader('Retry-After', String(retryAfterS));
      return res.status(429).json({
        error: 'TooManyConcurrentRequests',
        message: `Route family '${name}' is at concurrency limit (${maxInFlight}). Retry after ${retryAfterS}s.`,
        retry_after_seconds: retryAfterS,
        route_family: name,
      });
    }
    inFlight += 1;
    totalAccepted += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight -= 1;
    };
    res.on('finish', release);
    res.on('close', release);
    return next();
  }

  middleware.stats = () => ({ name, inFlight, totalAccepted, totalRejected, maxInFlight });
  middleware._resetForTest = () => { inFlight = 0; totalRejected = 0; totalAccepted = 0; };
  return middleware;
}

module.exports = { createConcurrencyLimiter };
