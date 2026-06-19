#!/usr/bin/env bash
# install-plexus-otel-runtime.sh — Codex CLI + Gemini CLI seat OTel onboarding.
# Per ADR-0032 Phase 0 Item A (yaklog-dev PLAN-ADR-0032-PHASE-0-CROSS-RUNTIME-TELEMETRY-PARITY.md §3 Task A.3).
#
# Sister to install-plexus-otel.sh (which is Claude Code-specific —
# settings.local.json merge). This script handles the non-CC runtimes
# (Codex CLI / Gemini CLI) which use entirely different config-file shapes.
#
# Usage:
#   bash install-plexus-otel-runtime.sh --runtime codex             # current $HOME (OVERWRITES)
#   bash install-plexus-otel-runtime.sh --runtime codex --merge-preserve
#                                                                  # preserves existing
#                                                                  # model/personality/project
#                                                                  # settings; only writes [otel]
#                                                                  # block. Required for seats
#                                                                  # with existing config per
#                                                                  # aieng3 #9707 substrate-truth.
#   bash install-plexus-otel-runtime.sh --runtime gemini            # current $HOME (OVERWRITES)
#   bash install-plexus-otel-runtime.sh --runtime gemini --merge-preserve
#                                                                  # JSON deep-merge; preserves
#                                                                  # all keys outside `telemetry`.
#   bash install-plexus-otel-runtime.sh --runtime codex --home /home/aieng3
#   bash install-plexus-otel-runtime.sh --runtime gemini --collector-endpoint http://192.168.122.76:4327
#   bash install-plexus-otel-runtime.sh --runtime codex --dry-run
#
# Pre-conditions:
#   - Collector reachable at the target endpoint (default localhost:4327)
#   - python3 (tomllib for codex; json for gemini)
#
# Exit codes:
#   0  success / dry-run
#   1  bad usage
#   2  pre-condition failed (runtime / templates missing / endpoint unreachable)
#   3  config validation failed AFTER edit (auto rolled back)

set -euo pipefail

RUNTIME=""
HOME_DIR="${HOME}"
ENDPOINT="http://localhost:4327"
DRY_RUN=false
MERGE_PRESERVE=false
TEMPLATE_DIR="/home/jon/yaklog/otel"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime)             RUNTIME="$2"; shift 2 ;;
    --runtime=*)           RUNTIME="${1#--runtime=}"; shift ;;
    --home)                HOME_DIR="$2"; shift 2 ;;
    --home=*)              HOME_DIR="${1#--home=}"; shift ;;
    --collector-endpoint)  ENDPOINT="$2"; shift 2 ;;
    --collector-endpoint=*) ENDPOINT="${1#--collector-endpoint=}"; shift ;;
    --template-dir)        TEMPLATE_DIR="$2"; shift 2 ;;
    --dry-run)             DRY_RUN=true; shift ;;
    --merge-preserve)      MERGE_PRESERVE=true; shift ;;
    --help|-h)
      sed -n '2,35p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "[ERR] unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$RUNTIME" ]]; then
  echo "[ERR] --runtime <codex|gemini> required" >&2
  exit 1
fi

case "$RUNTIME" in
  codex)
    TEMPLATE="${TEMPLATE_DIR}/codex-otel-config-template.toml"
    TARGET="${HOME_DIR}/.codex/config.toml"
    ;;
  gemini)
    TEMPLATE="${TEMPLATE_DIR}/gemini-otel-config-template.json"
    TARGET="${HOME_DIR}/.gemini/settings.json"
    ;;
  *)
    echo "[ERR] unsupported --runtime: $RUNTIME (use codex or gemini)" >&2
    exit 1
    ;;
esac

if [[ ! -f "$TEMPLATE" ]]; then
  echo "[ERR] template not found: $TEMPLATE" >&2
  exit 2
fi

TARGET_DIR=$(dirname "$TARGET")
TS=$(date -u +%Y%m%d-%H%M%S)

echo "[install] runtime=$RUNTIME"
echo "[install] template=$TEMPLATE"
echo "[install] target=$TARGET"
echo "[install] collector endpoint=$ENDPOINT"
echo "[install] dry-run=$DRY_RUN"
echo "[install] merge-preserve=$MERGE_PRESERVE"

if [[ "$DRY_RUN" == "true" ]]; then
  echo ""
  echo "[dry-run] would create $TARGET_DIR if missing"
  echo "[dry-run] would back up $TARGET → ${TARGET}.bak-${TS} (if exists)"
  echo "[dry-run] would substitute endpoint $ENDPOINT into template"
  if [[ "$MERGE_PRESERVE" == "true" ]]; then
    echo "[dry-run] would MERGE [otel]/telemetry block into $TARGET (preserves other settings)"
  else
    echo "[dry-run] would OVERWRITE $TARGET with template content"
  fi
  echo "[dry-run] would validate $TARGET parses cleanly"
  exit 0
fi

mkdir -p "$TARGET_DIR"
if [[ -f "$TARGET" ]]; then
  cp "$TARGET" "${TARGET}.bak-${TS}"
  echo "[install] backed up existing $TARGET → ${TARGET}.bak-${TS}"
fi

# Generate the endpoint-substituted template into a temp file (used by both
# overwrite + merge-preserve paths).
TMP_RENDERED=$(mktemp)
trap 'rm -f "$TMP_RENDERED"' EXIT
sed "s|http://localhost:4327|${ENDPOINT}|g" "$TEMPLATE" > "$TMP_RENDERED"

if [[ "$MERGE_PRESERVE" == "true" && -s "${TARGET}.bak-${TS}" ]]; then
  # Merge-preserve mode (per aieng3 #9707 substrate-truth): existing seat
  # config has non-otel settings (model/personality/project) that must
  # survive. Only replace the otel/telemetry section.
  case "$RUNTIME" in
    codex)
      # TOML merge via python tomllib (read) + custom serializer (write only
      # the [otel] section + preserve everything outside it).
      python3 - "${TARGET}.bak-${TS}" "$TMP_RENDERED" "$TARGET" <<'PYEOF'
import sys, tomllib, re
existing_path, rendered_path, target_path = sys.argv[1:4]
# Read rendered template's [otel] block as plain text (preserves formatting)
with open(rendered_path) as f:
    rendered = f.read()
# Extract the [otel] section + all subsections from rendered template
otel_block_match = re.search(r'^\[otel\][\s\S]*?(?=^\[(?!otel)|\Z)', rendered, re.MULTILINE)
if not otel_block_match:
    print('[ERR] merge-preserve: template missing [otel] section', file=sys.stderr)
    sys.exit(4)
otel_block = otel_block_match.group(0).rstrip() + '\n'
# Read existing config + strip its [otel] section (and all [otel.*] subsections)
with open(existing_path) as f:
    existing = f.read()
# Match [otel] + all subsequent [otel.X.Y...] sections until next non-otel section
existing_without_otel = re.sub(
    r'^\[otel(?:\.[^\]]+)?\][\s\S]*?(?=^\[(?!otel(\.|\]))|\Z)',
    '',
    existing,
    flags=re.MULTILINE,
)
existing_without_otel = existing_without_otel.rstrip() + '\n'
# Combine: preserved sections + new otel block
merged = existing_without_otel + '\n' + otel_block
with open(target_path, 'w') as f:
    f.write(merged)
print(f'[merge-preserve] wrote merged config; preserved {len(existing_without_otel)} bytes of non-otel content')
PYEOF
      if [[ $? -ne 0 ]]; then
        echo "[ERR] merge-preserve TOML merge failed; rolling back" >&2
        mv "${TARGET}.bak-${TS}" "$TARGET"
        exit 4
      fi
      ;;
    gemini)
      # JSON merge via jq (deep merge; existing keys outside telemetry preserved).
      if ! command -v jq >/dev/null 2>&1; then
        echo "[ERR] merge-preserve requires jq for gemini JSON merge" >&2
        mv "${TARGET}.bak-${TS}" "$TARGET"
        exit 4
      fi
      jq -s '.[0] * .[1]' "${TARGET}.bak-${TS}" "$TMP_RENDERED" > "$TARGET" || {
        echo "[ERR] merge-preserve JSON merge failed; rolling back" >&2
        mv "${TARGET}.bak-${TS}" "$TARGET"
        exit 4
      }
      ;;
  esac
  echo "[install] MERGED [otel]/telemetry block; preserved non-managed settings"
else
  # Default overwrite path (no existing file OR --merge-preserve not requested)
  cp "$TMP_RENDERED" "$TARGET"
fi

# Validate parses
case "$RUNTIME" in
  codex)
    if ! python3 -c "import tomllib; tomllib.load(open('$TARGET','rb'))" 2>/dev/null; then
      echo "[ERR] post-write TOML FAILS parse; rolling back" >&2
      if [[ -f "${TARGET}.bak-${TS}" ]]; then
        mv "${TARGET}.bak-${TS}" "$TARGET"
        echo "[install] rolled back to backup"
      else
        rm -f "$TARGET"
        echo "[install] removed bad config (no prior backup)"
      fi
      exit 3
    fi
    ;;
  gemini)
    if ! python3 -c "import json; json.load(open('$TARGET'))" 2>/dev/null; then
      echo "[ERR] post-write JSON FAILS parse; rolling back" >&2
      if [[ -f "${TARGET}.bak-${TS}" ]]; then
        mv "${TARGET}.bak-${TS}" "$TARGET"
        echo "[install] rolled back to backup"
      else
        rm -f "$TARGET"
        echo "[install] removed bad config (no prior backup)"
      fi
      exit 3
    fi
    ;;
esac

echo ""
echo "[install] ✓ $TARGET written + validated"
echo ""
echo "Next steps:"
case "$RUNTIME" in
  codex)
    echo "  1. Restart Codex CLI (or wait for next session)"
    echo "  2. Verify in Prom: curl -sS http://localhost:9090/api/v1/label/__name__/values | jq '.data[] | select(startswith(\"codex_\"))'"
    echo "  3. Expected: returns >= 1 series (e.g., codex_tool_call_total) within 5 min of next session"
    ;;
  gemini)
    echo "  1. Restart Gemini CLI (or wait for next session)"
    echo "  2. Verify in Prom: curl -sS http://localhost:9090/api/v1/label/__name__/values | jq '.data[] | select(startswith(\"gemini_cli_\"))'"
    echo "  3. Expected: returns >= 1 series (e.g., gemini_cli_tool_call_count_total) within 5 min of next session"
    ;;
esac
