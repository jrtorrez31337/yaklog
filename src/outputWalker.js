// CP13.2 / ADR-0032 Output-strand substrate walkers
//
// Two walker implementations behind a common interface:
//   - BareGitWalker (Phase 1.2 active): walks /srv/git/*.git canonical repos
//   - GitHubWalker (Phase 2 stub): scaffolds the GitHub API ingester shape
//
// Common interface (subclasses override):
//   listRepos()        → string[]      identifies repos in walker scope
//   walkRepo(repo, lastRef) → { commits, merges, newRef }
//   substrateType()    → 'bare-git' | 'github'
//
// Both walkers produce rows shaped for output_commit + output_merge tables
// per ADR-0032 Schema canonical. The ingester (separate module) writes
// rows + manages output_ingester_cursor state + runs the attribution parser.
//
// Per ADR-0032: bare-git uses git plumbing via spawnSync with arg-array
// (NOT shell-string) for safety. GitHub walker is stubbed; full
// implementation gated on Phase 2 ratify (which includes output_pr +
// output_pr_review schema not yet ratified).

'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const DEFAULT_BARE_GIT_ROOT = '/srv/git';

// ── Abstract base ─────────────────────────────────────────────────────────

class OutputWalker {
  /** @returns {string[]} repo names within this walker's scope */
  listRepos() {
    throw new Error('subclass must implement listRepos()');
  }

  /**
   * Walk a repo starting from lastRef (or beginning if null).
   * @param {string} repo
   * @param {string|null} lastRef
   * @returns {{ commits: object[], merges: object[], newRef: string|null }}
   */
  walkRepo(_repo, _lastRef) {
    throw new Error('subclass must implement walkRepo()');
  }

  /** @returns {'bare-git'|'github'} substrate identifier */
  substrateType() {
    throw new Error('subclass must implement substrateType()');
  }
}

// ── BareGitWalker (Phase 1.2 active) ──────────────────────────────────────

// Field separator + record separator chosen to never appear in git data.
// Git's `--format=` honors literal ASCII control chars; we use US (0x1F)
// for fields and RS (0x1E) for records.
const FS_CHAR = '\x1F';
const RS_CHAR = '\x1E';

const COMMIT_FORMAT = [
  '%H',   // 0: full sha
  '%an',  // 1: author name
  '%ae',  // 2: author email
  '%cn',  // 3: committer name
  '%ce',  // 4: committer email
  '%cI',  // 5: committer date ISO-8601 strict
  '%s',   // 6: subject (first line)
  '%P',   // 7: parent shas (space-separated)
  '%b',   // 8: body (rest of commit message)
].join(FS_CHAR);

class BareGitWalker extends OutputWalker {
  /**
   * @param {object} opts
   * @param {string} [opts.root] - bare-git root dir (default /srv/git)
   * @param {string[]} [opts.repos] - explicit allowlist; if null, discovers *.git
   */
  constructor(opts = {}) {
    super();
    this.root = opts.root || DEFAULT_BARE_GIT_ROOT;
    this.explicitRepos = opts.repos || null;
  }

  substrateType() { return 'bare-git'; }

  listRepos() {
    if (this.explicitRepos) return [...this.explicitRepos];
    try {
      return fs.readdirSync(this.root)
        .filter((name) => name.endsWith('.git'))
        .filter((name) => {
          // Confirm it's actually a bare-git dir (has HEAD + objects/)
          const p = path.join(this.root, name);
          return fs.existsSync(path.join(p, 'HEAD'))
            && fs.existsSync(path.join(p, 'objects'));
        });
    } catch (err) {
      // Root doesn't exist or unreadable: return empty rather than throw.
      return [];
    }
  }

  /**
   * Walk new commits + merges since lastRef. Returns rows shaped for
   * output_commit + output_merge schema.
   */
  walkRepo(repo, lastRef) {
    const repoPath = path.join(this.root, repo);
    if (!fs.existsSync(path.join(repoPath, 'HEAD'))) {
      return { commits: [], merges: [], newRef: lastRef };
    }
    // Walk from lastRef..HEAD (incremental); or full history if lastRef is null.
    const range = lastRef ? `${lastRef}..HEAD` : 'HEAD';
    const rawCommits = this._gitLog(repoPath, range);
    const newRef = this._gitRevParse(repoPath, 'HEAD');

    const commits = [];
    const merges = [];
    for (const parsed of rawCommits) {
      // Each parsed commit goes into output_commit always. Stats (files
      // changed, bytes delta) require a separate `git show --stat` call;
      // batch separately for performance.
      const stats = this._gitShowStat(repoPath, parsed.sha);
      const parents = parsed.parents.split(' ').filter(Boolean);
      const commitRow = {
        repo,
        commit_sha: parsed.sha,
        author_name: parsed.author_name,
        author_email: parsed.author_email,
        committer_name: parsed.committer_name,
        committer_email: parsed.committer_email,
        occurred_at: parsed.occurred_at,
        branch: null,  // bare-git doesn't track per-commit branch context
        subject: parsed.subject,
        body_digest: parsed.body ? sha256Hex(parsed.body) : null,
        // agent_attribution + attribution_method + runtime_class populated
        // by ingester (uses attribution parser); walker leaves null here.
        agent_attribution: null,
        attribution_method: null,
        runtime_class: null,
        files_changed: stats.files_changed,
        bytes_delta: stats.bytes_delta,
        // Task #290: governance-quality columns. `signed` from bare-git
        // requires `git log --show-signature` which is expensive per-commit;
        // defer to Task #290.1. `parent_count` is free (already parsed).
        signed: 0,
        parent_count: parents.length || 1,
        // Body kept transient on the returned row so the ingester can run
        // the attribution parser without re-fetching. NOT a schema column.
        _body: parsed.body,
        _full_message: `${parsed.subject}\n\n${parsed.body || ''}`,
      };
      commits.push(commitRow);

      // Merge commits: parent_count >= 2. Emit a parallel output_merge row.
      if (parents.length >= 2) {
        merges.push({
          repo,
          merge_commit_sha: parsed.sha,
          source_branch: null,  // not derivable from bare-git plumbing alone
          target_branch: 'main',  // assumption: bare-git canonical is main
          pr_number: null,  // bare-git has no PR concept; Phase 2 GitHub fills
          occurred_at: parsed.occurred_at,
          merged_by_agent: null,  // ingester fills from attribution parser
          attribution_method: null,
          parent_commit_count: parents.length,
          child_commit_count: 0,  // calculated separately; future enhancement
          bytes_delta: stats.bytes_delta,
          _full_message: `${parsed.subject}\n\n${parsed.body || ''}`,
        });
      }
    }
    return { commits, merges, newRef };
  }

  // ── git plumbing helpers (spawnSync with arg-array; no shell) ────────────

  _gitLog(repoPath, range) {
    const result = cp.spawnSync(
      'git',
      [
        `--git-dir=${repoPath}`,
        'log',
        `--format=${COMMIT_FORMAT}${RS_CHAR}`,
        range,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.status !== 0) {
      // range may be invalid (e.g., lastRef no longer exists in repo);
      // fall back to no commits rather than throw.
      return [];
    }
    return result.stdout
      .split(RS_CHAR)
      .map((rec) => rec.trim())
      .filter(Boolean)
      .map((rec) => {
        const fields = rec.split(FS_CHAR);
        return {
          sha: fields[0],
          author_name: fields[1],
          author_email: fields[2],
          committer_name: fields[3],
          committer_email: fields[4],
          occurred_at: fields[5],
          subject: fields[6],
          parents: fields[7] || '',
          body: fields[8] || '',
        };
      });
  }

  _gitRevParse(repoPath, ref) {
    const result = cp.spawnSync(
      'git',
      [`--git-dir=${repoPath}`, 'rev-parse', ref],
      { encoding: 'utf8' },
    );
    if (result.status !== 0) return null;
    return result.stdout.trim();
  }

  _gitShowStat(repoPath, sha) {
    const result = cp.spawnSync(
      'git',
      [
        `--git-dir=${repoPath}`,
        'show',
        '--shortstat',
        '--format=',
        sha,
      ],
      { encoding: 'utf8' },
    );
    if (result.status !== 0) return { files_changed: null, bytes_delta: null };
    // Output shape examples:
    //   " 3 files changed, 42 insertions(+), 8 deletions(-)"
    //   " 1 file changed, 5 insertions(+)"
    const out = result.stdout.trim();
    if (!out) return { files_changed: 0, bytes_delta: 0 };
    const filesMatch = out.match(/(\d+)\s+files?\s+changed/);
    const insMatch = out.match(/(\d+)\s+insertions?\(\+\)/);
    const delMatch = out.match(/(\d+)\s+deletions?\(-\)/);
    return {
      files_changed: filesMatch ? Number(filesMatch[1]) : 0,
      bytes_delta: (insMatch ? Number(insMatch[1]) : 0)
        + (delMatch ? Number(delMatch[1]) : 0),
    };
  }
}

// ── GitHubWalker (Phase 2.1 skeleton — CP13.6) ────────────────────────────
//
// Per parch #9799 canonical ratify on ADR-0032 Phase 2:
//   - Q1 Option C: output_repo table (canonical allowlist substrate-tier;
//     bootstrap from per-host config + ops-mutable via Phase 2.2 endpoint)
//   - Q2 Option A: single canonical PAT at mode-600 file
//     `~yaklog-output-ingester/.config/yaklog/github-pat.token`; scope
//     `repo:read` + `pull_requests:read` only; EnvironmentFile reference
//     via `GITHUB_PAT_FILE` env-var; NEVER argv per feedback_secrets_no_yaklog
//   - Q3 DROP: no output_pr_review table (semantic-class-2 anti-feature)
//
// Phase 2.1 (this commit): substrate skeleton + graceful-degradation
// no-PAT path. With-PAT path stubbed to return skipped:'phase-2.2-pending'
// for substrate-honesty until Phase 2.2 wires real GitHub API.
//
// Phase 2.2 (gated on secops sign-off + Jon-direct PAT mint + ssw-devops
// install per CP13.5 4-gate canon sister-shape): replaces walkRepo with-PAT
// stub with GET /repos/{owner}/{repo}/pulls?state=all&sort=updated&
// since={cursor.last_pr_updated_at} integration + rate-limit handling +
// X-RateLimit-Remaining/Reset cursor tracking.

class GitHubWalker extends OutputWalker {
  /**
   * Phase 2.1 substrate skeleton.
   *
   * @param {object} opts
   * @param {string} [opts.patFile] - path to GitHub PAT file (mode-600;
   *   canonical: `~yaklog-output-ingester/.config/yaklog/github-pat.token`
   *   per Q2 Option A ratify). Walker-class agnostic to canonical path
   *   (caller supplies via constructor).
   * @param {string[]} [opts.repos] - GitHub owner/repo allowlist (canonical
   *   source: output_repo table per Q1 Option C ratify; constructor
   *   accepts pre-resolved list for test mocking).
   * @param {Function} [opts.fetcher] - dependency-injected fetch for
   *   test mocking; defaults to globalThis.fetch (Node 18+ built-in).
   */
  constructor(opts = {}) {
    super();
    this.patFile = opts.patFile;
    this.repos = opts.repos || [];
    this.fetcher = opts.fetcher || globalThis.fetch.bind(globalThis);
    // Sentinel: undefined = not yet checked; null = checked + absent;
    // string = loaded PAT content (cached).
    this._pat = undefined;
  }

  substrateType() { return 'github'; }

  listRepos() {
    return [...this.repos];
  }

  /**
   * Read PAT from file (mode-600 discipline per feedback_secrets_no_yaklog).
   * Caches result after first call — Phase 2.1 read-once-per-walker-instance
   * semantic; ssw-devops restarts service if PAT rotates (sister to CP13.5
   * ops-key rotation discipline). Returns null when patFile missing or
   * unreadable; caller checks return value for graceful-degradation gate.
   *
   * @returns {string|null} PAT content (trimmed) or null if absent
   */
  _loadPat() {
    if (this._pat !== undefined) return this._pat;
    if (!this.patFile) {
      this._pat = null;
      return null;
    }
    try {
      this._pat = require('node:fs').readFileSync(this.patFile, 'utf8').trim();
      return this._pat;
    } catch (_) {
      this._pat = null;
      return null;
    }
  }

  /**
   * Phase 2.2 walker — real GitHub REST API integration.
   *
   * Substrate-states (in priority order):
   *   - no-pat: patFile missing/unreadable → graceful-degradation; bare-git
   *     walker continues unaffected per Phase 1 substrate
   *   - auth-fail: 401 from GitHub (PAT invalid/expired/revoked); cursor
   *     preserved; secops alert-worthy
   *   - rate-limited: 403 with X-RateLimit-Remaining 0; cursor preserved;
   *     next-tick retries after reset
   *   - server-error: 5xx; cursor preserved; transient
   *   - network-error: fetch throws (ECONNRESET / timeout / DNS); cursor preserved
   *   - ok: 2xx; PRs normalized + cursor advanced to max(updated_at)
   *
   * Cursor returned unchanged in all skipped paths; only ok-walk advances.
   *
   * @param {string} githubOwnerRepo - 'owner/repo' canonical key
   * @param {object|null} cursor - { last_pr_updated_at, prs_synced_total, ... }
   * @returns {Promise<{prs:Array, skipped:boolean, reason?:string, cursor:object}>}
   */
  async walkRepo(githubOwnerRepo, cursor) {
    const pat = this._loadPat();
    if (!pat) {
      return { prs: [], skipped: true, reason: 'no-pat', cursor };
    }

    const params = new URLSearchParams({
      state: 'all',
      sort: 'updated',
      direction: 'asc',
      per_page: '100',
    });
    if (cursor && cursor.last_pr_updated_at) {
      params.set('since', cursor.last_pr_updated_at);
    }
    const url = `https://api.github.com/repos/${githubOwnerRepo}/pulls?${params}`;

    let resp;
    try {
      resp = await this.fetcher(url, {
        method: 'GET',
        headers: {
          'Authorization': `token ${pat}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'yaklog-output-ingester/CP13.6',
        },
      });
    } catch (err) {
      return {
        prs: [],
        skipped: true,
        reason: 'network-error',
        cursor: { ...(cursor || {}), last_walk_status: 'error', last_walk_message: String(err.message || err).slice(0, 200) },
      };
    }

    const rateLimitRemaining = parseInt(resp.headers.get('x-ratelimit-remaining'), 10);
    const rateLimitReset = parseInt(resp.headers.get('x-ratelimit-reset'), 10);
    const rateLimitResetAt = Number.isFinite(rateLimitReset)
      ? new Date(rateLimitReset * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
      : null;

    if (resp.status === 401) {
      return {
        prs: [],
        skipped: true,
        reason: 'auth-fail',
        cursor: { ...(cursor || {}), last_walk_status: 'auth-failed', last_walk_message: 'GitHub PAT rejected (401)' },
      };
    }
    if (resp.status === 403 && rateLimitRemaining === 0) {
      return {
        prs: [],
        skipped: true,
        reason: 'rate-limited',
        cursor: {
          ...(cursor || {}),
          last_walk_status: 'rate-limited',
          last_walk_message: `rate-limit exhausted; resets at ${rateLimitResetAt}`,
          rate_limit_remaining: rateLimitRemaining,
          rate_limit_reset_at: rateLimitResetAt,
        },
      };
    }
    if (resp.status >= 500) {
      return {
        prs: [],
        skipped: true,
        reason: 'server-error',
        cursor: { ...(cursor || {}), last_walk_status: 'error', last_walk_message: `HTTP ${resp.status}` },
      };
    }
    if (!resp.ok) {
      return {
        prs: [],
        skipped: true,
        reason: 'server-error',
        cursor: { ...(cursor || {}), last_walk_status: 'error', last_walk_message: `HTTP ${resp.status}` },
      };
    }

    const rawPrs = await resp.json();
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const prs = rawPrs.map((pr) => normalizePr(pr, githubOwnerRepo, now));

    // Cursor advances to max(updated_at) of fetched PRs — cohort-cursor
    // semantic per Q4 sub-OQ ratify (#9799). If no PRs returned, preserve
    // existing cursor timestamp.
    let nextLastUpdatedAt = cursor && cursor.last_pr_updated_at;
    for (const pr of rawPrs) {
      if (!nextLastUpdatedAt || pr.updated_at > nextLastUpdatedAt) {
        nextLastUpdatedAt = pr.updated_at;
      }
    }
    const priorTotal = (cursor && cursor.prs_synced_total) || 0;

    return {
      prs,
      skipped: false,
      cursor: {
        last_pr_updated_at: nextLastUpdatedAt || now,
        prs_synced_total: priorTotal + prs.length,
        rate_limit_remaining: Number.isFinite(rateLimitRemaining) ? rateLimitRemaining : null,
        rate_limit_reset_at: rateLimitResetAt,
        last_walk_status: 'ok',
        last_walk_message: null,
      },
    };
  }

  // CP13.6 Phase 3 (Task #290): repo-meta walker.
  //
  // One-shot GET /repos/:owner/:repo for governance-coverage signals
  // (creation date, default branch, size, primary language, visibility,
  // updated_at, pushed_at). Substrate parity with Task #290 PLAN:
  // output_repo gains github_* metadata columns; walker is stateless per
  // pass (no cursor — always fetch current shape).
  //
  // States mirror walkRepo() shape: no-pat / auth-fail / rate-limited /
  // server-error / network-error / ok. `meta` is null on skipped paths.
  async walkRepoMeta(githubOwnerRepo) {
    const pat = this._loadPat();
    if (!pat) {
      return { meta: null, skipped: true, reason: 'no-pat' };
    }
    const url = `https://api.github.com/repos/${githubOwnerRepo}`;
    let resp;
    try {
      resp = await this.fetcher(url, {
        method: 'GET',
        headers: {
          'Authorization': `token ${pat}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'yaklog-output-ingester/CP13.6-p3',
        },
      });
    } catch (err) {
      return {
        meta: null,
        skipped: true,
        reason: 'network-error',
        error: String(err.message || err).slice(0, 200),
      };
    }
    if (resp.status === 401) return { meta: null, skipped: true, reason: 'auth-fail' };
    const rateRemaining = parseInt(resp.headers.get('x-ratelimit-remaining'), 10);
    if (resp.status === 403 && rateRemaining === 0) {
      return { meta: null, skipped: true, reason: 'rate-limited' };
    }
    if (!resp.ok) {
      return { meta: null, skipped: true, reason: 'server-error', error: `HTTP ${resp.status}` };
    }
    const raw = await resp.json();
    return {
      meta: {
        github_repo_created_at: raw.created_at || null,
        github_default_branch: raw.default_branch || null,
        github_size_kb: Number.isFinite(raw.size) ? raw.size : null,
        github_primary_language: raw.language || null,
        github_visibility: raw.visibility || (raw.private ? 'private' : 'public'),
        github_repo_updated_at: raw.updated_at || null,
        github_repo_pushed_at: raw.pushed_at || null,
      },
      skipped: false,
    };
  }

  // CP13.6 Phase 3 (Task #290): commits walker.
  //
  // Paginated GET /repos/:owner/:repo/commits?since=<cursor.last_commit_committed_at>
  // Follows Link: rel="next" for cursor-forward walk; caps at 10000 commits per
  // pass to bound first-walk on large repos (subsequent passes are incremental
  // via since= and typically fit in a few pages). GitHub committer-date is the
  // canonical ordering axis; author-date can predate `since` on backport
  // patches so we filter downstream.
  //
  // Rate-limit + auth-fail + network-error semantics mirror walkRepo().
  // Cursor advances to max(commit.committer.date) of returned commits.
  //
  // Returned commits are output_commit-shape with `_full_message` (for
  // attribution parsing at ingester tier) and `_body` (unused post-parse).
  async walkCommits(githubOwnerRepo, cursor) {
    const pat = this._loadPat();
    if (!pat) return { commits: [], skipped: true, reason: 'no-pat', cursor };
    const perPage = 100;
    const maxCommits = 10000;
    const headers = {
      'Authorization': `token ${pat}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'yaklog-output-ingester/CP13.6-p3',
    };
    const params = new URLSearchParams({ per_page: String(perPage) });
    if (cursor && cursor.last_commit_committed_at) {
      params.set('since', cursor.last_commit_committed_at);
    }
    let url = `https://api.github.com/repos/${githubOwnerRepo}/commits?${params}`;
    const collected = [];
    let rateLimitRemaining = null;
    let rateLimitResetAt = null;
    let lastResp = null;

    while (url && collected.length < maxCommits) {
      let resp;
      try {
        resp = await this.fetcher(url, { method: 'GET', headers });
      } catch (err) {
        return {
          commits: [],
          skipped: true,
          reason: 'network-error',
          cursor: {
            ...(cursor || {}),
            last_walk_status: 'error',
            last_walk_message: String(err.message || err).slice(0, 200),
          },
        };
      }
      lastResp = resp;
      const rrRemaining = parseInt(resp.headers.get('x-ratelimit-remaining'), 10);
      const rrReset = parseInt(resp.headers.get('x-ratelimit-reset'), 10);
      rateLimitRemaining = Number.isFinite(rrRemaining) ? rrRemaining : null;
      rateLimitResetAt = Number.isFinite(rrReset)
        ? new Date(rrReset * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
        : null;

      if (resp.status === 401) {
        return {
          commits: [],
          skipped: true,
          reason: 'auth-fail',
          cursor: { ...(cursor || {}), last_walk_status: 'auth-failed', last_walk_message: 'GitHub PAT rejected (401)' },
        };
      }
      if (resp.status === 403 && rrRemaining === 0) {
        return {
          commits: [],
          skipped: true,
          reason: 'rate-limited',
          cursor: {
            ...(cursor || {}),
            last_walk_status: 'rate-limited',
            last_walk_message: `rate-limit exhausted; resets at ${rateLimitResetAt}`,
            rate_limit_remaining: 0,
            rate_limit_reset_at: rateLimitResetAt,
          },
        };
      }
      // Empty repo: GitHub returns 409 Conflict on /commits when repo has no commits
      if (resp.status === 409) {
        return {
          commits: [],
          skipped: true,
          reason: 'empty-repo',
          cursor: { ...(cursor || {}), last_walk_status: 'ok', last_walk_message: 'empty repo' },
        };
      }
      if (resp.status >= 500 || !resp.ok) {
        return {
          commits: [],
          skipped: true,
          reason: 'server-error',
          cursor: { ...(cursor || {}), last_walk_status: 'error', last_walk_message: `HTTP ${resp.status}` },
        };
      }

      const page = await resp.json();
      if (!Array.isArray(page) || page.length === 0) break;
      for (const c of page) {
        if (collected.length >= maxCommits) break;
        collected.push(c);
      }
      url = parseNextLink(resp.headers.get('link'));
    }

    // Normalize + compute next cursor
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    let nextCommittedAt = cursor && cursor.last_commit_committed_at;
    let nextSha = cursor && cursor.last_commit_sha;
    const commits = [];
    for (const raw of collected) {
      const committedAt = raw.commit && raw.commit.committer && raw.commit.committer.date;
      // De-dupe: `since=` is inclusive → skip cursor sha if present
      if (nextSha && raw.sha === nextSha) continue;
      commits.push(normalizeGithubCommit(raw, githubOwnerRepo));
      if (!nextCommittedAt || (committedAt && committedAt > nextCommittedAt)) {
        nextCommittedAt = committedAt;
        nextSha = raw.sha;
      }
    }

    const priorTotal = (cursor && cursor.commits_synced_total) || 0;
    return {
      commits,
      skipped: false,
      cursor: {
        last_commit_committed_at: nextCommittedAt || now,
        last_commit_sha: nextSha || null,
        commits_synced_total: priorTotal + commits.length,
        rate_limit_remaining: rateLimitRemaining,
        rate_limit_reset_at: rateLimitResetAt,
        last_walk_status: 'ok',
        last_walk_message: collected.length >= maxCommits ? 'walk-cap-reached-10k' : null,
      },
    };
  }
}

// Parse GitHub's `Link:` response header for rel="next" URL.
// Header format: `<url1>; rel="next", <url2>; rel="last"`
function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const segment of linkHeader.split(',')) {
    const [urlPart, ...relParts] = segment.split(';').map((s) => s.trim());
    if (relParts.some((p) => p === 'rel="next"')) {
      const m = urlPart.match(/^<(.+)>$/);
      if (m) return m[1];
    }
  }
  return null;
}

// Normalize a GitHub commit-API row to output_commit shape. Attribution +
// runtime-class populate downstream via parseAttribution; body_digest
// enables client-side dedupe (sister-shape bare-git).
function normalizeGithubCommit(raw, githubOwnerRepo) {
  const commit = raw.commit || {};
  const author = commit.author || {};
  const committer = commit.committer || {};
  const subject = (commit.message || '').split('\n')[0];
  const body = (commit.message || '').split('\n').slice(1).join('\n').replace(/^\n+/, '');
  const verified = commit.verification && commit.verification.verified === true;
  const parentCount = Array.isArray(raw.parents) ? raw.parents.length : 1;
  return {
    repo: githubOwnerRepo,
    commit_sha: raw.sha,
    author_name: author.name || '',
    author_email: author.email || '',
    committer_name: committer.name || author.name || '',
    committer_email: committer.email || author.email || '',
    occurred_at: committer.date || author.date || null,
    branch: null, // GitHub commits API is branch-agnostic; default-branch resolved at repo-meta tier
    subject,
    body_digest: body ? sha256Hex(body) : null,
    files_changed: null, // per-commit stats require additional GET /repos/:o/:r/commits/:sha; deferred
    bytes_delta: null,
    signed: verified ? 1 : 0,
    parent_count: parentCount,
    _body: body,
    _full_message: commit.message || '',
  };
}

// Normalize a GitHub API PR response to output_pr-shape row.
// State derivation: GitHub uses {open, closed}; we expand to {open, merged, closed}
// based on merged_at presence (closed + merged_at = merged; closed + !merged_at = closed).
function normalizePr(pr, githubOwnerRepo, lastSyncedAt) {
  let state = pr.state;
  if (state === 'closed' && pr.merged_at) state = 'merged';
  return {
    github_owner_repo: githubOwnerRepo,
    pr_number: pr.number,
    state,
    title: pr.title,
    author_login: pr.user && pr.user.login,
    author_email: (pr.user && pr.user.email) || null,
    base_ref: pr.base && pr.base.ref,
    head_ref: pr.head && pr.head.ref,
    opened_at: pr.created_at,
    merged_at: pr.merged_at,
    closed_at: pr.closed_at,
    merge_commit_sha: pr.merge_commit_sha,
    commit_count: null,  // Phase 2.x: requires per-PR detail fetch; forward-track
    last_synced_at: lastSyncedAt,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────

function sha256Hex(s) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

module.exports = {
  OutputWalker,
  BareGitWalker,
  GitHubWalker,
  // exposed for unit testing
  DEFAULT_BARE_GIT_ROOT,
  FS_CHAR,
  RS_CHAR,
};
