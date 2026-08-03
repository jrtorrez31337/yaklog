#!/usr/bin/env bash
# yaklog-output-ingester.sh — CP13 / ADR-0032 Phase 1.2 output-strand
# ingester cron-driver per parch eec3039 ratified shape (hourly cadence
# + bare-git walker default; GitHub walker Phase 2 forward-track).
#
# Flow:
#   1. POST /api/v1/ops/output/ingest with ops-key Bearer
#   2. Parse response { perRepo, totalCommits, totalMerges,
#      totalAttributionGaps, walkersUsed }
#   3. Emit Prom textfile metrics for node_exporter scrape
#
# The ingester itself runs INSIDE the yaklog container (Node process has
# access to /srv/git bind-mount + SQLite). This script is the host-side
# trigger that POSTs through the ops-key gated endpoint per
# feedback_secrets_no_yaklog discipline (NEVER argv; file-only transit).
#
# Usage:
#   ./scripts/yaklog-output-ingester.sh \
#     --yaklog-url http://localhost:3100 \
#     --ops-key-file /etc/yaklog/ops-key

set -euo pipefail

YAKLOG_URL="${YAKLOG_URL:-http://localhost:3100}"
OPS_KEY_FILE=""
# Sub-dir per ssw-devops #9769 disposition (b): preserves existing
# /var/lib/yaklog/textfile/ canonical ownership by yaklog-audit-publisher.
TEXTFILE_DIR="${TEXTFILE_DIR:-/var/lib/yaklog/textfile/output-ingester}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yaklog-url)    YAKLOG_URL="$2"; shift 2 ;;
    --ops-key-file)  OPS_KEY_FILE="$2"; shift 2 ;;
    --textfile-dir)  TEXTFILE_DIR="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
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
echo "[ingester] start at $NOW_ISO; yaklog=$YAKLOG_URL"

# POST /api/v1/ops/output/ingest. Capture HTTP code via -w; body via -o tmp.
TMP_BODY=$(mktemp)
trap 'rm -f "$TMP_BODY"' EXIT
HTTP_CODE=$(curl -sS -o "$TMP_BODY" -w '%{http_code}' \
  -X POST \
  -H "Authorization: Bearer $OPS_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "$YAKLOG_URL/api/v1/ops/output/ingest" || echo "000")
BODY=$(cat "$TMP_BODY")

# Prom textfile metrics: write per-run state regardless of success.
# Operator sees failed runs distinctly via Prom alert (pattern mirrors
# scripts/audit-anchor-publisher.sh).
mkdir -p "$TEXTFILE_DIR" 2>/dev/null || true
TEXTFILE_PATH="${TEXTFILE_DIR}/yaklog_output_ingester.prom"

emit_metrics() {
  local status="$1"
  local http_code="$2"
  local total_commits="${3:-0}"
  local total_merges="${4:-0}"
  local total_attr_gaps="${5:-0}"
  cat > "${TEXTFILE_PATH}.tmp" <<EOF
# HELP yaklog_output_ingester_last_run_ts_seconds Unix timestamp of last ingester run
# TYPE yaklog_output_ingester_last_run_ts_seconds gauge
yaklog_output_ingester_last_run_ts_seconds ${NOW_TS}
# HELP yaklog_output_ingester_status Last run status (1=success, 0=failure)
# TYPE yaklog_output_ingester_status gauge
yaklog_output_ingester_status ${status}
# HELP yaklog_output_ingester_http_code Last run HTTP code from /api/v1/ops/output/ingest
# TYPE yaklog_output_ingester_http_code gauge
yaklog_output_ingester_http_code ${http_code}
# HELP yaklog_output_ingester_commits_ingested_total Commits ingested in last run
# TYPE yaklog_output_ingester_commits_ingested_total gauge
yaklog_output_ingester_commits_ingested_total ${total_commits}
# HELP yaklog_output_ingester_merges_ingested_total Merges ingested in last run
# TYPE yaklog_output_ingester_merges_ingested_total gauge
yaklog_output_ingester_merges_ingested_total ${total_merges}
# HELP yaklog_output_ingester_attribution_gaps_total Null-fallback attribution counts in last run
# TYPE yaklog_output_ingester_attribution_gaps_total gauge
yaklog_output_ingester_attribution_gaps_total ${total_attr_gaps}
EOF
  mv -f "${TEXTFILE_PATH}.tmp" "${TEXTFILE_PATH}" 2>/dev/null || true
}

if [[ "$HTTP_CODE" != "200" ]]; then
  emit_metrics 0 "$HTTP_CODE"
  echo "[ERR] HTTP $HTTP_CODE from /api/v1/ops/output/ingest" >&2
  echo "$BODY" >&2
  exit 5
fi

# Parse JSON via jq if available; otherwise fall back to grep+sed
if command -v jq >/dev/null 2>&1; then
  TOTAL_COMMITS=$(printf '%s' "$BODY" | jq -r '.totalCommits // 0')
  TOTAL_MERGES=$(printf '%s' "$BODY" | jq -r '.totalMerges // 0')
  TOTAL_ATTR_GAPS=$(printf '%s' "$BODY" | jq -r '.totalAttributionGaps // 0')
else
  TOTAL_COMMITS=$(printf '%s' "$BODY" | grep -oE '"totalCommits"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+' || echo 0)
  TOTAL_MERGES=$(printf '%s' "$BODY" | grep -oE '"totalMerges"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+' || echo 0)
  TOTAL_ATTR_GAPS=$(printf '%s' "$BODY" | grep -oE '"totalAttributionGaps"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+' || echo 0)
fi

emit_metrics 1 "$HTTP_CODE" "$TOTAL_COMMITS" "$TOTAL_MERGES" "$TOTAL_ATTR_GAPS"
echo "[ingester] OK: commits=$TOTAL_COMMITS merges=$TOTAL_MERGES attribution_gaps=$TOTAL_ATTR_GAPS"
echo "[metrics] textfile emitted: $TEXTFILE_PATH"
