#!/usr/bin/env bash
# permission-change-scanner.sh — CP12.8 Phase 2 admin-R4 source-coverage.
#
# Discovers filesystem-resident permission sources on this host + computes
# sha256[:16] fingerprint per source + POSTs to yaklog server's
# /api/v1/ops/audit/permission-change/scan endpoint.
#
# Server-side does the diff + emit + snapshot-persist logic; this script
# is a thin stateless client.
#
# Sources scanned per admin R4:
#   1. settings.local.json     — per-agent CC seat permissions
#   2. agent-specs.git HEAD    — canonical agent scope definitions
#   3. systemd overrides       — per-agent service definitions
#   4. authorized_keys         — per-user ssh access
#   5. gh hosts.yml            — per-user gh CLI auth state
#
# Per-agent attribution heuristic (devel + operator-host cluster canon):
#   - /home/<user>/agents/<agent>/.claude/...  → agent_id = <agent>-agent
#   - /home/<user>/.ssh/...                    → agent_id = <user> (uid-mapped)
#   - /home/<user>/.config/...                 → agent_id = <user> (uid-mapped)
#   - /home/<user>/.config/systemd/user/...    → agent_id = <user> (uid-mapped;
#                                                 instance @suffix split out)
#   - /srv/git/agent-specs.git                 → agent_id = 'cluster-canonical'
#
# Usage:
#   ./scripts/permission-change-scanner.sh \
#     --yaklog-url http://localhost:3100 \
#     --ops-key-file /etc/yaklog/ops-key
#
# Or via systemd timer (Phase 2b forward-track; not in this ship).

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
      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
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

# ─── Discovery + fingerprinting ─────────────────────────────────────────

# Emit JSON object per source. Outer caller wraps into "sources":[...] array.
fingerprint() {
  local p="$1"
  [[ -r "$p" ]] || { echo ""; return; }
  sha256sum "$p" | awk '{print substr($1, 1, 16)}'
}

emit_source() {
  local source_class="$1"
  local source_path="$2"
  local agent_id="$3"
  local fingerprint="$4"
  [[ -z "$fingerprint" ]] && return
  # JSON-escape source_path + agent_id (paths shouldn't contain quotes but
  # defense-in-depth via sed)
  local esc_path esc_agent
  esc_path=$(printf '%s' "$source_path" | sed 's/"/\\"/g')
  esc_agent=$(printf '%s' "$agent_id" | sed 's/"/\\"/g')
  printf '{"source_class":"%s","source_path":"%s","agent_id":"%s","fingerprint":"%s"}' \
    "$source_class" "$esc_path" "$esc_agent" "$fingerprint"
}

# Collect all sources, comma-separate into JSON array.
SOURCES=()

# 1. settings.local.json (per-agent CC seat permissions)
for p in /home/*/agents/*/.claude/settings.local.json; do
  [[ -r "$p" ]] || continue
  # Extract agent name from path: /home/<user>/agents/<agent>/.claude/...
  agent_name=$(echo "$p" | awk -F/ '{print $5}')
  agent_id="${agent_name}-agent"
  fp=$(fingerprint "$p")
  json=$(emit_source "settings.local.json" "$p" "$agent_id" "$fp")
  [[ -n "$json" ]] && SOURCES+=("$json")
done

# 2. agent-specs.git HEAD
if [[ -d /srv/git/agent-specs.git ]]; then
  head_sha=$(git -C /srv/git/agent-specs.git rev-parse HEAD 2>/dev/null || echo "")
  if [[ -n "$head_sha" ]]; then
    # HEAD sha is itself the fingerprint; first 16 hex chars per cluster sha256[:16] canon
    fp="${head_sha:0:16}"
    json=$(emit_source "agent-specs.git-head" "/srv/git/agent-specs.git" "cluster-canonical" "$fp")
    [[ -n "$json" ]] && SOURCES+=("$json")
  fi
fi

# 3. systemd overrides (per-user yaklog-sub@.service.d drop-ins)
for p in /home/*/.config/systemd/user/yaklog-sub@*.service.d/*.conf; do
  [[ -r "$p" ]] || continue
  user=$(echo "$p" | awk -F/ '{print $3}')
  fp=$(fingerprint "$p")
  json=$(emit_source "systemd-override" "$p" "$user" "$fp")
  [[ -n "$json" ]] && SOURCES+=("$json")
done

# 4. authorized_keys (per-user ssh access)
for p in /home/*/.ssh/authorized_keys; do
  [[ -r "$p" ]] || continue
  user=$(echo "$p" | awk -F/ '{print $3}')
  fp=$(fingerprint "$p")
  json=$(emit_source "authorized_keys" "$p" "$user" "$fp")
  [[ -n "$json" ]] && SOURCES+=("$json")
done

# 5. gh hosts.yml (per-user gh CLI auth state)
for p in /home/*/.config/gh/hosts.yml; do
  [[ -r "$p" ]] || continue
  user=$(echo "$p" | awk -F/ '{print $3}')
  fp=$(fingerprint "$p")
  json=$(emit_source "gh-hosts.yml" "$p" "$user" "$fp")
  [[ -n "$json" ]] && SOURCES+=("$json")
done

# ─── Build + POST payload ───────────────────────────────────────────────

# Join sources with commas
IFS=','
PAYLOAD='{"sources":['"${SOURCES[*]}"']}'
unset IFS

if [[ $DRY_RUN -eq 1 ]]; then
  echo "[dry-run] would POST to $YAKLOG_URL/api/v1/ops/audit/permission-change/scan"
  echo "[dry-run] discovered ${#SOURCES[@]} sources:"
  printf '%s\n' "${SOURCES[@]}" | head -20
  exit 0
fi

# POST via curl. Ops-key in Authorization header (never in argv).
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "$YAKLOG_URL/api/v1/ops/audit/permission-change/scan" \
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
