#!/usr/bin/env bash
# channel-subscription-scanner.sh — CP12.15 Phase 2 channel-sub change history.
#
# Discovers per-user ~/.config/yaklog/channels CSV files on this host +
# parses + POSTs to yaklog server's /api/v1/ops/audit/channel-subscription/scan
# endpoint.
#
# Server-side does the diff + emit + snapshot-persist logic; this script
# is a thin stateless client (same pattern as permission-change-scanner.sh).
#
# Channels file format: single line of comma-separated channel names per
# user, e.g. `handoff,status,aieng,gamedev,ptah`. Empty file → zero channels.
#
# Per-user attribution heuristic:
#   /home/<user>/.config/yaklog/channels → agent_id = <user>
#
# Future: traptop10k bridge support for cross-host scanning (Phase 2b).
#
# Usage:
#   ./scripts/channel-subscription-scanner.sh \
#     --yaklog-url http://localhost:3100 \
#     --ops-key-file /home/jon/.config/yaklog/ops-key

set -euo pipefail

YAKLOG_URL="${YAKLOG_URL:-http://localhost:3100}"
OPS_KEY_FILE=""
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yaklog-url) YAKLOG_URL="$2"; shift 2 ;;
    --ops-key-file) OPS_KEY_FILE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "[ERR] unknown flag: $1" >&2; exit 2 ;;
  esac
done

# Read ops-key from file (NEVER from CLI argv per feedback_secrets_no_yaklog).
if [[ -z "$OPS_KEY_FILE" && -z "${YAKLOG_OPS_KEY:-}" ]]; then
  echo "[ERR] --ops-key-file <path> required (or YAKLOG_OPS_KEY env)" >&2
  exit 2
fi
if [[ -n "$OPS_KEY_FILE" ]]; then
  if [[ ! -r "$OPS_KEY_FILE" ]]; then
    echo "[ERR] ops-key file not readable: $OPS_KEY_FILE" >&2
    exit 3
  fi
  YAKLOG_OPS_KEY=$(< "$OPS_KEY_FILE")
fi

# ─── Discovery + parsing ────────────────────────────────────────────────

SUBS=()

for channels_file in /home/*/.config/yaklog/channels; do
  [[ -r "$channels_file" ]] || continue
  user=$(echo "$channels_file" | awk -F/ '{print $3}')
  # Read CSV (single line); split on comma; trim whitespace; dedupe via sort -u
  raw=$(<"$channels_file")
  raw=$(printf '%s' "$raw" | tr -d '[:space:]')
  if [[ -z "$raw" ]]; then
    channels_json='[]'
  else
    # Convert CSV → JSON array of strings; validate each token matches the
    # server's channel-name regex (server will reject malformed anyway, but
    # surfacing it early helps the operator catch typos).
    tokens=()
    IFS=',' read -ra raw_tokens <<< "$raw"
    for t in "${raw_tokens[@]}"; do
      if [[ "$t" =~ ^[a-zA-Z0-9_-]{1,64}$ ]]; then
        tokens+=("\"$t\"")
      else
        echo "[warn] dropping invalid channel name from $channels_file: '$t'" >&2
      fi
    done
    if [[ ${#tokens[@]} -eq 0 ]]; then
      channels_json='[]'
    else
      IFS=','
      channels_json="[${tokens[*]}]"
      unset IFS
    fi
  fi
  esc_path=$(printf '%s' "$channels_file" | sed 's/"/\\"/g')
  SUBS+=("{\"agent_id\":\"$user\",\"channels\":$channels_json,\"source_path\":\"$esc_path\"}")
done

IFS=','
PAYLOAD='{"subscriptions":['"${SUBS[*]}"']}'
unset IFS

if [[ $DRY_RUN -eq 1 ]]; then
  echo "[dry-run] would POST to $YAKLOG_URL/api/v1/ops/audit/channel-subscription/scan"
  echo "[dry-run] discovered ${#SUBS[@]} subscription rows:"
  printf '%s\n' "${SUBS[@]}" | head -20
  exit 0
fi

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "$YAKLOG_URL/api/v1/ops/audit/channel-subscription/scan" \
  -H "Authorization: Bearer $YAKLOG_OPS_KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

HTTP_CODE=$(printf '%s' "$RESPONSE" | tail -1)
BODY=$(printf '%s' "$RESPONSE" | head -n -1)

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "[ERR] HTTP $HTTP_CODE from yaklog server" >&2
  echo "$BODY" >&2
  exit 4
fi

echo "$BODY"
