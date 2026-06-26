#!/usr/bin/env bash
# yaklog-audit-rollup.sh — CP16 Phase 2 cron-driver for audit-rollup substrate
# per PLAN-CP16-PILLAR-AUDIT-ROLLUP-SUBSTRATE.md §13 option (b)+(d).
#
# Sister-shape yaklog-output-ingester.sh + audit-anchor-publisher.sh:
#   - Host-side trigger that POSTs through ops-key-gated endpoint
#   - File-only ops-key transit per `feedback_secrets_no_yaklog` (NEVER argv)
#   - Prom textfile metrics for node_exporter scrape
#
# Flow:
#   1. POST /api/v1/ops/audit-rollup/backfill with ops-key Bearer
#   2. Parse response { days_rolled, by_control_area_rows,
#      by_object_class_rows, by_agent_rows, elapsed_ms }
#   3. Emit Prom textfile metrics for node_exporter scrape
#
# The rollup driver itself runs INSIDE the yaklog container (Node process
# has SQLite access). This script is the host-side hourly trigger.
#
# Usage:
#   ./scripts/yaklog-audit-rollup.sh \
#     --yaklog-url http://localhost:3100 \
#     --ops-key-file /etc/plexus/audit-rollup-ops-key \
#     --days-back 7

set -euo pipefail

YAKLOG_URL="${YAKLOG_URL:-http://localhost:3100}"
OPS_KEY_FILE=""
DAYS_BACK="${DAYS_BACK:-7}"
# Sub-dir per ssw-devops #10857 disposition: sister-shape output-ingester +
# wal-checkpoint + anchor-publisher canonical /var/lib/yaklog/textfile/ tree.
TEXTFILE_DIR="${TEXTFILE_DIR:-/var/lib/yaklog/textfile/audit-rollup}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yaklog-url)    YAKLOG_URL="$2"; shift 2 ;;
    --ops-key-file)  OPS_KEY_FILE="$2"; shift 2 ;;
    --days-back)     DAYS_BACK="$2"; shift 2 ;;
    --textfile-dir)  TEXTFILE_DIR="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "[ERR] unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$OPS_KEY_FILE" && -z "${YAKLOG_OPS_KEY:-}" ]]; then
  echo "[ERR] --ops-key-file or YAKLOG_OPS_KEY env var required" >&2
  exit 2
fi

if [[ -n "$OPS_KEY_FILE" ]]; then
  if [[ ! -r "$OPS_KEY_FILE" ]]; then
    echo "[ERR] ops-key file not readable: $OPS_KEY_FILE" >&2
    exit 3
  fi
  OPS_KEY=$(cat "$OPS_KEY_FILE")
else
  OPS_KEY="$YAKLOG_OPS_KEY"
fi

NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
NOW_TS=$(date -u +%s)
echo "[audit-rollup] start at $NOW_ISO; yaklog=$YAKLOG_URL; days_back=$DAYS_BACK"

# POST /api/v1/ops/audit-rollup/backfill. Capture HTTP code via -w; body via -o tmp.
TMP_BODY=$(mktemp)
trap 'rm -f "$TMP_BODY"' EXIT
HTTP_CODE=$(curl -sS -o "$TMP_BODY" -w '%{http_code}' \
  -X POST \
  -H "Authorization: Bearer $OPS_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"days_back\":${DAYS_BACK}}" \
  "$YAKLOG_URL/api/v1/ops/audit-rollup/backfill" || echo "000")
BODY=$(cat "$TMP_BODY")

# Prom textfile metrics: write per-run state regardless of success.
mkdir -p "$TEXTFILE_DIR" 2>/dev/null || true
TEXTFILE_PATH="${TEXTFILE_DIR}/yaklog_audit_rollup.prom"

emit_metrics() {
  local status="$1"
  local http_code="$2"
  local days_rolled="${3:-0}"
  local cca_rows="${4:-0}"
  local coc_rows="${5:-0}"
  local cba_rows="${6:-0}"
  local elapsed_ms="${7:-0}"
  cat > "${TEXTFILE_PATH}.tmp" <<EOF
# HELP yaklog_audit_rollup_last_run_ts_seconds Unix timestamp of last audit-rollup run
# TYPE yaklog_audit_rollup_last_run_ts_seconds gauge
yaklog_audit_rollup_last_run_ts_seconds ${NOW_TS}
# HELP yaklog_audit_rollup_status Last run status (1=success, 0=failure)
# TYPE yaklog_audit_rollup_status gauge
yaklog_audit_rollup_status ${status}
# HELP yaklog_audit_rollup_http_code Last run HTTP code from /api/v1/ops/audit-rollup/backfill
# TYPE yaklog_audit_rollup_http_code gauge
yaklog_audit_rollup_http_code ${http_code}
# HELP yaklog_audit_rollup_days_rolled Days rolled up in last run
# TYPE yaklog_audit_rollup_days_rolled gauge
yaklog_audit_rollup_days_rolled ${days_rolled}
# HELP yaklog_audit_rollup_by_control_area_rows Rollup rows written to audit_daily_by_control_area
# TYPE yaklog_audit_rollup_by_control_area_rows gauge
yaklog_audit_rollup_by_control_area_rows ${cca_rows}
# HELP yaklog_audit_rollup_by_object_class_rows Rollup rows written to audit_daily_by_object_class
# TYPE yaklog_audit_rollup_by_object_class_rows gauge
yaklog_audit_rollup_by_object_class_rows ${coc_rows}
# HELP yaklog_audit_rollup_by_agent_rows Rollup rows written to audit_daily_by_agent
# TYPE yaklog_audit_rollup_by_agent_rows gauge
yaklog_audit_rollup_by_agent_rows ${cba_rows}
# HELP yaklog_audit_rollup_elapsed_ms Last run elapsed milliseconds (server-reported)
# TYPE yaklog_audit_rollup_elapsed_ms gauge
yaklog_audit_rollup_elapsed_ms ${elapsed_ms}
EOF
  mv -f "${TEXTFILE_PATH}.tmp" "${TEXTFILE_PATH}" 2>/dev/null || true
}

if [[ "$HTTP_CODE" != "200" ]]; then
  emit_metrics 0 "$HTTP_CODE"
  echo "[ERR] HTTP $HTTP_CODE from /api/v1/ops/audit-rollup/backfill" >&2
  echo "$BODY" | head -c 500 >&2
  exit 4
fi

# Parse response JSON (jq required; sister-shape output-ingester canon)
DAYS_ROLLED=$(echo "$BODY" | jq -r '.days_rolled // 0')
CCA_ROWS=$(echo "$BODY" | jq -r '.by_control_area_rows // 0')
COC_ROWS=$(echo "$BODY" | jq -r '.by_object_class_rows // 0')
CBA_ROWS=$(echo "$BODY" | jq -r '.by_agent_rows // 0')
ELAPSED_MS=$(echo "$BODY" | jq -r '.elapsed_ms // 0')

emit_metrics 1 "$HTTP_CODE" "$DAYS_ROLLED" "$CCA_ROWS" "$COC_ROWS" "$CBA_ROWS" "$ELAPSED_MS"

echo "[audit-rollup] OK: days_rolled=$DAYS_ROLLED cca=$CCA_ROWS coc=$COC_ROWS cba=$CBA_ROWS elapsed_ms=$ELAPSED_MS"
