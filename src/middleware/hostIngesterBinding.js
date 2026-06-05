// CP12.5 (2026-06-05): host-ingester binding enforcement per ADR-0030 v1.1
// Phase 1.5 + secops #7810 OQ#5 SIGNED OFF.
//
// Validates that the request bearer is bound to publish file-access events
// for the claimed host. Mirrors the daemon-binding shape (enforceDaemonBinding
// in src/middleware/daemonBinding.js) — same `host:token` CSV in env, same
// Map<token, Set<host>> data structure for one-to-many semantics.
//
// Per secops: dedicated `YAKLOG_HOST_INGESTER_BINDINGS` env. NOT shared with
// YAKLOG_DAEMON_BINDINGS (would conflate substrate-identity with agent-bus-
// identity). Token lives in the per-host plexus-audit-ingester service-account's
// EnvironmentFile.

const config = require('../config');

// Fail-CLOSED for unbound bearers (unlike daemon-binding which fail-opens for
// legacy compat). Per ADR-0030 v1.1 Phase 1.5 + secops #7810 OQ#5 SIGNED OFF:
// the host-ingester intake is a privileged-write surface; ANY bearer without
// an explicit host-binding gets 403, even if it's a valid YAKLOG_API_KEYS
// member. Mirrors ADR-0026 DM-filter fail-closed-for-unbound-bearers discipline.
function enforceHostIngesterBinding(req, claimedHost) {
  if (!req.auth || !req.auth.token) {
    return {
      status: 403,
      body: {
        error: 'HostIngesterBindingViolation',
        message: 'No authenticated bearer; host-ingester intake requires explicit host-binding.'
      }
    };
  }
  const allowedHosts = config.hostIngesterBindings.get(req.auth.token);
  if (!allowedHosts || !allowedHosts.has(claimedHost)) {
    return {
      status: 403,
      body: {
        error: 'HostIngesterBindingViolation',
        message: 'Token is not authorized to publish file-access events for the specified host.'
      }
    };
  }
  return null;
}

module.exports = { enforceHostIngesterBinding };
