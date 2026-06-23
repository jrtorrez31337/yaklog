const config = require('../config');

// Token authority resolver per Jon-direct 2026-05-19 dual-source auth.
// Returns: { allowedSenders: Set<string>|null, isRegistration: bool }
//   allowedSenders is null when token has no binding at all (legacy behavior:
//   skip binding check; treat as binding-exempt).
function resolveAllowedSenders(req) {
  if (!req.auth || !req.auth.token) return { allowedSenders: null, isRegistration: false };
  // Operator-class (ADR-0040 §4.2 + dashboard-DM PLAN §2.3 sister-canon Block-1):
  // operator-bearer allowedSenders is exactly the bound operator_id. Sister-shape
  // to /register-minted token path below — both bind a single identity.
  // Covers POST + PATCH + DELETE write-routes per secops FLAG-3 + parch Q8 RATIFY
  // canon-fold feedback_class_tier_sender_override_substantively_covers_all_write_routes_post_patch_delete.
  if (req.auth.source === 'operator' && req.auth.operatorId) {
    return { allowedSenders: new Set([req.auth.operatorId]), isRegistration: false };
  }
  // /register-minted token (path b): registration row IS the binding.
  if (req.auth.source === 'registration' && req.auth.registrationAgentId) {
    return { allowedSenders: new Set([req.auth.registrationAgentId]), isRegistration: true };
  }
  // Env-configured token (path a): YAKLOG_TOKEN_BINDINGS lookup.
  const allowed = config.tokenBindings.get(req.auth.token);
  return { allowedSenders: allowed || null, isRegistration: false };
}

function enforceSenderBinding(req, claimedSender) {
  const { allowedSenders } = resolveAllowedSenders(req);
  if (!allowedSenders) return null;  // unbound token; legacy permissive
  if (allowedSenders.has(claimedSender)) return null;
  return {
    status: 403,
    body: {
      error: 'SenderBindingViolation',
      message: 'Token is not authorized for the specified sender.'
    }
  };
}

function enforceMutationBinding(req, originalSender) {
  const { allowedSenders } = resolveAllowedSenders(req);
  if (!allowedSenders) return null;
  if (allowedSenders.has(originalSender)) return null;
  return {
    status: 403,
    body: {
      error: 'SenderBindingViolation',
      message: 'Token is not authorized to modify this message.'
    }
  };
}

module.exports = {
  enforceSenderBinding,
  enforceMutationBinding,
  resolveAllowedSenders
};
