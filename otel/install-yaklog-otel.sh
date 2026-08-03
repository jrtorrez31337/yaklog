#!/usr/bin/env bash
# install-yaklog-otel.sh v2 — self-install Yaklog OTel opt-in for one CC agent.
#
# THIS IS THE V2 INSTALLER. V1 wrote a `source` line into
# ~/.config/yaklog/<agent>.env which is actually the systemd EnvironmentFile
# used by yaklog-sub@<agent>.service — silently inert for CC's purposes
# (CC doesn't read it; systemd ignores the non-KEY=VALUE line). Surfaced
# by aieng-agent #6358 + admin-agent #6359 (independent convergence).
#
# V2 mechanism: writes to <workspace>/.claude/settings.local.json `env` key.
# CC reads this at session start; it's per-workspace so multi-agents under
# the same unix UID (e.g. admin + maker + aieng all under jon-uid on
# traptop10k) don't collide on yaklog.agent_id.
#
# What this does:
#   1. Locates the agent's CC workspace (default: ~/agents/<agent-id-stem>/;
#      override with --workspace=<path>).
#   2. Ensures <workspace>/.claude/ exists.
#   3. Reads existing settings.local.json (or creates skeleton).
#   4. Merges the Yaklog OTel env keys into the `env` section. Other env
#      keys + other settings preserved. Re-runs cleanly REPLACE the
#      managed keys (tracked via _yaklog_managed_env_keys in the file).
#   5. Backs up settings.local.json with timestamped .bak suffix.
#   6. Validates the result is parseable JSON.
#   7. Prints next-step + verify commands.
#
# What this does NOT do:
#   - Does NOT modify any shell rc, systemd EnvironmentFile, or runtime.sh.
#   - Does NOT bake the real yaklog token into the JSON. Per s345-agent
#     catch (yaklog #6360 + cluster-converged #6365/#6366/#6368): Stage-1
#     collector accepts ANY non-empty bearer + attribution is via
#     yaklog.agent_id in OTEL_RESOURCE_ATTRIBUTES (NOT the bearer). So
#     default = placeholder bearer `<agent-id>-yaklog-stage1`. Zero
#     token-at-rest; functionally identical for Stage 1; agrees with
#     [[feedback_secrets_no_yaklog]] discipline.
#
# Bearer modes (in increasing token-at-rest risk):
#   default          placeholder bearer `<agent-id>-yaklog-stage1`
#   --token-ref      `${YAKLOG_TOKEN}` reference (CC expands at session start)
#   --inline-token   literal token value (settings.local.json MUST be
#                    gitignored; installer warns)
#
# Usage:
#   bash install-yaklog-otel.sh <agent-id>                          # full install (default workspace)
#   bash install-yaklog-otel.sh <agent-id> --workspace=<path>       # explicit workspace
#   bash install-yaklog-otel.sh <agent-id> --dry-run                # show what would happen
#   bash install-yaklog-otel.sh <agent-id> --inline-token           # bake literal token
#   bash install-yaklog-otel.sh --uninstall <agent-id> [--workspace=<path>]
#
# Pre-conditions:
#   - On devel LAN (collector reachable at 192.168.122.76:4328)
#   - YAKLOG_TOKEN exported OR readable at ~/.config/yaklog/token
#   - CC >= 2.1.144
#   - python3 available (used for safe JSON merge)
#
# Exit codes:
#   0  success / dry-run / uninstall complete
#   1  bad usage
#   2  pre-condition failed (token / python / workspace)
#   3  JSON validation failed AFTER edit (auto rolled back)

set -euo pipefail

# ── arg parsing ───────────────────────────────────────────────────────
DRY_RUN=0
BEARER_MODE="placeholder"   # placeholder | tokenref | inline
UNINSTALL=0
WORKSPACE=""
AGENT_ID=""

while (( $# )); do
  case "$1" in
    --dry-run)        DRY_RUN=1 ;;
    --inline-token)   BEARER_MODE="inline" ;;
    --token-ref)      BEARER_MODE="tokenref" ;;
    --uninstall)      UNINSTALL=1 ;;
    --workspace=*)    WORKSPACE="${1#--workspace=}" ;;
    --workspace)      shift; WORKSPACE="${1:?--workspace requires a path}" ;;
    -h|--help)        sed -n '2,/^set -/p' "$0" | sed -e 's/^# //' -e 's/^#//' ; exit 0 ;;
    -*)               echo "unknown flag: $1" >&2; exit 1 ;;
    *)                if [[ -z "$AGENT_ID" ]]; then AGENT_ID="$1"; else echo "unexpected arg: $1" >&2; exit 1; fi ;;
  esac
  shift
done

if [[ -z "$AGENT_ID" ]]; then
  echo "usage: $0 <agent-id> [--workspace=<path>] [--dry-run | --inline-token | --uninstall]" >&2
  exit 1
fi

if ! [[ "$AGENT_ID" =~ ^[a-zA-Z0-9@._+:/\-]{1,128}$ ]]; then
  echo "invalid agent-id '$AGENT_ID' — must match /^[a-zA-Z0-9@._+:/\\-]{1,128}\$/" >&2
  exit 1
fi

# ── default workspace inference ──────────────────────────────────────
# Convention: ~/agents/<agent-id-stem>/  where stem = agent-id minus "-agent" suffix.
# Examples:  yaklog-dev-agent → ~/agents/yaklog-dev/
#            parch-agent → ~/agents/parch/
#            gemini-agent → ~/agents/gemini/
if [[ -z "$WORKSPACE" ]]; then
  STEM="${AGENT_ID%-agent}"
  WORKSPACE="$HOME/agents/$STEM"
fi

log()  { printf '[install-yaklog-otel] %s\n' "$*"; }
warn() { printf '[install-yaklog-otel] WARN: %s\n' "$*" >&2; }
err()  { printf '[install-yaklog-otel] ERROR: %s\n' "$*" >&2; }

# ── pre-conditions ────────────────────────────────────────────────────
if ! command -v python3 >/dev/null 2>&1; then
  err "python3 not found — required for safe JSON merge"; exit 2
fi
TOKEN_FILE="$HOME/.config/yaklog/token"
# Token is only required for --inline-token mode. Placeholder + tokenref
# modes don't read the real token at install time.
if [[ "$BEARER_MODE" == "inline" ]]; then
  if [[ ! -r "$TOKEN_FILE" && -z "${YAKLOG_TOKEN:-}" ]]; then
    err "no YAKLOG_TOKEN env var and $TOKEN_FILE not readable — can't bootstrap --inline-token"
    exit 2
  fi
fi
if [[ ! -d "$WORKSPACE" ]]; then
  err "workspace does not exist: $WORKSPACE"
  err "create it OR pass --workspace=<path> with an existing CC workspace"
  exit 2
fi

CLAUDE_DIR="$WORKSPACE/.claude"
SETTINGS_FILE="$CLAUDE_DIR/settings.local.json"

# ── uninstall path ────────────────────────────────────────────────────
if (( UNINSTALL )); then
  log "uninstalling for agent=$AGENT_ID workspace=$WORKSPACE"
  if [[ ! -f "$SETTINGS_FILE" ]]; then
    log "  no $SETTINGS_FILE; nothing to remove"
    exit 0
  fi
  if (( DRY_RUN )); then
    log "  would strip Yaklog-managed env keys from $SETTINGS_FILE"
    exit 0
  fi
  cp "$SETTINGS_FILE" "${SETTINGS_FILE}.bak.pre-yaklog-uninstall-$(date +%Y%m%dT%H%M%SZ)"
  python3 - "$SETTINGS_FILE" <<'PYEOF'
import sys, json
p = sys.argv[1]
with open(p) as f: s = json.load(f)
mgr = s.get('_yaklog_managed_env_keys') or []
env = s.get('env') or {}
for k in mgr: env.pop(k, None)
s.pop('_yaklog_managed_env_keys', None)
if not env: s.pop('env', None)
else:       s['env'] = env
with open(p, 'w') as f: json.dump(s, f, indent=2); f.write('\n')
PYEOF
  log "  stripped Yaklog env keys from $SETTINGS_FILE"
  exit 0
fi

# ── bearer resolution ─────────────────────────────────────────────────
# Per cluster-converged design (s345 #6360 → admin #6365 → parch #6366
# → aieng #6368): the Stage-1 collector accepts ANY non-empty bearer
# and attribution is via yaklog.agent_id in OTEL_RESOURCE_ATTRIBUTES,
# NOT the bearer. So the default = non-secret placeholder. Zero
# token-at-rest in settings.local.json.
case "$BEARER_MODE" in
  placeholder)
    OTLP_BEARER="Authorization=Bearer ${AGENT_ID}-yaklog-stage1"
    ;;
  tokenref)
    OTLP_BEARER='Authorization=Bearer ${YAKLOG_TOKEN}'
    ;;
  inline)
    if [[ -z "${YAKLOG_TOKEN:-}" ]]; then
      YAKLOG_TOKEN="$(cat "$TOKEN_FILE")"
    fi
    OTLP_BEARER="Authorization=Bearer ${YAKLOG_TOKEN}"
    ;;
esac

# ── env keyset (Profile C minus TOOL_CONTENT per Plan C Q4 Jon-ratify) ─
# Order is preserved in the JSON output via Python's dict-insertion-order.
declare -a OTEL_KEYS=(
  CLAUDE_CODE_ENABLE_TELEMETRY
  OTEL_EXPORTER_OTLP_PROTOCOL
  OTEL_EXPORTER_OTLP_ENDPOINT
  OTEL_EXPORTER_OTLP_HEADERS
  OTEL_RESOURCE_ATTRIBUTES
  OTEL_METRICS_EXPORTER
  OTEL_LOGS_EXPORTER
  OTEL_TRACES_EXPORTER
  OTEL_LOG_USER_PROMPTS
  OTEL_LOG_TOOL_DETAILS
  OTEL_LOG_RAW_API_BODIES
  OTEL_METRICS_INCLUDE_SESSION_ID
  OTEL_METRIC_EXPORT_INTERVAL
  OTEL_LOGS_EXPORT_INTERVAL
)
declare -A OTEL_VALS=(
  [CLAUDE_CODE_ENABLE_TELEMETRY]="1"
  [OTEL_EXPORTER_OTLP_PROTOCOL]="http/protobuf"
  [OTEL_EXPORTER_OTLP_ENDPOINT]="http://192.168.122.76:4328"
  [OTEL_EXPORTER_OTLP_HEADERS]="$OTLP_BEARER"
  [OTEL_RESOURCE_ATTRIBUTES]="yaklog.agent_id=${AGENT_ID},yaklog.cluster_id=ssw-dev,yaklog.deployment=devel"
  [OTEL_METRICS_EXPORTER]="otlp"
  [OTEL_LOGS_EXPORTER]="otlp"
  [OTEL_TRACES_EXPORTER]="none"
  [OTEL_LOG_USER_PROMPTS]="1"
  [OTEL_LOG_TOOL_DETAILS]="1"
  [OTEL_LOG_RAW_API_BODIES]="1"
  [OTEL_METRICS_INCLUDE_SESSION_ID]="false"
  [OTEL_METRIC_EXPORT_INTERVAL]="60000"
  [OTEL_LOGS_EXPORT_INTERVAL]="5000"
)

log "agent=$AGENT_ID"
log "workspace=$WORKSPACE"
log "settings file=$SETTINGS_FILE"
case "$BEARER_MODE" in
  placeholder) log "bearer: PLACEHOLDER (${AGENT_ID}-yaklog-stage1) — zero token-at-rest [default]" ;;
  tokenref)    log "bearer: REFERENCE (\${YAKLOG_TOKEN}) — expanded by CC from shell env" ;;
  inline)      log "bearer: INLINE (literal token) — settings.local.json MUST be gitignored" ;;
esac

# Serialize the OTel keyset as JSON for the merge step.
JSON_KV="$(
  python3 - <<PYEOF
import json
keys = """$(printf '%s\n' "${OTEL_KEYS[@]}")""".strip().split('\n')
vals = {}
$(for k in "${OTEL_KEYS[@]}"; do
    printf 'vals[%s] = %s\n' "$(python3 -c "import json;print(json.dumps('$k'))")" "$(python3 -c "import json,os;print(json.dumps(os.environ.get('OTEL_INSTALL_VAL_$k','')))" OTEL_INSTALL_VAL_$k="${OTEL_VALS[$k]}")"
  done)
print(json.dumps([(k, vals[k]) for k in keys]))
PYEOF
)"

# Cleaner approach: pass key+value as separate env vars to a single Python.
mkdir -p "$CLAUDE_DIR"

if (( DRY_RUN )); then
  log "would create/update: $SETTINGS_FILE"
  log "  env keys to merge:"
  for k in "${OTEL_KEYS[@]}"; do
    # Redact the bearer in dry-run output so --inline-token doesn't leak
    # the real token to a log/screenshot/transcript.
    if [[ "$k" == "OTEL_EXPORTER_OTLP_HEADERS" && "$BEARER_MODE" == "inline" ]]; then
      log "    $k=Authorization=Bearer <REDACTED-literal-token-${#YAKLOG_TOKEN}-chars>"
    else
      log "    $k=${OTEL_VALS[$k]}"
    fi
  done
  log "  marker: _yaklog_managed_env_keys = [${OTEL_KEYS[*]}]"
  exit 0
fi

# Backup if file already exists
if [[ -f "$SETTINGS_FILE" ]]; then
  cp "$SETTINGS_FILE" "${SETTINGS_FILE}.bak-$(date +%Y%m%dT%H%M%SZ)"
fi

# Build the env-keys JSON object for safe atomic merge
# (pass via env to Python to avoid heredoc-quoting hell with values containing $ )
export PX_KEYS="$(printf '%s\n' "${OTEL_KEYS[@]}")"
for k in "${OTEL_KEYS[@]}"; do
  export "PX_VAL__${k}=${OTEL_VALS[$k]}"
done

python3 - "$SETTINGS_FILE" <<'PYEOF'
import sys, json, os
p = sys.argv[1]
try:
    with open(p) as f:
        s = json.load(f)
    if not isinstance(s, dict):
        raise ValueError('settings.local.json is not a JSON object')
except FileNotFoundError:
    s = {}

keys = [k for k in os.environ['PX_KEYS'].strip().split('\n') if k]
env = s.get('env') or {}
if not isinstance(env, dict):
    raise SystemExit("settings.local.json has non-object 'env' — aborting")

# Replace Yaklog-managed keys; preserve any other keys the user has set
for k in keys:
    env[k] = os.environ[f'PX_VAL__{k}']

s['env'] = env
s['_yaklog_managed_env_keys'] = keys

tmp = p + '.tmp'
with open(tmp, 'w') as f:
    json.dump(s, f, indent=2)
    f.write('\n')
# Validate parseability of what we just wrote
with open(tmp) as f:
    json.load(f)
os.replace(tmp, p)
print(f'  wrote {p}')
PYEOF

if ! python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$SETTINGS_FILE" 2>/dev/null; then
  err "post-write JSON validation FAILED on $SETTINGS_FILE — rolling back"
  LAST_BAK="$(ls -t "${SETTINGS_FILE}.bak-"* 2>/dev/null | head -1)"
  if [[ -n "$LAST_BAK" ]]; then cp "$LAST_BAK" "$SETTINGS_FILE"; err "restored from $LAST_BAK"; fi
  exit 3
fi

# Defense check: settings.local.json should be gitignored (CC convention).
GITIGNORE="$WORKSPACE/.gitignore"
if [[ -d "$WORKSPACE/.git" ]] && [[ -f "$GITIGNORE" ]] && ! grep -qE '\.claude/settings\.local\.json|^\.claude/$|^\.claude/?\*' "$GITIGNORE"; then
  warn "$SETTINGS_FILE is not obviously gitignored — recommend adding '.claude/settings.local.json' to $GITIGNORE"
fi

log ""
log "=== INSTALL COMPLETE ==="
log ""
log "1. RESTART your Claude Code session for this workspace."
log "   CC reads settings.local.json env at session start; running session won't see it."
log ""
log "2. After your restarted session has made at least one API call + tool use,"
log "   verify telemetry is flowing:"
log ""
log "   curl -sS 'http://192.168.122.76:9090/api/v1/query?query=claude_code_session_count_total{yaklog_agent_id=\"${AGENT_ID}\"}' | python3 -m json.tool"
log ""
log "3. Or visually: open http://192.168.122.76:3100/dashboard"
log "   Your agent should grow a green 'OTel' pill next to its name in the"
log "   presence table within ~60s of first activity."
log ""
log "To uninstall later: $0 --uninstall $AGENT_ID --workspace=$WORKSPACE"
