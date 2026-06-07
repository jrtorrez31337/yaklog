#!/usr/bin/env bash
# audit-anchor-publisher.sh — CP12.12 Phase 3 (A) external integrity anchor
# daily cron-driver per parch #7984 ratified shape (S3 Object Lock baseline +
# daily cadence + 7y retention + public verify + dual-publish 12mo).
#
# Flow:
#   1. POST /api/v1/ops/audit/anchor-snapshot → get current chain digest
#   2. Publish digest to s3://plexus-audit-anchor-<env>/yyyy/mm/dd/digest.txt
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
#     --s3-bucket plexus-audit-anchor-devel \
#     [--dry-run]

set -euo pipefail

YAKLOG_URL="${YAKLOG_URL:-http://localhost:3100}"
OPS_KEY_FILE=""
S3_BUCKET=""
DRY_RUN=0
ANCHOR_DAY="${ANCHOR_DAY:-$(date -u +%Y-%m-%d)}"
ANCHOR_SUBSTRATE="s3-object-lock"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yaklog-url)    YAKLOG_URL="$2"; shift 2 ;;
    --ops-key-file)  OPS_KEY_FILE="$2"; shift 2 ;;
    --s3-bucket)     S3_BUCKET="$2"; shift 2 ;;
    --anchor-day)    ANCHOR_DAY="$2"; shift 2 ;;
    --substrate)     ANCHOR_SUBSTRATE="$2"; shift 2 ;;
    --dry-run)       DRY_RUN=1; shift ;;
    --help|-h)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "[ERR] unknown flag: $1" >&2; exit 2 ;;
  esac
done

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
S3_KEY="${YEAR}/${MONTH}/${DAY}/digest.txt"
ANCHOR_URI=""

if [[ $DRY_RUN -eq 1 ]]; then
  echo "[dry-run] would PUT s3://${S3_BUCKET}/${S3_KEY} with Object Lock Compliance 7y"
  ANCHOR_URI="s3://${S3_BUCKET}/${S3_KEY}#dry-run"
else
  if ! command -v aws >/dev/null; then
    echo "[ERR] aws cli not installed; cannot publish to S3" >&2
    exit 4
  fi
  RETENTION_UNTIL=$(date -u -d "$ANCHOR_DAY +7 years" +%Y-%m-%dT%H:%M:%SZ)
  echo "[anchor] PUT s3://${S3_BUCKET}/${S3_KEY} (Compliance until $RETENTION_UNTIL)"
  echo "$DIGEST" | aws s3api put-object \
    --bucket "$S3_BUCKET" \
    --key "$S3_KEY" \
    --body /dev/stdin \
    --object-lock-mode COMPLIANCE \
    --object-lock-retain-until-date "$RETENTION_UNTIL" \
    --content-type text/plain
  ANCHOR_URI="s3://${S3_BUCKET}/${S3_KEY}"
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

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "[ERR] HTTP $HTTP_CODE from anchor-record" >&2
  echo "$BODY" >&2
  exit 5
fi

echo "[anchor] OK: $BODY"
