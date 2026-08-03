// CP17.A (Jon-direct 2026-07-06 + secops #11759 SIGN-OFF): agent-writable repo
// tracking management substrate. Per PLAN-CP17-CLUSTER-REPO-SUBSTRATE.md §3.1
// with T1-T7 security touchpoints baked at design-time.
//
// Auth model (T1): any authenticated bearer; sender-attested via
// resolveAllowedSenders; ops-key override; self-scoped destructive on disable.
// Input validation (T2/T3): strict regex, no scheme, no server-fetch, no
// credential storage, canonical name safety with path-traversal defense.
// Audit-fold (T6): every mutation calls insertAuditRepoChange inside the same
// SQL transaction as the underlying mutation (non-bypassable).
// SSRF (T7): server-side never fetches user-supplied URL at add-time.

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const dbModule = require('./db');
const { resolveAllowedSenders } = require('./middleware/senderBinding');

const router = express.Router();

// ── Validation regexes ─────────────────────────────────────────────────────
// T2: strict `owner/repo` shape; no scheme; charset restricted; length bounded
// in-regex per secops #11786 hardening nit (defense-in-depth alongside the
// explicit MAX_GITHUB_OWNER_REPO_LEN check below).
const GITHUB_OWNER_REPO_RE = /^[a-zA-Z0-9._-]{1,64}\/[a-zA-Z0-9._-]{1,64}$/;
const MAX_GITHUB_OWNER_REPO_LEN = 96;
// T3: canonical name safety for bare-git; lowercase filesystem-safe; no
// case-collision on case-insensitive filesystems. Regex length bounded per
// secops #11786 defense-in-depth. Embedded '..' IS regex-matchable ('.' is
// in the charset) but explicitly rejected below via includes('..') guard —
// layered defense; secops #11786 noted T5 script realpath-confinement is
// the last-line-of-defense, endpoint is the first.
const BARE_GIT_REPO_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const MAX_BARE_GIT_REPO_NAME_LEN = 63;
// Bare-git canonical filesystem root (walker sees this ro-mounted in container).
const BARE_GIT_ROOT = process.env.YAKLOG_BARE_GIT_ROOT_HOST || '/srv/git';

// Resolve the actor sender-id from the authenticated bearer.
// Returns senderId string OR sends a 403 and returns null.
function resolveActor(req, res) {
  // Ops-key attribution: sister-shape existing outputApiRoutes.js:313 pattern.
  if (req.tokenClass === 'ops') {
    return `ops:${req.headers['x-ops-key-id'] || req.auth?.opsKeyId || 'unknown'}`;
  }
  const { allowedSenders } = resolveAllowedSenders(req);
  if (!allowedSenders || allowedSenders.size === 0) {
    res.status(403).json({
      error: 'SenderBindingRequired',
      message: 'Bearer must be bound to a sender-id for repo write endpoints.',
    });
    return null;
  }
  // Single-binding is the normal case; multi-binding takes the first.
  return [...allowedSenders][0];
}

// ── POST /api/v1/repos — agent-authored GitHub add (T1/T2/T6/T7) ──────────
router.post('/repos', (req, res) => {
  const actor = resolveActor(req, res);
  if (!actor) return;
  const { github_owner_repo, bare_git_path } = req.body || {};

  // T2: strict validation. No scheme accepted — reject anything containing '://'.
  if (typeof github_owner_repo !== 'string' || github_owner_repo.length === 0) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'github_owner_repo is required (owner/repo shape).',
    });
  }
  if (github_owner_repo.length > MAX_GITHUB_OWNER_REPO_LEN) {
    return res.status(400).json({
      error: 'ValidationError',
      message: `github_owner_repo exceeds max length ${MAX_GITHUB_OWNER_REPO_LEN}.`,
    });
  }
  if (github_owner_repo.includes('://')) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'github_owner_repo must be owner/repo (no URL scheme).',
    });
  }
  if (!GITHUB_OWNER_REPO_RE.test(github_owner_repo)) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'github_owner_repo must match ^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$',
    });
  }
  // T2: bare_git_path optional but validated if provided (canonical filesystem-safe).
  if (bare_git_path !== undefined && bare_git_path !== null) {
    if (typeof bare_git_path !== 'string' || bare_git_path.length > 256) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'bare_git_path must be a string (max 256 chars).',
      });
    }
  }

  // T7: no server-side fetch of the URL at add-time. Record-only. GitHubWalker
  // fetches on scheduled cadence via existing GITHUB_PAT_FILE env (out-of-band
  // PAT never stored in row).

  // T6: atomic transaction — mutation + audit-fold succeed or fail together.
  const database = dbModule.getDb();
  const prior = database
    .prepare(`SELECT enabled FROM output_repo WHERE github_owner_repo = ?`)
    .get(github_owner_repo);
  const firstTime = !prior;

  const tx = database.transaction(() => {
    dbModule.upsertOutputRepo({
      github_owner_repo,
      bare_git_path: bare_git_path || null,
      enabled: 1,
      added_by: actor,
    });
    dbModule.insertAuditRepoChange({
      repo_key: github_owner_repo,
      action: firstTime ? 'add' : 'enable',
      actor_agent_id: actor,
      metadata: bare_git_path ? { bare_git_path } : null,
    });
  });
  tx();

  return res.json({
    ok: true,
    github_owner_repo,
    added_by: actor,
    first_time: firstTime,
  });
});

// ── POST /api/v1/repos/:owner/:repo/disable — self-scoped or ops-key ──────
router.post('/repos/:owner/:repo/disable', (req, res) => {
  const actor = resolveActor(req, res);
  if (!actor) return;
  const github_owner_repo = `${req.params.owner}/${req.params.repo}`;
  if (!GITHUB_OWNER_REPO_RE.test(github_owner_repo)) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'owner/repo path must match ^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$',
    });
  }

  const database = dbModule.getDb();
  const row = database
    .prepare(`SELECT * FROM output_repo WHERE github_owner_repo = ?`)
    .get(github_owner_repo);
  if (!row) {
    return res.status(404).json({
      error: 'NotFound',
      message: 'no matching output_repo row',
    });
  }
  // Self-scoped destructive guard per T1: senderId == added_by OR ops-key.
  const isOps = req.tokenClass === 'ops';
  if (!isOps && row.added_by !== actor) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'self-scoped disable: only the adding agent or ops-key can disable',
    });
  }
  // T6: atomic transaction.
  const tx = database.transaction(() => {
    dbModule.disableOutputRepo(github_owner_repo);
    dbModule.insertAuditRepoChange({
      repo_key: github_owner_repo,
      action: 'disable',
      actor_agent_id: actor,
      metadata: { prior_added_by: row.added_by, prior_enabled: row.enabled },
    });
  });
  tx();

  return res.json({ ok: true, disabled: github_owner_repo });
});

// ── POST /api/v1/repos/bare-git-request — intent record (T1/T3/T6) ────────
// NOTE: `purpose` is folded into audit_repo_change.metadata_json and
// publicly readable via GET /yaklog/public/repos/:repo_key/audit. Callers
// MUST NOT put secrets in `purpose` (no tokens, keys, DB creds). Convention
// documented per secops #11837 hardening note 2.
router.post('/repos/bare-git-request', (req, res) => {
  const actor = resolveActor(req, res);
  if (!actor) return;
  const { repo_name, purpose } = req.body || {};

  // T3: canonical name safety.
  if (typeof repo_name !== 'string' || repo_name.length === 0) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'repo_name is required.',
    });
  }
  if (repo_name.length > MAX_BARE_GIT_REPO_NAME_LEN) {
    return res.status(400).json({
      error: 'ValidationError',
      message: `repo_name exceeds max length ${MAX_BARE_GIT_REPO_NAME_LEN}.`,
    });
  }
  if (!BARE_GIT_REPO_NAME_RE.test(repo_name)) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'repo_name must match ^[a-z0-9][a-z0-9._-]*$ (lowercase; filesystem-safe).',
    });
  }
  // T3: explicit path-traversal / absolute-path defense (regex above already
  // excludes '..' + '/' + '\' but defense-in-depth):
  if (
    repo_name.includes('..') ||
    repo_name.includes('/') ||
    repo_name.includes('\\') ||
    repo_name.startsWith('.') ||
    repo_name.startsWith('/')
  ) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'repo_name contains disallowed characters.',
    });
  }
  if (purpose !== undefined && purpose !== null) {
    if (typeof purpose !== 'string' || purpose.length > 512) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'purpose must be a string (max 512 chars).',
      });
    }
  }

  // Reject if bare-git canonical already exists on host filesystem.
  // Container has /srv/git mounted read-only; we can stat.
  const targetPath = path.join(BARE_GIT_ROOT, `${repo_name}.git`);
  try {
    if (fs.existsSync(targetPath)) {
      return res.status(409).json({
        error: 'Conflict',
        message: `bare-git canonical already exists at ${targetPath}.`,
      });
    }
  } catch { /* if stat fails, admin-lane will re-validate at fulfill-time */ }

  // Reject duplicate pending request for the same repo_name (idempotency guard).
  const dup = dbModule.getPendingBareGitRequestByName(repo_name);
  if (dup) {
    return res.status(409).json({
      error: 'Conflict',
      message: `a pending bare-git-request already exists for repo_name '${repo_name}' (request_id ${dup.request_id}).`,
    });
  }

  // T6: atomic transaction — insert request + audit-fold together.
  const database = dbModule.getDb();
  let requestId;
  const tx = database.transaction(() => {
    requestId = dbModule.insertBareGitRequest({
      repo_name,
      requested_by: actor,
      purpose: purpose || null,
    });
    dbModule.insertAuditRepoChange({
      repo_key: `bare-git:${repo_name}`,
      action: 'bare-git-requested',
      actor_agent_id: actor,
      metadata: purpose ? { purpose } : null,
    });
  });
  tx();

  return res.json({ ok: true, request_id: requestId, status: 'pending' });
});

// ── GET /api/v1/repos/bare-git-request/:id — status poll ──────────────────
router.get('/repos/bare-git-request/:id', (req, res) => {
  const actor = resolveActor(req, res);
  if (!actor) return;
  const requestId = parseInt(req.params.id, 10);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'request_id must be a positive integer.',
    });
  }
  const row = dbModule.getBareGitRequest(requestId);
  // Enumerate-safe 404: return not-found unless requester or ops-key.
  const isOps = req.tokenClass === 'ops';
  if (!row || (!isOps && row.requested_by !== actor)) {
    return res.status(404).json({
      error: 'NotFound',
      message: 'bare-git-request not found (or not visible to this bearer).',
    });
  }
  return res.json({
    request_id: row.request_id,
    repo_name: row.repo_name,
    requested_by: row.requested_by,
    purpose: row.purpose,
    requested_at: row.requested_at,
    fulfilled_at: row.fulfilled_at,
    fulfilled_by: row.fulfilled_by,
    fulfillment_result: row.fulfillment_result,
    error_message: row.error_message,
  });
});

module.exports = { router };
