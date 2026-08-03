#!/usr/bin/env bash
# yaklog-wal-checkpoint — periodic WAL maintenance per 2026-06-20T~21:08-21:43Z
# incident post-mortem. Sister-shape to yaklog-output-ingester.sh hardening.
#
# Problem this solves: SQLite WAL accumulates under sustained write load;
# unmaintained, it grows until the next implicit checkpoint blocks for
# multiple seconds, contending with the writer lock + cascading into
# event-loop saturation (see /tmp/yaklog-wedge-20260620T212346Z.log).
#
# Mechanism: invoke yaklog ops endpoint to trigger PRAGMA wal_checkpoint(TRUNCATE).
# Emits Prom textfile metrics (elapsed_ms, log_pages, checkpointed_pages, busy).
# A healthy checkpoint takes <100ms; >1000ms indicates writer contention is
# accumulating and the cluster is approaching the cascade onset threshold.
#
# Cadence: hourly (sister-shape yaklog-output-ingester.timer) — empirically
# sufficient at current ~30-agent cluster + 4GB DB scale; revisit if Phase 0
# empirical-bench (CP16) surfaces a different cadence requirement.

set -euo pipefail

YAKLOG_URL="http://localhost:3100"
OPS_KEY_FILE=""
TEXTFILE_DIR="${TEXTFILE_DIR:-/var/lib/yaklog/textfile/wal-checkpoint}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yaklog-url)    YAKLOG_URL="$2"; shift 2 ;;
    --ops-key-file)  OPS_KEY_FILE="$2"; shift 2 ;;
    --textfile-dir)  TEXTFILE_DIR="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$OPS_KEY_FILE" || ! -r "$OPS_KEY_FILE" ]]; then
  echo "FATAL: --ops-key-file required and must be readable (mode-600 owned by service user)" >&2
  exit 2
fi

OPS_KEY="$(cat "$OPS_KEY_FILE" | tr -d '[:space:]')"
if [[ -z "$OPS_KEY" ]]; then
  echo "FATAL: ops-key file is empty" >&2
  exit 2
fi

mkdir -p "$TEXTFILE_DIR"

# CP14-X (parch #10175 Q3 + secops #10172 condition D): checkpoint BOTH
# yaklog.db AND yaklog-secure.db so the new substrate-canon class doesn't
# accumulate unmanaged WAL (per feedback_yaklog_load_cascade_recovery_requires_restart_plus_wal_checkpoint).
# Both fires write to the same Prom textfile (each overwrites the last; the
# metrics are point-in-time snapshots, sister-shape to existing pattern).
# A future micro-cycle could split into per-db textfile if per-db retention
# matters; for now operator-tier discipline reads both via separate cron firings.
DBS_TO_CHECKPOINT="${DBS_TO_CHECKPOINT:-yaklog yaklog-secure}"

# Aggregated metrics across all dbs
TOTAL_ELAPSED_MS=0
TOTAL_LOG_PAGES=0
TOTAL_CHECKPOINTED=0
ANY_BUSY=0
ANY_FAIL=0
LAST_HTTP_CODE=0

for DB in $DBS_TO_CHECKPOINT; do
  T0_NS=$(date +%s%N)
  # Auth per cluster canon: Bearer in Authorization header (NOT X-Ops-Key).
  # Sister-shape to existing ops-endpoint family (auditOpsRoutes.js uses
  # enforceOpsKey middleware which extracts via Authorization: Bearer).
  RESPONSE=$(curl -sS -X POST \
    "${YAKLOG_URL}/api/v1/ops/wal-checkpoint" \
    -H "Authorization: Bearer ${OPS_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"mode\":\"TRUNCATE\",\"db\":\"${DB}\"}" \
    -w "\n%{http_code}" 2>&1) || true
  T1_NS=$(date +%s%N)

  THIS_ELAPSED_MS=$(( (T1_NS - T0_NS) / 1000000 ))
  THIS_HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  THIS_BODY=$(echo "$RESPONSE" | sed '$d')

  THIS_LOG=$(echo "$THIS_BODY" | grep -oE '"log":[0-9]+' | head -1 | grep -oE '[0-9]+' || echo "0")
  THIS_CHK=$(echo "$THIS_BODY" | grep -oE '"checkpointed":[0-9]+' | head -1 | grep -oE '[0-9]+' || echo "0")
  THIS_BUSY=$(echo "$THIS_BODY" | grep -oE '"busy":[0-9]+' | head -1 | grep -oE '[0-9]+' || echo "0")

  TOTAL_ELAPSED_MS=$(( TOTAL_ELAPSED_MS + THIS_ELAPSED_MS ))
  TOTAL_LOG_PAGES=$(( TOTAL_LOG_PAGES + THIS_LOG ))
  TOTAL_CHECKPOINTED=$(( TOTAL_CHECKPOINTED + THIS_CHK ))
  if [[ "$THIS_BUSY" != "0" ]]; then ANY_BUSY=1; fi
  if [[ "$THIS_HTTP_CODE" != "200" && "$THIS_HTTP_CODE" != "201" ]]; then ANY_FAIL=1; fi
  LAST_HTTP_CODE="$THIS_HTTP_CODE"
  echo "  checkpoint db=${DB} http=${THIS_HTTP_CODE} elapsed_ms=${THIS_ELAPSED_MS} log=${THIS_LOG} checkpointed=${THIS_CHK} busy=${THIS_BUSY}"
done

ELAPSED_MS=$TOTAL_ELAPSED_MS
HTTP_CODE=$LAST_HTTP_CODE
BODY="aggregated"
LOG_PAGES=$TOTAL_LOG_PAGES
CHECKPOINTED=$TOTAL_CHECKPOINTED
BUSY=$ANY_BUSY

# Emit Prom textfile metrics atomically (write to .tmp + rename).
# Per-db values already aggregated above (LOG_PAGES / CHECKPOINTED / BUSY are
# sums/disjunctions across DBS_TO_CHECKPOINT); no per-response re-parse needed.
METRICS_TMP="${TEXTFILE_DIR}/wal-checkpoint.prom.$$.tmp"
METRICS_OUT="${TEXTFILE_DIR}/wal-checkpoint.prom"

if [[ "$ANY_FAIL" == "0" ]]; then
  STATUS=1
else
  STATUS=0
fi

cat > "$METRICS_TMP" <<EOF
# HELP yaklog_wal_checkpoint_elapsed_ms Time taken by last WAL checkpoint
# TYPE yaklog_wal_checkpoint_elapsed_ms gauge
yaklog_wal_checkpoint_elapsed_ms ${ELAPSED_MS}
# HELP yaklog_wal_checkpoint_log_pages Pages in WAL when checkpoint began
# TYPE yaklog_wal_checkpoint_log_pages gauge
yaklog_wal_checkpoint_log_pages ${LOG_PAGES}
# HELP yaklog_wal_checkpoint_pages_checkpointed Pages successfully written back
# TYPE yaklog_wal_checkpoint_pages_checkpointed gauge
yaklog_wal_checkpoint_pages_checkpointed ${CHECKPOINTED}
# HELP yaklog_wal_checkpoint_busy_flag SQLite busy flag (1 = lock contention)
# TYPE yaklog_wal_checkpoint_busy_flag gauge
yaklog_wal_checkpoint_busy_flag ${BUSY}
# HELP yaklog_wal_checkpoint_success Whether last checkpoint succeeded (1) or failed (0)
# TYPE yaklog_wal_checkpoint_success gauge
yaklog_wal_checkpoint_success ${STATUS}
# HELP yaklog_wal_checkpoint_last_run_unix_timestamp Unix timestamp of last run
# TYPE yaklog_wal_checkpoint_last_run_unix_timestamp gauge
yaklog_wal_checkpoint_last_run_unix_timestamp $(date +%s)
EOF
mv "$METRICS_TMP" "$METRICS_OUT"

# Journal log (machine-greppable single line)
echo "yaklog-wal-checkpoint status=${STATUS} http=${HTTP_CODE} elapsed_ms=${ELAPSED_MS} log_pages=${LOG_PAGES} checkpointed=${CHECKPOINTED} busy=${BUSY}"

# Non-zero exit if HTTP failed so systemd records failure
if [[ "$STATUS" -eq 0 ]]; then
  echo "FAIL: HTTP ${HTTP_CODE} body=${BODY}" >&2
  exit 1
fi

# Warn (but not fail) if elapsed > 1000ms — substrate-availability-tier signal
if [[ "$ELAPSED_MS" -gt 1000 ]]; then
  echo "WARN: checkpoint elapsed ${ELAPSED_MS}ms > 1000ms — writer contention accumulating" >&2
fi

exit 0
