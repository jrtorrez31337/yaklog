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
        // Body kept transient on the returned row so the ingester can run
        // the attribution parser without re-fetching. NOT a schema column.
        _body: parsed.body,
        _full_message: `${parsed.subject}\n\n${parsed.body || ''}`,
      };
      commits.push(commitRow);

      // Merge commits: parent_count >= 2. Emit a parallel output_merge row.
      const parents = parsed.parents.split(' ').filter(Boolean);
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
//     `~plexus-output-ingester/.config/yaklog/github-pat.token`; scope
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
   *   canonical: `~plexus-output-ingester/.config/yaklog/github-pat.token`
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
   * Phase 2.1 substrate-honest walker.
   *
   * Three substrate-states:
   *   - no-pat: patFile missing/unreadable → graceful-degradation; bare-git
   *     walker continues unaffected per Phase 1 substrate
   *   - phase-2.2-pending: PAT loadable but real API call not yet wired
   *     (this stub; Phase 2.2 replaces with actual GitHub API integration)
   *   - real-walk: Phase 2.2+ — actual PRs fetched + cursor advanced
   *
   * Cursor returned unchanged in skipped paths; only real-walk advances it.
   *
   * @param {string} githubOwnerRepo - 'owner/repo' canonical key
   * @param {object|null} cursor - { last_pr_updated_at, rate_limit_*, ... }
   *   or null on first walk
   * @returns {Promise<{prs:Array, skipped:boolean, reason?:string, cursor:object|null}>}
   */
  async walkRepo(githubOwnerRepo, cursor) {
    const pat = this._loadPat();
    if (!pat) {
      return { prs: [], skipped: true, reason: 'no-pat', cursor };
    }
    // Phase 2.2 replaces this stub with real GitHub API integration
    return { prs: [], skipped: true, reason: 'phase-2.2-pending', cursor };
  }
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
