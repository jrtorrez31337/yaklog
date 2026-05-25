#!/usr/bin/env bash
# install-plexus-otel.sh — self-install Plexus OTel opt-in for one agent.
#
# What this does (in order):
#   1. Writes ~/.config/yaklog/<agent-id>-otel.env with the agent-specific
#      OTel env block (Profile C minus TOOL_CONTENT, per Plan C Q4 ratify).
#   2. Auto-wires a `source <env-file>` line into the FIRST detected
#      launcher among:
#        a. ~/.config/yaklog/<agent-id>-runtime.sh           (aieng3-style)
#        b. ~/.config/yaklog/<agent-id>.env                  (env-file-loader style)
#        c. ~/.bashrc                                        (interactive fallback)
#      Edits are bounded by idempotent BEGIN/END markers so re-runs
#      cleanly REPLACE the block rather than appending duplicates.
#   3. Backs up any file before editing (timestamped .bak).
#   4. Verifies bash syntax of any edited file.
#   5. Prints next steps (restart CC session; verify command).
#
# Usage:
#   bash install-plexus-otel.sh <agent-id>            # full install
#   bash install-plexus-otel.sh <agent-id> --dry-run  # show what would happen, no writes
#   bash install-plexus-otel.sh <agent-id> --no-source # write env file only;
#                                                       # operator wires source manually
#   bash install-plexus-otel.sh --uninstall <agent-id> # remove the block + env file
#
# Pre-conditions:
#   - On devel LAN (collector reachable at 192.168.122.76:4328)
#   - YAKLOG_TOKEN exported OR readable at ~/.config/yaklog/token
#   - CC >= 2.1.144
#
# Exit codes:
#   0  success / dry-run / uninstall complete
#   1  bad usage
#   2  pre-condition failed (token not findable; etc.)
#   3  detected launcher had syntax errors AFTER edit (rolled back)
#
# Canonical: yaklog repo ~/yaklog/otel/install-plexus-otel.sh
# Pull via: scp jon@devel:~/yaklog/otel/install-plexus-otel.sh ~/  (or bare-git)

set -euo pipefail

# ── arg parsing ───────────────────────────────────────────────────────
DRY_RUN=0
NO_SOURCE=0
UNINSTALL=0
AGENT_ID=""

while (( $# )); do
  case "$1" in
    --dry-run)   DRY_RUN=1 ;;
    --no-source) NO_SOURCE=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help)
      sed -n '2,/^set -/p' "$0" | sed -e 's/^# //' -e 's/^#//'
      exit 0 ;;
    -*)
      echo "unknown flag: $1" >&2; exit 1 ;;
    *)
      if [[ -z "$AGENT_ID" ]]; then AGENT_ID="$1"
      else echo "unexpected arg: $1" >&2; exit 1; fi
      ;;
  esac
  shift
done

if [[ -z "$AGENT_ID" ]]; then
  echo "usage: $0 <agent-id> [--dry-run | --no-source | --uninstall]" >&2
  exit 1
fi

# Validate agent_id shape (mirrors backend allowlist regex SAFE_LABEL_VALUE)
if ! [[ "$AGENT_ID" =~ ^[a-zA-Z0-9@._+:/\-]{1,128}$ ]]; then
  echo "invalid agent-id '$AGENT_ID' — must match /^[a-zA-Z0-9@._+:/\\-]{1,128}\$/" >&2
  exit 1
fi

# ── paths ─────────────────────────────────────────────────────────────
ENV_DIR="$HOME/.config/yaklog"
ENV_FILE="$ENV_DIR/${AGENT_ID}-otel.env"
TOKEN_FILE="$HOME/.config/yaklog/token"

BEGIN_MARKER="# >>> plexus-otel install for ${AGENT_ID} >>>"
END_MARKER="# <<< plexus-otel install for ${AGENT_ID} <<<"

# Launcher detection order (first match wins).
LAUNCHER_CANDIDATES=(
  "$HOME/.config/yaklog/${AGENT_ID}-runtime.sh"
  "$HOME/.config/yaklog/${AGENT_ID}.env"
  "$HOME/.bashrc"
)

# ── helpers ───────────────────────────────────────────────────────────
log()  { printf '[install-plexus-otel] %s\n' "$*"; }
warn() { printf '[install-plexus-otel] WARN: %s\n' "$*" >&2; }
err()  { printf '[install-plexus-otel] ERROR: %s\n' "$*" >&2; }

# ── uninstall path ────────────────────────────────────────────────────
if (( UNINSTALL )); then
  log "uninstalling for agent=$AGENT_ID"
  if [[ -f "$ENV_FILE" ]]; then
    if (( DRY_RUN )); then
      log "  would rm $ENV_FILE"
    else
      rm -f "$ENV_FILE" && log "  removed $ENV_FILE"
    fi
  fi
  for cand in "${LAUNCHER_CANDIDATES[@]}"; do
    if [[ -f "$cand" ]] && grep -qF "$BEGIN_MARKER" "$cand"; then
      if (( DRY_RUN )); then
        log "  would strip marker block from $cand"
      else
        local_bak="${cand}.bak.pre-plexus-uninstall-$(date +%Y%m%dT%H%M%SZ)"
        cp "$cand" "$local_bak"
        # Remove BEGIN..END (inclusive). Use awk for portability.
        awk -v bm="$BEGIN_MARKER" -v em="$END_MARKER" '
          $0 == bm { inblock=1; next }
          $0 == em { inblock=0; next }
          !inblock { print }
        ' "$cand" > "${cand}.tmp" && mv "${cand}.tmp" "$cand"
        log "  stripped marker block from $cand (backup: $local_bak)"
      fi
    fi
  done
  log "done."
  exit 0
fi

# ── pre-conditions ────────────────────────────────────────────────────
if [[ ! -r "$TOKEN_FILE" && -z "${YAKLOG_TOKEN:-}" ]]; then
  err "no YAKLOG_TOKEN env var and $TOKEN_FILE not readable — can't bootstrap"
  err "set YAKLOG_TOKEN or place your token at $TOKEN_FILE first"
  exit 2
fi

mkdir -p "$ENV_DIR"

# ── step 1: generate env file ─────────────────────────────────────────
log "agent=$AGENT_ID"
log "env file: $ENV_FILE"

ENV_BLOCK="$(cat <<EOF
# Plexus OTel opt-in for ${AGENT_ID}.
# Generated by install-plexus-otel.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ).
# Per Plan C Q4 Jon-ratify 2026-05-24: Profile C minus TOOL_CONTENT.
# Privacy: data stays in the devel Plexus stack; does NOT cross the
# yaklog bus; does NOT leave devel.
#
# Re-source after editing OR restart your CC session to pick up changes.
# (CC reads env at process start only.)

export CLAUDE_CODE_ENABLE_TELEMETRY=1

# Push target (OTLP/HTTP)
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT=http://192.168.122.76:4328

# Bearer auth — reuse yaklog token (no new credential to provision)
if [[ -z "\${YAKLOG_TOKEN:-}" && -r "$TOKEN_FILE" ]]; then
  export YAKLOG_TOKEN="\$(cat "$TOKEN_FILE")"
fi
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer \${YAKLOG_TOKEN}"

# Identity binding (this is YOUR agent_id; matches plexus_agent_id in Prom labels)
export OTEL_RESOURCE_ATTRIBUTES="plexus.agent_id=${AGENT_ID},plexus.cluster_id=ssw-dev,plexus.deployment=devel"

# Exporters
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_TRACES_EXPORTER=none

# Profile C minus TOOL_CONTENT — enterprise full-data-capture default
export OTEL_LOG_USER_PROMPTS=1
export OTEL_LOG_TOOL_DETAILS=1
export OTEL_LOG_RAW_API_BODIES=1

# Cardinality + cadence
export OTEL_METRICS_INCLUDE_SESSION_ID=false
export OTEL_METRIC_EXPORT_INTERVAL=60000
export OTEL_LOGS_EXPORT_INTERVAL=5000
EOF
)"

if (( DRY_RUN )); then
  log "would write to $ENV_FILE:"
  printf '%s\n' "$ENV_BLOCK" | sed 's/^/    /'
else
  if [[ -f "$ENV_FILE" ]]; then
    cp "$ENV_FILE" "${ENV_FILE}.bak-$(date +%Y%m%dT%H%M%SZ)"
    log "  backed up existing $ENV_FILE"
  fi
  printf '%s\n' "$ENV_BLOCK" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  log "  wrote $ENV_FILE (mode 600)"
fi

# ── step 2: wire `source` into launcher ───────────────────────────────
if (( NO_SOURCE )); then
  log "--no-source given; skipping launcher wiring"
  log ""
  log "Manual step: add this line to your CC-launching shell:"
  log "    source $ENV_FILE"
  log ""
  log "Then restart your CC session."
  exit 0
fi

LAUNCHER=""
for cand in "${LAUNCHER_CANDIDATES[@]}"; do
  if [[ -f "$cand" ]]; then LAUNCHER="$cand"; break; fi
done

if [[ -z "$LAUNCHER" ]]; then
  warn "no launcher detected from: ${LAUNCHER_CANDIDATES[*]}"
  warn "creating ~/.bashrc and wiring source line there as a fallback"
  if (( DRY_RUN )); then
    log "  would touch $HOME/.bashrc"
  else
    touch "$HOME/.bashrc"
  fi
  LAUNCHER="$HOME/.bashrc"
fi

log "launcher: $LAUNCHER"

SOURCE_LINE="[[ -r \"$ENV_FILE\" ]] && source \"$ENV_FILE\""

if grep -qF "$BEGIN_MARKER" "$LAUNCHER"; then
  log "  block already present — replacing in-place (idempotent)"
  if (( DRY_RUN )); then
    log "  would replace block bounded by:"
    log "    $BEGIN_MARKER"
    log "    $END_MARKER"
  else
    cp "$LAUNCHER" "${LAUNCHER}.bak-$(date +%Y%m%dT%H%M%SZ)"
    awk -v bm="$BEGIN_MARKER" -v em="$END_MARKER" -v line="$SOURCE_LINE" '
      $0 == bm { print bm; print line; print em; inblock=1; next }
      $0 == em { inblock=0; next }
      !inblock { print }
    ' "$LAUNCHER" > "${LAUNCHER}.tmp" && mv "${LAUNCHER}.tmp" "$LAUNCHER"
    log "  replaced block in $LAUNCHER"
  fi
else
  log "  appending new block"
  if (( DRY_RUN )); then
    log "  would append:"
    log "    $BEGIN_MARKER"
    log "    $SOURCE_LINE"
    log "    $END_MARKER"
  else
    cp "$LAUNCHER" "${LAUNCHER}.bak-$(date +%Y%m%dT%H%M%SZ)" 2>/dev/null || true
    {
      printf '\n%s\n' "$BEGIN_MARKER"
      printf '%s\n' "$SOURCE_LINE"
      printf '%s\n' "$END_MARKER"
    } >> "$LAUNCHER"
    log "  appended source-block to $LAUNCHER"
  fi
fi

# ── step 3: bash-syntax-check the edited launcher ─────────────────────
if (( ! DRY_RUN )); then
  if ! bash -n "$LAUNCHER" 2>/dev/null; then
    err "post-edit syntax check failed on $LAUNCHER — rolling back"
    LAST_BAK="$(ls -t "${LAUNCHER}.bak-"* 2>/dev/null | head -1)"
    if [[ -n "$LAST_BAK" ]]; then
      cp "$LAST_BAK" "$LAUNCHER"
      err "restored from $LAST_BAK"
    fi
    exit 3
  fi
fi

# ── step 4: print next steps ──────────────────────────────────────────
log ""
log "=== INSTALL COMPLETE ==="
log ""
log "1. Restart your Claude Code session so it picks up the new env vars."
log "   (CC reads env at process start; running sessions won't see this until restart.)"
log ""
log "2. After your restarted session has made at least one API call + tool use,"
log "   verify telemetry is flowing:"
log ""
log "   curl -sS 'http://192.168.122.76:9090/api/v1/query?query=claude_code_session_count_total{plexus_agent_id=\"${AGENT_ID}\"}' | python3 -m json.tool"
log ""
log "3. Visit the dashboard at http://192.168.122.76:3100/dashboard ; your agent"
log "   should appear in the Live tab charts within ~60s of first activity."
log ""
log "To uninstall later: $0 --uninstall $AGENT_ID"
