// /register endpoints (ADR-0025 + ferry-canon).
//
// Mounted at /api/v1/register BEFORE the global Bearer auth middleware in
// app.js, because /register endpoints have heterogeneous auth requirements:
//   POST /register                 — open submission (NO Bearer required;
//                                    per ADR §Authority matrix "→ SUBMITTED:
//                                    any agent")
//   GET /register/<id>             — registrant-token (enforceRegistrantToken)
//   POST /register/<id>/activate   — registrant presents decrypted token as
//                                    Bearer; validated against minted token
//                                    (wave 2)
//   POST .../parch-review,
//   POST .../jon-ratify,
//   POST .../revoke                — parch-binding (enforceSenderBinding; wave 2)
//   GET  .../ciphertext            — op-key (enforceOpsKey for ferry-group
//                                    FALLBACK path) OR registrant-token (PRIMARY
//                                    pull path; wave 2)
//   POST .../ferry-complete        — op-key (enforceOpsKey; wave 2)
//
// Wave 1 (this commit): POST /register, GET /register/<id>.

const express = require('express');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const config = require('./config');
const {
  insertRegistration,
  getRegistration,
  getRegistrationByAgent,
  insertRegistrationEvent,
  updateRegistration,
  insertAuditCredentialChange
} = require('./db');
const { enforceRegistrantToken } = require('./middleware/registrantToken');
const { enforceOpsKey } = require('./middleware/opsKey');
const auth = require('./middleware/auth');
const { enforceSenderBinding, resolveAllowedSenders } = require('./middleware/senderBinding');
// Task #137 Phase B per parch #10266 Q2+Q3 ratify: at /register-transition-to-
// ACTIVE, pre-provision per-Ptah-agent audit SQLite file when submission
// declares runtime_class='ptah'. Q2 ratify: "at /register pre-provisioned +
// clean first-POST latency". Hooked at ACTIVATE (vs SUBMITTED) gives
// just-in-time provision + post-rejection-window clean lifecycle (REJECTED
// registrations never get a stray DB file). PTAH_AGENT_ID_RE namespace bound
// is enforced inside ptahAuditDb.provisionForAgent() (defense-in-depth per
// /register sub-OQ Option (c) trusted-runtime bootstrap discipline).
const ptahAuditDb = require('./ptahAuditDb');
const ptahTraceDb = require('./ptahTraceDb');  // Task #246 sister-shape per-Ptah-instance trace substrate
// Path Y per parch #10658: at /activate, provision operator_records row when
// submission declares session_class='operator'. Sister-canon to ptahAuditDb
// provisioning at runtime_class='ptah'. Closes the Phase A scope-gap from #10650.
const plexusSecureDb = require('./plexusSecureDb');

const router = express.Router();

const AGENT_ID_RE = /^[a-zA-Z0-9._:@/-]{1,64}$/;
// age recipient: bech32 "age1" + 58 chars (lowercase a-z + 0-9, restricted).
const AGE_RECIPIENT_RE = /^age1[a-z0-9]{58}$/;

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf-8').digest('hex');
}

function shaPrefix(s) {
  return sha256Hex(s).slice(0, 16);
}

// Strip secret-class fields from registration row before returning to client.
// registrant_token_hash + ciphertext_b64 are NEVER returned via GET; ciphertext
// is served via separate /ciphertext endpoint (wave 2) with its own auth gate.
function publicRegistrationView(reg) {
  if (!reg) return null;
  return {
    registration_id: reg.registration_id,
    agent_id: reg.agent_id,
    status: reg.status,
    registrant_pubkey: reg.registrant_pubkey,
    registrant_pubkey_sha256_prefix: shaPrefix(reg.registrant_pubkey),
    justification: reg.justification_json ? JSON.parse(reg.justification_json) : null,
    submission: reg.submission_json ? JSON.parse(reg.submission_json) : null,
    ratified_by: reg.ratified_by,
    ratified_at: reg.ratified_at,
    ferried_by: reg.ferried_by,
    ferried_at: reg.ferried_at,
    activated_at: reg.activated_at,
    revoked_at: reg.revoked_at,
    revoked_reason: reg.revoked_reason,
    rejected_reason: reg.rejected_reason,
    created_at: reg.created_at,
    updated_at: reg.updated_at
  };
}

// POST / — registrant submits a new registration proposal. Open (no Bearer).
// Body: { agent_id, registrant_pubkey, submission: { ... candidate self-description ... } }
// Returns: { registration_id, registration_access_token, status }
//
// registration_access_token is returned ONCE here (synchronous HTTP body;
// never on yaklog bus). Server stores only sha256 hash. Registrant retains
// for use until ACTIVE per ferry-canon §4a.
router.post('/', (req, res) => {
  const { agent_id, registrant_pubkey, submission } = req.body || {};

  if (typeof agent_id !== 'string' || !AGENT_ID_RE.test(agent_id)) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'agent_id is required and must match [a-zA-Z0-9._:@/-] (1-64 chars).'
    });
  }
  if (typeof registrant_pubkey !== 'string' || !AGE_RECIPIENT_RE.test(registrant_pubkey)) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'registrant_pubkey is required and must be an age X25519 recipient (format: age1 + 58 bech32 chars).'
    });
  }
  if (!submission || typeof submission !== 'object') {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'submission is required and must be an object (candidate self-description per ADR-0025 §1).'
    });
  }

  // ADR §Defaults+invariants: ≤1 non-terminal registration per agent_id at a time.
  const existing = getRegistrationByAgent(agent_id);
  if (existing) {
    return res.status(409).json({
      error: 'Conflict',
      message: `agent_id ${agent_id} already has a non-terminal registration (${existing.registration_id} status=${existing.status}). Wait for terminal state or revoke before re-submitting.`,
      existing_registration_id: existing.registration_id,
      existing_status: existing.status
    });
  }

  const registration_id = crypto.randomUUID();
  const registration_access_token = crypto.randomBytes(32).toString('base64url');
  const registrant_token_hash = sha256Hex(registration_access_token);

  insertRegistration({
    registration_id,
    agent_id,
    registrant_pubkey,
    registrant_token_hash,
    submission_json: JSON.stringify(submission)
  });

  insertRegistrationEvent({
    registration_id,
    agent_id,
    event_type: 'SUBMITTED',
    actor: 'registrant',
    registrant_pubkey_sha256_prefix: shaPrefix(registrant_pubkey),
    metadata: { from_ip: req.ip }
  });

  return res.status(201).json({
    registration_id,
    registration_access_token,
    status: 'SUBMITTED',
    note: 'Capture both registration_id AND registration_access_token now -- the access token is returned ONCE here and not retrievable later. Use it for GET /register/<id> status polling and (after FERRIED) GET /register/<id>/ciphertext.'
  });
});

// GET /:id — fetch registration state. Registrant-token-gated.
router.get('/:id', enforceRegistrantToken, (req, res) => {
  return res.status(200).json({ registration: publicRegistrationView(req.registration) });
});

// ============================================================================
// Wave-2 endpoints: parch-review, jon-ratify, activate, revoke
// ============================================================================
//
// These use auth (full Bearer/X-API-Key + dual-source DB-lookup per Jon-direct
// 2026-05-19) followed by per-route enforceSenderBinding ('parch-agent' etc).

// Helper: require the request's authed sender to be in the allowedSet.
// Returns an error response object on mismatch, null on pass.
function requireAuthedSender(req, allowedSet, action) {
  // /register routes are mounted before the global auth middleware, so
  // wave-2 endpoints invoke auth() inline (see route handlers below).
  if (!req.auth || !req.auth.token) {
    return { status: 401, body: { error: 'Unauthorized', message: 'Bearer token required.' } };
  }
  // The sender claim is the X-Sender header (explicit) OR the registration
  // row agent_id when source=='registration'. For wave-2 we require explicit
  // X-Sender to force the caller to assert which identity they're acting as.
  const sender = req.headers['x-sender'];
  if (typeof sender !== 'string' || sender.length === 0) {
    return {
      status: 400,
      body: { error: 'ValidationError', message: 'X-Sender header required for /register state-transition actions.' }
    };
  }
  // Validate the sender matches the token's binding.
  const violation = enforceSenderBinding(req, sender);
  if (violation) return violation;
  // Validate the sender is in the allowed set for this action.
  if (!allowedSet.has(sender)) {
    return {
      status: 403,
      body: { error: 'AuthorityViolation', message: `Sender '${sender}' is not authorized to ${action}. Allowed: ${[...allowedSet].join(', ')}.` }
    };
  }
  req.authedSender = sender;
  return null;
}

const TERMINAL_STATES = new Set(['ACTIVE', 'REVOKED', 'REJECTED']);

// POST /:id/parch-review — parch (only) submits justification block; transitions
// SUBMITTED → PARCH_REVIEW. Body: { justification: { cluster_fit, lane_shape,
// why_now, capabilities_overlap, rationale } } per ADR §2.
router.post('/:id/parch-review', auth, (req, res) => {
  const violation = requireAuthedSender(req, new Set(['parch-agent']), 'parch-review');
  if (violation) return res.status(violation.status).json(violation.body);

  const reg = getRegistration(req.params.id);
  if (!reg) return res.status(404).json({ error: 'NotFound', message: `Registration ${req.params.id} not found.` });
  if (reg.status !== 'SUBMITTED') {
    return res.status(409).json({
      error: 'IllegalTransition',
      message: `Registration ${req.params.id} is in status ${reg.status}; parch-review requires SUBMITTED.`
    });
  }
  const { justification } = req.body || {};
  if (!justification || typeof justification !== 'object') {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'justification body field required (object with cluster_fit / lane_shape / why_now / capabilities_overlap / rationale per ADR §2).'
    });
  }

  const updated = updateRegistration(req.params.id, {
    status: 'PARCH_REVIEW',
    justification_json: JSON.stringify(justification)
  });
  insertRegistrationEvent({
    registration_id: req.params.id,
    agent_id: reg.agent_id,
    event_type: 'PARCH_REVIEW',
    actor: req.authedSender,
    metadata: { from_ip: req.ip }
  });
  return res.status(200).json({ registration: publicRegistrationView(updated) });
});

// POST /:id/jon-ratify — parch-relays-Jon-decision: PARCH_REVIEW → APPROVED_PENDING_FERRY
// (with token mint + age encrypt) OR PARCH_REVIEW → REJECTED.
// Body: { decision: "approve"|"reject", jon_direct_quote: "...", rejected_reason?: "..." }
router.post('/:id/jon-ratify', auth, (req, res) => {
  const violation = requireAuthedSender(req, new Set(['parch-agent']), 'jon-ratify (parch-relays-Jon-decision)');
  if (violation) return res.status(violation.status).json(violation.body);

  const reg = getRegistration(req.params.id);
  if (!reg) return res.status(404).json({ error: 'NotFound', message: `Registration ${req.params.id} not found.` });
  if (reg.status !== 'PARCH_REVIEW') {
    return res.status(409).json({
      error: 'IllegalTransition',
      message: `Registration ${req.params.id} is in status ${reg.status}; jon-ratify requires PARCH_REVIEW.`
    });
  }
  const { decision, jon_direct_quote, rejected_reason } = req.body || {};
  if (decision !== 'approve' && decision !== 'reject') {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'decision must be "approve" or "reject".'
    });
  }
  if (typeof jon_direct_quote !== 'string' || jon_direct_quote.trim().length === 0) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'jon_direct_quote required (parch relays Jon-direct verbatim per [[feedback_parch_authors_canonical_adrs]]).'
    });
  }

  const now = new Date().toISOString();

  if (decision === 'reject') {
    if (typeof rejected_reason !== 'string' || rejected_reason.trim().length === 0) {
      return res.status(400).json({ error: 'ValidationError', message: 'rejected_reason required for reject decision.' });
    }
    const updated = updateRegistration(req.params.id, {
      status: 'REJECTED',
      rejected_reason,
      ratified_by: req.authedSender,
      ratified_at: now,
      // Clear registrant_token_hash on terminal transition per ferry-canon §4a.
      registrant_token_hash: null
    });
    insertRegistrationEvent({
      registration_id: req.params.id,
      agent_id: reg.agent_id,
      event_type: 'REJECTED',
      actor: req.authedSender,
      metadata: { jon_direct_quote, rejected_reason }
    });
    return res.status(200).json({ registration: publicRegistrationView(updated) });
  }

  // approve: mint token, encrypt to pubkey, store ciphertext + minted_token_hash
  const mintedToken = crypto.randomBytes(48).toString('base64url'); // 64-char yaklog-style token
  const mintedTokenHash = sha256Hex(mintedToken);

  // Spawn age to encrypt the plaintext token to the registrant's pubkey.
  // execFileSync with explicit args (no shell); plaintext token passed via
  // stdin (NEVER via argv — process listings would leak it).
  let ciphertextB64;
  try {
    const result = spawnSync('age', ['-r', reg.registrant_pubkey, '--armor'], {
      input: mintedToken,
      encoding: 'utf-8',
      timeout: 5000
    });
    if (result.status !== 0) {
      return res.status(500).json({
        error: 'InternalServerError',
        message: 'age encryption failed.',
        detail: result.stderr ? result.stderr.toString().slice(0, 200) : null
      });
    }
    ciphertextB64 = Buffer.from(result.stdout, 'utf-8').toString('base64');
  } catch (err) {
    return res.status(500).json({
      error: 'InternalServerError',
      message: 'age encryption errored: ' + err.message
    });
  }

  const updated = updateRegistration(req.params.id, {
    status: 'APPROVED_PENDING_FERRY',
    ciphertext_b64: ciphertextB64,
    minted_token_hash: mintedTokenHash,
    ratified_by: req.authedSender,
    ratified_at: now
  });
  insertRegistrationEvent({
    registration_id: req.params.id,
    agent_id: reg.agent_id,
    event_type: 'TOKEN_MINTED',
    actor: req.authedSender,
    ciphertext_sha256_prefix: shaPrefix(ciphertextB64),
    token_sha256_prefix: mintedTokenHash.slice(0, 16),
    registrant_pubkey_sha256_prefix: shaPrefix(reg.registrant_pubkey),
    metadata: { jon_direct_quote }
  });
  // CP12.7 Phase A: emit audit_credential_change for the mint event.
  // Feeds CC6 (Logical & Physical Access Controls) Attestation status.
  try {
    insertAuditCredentialChange({
      occurred_at: now,
      credential_class: 'agent-bearer',
      agent_id: reg.agent_id,
      change_type: 'mint',
      actor: req.authedSender,
      prior_digest: null,
      new_digest: mintedTokenHash.slice(0, 16),
      reason: `jon-ratify mint via /register/${req.params.id}`
    });
  } catch (e) { /* audit emit must never block the state-transition */ }
  return res.status(200).json({ registration: publicRegistrationView(updated) });
});

// POST /:id/activate — registrant presents the DECRYPTED minted-token as Bearer;
// validates against minted_token_hash; transitions PENDING_ACTIVATION → ACTIVE.
// Per ferry-canon §4a: token-as-proof (transitively proves privkey possession).
//
// Note: registrant submits with Bearer = DECRYPTED token (NOT registration_access_token).
// This is the moment the dual-source auth-DB-lookup kicks in for the first time:
// the token won't be in YAKLOG_API_KEYS env, only minted_token_hash. But at this
// transition, status is PENDING_ACTIVATION not yet ACTIVE — so auth middleware
// won't find it via getActiveRegistrationByMintedTokenHash (which filters ACTIVE).
// Instead, /activate accepts the token via plain Bearer extraction and matches
// it itself against minted_token_hash with status=PENDING_ACTIVATION.
const { getActiveRegistrationByMintedTokenHash } = require('./db');
function extractBearer(req) {
  // Prefer the original Bearer stashed by opsKeyAuditMiddleware (CP12.2
  // R1 fold) before req.headers.authorization was masked to
  // `Bearer sha256:<prefix>`. Mirrors src/middleware/auth.js extractToken.
  if (req.rawBearer) return req.rawBearer;
  const a = req.headers.authorization;
  if (!a || !a.startsWith('Bearer ')) return null;
  return a.slice('Bearer '.length).trim();
}

router.post('/:id/activate', (req, res) => {
  const reg = getRegistration(req.params.id);
  if (!reg) return res.status(404).json({ error: 'NotFound', message: `Registration ${req.params.id} not found.` });
  if (reg.status !== 'PENDING_ACTIVATION') {
    return res.status(409).json({
      error: 'IllegalTransition',
      message: `Registration ${req.params.id} is in status ${reg.status}; activate requires PENDING_ACTIVATION.`
    });
  }
  const token = extractBearer(req);
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Bearer (decrypted minted-token) required.' });
  }
  if (!reg.minted_token_hash || sha256Hex(token) !== reg.minted_token_hash) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Bearer does not match minted-token for this registration. Did you decrypt the ciphertext correctly?'
    });
  }

  const now = new Date().toISOString();

  // Task #137 Phase B per parch #10266 Q2+Q3 ratify: pre-provision per-Ptah-
  // agent audit SQLite file at activate time when submission declares
  // runtime_class='ptah'. Failures here MUST block ACTIVE transition —
  // substrate-honest at activate-tier: an agent transitioning to ACTIVE without
  // its audit substrate would silently lose audit events on first POST. Sister-
  // shape to feedback_substrate_empirical_check_before_pre_stage discipline.
  let submission = null;
  try { submission = reg.submission_json ? JSON.parse(reg.submission_json) : null; }
  catch { submission = null; }
  if (submission && submission.runtime_class === 'ptah') {
    try {
      ptahAuditDb.provisionForAgent(reg.agent_id);
    } catch (e) {
      return res.status(500).json({
        error: 'ProvisionFailed',
        message: `runtime_class=ptah agent: per-Ptah-agent audit DB provision failed: ${e.message}. Registration stays in PENDING_ACTIVATION; resolve provisioning failure (e.g., agent_id ptah-* namespace bound) and retry activate.`
      });
    }
    // Task #246: also provision per-Ptah-instance trace substrate (sister-shape
    // audit provision; same per-Ptah-instance file-isolation canon-class per
    // ADR-0037 §6 amendment / parch #10731 ratify).
    try {
      ptahTraceDb.provisionForAgent(reg.agent_id);
    } catch (e) {
      return res.status(500).json({
        error: 'ProvisionFailed',
        message: `runtime_class=ptah agent: per-Ptah-instance trace DB provision failed: ${e.message}.`
      });
    }
  }

  // Path Y per parch #10658: provision operator_records row when submission
  // declares session_class='operator'. Sister-canon to ptahAuditDb provision
  // above. Failures block ACTIVE transition (substrate-honest: an operator
  // landing ACTIVE without operator_records row would fail ADR-0040 §4.6
  // offboarding step (a)). Auth-class derivation lives in auth.js path-b.
  if (submission && submission.session_class === 'operator') {
    try {
      plexusSecureDb.upsertOperatorRecord({
        operatorId: reg.agent_id,
        userEmail: submission.user_email || null,
        actor: 'register-state-machine',
        notes: `auto-provisioned at /register/${req.params.id}/activate`
      });
    } catch (e) {
      return res.status(500).json({
        error: 'ProvisionFailed',
        message: `session_class=operator: operator_records provision failed: ${e.message}. Registration stays in PENDING_ACTIVATION; resolve and retry activate.`
      });
    }
  }

  const updated = updateRegistration(req.params.id, {
    status: 'ACTIVE',
    activated_at: now,
    // Clear registrant_token_hash per ferry-canon §4a (token retires at ACTIVE).
    registrant_token_hash: null,
    // ciphertext_b64 also no longer needed (registrant has decrypted; ciphertext
    // was the transient ferry artifact). Clear for hygiene.
    ciphertext_b64: null
  });
  insertRegistrationEvent({
    registration_id: req.params.id,
    agent_id: reg.agent_id,
    event_type: 'ACTIVATED',
    actor: reg.agent_id,
    token_sha256_prefix: reg.minted_token_hash.slice(0, 16),
    metadata: {
      from_ip: req.ip,
      // Surface Ptah-provision outcome in registration event metadata for
      // operator visibility + audit-trail clarity.
      ptah_audit_provisioned: !!(submission && submission.runtime_class === 'ptah') || undefined,
    }
  });
  // CP12.7 Phase A: emit audit_credential_change for the activate transition.
  // Token transitions from latent-ciphertext to actively-bound; CC6 signal.
  try {
    insertAuditCredentialChange({
      occurred_at: now,
      credential_class: 'agent-bearer',
      agent_id: reg.agent_id,
      change_type: 'activate',
      actor: reg.agent_id,
      prior_digest: null,
      new_digest: reg.minted_token_hash.slice(0, 16),
      reason: `activate via /register/${req.params.id} (PENDING_ACTIVATION → ACTIVE)`
    });
  } catch (e) { /* audit emit must never block the state-transition */ }
  return res.status(200).json({
    registration: publicRegistrationView(updated),
    note: 'Registration ACTIVE. Your minted token is now usable for normal yaklog API calls (no env config needed; server validates via dual-source DB-lookup).'
  });
});

// POST /:id/revoke — multi-authority: parch / Jon-via-parch / secops.
// Body: { reason: "..." } required.
// Effect: status → REVOKED; minted_token_hash + registrant_token_hash + ciphertext_b64 all cleared.
const REVOKE_AUTHORITIES = new Set(['parch-agent', 'secops-agent']);
router.post('/:id/revoke', auth, (req, res) => {
  const violation = requireAuthedSender(req, REVOKE_AUTHORITIES, 'revoke');
  if (violation) return res.status(violation.status).json(violation.body);

  const reg = getRegistration(req.params.id);
  if (!reg) return res.status(404).json({ error: 'NotFound', message: `Registration ${req.params.id} not found.` });
  if (TERMINAL_STATES.has(reg.status)) {
    return res.status(409).json({
      error: 'IllegalTransition',
      message: `Registration ${req.params.id} is already in terminal state ${reg.status}; revoke is a no-op.`
    });
  }
  const { reason } = req.body || {};
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    return res.status(400).json({ error: 'ValidationError', message: 'reason required for revoke.' });
  }

  const now = new Date().toISOString();
  const updated = updateRegistration(req.params.id, {
    status: 'REVOKED',
    revoked_at: now,
    revoked_reason: reason,
    minted_token_hash: null,
    registrant_token_hash: null,
    ciphertext_b64: null
  });
  insertRegistrationEvent({
    registration_id: req.params.id,
    agent_id: reg.agent_id,
    event_type: 'REVOKED',
    actor: req.authedSender,
    metadata: { reason }
  });
  // CP12.7 Phase A: emit audit_credential_change for the revoke event.
  // prior_digest = the now-revoked minted_token_hash (captured before update
  // cleared it). CC6 signal.
  try {
    insertAuditCredentialChange({
      occurred_at: now,
      credential_class: 'agent-bearer',
      agent_id: reg.agent_id,
      change_type: 'revoke',
      actor: req.authedSender,
      prior_digest: reg.minted_token_hash ? reg.minted_token_hash.slice(0, 16) : null,
      new_digest: null,
      reason: `revoke via /register/${req.params.id}: ${reason}`.slice(0, 200)
    });
  } catch (e) { /* audit emit must never block the state-transition */ }
  return res.status(200).json({ registration: publicRegistrationView(updated) });
});

// ============================================================================
// Wave-3 endpoints: ciphertext, ferry-complete, list-pending
// ============================================================================

// States during which ciphertext exists + is fetchable.
const CIPHERTEXT_AVAILABLE_STATES = new Set([
  'APPROVED_PENDING_FERRY', 'FERRIED', 'PENDING_ACTIVATION'
]);

// GET /:id/ciphertext — dual-auth per ferry-canon §4 + ADR §4b:
//   - op-key (ferry-group FALLBACK courier path; admin couriers ciphertext)
//   - registrant_access_token (PRIMARY runtime-pull path; registrant fetches own ciphertext)
// Returns base64-encoded age ciphertext in JSON body. NEVER returns plaintext token
// (ciphertext is age-encrypted to registrant's pubkey; only privkey-holder can decrypt).
const { sha256Hex: _sha256Hex } = (() => {
  // local alias for clarity at use-site; module-scope sha256Hex already defined above.
  return { sha256Hex };
})();
function authForCiphertext(req, reg) {
  // Try registrant-token first (PRIMARY path expected; cheaper success).
  // Prefer req.rawBearer stashed by opsKeyAuditMiddleware (CP12.2 R1 fold)
  // before req.headers.authorization was masked. Mirrors auth.js pattern.
  const bearer = req.rawBearer ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (bearer) {
    if (reg.registrant_token_hash && sha256Hex(bearer) === reg.registrant_token_hash) {
      return { ok: true, actor: reg.agent_id, source: 'registrant_token' };
    }
    if (config.opsApiKeys && config.opsApiKeys.has(bearer)) {
      return { ok: true, actor: 'ferry-group', source: 'op_key' };
    }
  }
  return { ok: false };
}

router.get('/:id/ciphertext', (req, res) => {
  const reg = getRegistration(req.params.id);
  if (!reg) return res.status(404).json({ error: 'NotFound', message: `Registration ${req.params.id} not found.` });
  const authed = authForCiphertext(req, reg);
  if (!authed.ok) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Bearer must be registrant_access_token (PRIMARY pull) OR op-key (FALLBACK courier).'
    });
  }
  if (!CIPHERTEXT_AVAILABLE_STATES.has(reg.status)) {
    return res.status(409).json({
      error: 'IllegalState',
      message: `Registration ${req.params.id} is in status ${reg.status}; ciphertext only available in APPROVED_PENDING_FERRY/FERRIED/PENDING_ACTIVATION (cleared at ACTIVE/REVOKED/REJECTED).`
    });
  }
  if (!reg.ciphertext_b64) {
    return res.status(500).json({
      error: 'InternalServerError',
      message: 'Registration is in ciphertext-available state but ciphertext is missing. Data integrity issue.'
    });
  }
  insertRegistrationEvent({
    registration_id: req.params.id,
    agent_id: reg.agent_id,
    event_type: 'FERRY_PULL',
    actor: authed.actor,
    ciphertext_sha256_prefix: shaPrefix(reg.ciphertext_b64),
    metadata: { auth_source: authed.source, from_ip: req.ip }
  });
  return res.status(200).json({
    registration_id: reg.registration_id,
    agent_id: reg.agent_id,
    status: reg.status,
    ciphertext_b64: reg.ciphertext_b64,
    ciphertext_sha256_prefix: shaPrefix(reg.ciphertext_b64),
    decryption_hint: 'Decrypt via: base64 -d <ciphertext_b64> | age -d -i <registration.age.key> > /tmp/token; install -m 600 /tmp/token ~/.config/yaklog/<agent-id>.token; shred /tmp/token + the registration.age.key (single-use); then POST /register/<id>/activate with Bearer = decrypted token.'
  });
});

// POST /:id/ferry-complete — op-key gated; ferry-group transitions
// APPROVED_PENDING_FERRY → FERRIED → PENDING_ACTIVATION (auto via state machine
// since PENDING_ACTIVATION is just "waiting for registrant to activate" — we collapse
// the two transitions here for ferry-group operational simplicity).
// Body optional: { ferry_method: "primary"|"fallback", notes?: "..." }
router.post('/:id/ferry-complete', auth, (req, res) => {
  const violation = requireAuthedSender(req,
    new Set(['secops-agent', 'ssw-devops', 'admin-agent']), 'ferry-complete');
  if (violation) return res.status(violation.status).json(violation.body);

  const reg = getRegistration(req.params.id);
  if (!reg) return res.status(404).json({ error: 'NotFound', message: `Registration ${req.params.id} not found.` });
  if (reg.status !== 'APPROVED_PENDING_FERRY') {
    return res.status(409).json({
      error: 'IllegalTransition',
      message: `Registration ${req.params.id} is in status ${reg.status}; ferry-complete requires APPROVED_PENDING_FERRY.`
    });
  }
  const { ferry_method, notes } = req.body || {};
  if (ferry_method !== undefined && ferry_method !== 'primary' && ferry_method !== 'fallback') {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'ferry_method (optional) must be "primary" or "fallback" when provided.'
    });
  }

  const now = new Date().toISOString();
  const updated = updateRegistration(req.params.id, {
    status: 'PENDING_ACTIVATION',
    ferried_by: req.authedSender,
    ferried_at: now
  });
  insertRegistrationEvent({
    registration_id: req.params.id,
    agent_id: reg.agent_id,
    event_type: 'FERRY_INSTALLED',
    actor: req.authedSender,
    ciphertext_sha256_prefix: reg.ciphertext_b64 ? shaPrefix(reg.ciphertext_b64) : null,
    metadata: { ferry_method: ferry_method || 'unspecified', notes: notes || null }
  });
  return res.status(200).json({
    registration: publicRegistrationView(updated),
    note: 'Registration now in PENDING_ACTIVATION; registrant should POST /register/<id>/activate with the decrypted token as Bearer to complete the state machine.'
  });
});

// GET /?pending=parch — list registrations awaiting parch review (status='SUBMITTED').
// Parch-binding (X-Sender: parch-agent); supports parch session-resume per ADR sub-decision 5.
// Returns array of publicRegistrationViews (justification absent since not yet authored).
const { listRegistrationsByStatus } = require('./db');
router.get('/', auth, (req, res) => {
  const { pending } = req.query;
  if (pending !== 'parch') {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'Only ?pending=parch is supported on this endpoint currently. Use GET /register/<id> for single-registration fetch.'
    });
  }
  const violation = requireAuthedSender(req, new Set(['parch-agent']), 'list pending registrations');
  if (violation) return res.status(violation.status).json(violation.body);

  const rows = listRegistrationsByStatus('SUBMITTED');
  return res.status(200).json({
    count: rows.length,
    registrations: rows.map(publicRegistrationView)
  });
});

// ─── Task #223 v1: /register/:id/channels (canonical-authority tier) ────────
// Per PLAN-PLEXUS-ADMIN-CHANNEL-SUBSCRIPTION + parch #11225 RATIFY.
// POST = ops-key write (admin authority); GET = bearer OR ops-key read.

const { setAgentChannels, getAgentChannels } = require('./db');

router.post('/:id/channels', enforceOpsKey, (req, res) => {
  const agent_id = req.params.id;
  if (!AGENT_ID_RE.test(agent_id)) {
    return res.status(400).json({ error: 'ValidationError', message: 'agent_id must match [a-zA-Z0-9._:@/-]{1,64}' });
  }
  const { channels } = req.body || {};
  if (!Array.isArray(channels)) {
    return res.status(400).json({ error: 'ValidationError', message: 'body.channels must be an array' });
  }
  const subscribed_by = req.headers['x-ops-key-id'] || 'ops-endpoint';
  try {
    const result = setAgentChannels({ agent_id, channels, subscribed_by });
    return res.status(200).json(result);
  } catch (err) {
    return res.status(400).json({ error: 'ValidationError', message: err.message });
  }
});

router.get('/:id/channels', (req, res) => {
  const agent_id = req.params.id;
  if (!AGENT_ID_RE.test(agent_id)) {
    return res.status(400).json({ error: 'ValidationError', message: 'agent_id must match [a-zA-Z0-9._:@/-]{1,64}' });
  }
  // Auth per PLAN §3.3: ops-key (admin cross-read) OR bearer bound to this agent (daemon self-read).
  // Task #262 secops #11229 advisory fold: consult shared resolveAllowedSenders()
  // FIRST for canon-consistency across operator/registration/env-token paths,
  // then FALL THROUGH to daemonBindings for cross-canon coverage (senderBinding's
  // shared resolver doesn't include daemonBindings; extending it is broader
  // canon-review-required change per Task #262). Uses req.rawBearer stashed by
  // opsKeyAuditMiddleware per ADR-0030 v1.1 R1 (header masked to sha256:<prefix>).
  let token = req.rawBearer;
  if (!token) {
    const authHeader = req.headers['authorization'] || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/);
    token = match ? match[1].trim() : null;
  }
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Bearer token required (ops-key or per-agent)' });
  }
  const isOps = config.opsApiKeys && config.opsApiKeys.has(token);
  if (!isOps) {
    // Delegate operator/registration/env-tokenBindings path to shared resolver
    // (canon-consistency per secops #11229 advisory).
    const { allowedSenders } = resolveAllowedSenders(req);
    if (allowedSenders) {
      if (!allowedSenders.has(agent_id)) {
        return res.status(403).json({ error: 'Forbidden', message: 'bearer token not bound to this agent_id' });
      }
      // Bound + matches → authorized; fall to read
    } else {
      // Shared resolver returned unbound. Fall through to legacy checks
      // (apiKeys + daemonBindings) — preserves daemon-self-read canon that
      // the shared resolver doesn't cover. Extending resolveAllowedSenders
      // to include daemonBindings is broader canon-review-required change.
      if (!config.apiKeys.has(token)) {
        return res.status(401).json({ error: 'Unauthorized', message: 'invalid token' });
      }
      const boundAgents = config.tokenBindings.get(token) || config.daemonBindings.get(token);
      if (boundAgents && !boundAgents.has(agent_id)) {
        return res.status(403).json({ error: 'Forbidden', message: 'bearer token not bound to this agent_id' });
      }
    }
  }
  const channels = getAgentChannels(agent_id);
  return res.status(200).json({ agent_id, channels });
});

module.exports = router;
