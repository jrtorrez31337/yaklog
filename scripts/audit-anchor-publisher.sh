#!/usr/bin/env bash
# audit-anchor-publisher.sh — CP12.12 Phase 3 (A) external integrity anchor
# daily cron-driver per parch #7984 ratified shape (S3 Object Lock baseline +
# daily cadence + 7y retention + public verify + dual-publish 12mo).
#
# Flow:
#   1. POST /api/v1/ops/audit/anchor-snapshot → get current chain digest
#   2. Publish digest to s3://yaklog-audit-anchor-<env>/yyyy/mm/dd/digest.txt
#      with Object Lock Compliance mode + 7-year retention
#   3. POST /api/v1/ops/audit/anchor-record with the anchor_uri + digest
#
# DRY-RUN mode (--dry-run) skips the S3 publish step (useful for cron-test +
# pre-deploy empirical verify on hosts without S3 credentials configured).
#
# Usage:
#   ./scripts/audit-anchor-publisher.sh \
#     --yaklog-url http://localhost:3100 \
#     --ops-key-file /home/jon/.config/yaklog/ops-key \
#     --s3-bucket yaklog-audit-anchor-devel \
#     [--dry-run]

set -euo pipefail

YAKLOG_URL="${YAKLOG_URL:-http://localhost:3100}"
OPS_KEY_FILE=""
S3_BUCKET=""
DRY_RUN=0
ANCHOR_DAY="${ANCHOR_DAY:-$(date -u +%Y-%m-%d)}"
ANCHOR_SUBSTRATE="s3-object-lock"
# CP12.21.1 (2026-06-09): --endpoint-url support for local-S3-equivalent
# (MinIO on devel per Jon-direct brand-narrative pivot). Defaults to
# AWS_ENDPOINT_URL env var (which aws cli v2.13+ honors natively); script
# flag is explicit override. Empty = AWS-default-cloud-S3 endpoint.
S3_ENDPOINT_URL="${AWS_ENDPOINT_URL:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yaklog-url)    YAKLOG_URL="$2"; shift 2 ;;
    --ops-key-file)  OPS_KEY_FILE="$2"; shift 2 ;;
    --s3-bucket)     S3_BUCKET="$2"; shift 2 ;;
    --endpoint-url)  S3_ENDPOINT_URL="$2"; shift 2 ;;
    --anchor-day)    ANCHOR_DAY="$2"; shift 2 ;;
    --substrate)     ANCHOR_SUBSTRATE="$2"; shift 2 ;;
    --dry-run)       DRY_RUN=1; shift ;;
    --help|-h)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "[ERR] unknown flag: $1" >&2; exit 2 ;;
  esac
done

# Build --endpoint-url arg array (empty if no endpoint set; passed to all
# aws s3api calls as expansion). Avoids breaking AWS-default-cloud usage.
AWS_ENDPOINT_ARGS=()
if [[ -n "$S3_ENDPOINT_URL" ]]; then
  AWS_ENDPOINT_ARGS=("--endpoint-url" "$S3_ENDPOINT_URL")
  echo "[anchor] S3 endpoint: $S3_ENDPOINT_URL"
fi

if [[ -z "$OPS_KEY_FILE" && -z "${YAKLOG_OPS_KEY:-}" ]]; then
  echo "[ERR] --ops-key-file <path> required (or YAKLOG_OPS_KEY env)" >&2
  exit 2
fi
if [[ -n "$OPS_KEY_FILE" ]]; then
  [[ -r "$OPS_KEY_FILE" ]] || { echo "[ERR] ops-key file not readable: $OPS_KEY_FILE" >&2; exit 3; }
  YAKLOG_OPS_KEY=$(< "$OPS_KEY_FILE")
fi

if [[ $DRY_RUN -eq 0 && -z "$S3_BUCKET" ]]; then
  echo "[ERR] --s3-bucket required when not --dry-run" >&2
  exit 2
fi

echo "[anchor] day=$ANCHOR_DAY substrate=$ANCHOR_SUBSTRATE dry_run=$DRY_RUN"

# Step 1: snapshot
SNAP=$(curl -sS -X POST "$YAKLOG_URL/api/v1/ops/audit/anchor-snapshot" \
  -H "Authorization: Bearer $YAKLOG_OPS_KEY")
CHAIN_HW_EVENT_ID=$(echo "$SNAP" | jq -r .chain_high_water_event_id)
CHAIN_HW_TABLE=$(echo "$SNAP" | jq -r .chain_high_water_table)
DIGEST=$(echo "$SNAP" | jq -r .digest_sha256)
SAMPLE_SIZE=$(echo "$SNAP" | jq -r .sample_size)
echo "[anchor] snapshot: event_id=${CHAIN_HW_EVENT_ID} table=${CHAIN_HW_TABLE} sample=${SAMPLE_SIZE}"
echo "[anchor] digest: $DIGEST"

# Step 2: publish to S3 (or skip if dry-run)
YEAR=$(echo "$ANCHOR_DAY" | cut -d- -f1)
MONTH=$(echo "$ANCHOR_DAY" | cut -d- -f2)
DAY=$(echo "$ANCHOR_DAY" | cut -d- -f3)
# CP12.21 secops #8068 §2 refinement: content-addressed S3 key schema.
# Key includes digest-first-16 chars so an attacker who PutObject's a
# crafted digest cannot silently replace the original (key derives from
# content). External auditors using the `external_ref` from the
# `/audit/anchors` endpoint fetch the specific object; flat-key replace
# attacks are defeated.
DIGEST_PREFIX="${DIGEST:0:16}"
S3_KEY="${YEAR}/${MONTH}/${DAY}/${DIGEST_PREFIX}.txt"
ANCHOR_URI=""

if [[ $DRY_RUN -eq 1 ]]; then
  echo "[dry-run] would PUT s3://${S3_BUCKET}/${S3_KEY} with Object Lock Compliance 7y"
  echo "[dry-run] would record anchor in yaklog (skipped to avoid incoherent DB row without S3 object)"
  echo "[dry-run] OK — snapshot + key computation paths validated; substrate untouched"
  exit 0
else
  if ! command -v aws >/dev/null; then
    echo "[ERR] aws cli not installed; cannot publish to S3" >&2
    exit 4
  fi
  RETENTION_UNTIL=$(date -u -d "$ANCHOR_DAY +7 years" +%Y-%m-%dT%H:%M:%SZ)
  echo "[anchor] PUT s3://${S3_BUCKET}/${S3_KEY} (Compliance until $RETENTION_UNTIL)"
  # AWS CLI --body requires a file path (not /dev/stdin). Use mktemp +
  # trap-cleanup so the digest file is gone after publish; nothing stays
  # in tmpfs that survives the publish call.
  DIGEST_FILE=$(mktemp --tmpdir audit-anchor-digest.XXXXXX)
  trap "rm -f '$DIGEST_FILE'" EXIT
  printf '%s' "$DIGEST" > "$DIGEST_FILE"
  aws s3api put-object \
    "${AWS_ENDPOINT_ARGS[@]}" \
    --bucket "$S3_BUCKET" \
    --key "$S3_KEY" \
    --body "$DIGEST_FILE" \
    --object-lock-mode COMPLIANCE \
    --object-lock-retain-until-date "$RETENTION_UNTIL" \
    --content-type text/plain
  rm -f "$DIGEST_FILE"
  trap - EXIT
  ANCHOR_URI="s3://${S3_BUCKET}/${S3_KEY}"

  # CP12.21 secops #8068 §3 refinement: GetObject post-publish self-verify.
  # Re-read the object we just wrote; confirm body matches the digest we
  # published. Catches silent write-failure / mid-publish corruption /
  # IAM-policy denial that PUT returned 200 on but the object isn't
  # readable. Non-blocking on yaklog-side record (we still record the
  # anchor even if self-verify fails — operator sees the warning).
  ROUNDTRIP=$(aws s3api get-object "${AWS_ENDPOINT_ARGS[@]}" --bucket "$S3_BUCKET" --key "$S3_KEY" /dev/stdout 2>/dev/null | head -c 64)
  if [[ "$ROUNDTRIP" != "$DIGEST" ]]; then
    echo "[WARN] post-publish self-verify FAILED: roundtrip='${ROUNDTRIP}' expected='${DIGEST}'" >&2
    echo "[WARN] proceeding to record anchor in yaklog; operator should investigate S3 state" >&2
  else
    echo "[anchor] post-publish self-verify: roundtrip-match ✓"
  fi
fi
echo "[anchor] anchor_uri=$ANCHOR_URI"

# Step 3: record in yaklog
PAYLOAD=$(jq -n \
  --arg day "$ANCHOR_DAY" \
  --arg sub "$ANCHOR_SUBSTRATE" \
  --arg uri "$ANCHOR_URI" \
  --arg ev "$CHAIN_HW_EVENT_ID" \
  --arg tbl "$CHAIN_HW_TABLE" \
  --arg dig "$DIGEST" \
  '{anchor_day:$day, anchor_substrate:$sub, anchor_uri:$uri,
    chain_high_water_event_id:$ev, chain_high_water_table:$tbl,
    digest_sha256:$dig}')

RESPONSE=$(curl -sS -w "\n%{http_code}" -X POST \
  "$YAKLOG_URL/api/v1/ops/audit/anchor-record" \
  -H "Authorization: Bearer $YAKLOG_OPS_KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

HTTP_CODE=$(printf '%s' "$RESPONSE" | tail -1)
BODY=$(printf '%s' "$RESPONSE" | head -n -1)

# CP12.21 Prom metric textfile emit: write last-publish timestamp + status
# to a textfile-collector path. node_exporter / Prom scrape-config is an
# admin/ssw-devops coord-ask (path documented in YAKLOG-ANCHOR-OPERATIONS.md).
# Emit happens regardless of yaklog-record HTTP status so operator sees
# failed-record cases distinctly via Prom alert.
TEXTFILE_DIR="${TEXTFILE_DIR:-/var/lib/yaklog/textfile}"
mkdir -p "$TEXTFILE_DIR" 2>/dev/null || true
TEXTFILE_PATH="${TEXTFILE_DIR}/yaklog_audit_anchor.prom"
NOW_TS=$(date -u +%s)

emit_metrics() {
  local status="$1"
  local http_code="$2"
  cat > "${TEXTFILE_PATH}.tmp" <<EOF
# HELP yaklog_audit_anchor_last_publish_ts_seconds Unix timestamp of last anchor publish attempt
# TYPE yaklog_audit_anchor_last_publish_ts_seconds gauge
yaklog_audit_anchor_last_publish_ts_seconds{substrate="${ANCHOR_SUBSTRATE}",anchor_day="${ANCHOR_DAY}"} ${NOW_TS}
# HELP yaklog_audit_anchor_publish_status Status of last anchor publish (1=success, 0=failure)
# TYPE yaklog_audit_anchor_publish_status gauge
yaklog_audit_anchor_publish_status{substrate="${ANCHOR_SUBSTRATE}",anchor_day="${ANCHOR_DAY}"} ${status}
# HELP yaklog_audit_anchor_publish_http_code Last anchor-record endpoint HTTP code
# TYPE yaklog_audit_anchor_publish_http_code gauge
yaklog_audit_anchor_publish_http_code{substrate="${ANCHOR_SUBSTRATE}"} ${http_code}
EOF
  mv -f "${TEXTFILE_PATH}.tmp" "${TEXTFILE_PATH}" 2>/dev/null || true
}

if [[ "$HTTP_CODE" != "200" ]]; then
  emit_metrics 0 "$HTTP_CODE"
  echo "[ERR] HTTP $HTTP_CODE from anchor-record" >&2
  echo "$BODY" >&2
  exit 5
fi

emit_metrics 1 "$HTTP_CODE"
echo "[anchor] OK: $BODY"
echo "[metrics] textfile emitted: $TEXTFILE_PATH"
