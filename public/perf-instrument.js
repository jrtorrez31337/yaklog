// CP16 Pillar 0 Phase B (browser side) per PLAN-CP16-PILLAR-0-AMENDMENT.
//
// Browser-side performance instrumentation. Exposes window.PerfInstrument
// with start/end/wrap/flush API. Callsite wraps in dashboard.js (separate
// sub-cycle) call this module to record per-callsite timing. Buffered
// batches POST to /api/v1/instrument/browser-perf via navigator.sendBeacon
// every 30s OR on visibilitychange:hidden (Q2 SSE sister-canon — flush
// before browser unloads / tab hides so no measurements are lost).
//
// Per parch ratify #10691 + Phase A Gate (4) close #10716. Phase B server
// endpoint shipped at yaklog@17a1950; this module ships the producer side
// independently so dashboard.js can adopt wraps incrementally once the
// server endpoint deploys (ssw-devops Gate 2 bundled rebuild).

(() => {
  'use strict';

  // Buffer of pending measurements. Each entry:
  //   { ts_unix_ms, session_id, agent_id, callsite, duration_ms, n_rows? }
  const buffer = [];
  const MAX_BUFFER = 500;          // server caps batch at 500
  const FLUSH_INTERVAL_MS = 30000; // 30s; per ssw-devops A2 default cadence
  const ENDPOINT = '/api/v1/instrument/browser-perf';

  // Session id derived once per page load. Bounded cardinality.
  const sessionId = (function genSessionId() {
    try {
      const arr = new Uint8Array(8);
      crypto.getRandomValues(arr);
      return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return String(Date.now()) + '-' + Math.floor(Math.random() * 1e6).toString(36);
    }
  })();

  // Read operator credentials from Dashboard-DM Phase A sessionStorage shape
  // (per dashboard.js YaklogOperatorDM module). Same storage keys; same auth
  // model. Per secops #10719 flag: sendBeacon can't set Authorization header,
  // so without bearer read at flush time the auth-wrapped endpoint 401s
  // silently. Reading per-flush also picks up post-login session activation
  // without restart.
  const STORAGE_KEY_BEARER = 'yaklog_operator_bearer';
  const STORAGE_KEY_OP = 'yaklog_operator_id';
  function getBearer() {
    try { return sessionStorage.getItem(STORAGE_KEY_BEARER) || null; }
    catch { return null; }
  }
  function getAgentId() {
    try { return sessionStorage.getItem(STORAGE_KEY_OP) || null; }
    catch { return null; }
  }

  function record(callsite, durationMs, nRows) {
    if (typeof callsite !== 'string' || !callsite) return;
    if (typeof durationMs !== 'number' || !isFinite(durationMs) || durationMs < 0) return;
    if (buffer.length >= MAX_BUFFER) buffer.shift(); // drop oldest if cap hit
    buffer.push({
      ts_unix_ms: Date.now(),
      session_id: sessionId,
      agent_id: getAgentId(),
      callsite,
      duration_ms: durationMs,
      n_rows: (typeof nRows === 'number' && isFinite(nRows)) ? nRows : undefined,
    });
  }

  // High-resolution start/end pair. Returns the timing handle id; pass to
  // end() to record. Falls back to Date.now() if performance.now unavailable.
  let nextHandle = 1;
  const openHandles = new Map(); // handle -> { callsite, startMs }
  function start(callsite) {
    const handle = nextHandle++;
    const startMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    openHandles.set(handle, { callsite, startMs });
    return handle;
  }
  function end(handle, nRows) {
    const h = openHandles.get(handle);
    if (!h) return;
    openHandles.delete(handle);
    const nowMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    record(h.callsite, nowMs - h.startMs, nRows);
  }

  // Sync wrap: PerfInstrument.wrap('callsite', () => { ... }). Returns fn result.
  function wrap(callsite, fn, nRowsExtractor) {
    const h = start(callsite);
    try {
      const result = fn();
      // Promise? defer recording until resolved.
      if (result && typeof result.then === 'function') {
        return result.then(
          (v) => { end(h, nRowsExtractor ? nRowsExtractor(v) : undefined); return v; },
          (e) => { end(h); throw e; }
        );
      }
      end(h, nRowsExtractor ? nRowsExtractor(result) : undefined);
      return result;
    } catch (e) {
      end(h);
      throw e;
    }
  }

  // Flush buffer to server via fetch + keepalive. Per secops #10719: dropped
  // sendBeacon path because it can't set Authorization header; the auth-
  // wrapped endpoint would 401 silently. Fetch+keepalive supports custom
  // headers AND survives page-unload (modern browser standard; the canonical
  // sendBeacon replacement). If no bearer available, skip the flush — no
  // point firing into 401. Returns true if flush attempted; false otherwise.
  function flush() {
    if (buffer.length === 0) return false;
    const bearer = getBearer();
    if (!bearer) return false; // pre-login or operator-class not active
    const batch = buffer.splice(0, buffer.length); // take all + clear
    const body = JSON.stringify({ measurements: batch });
    try {
      if (typeof fetch !== 'undefined') {
        fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + bearer,
          },
          body,
          keepalive: true,
        }).catch(() => { /* best-effort; silent */ });
        return true;
      }
    } catch {
      // best-effort; on hard failure restore and continue
      buffer.unshift(...batch);
    }
    return false;
  }

  // Periodic auto-flush
  let _flushTimer = null;
  function startAutoFlush() {
    if (_flushTimer) return;
    _flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
  }
  function stopAutoFlush() {
    if (_flushTimer) { clearInterval(_flushTimer); _flushTimer = null; }
  }

  // Visibility-pause sister-canon (Q2 SSE pause at cascade-prevention #10559):
  // flush + stop auto-flush when hidden; restart on visible. Beacons fire
  // reliably during the visibilitychange:hidden transition (per spec).
  function attachVisibilityFlush() {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        flush();
        stopAutoFlush();
      } else {
        startAutoFlush();
      }
    });
  }

  // Also flush on pagehide (unload-class event; sendBeacon's design target)
  function attachUnloadFlush() {
    if (typeof window === 'undefined') return;
    window.addEventListener('pagehide', flush);
  }

  // Public API
  const PerfInstrument = { start, end, wrap, flush, record };

  // Auto-start in browser context; tests can override via window.PERF_INSTRUMENT_NOAUTO.
  if (typeof window !== 'undefined') {
    window.PerfInstrument = PerfInstrument;
    if (!window.PERF_INSTRUMENT_NOAUTO) {
      startAutoFlush();
      attachVisibilityFlush();
      attachUnloadFlush();
    }
  }

  // Node test export (CommonJS fallback)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      PerfInstrument,
      __startAutoFlush: startAutoFlush,
      __stopAutoFlush: stopAutoFlush,
      __bufferLen: () => buffer.length,
      __reset: () => { buffer.length = 0; openHandles.clear(); stopAutoFlush(); },
    };
  }
})();
