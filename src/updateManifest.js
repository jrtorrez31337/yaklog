// Plan C Stage 4 CP7.1 — canonical artifact manifest for /update.
//
// Hand-curated list of cluster-canonical artifacts. Each entry tells
// operators + agents:
//   - what the canonical artifact is
//   - which version is current
//   - where to pull from (bare-git path on devel)
//   - how to install / upgrade
//   - what changed in the most recent canonical release
//
// Update this file when shipping a canonical artifact change. The
// /update HTML page + /api/v1/update/manifest JSON endpoint read from
// here. Dashboard's AgentCard "update available" pill compares
// agent-reported daemon_version against the daemon entry's version.
//
// Future: auto-generate from bare-git tags + commit metadata. For now
// hand-curated keeps the format flexible while we figure out what
// fields operators actually use.

const MANIFEST = {
  // Generated-at; manifest format version for forward-compat consumers
  format_version: 1,
  generated_at: new Date().toISOString(),

  artifacts: [
    {
      name: 'yaklog server',
      version: '0.5.7.2',
      source_repo: '/srv/git/yaklog.git',
      source_path: 'src/',
      install_command:
        'WORK=$(mktemp -d); git clone /srv/git/yaklog.git "$WORK/y"; ' +
        'cd "$WORK/y" && docker compose up -d --build yaklog',
      description:
        'Node.js/Express/SQLite SSE message bus + Plexus dashboard. ' +
        'Runs in docker; rebuild + restart picks up the new commit.',
      changed_in:
        'CP6.13 (rate/lookback labels) + CP6.10 (Runtime card split) + ' +
        'CP6.8 (env schema). Cumulative since last v-bump.',
      audience: 'devel operator (docker host)',
    },

    {
      name: 'yaklog-sub daemon',
      version: '0.5.7.4',
      source_repo: '/srv/git/agent-tooling.git',
      source_path: 'yaklog-sub/yaklog-sub',
      install_command:
        'WORK=$(mktemp -d); git clone /srv/git/agent-tooling.git "$WORK/at" && ' +
        'install -m 755 "$WORK/at/yaklog-sub/yaklog-sub" ~/.local/bin/yaklog-sub && ' +
        'systemctl --user restart yaklog-sub@<YOUR-AGENT-ID>.service',
      description:
        'Per-agent Python daemon: tails state.jsonl, posts /presence/event ' +
        'heartbeat. v0.5.7.4 adds daemon_pid/version/started_at reporting ' +
        'for the Runtime card view.',
      changed_in:
        'v0.5.7.4 — daemon-process detail reporting (CP6.10). ' +
        'v0.5.7.3 — uid/gid/hostname/cwd reporting (CP6.8). ' +
        'v0.5.7.1 — semantic-clear current_tool on PostToolUse (yaklog #6347).',
      audience: 'every CC agent',
      check_dashboard_pill: true,  // dashboard surfaces "update available" via this entry
    },

    {
      name: 'install-plexus-otel.sh',
      version: 'v3 (b5622e8)',
      source_repo: '/srv/git/yaklog.git',
      source_path: 'otel/install-plexus-otel.sh',
      install_command:
        'WORK=$(mktemp -d); git clone /srv/git/yaklog.git "$WORK/y" && ' +
        'install -m 755 "$WORK/y/otel/install-plexus-otel.sh" ~/install-plexus-otel.sh && ' +
        '~/install-plexus-otel.sh <YOUR-AGENT-ID>',
      description:
        'Per-agent OTel opt-in installer. v3 writes to ' +
        '<workspace>/.claude/settings.local.json env (CC reads at session start). ' +
        'Default bearer = placeholder (no token-at-rest).',
      changed_in:
        'v3 (b5622e8) — placeholder-bearer default + dry-run redaction. ' +
        'v2 — settings.local.json mechanism (replaced inert source-line v1).',
      audience: 'every CC agent',
    },

    {
      name: 'plexus-emit.sh',
      version: 'edaba03',
      source_repo: '/srv/git/yaklog.git',
      source_path: 'otel/plexus-emit.sh',
      install_command:
        'WORK=$(mktemp -d); git clone /srv/git/yaklog.git "$WORK/y" && ' +
        'mkdir -p ~/.yaklog && install -m 755 "$WORK/y/otel/plexus-emit.sh" ~/.yaklog/plexus-emit.sh',
      description:
        'OTLP push helper for non-CC runtimes (Gemini CLI, Codex, custom). ' +
        'Hides OTLP/HTTP JSON payload shape behind a one-line invocation.',
      changed_in: 'Initial drop (edaba03) per yaklog #6325.',
      audience: 'non-CC runtime agents (e.g. gemini-agent)',
    },

    {
      name: 'spawn-monitor.sh',
      version: 'c87eb86',
      source_repo: '/srv/git/agent-tooling.git',
      source_path: 'hooks/spawn-monitor.sh',
      install_command:
        'WORK=$(mktemp -d); git clone /srv/git/agent-tooling.git "$WORK/at" && ' +
        'install -m 755 "$WORK/at/hooks/spawn-monitor.sh" ~/.yaklog/spawn-monitor.sh',
      description:
        'Idempotent fire-and-forget Monitor (tail -F events.ndjson | jq) ' +
        'spawner. Designed for SessionStart hook on bare-launched CC sessions.',
      changed_in: 'Initial drop (c87eb86) per yaklog #6400 (Path E).',
      audience: 'every CC agent (especially bare-launched sessions)',
    },

    {
      name: 'monitor-watchdog suite',
      version: '5610-track-B',
      source_repo: '/srv/git/agent-tooling.git',
      source_path: 'hooks/monitor-watchdog{.sh,@.service,@.timer}',
      install_command:
        'WORK=$(mktemp -d); git clone /srv/git/agent-tooling.git "$WORK/at" && ' +
        'install -m 755 "$WORK/at/hooks/monitor-watchdog.sh" ~/.yaklog/monitor-watchdog.sh && ' +
        'install -m 644 "$WORK/at/hooks/monitor-watchdog@.service" ~/.config/systemd/user/ && ' +
        'install -m 644 "$WORK/at/hooks/monitor-watchdog@.timer" ~/.config/systemd/user/ && ' +
        'systemctl --user daemon-reload && ' +
        'systemctl --user enable --now monitor-watchdog@<YOUR-AGENT-ID>.timer',
      description:
        'Systemd-user timer that probes Monitor liveness every 30s. ' +
        'Writes MonitorDead to state.jsonl when the events.ndjson tailer ' +
        'is absent (so dashboard pill goes orange).',
      changed_in: 'Track B Monitor durability per yaklog-dev #5610.',
      audience: 'every CC agent (paired with spawn-monitor.sh)',
    },

    {
      name: 'emit-hook-event.sh',
      version: 'v3 (5e018e9 + 6cc70ba)',
      source_repo: '/srv/git/agent-tooling.git',
      source_path: 'hooks/emit-hook-event.sh',
      install_command:
        'WORK=$(mktemp -d); git clone /srv/git/agent-tooling.git "$WORK/at" && ' +
        'install -m 755 "$WORK/at/hooks/emit-hook-event.sh" ~/.yaklog/emit-hook-event.sh',
      description:
        'CC hook helper: appends one JSONL line per hook event to ' +
        'state.jsonl. v3 captures stdin payload (when CC delivers it).',
      changed_in:
        'v3 (5e018e9) — stdin-payload passthrough. ' +
        '6cc70ba — set-u-safe XDG_RUNTIME_DIR (macOS fix).',
      audience: 'every CC agent (wired in settings.local.json hooks)',
    },

    {
      name: 'settings-template.json',
      version: 'v0.5.7 (5e8be08)',
      source_repo: '/srv/git/agent-tooling.git',
      source_path: 'hooks/settings-template.json',
      install_command:
        '# Template only; copy + merge into <workspace>/.claude/settings.local.json. ' +
        'Replace <YOUR-AGENT-ID> + <YOUR-UNIX-HOME>.',
      description:
        'Canonical hook-events template for CC. v0.5.7 adds StopFailure + ' +
        'SubagentStart + SubagentStop + PostToolUseFailure hooks.',
      changed_in: 'v0.5.7 — 4 new hook events for richer session_state visibility.',
      audience: 'every CC agent (one-time wire-up; refresh on hook-set changes)',
    },
  ],
};

function getManifest() {
  // Return a fresh copy with current generated_at timestamp; rest is static.
  return {
    ...MANIFEST,
    generated_at: new Date().toISOString(),
  };
}

// Convenience: pluck the canonical version of a named artifact. Used by
// presence-row enrichment (CP7.2) to compare against reported daemon_version.
function canonicalVersionOf(artifactName) {
  const a = MANIFEST.artifacts.find((x) => x.name === artifactName);
  return a ? a.version : null;
}

module.exports = { getManifest, canonicalVersionOf, MANIFEST };
