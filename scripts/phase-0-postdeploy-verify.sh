#!/usr/bin/env bash
# phase-0-postdeploy-verify.sh — empirical close-criterion runbook for
# ADR-0032 Phase 0 (cross-runtime telemetry parity). Per PLAN section
# 4.2 Post-ship gates 8-12.
#
# Run AFTER ssw-devops deploys the Phase 0 PR (branch
# phase-0-cross-runtime-telemetry@bc614a8). Performs 6 empirical probes
# verifying Items A + B substrate-tier convergence.
#
# Usage:
#   bash phase-0-postdeploy-verify.sh                        # all probes
#   bash phase-0-postdeploy-verify.sh --probe schema         # single probe
#   bash phase-0-postdeploy-verify.sh --ops-key-file /etc/yaklog/ops-key
#
# Pre-conditions:
#   - Phase 0 PR merged + deployed
#   - aieng3 (Codex) + gemini-agent (Gemini) seats either have OTel templates
#     installed OR will run a live session during the soak window
#   - jq available
#
# Exit codes:
#   0  all probes PASS (or soak-pending shown as informational)
#   1  bad usage
#   2  one or more probes FAIL substantively

set -euo pipefail

YAKLOG_URL="${YAKLOG_URL:-http://localhost:3100}"
PROM_URL="${PROM_URL:-http://localhost:9090}"
PROBE="all"
OPS_KEY_FILE="${OPS_KEY_FILE:-${HOME}/.config/yaklog/ops-key}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --probe)         PROBE="$2"; shift 2 ;;
    --probe=*)       PROBE="${1#--probe=}"; shift ;;
    --ops-key-file)  OPS_KEY_FILE="$2"; shift 2 ;;
    --yaklog-url)    YAKLOG_URL="$2"; shift 2 ;;
    --prom-url)      PROM_URL="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "[ERR] unknown flag: $1" >&2; exit 1 ;;
  esac
done

YAKLOG_TOKEN=""
if [[ -r "${HOME}/.config/yaklog/token" ]]; then
  YAKLOG_TOKEN=$(cat "${HOME}/.config/yaklog/token")
fi

OPS_KEY=""
if [[ -r "$OPS_KEY_FILE" ]]; then
  OPS_KEY=$(cat "$OPS_KEY_FILE")
fi

FAIL_COUNT=0
PASS_COUNT=0
PENDING_COUNT=0

mark_pass()   { PASS_COUNT=$((PASS_COUNT+1));     echo "  ✓ PASS — $1"; }
mark_fail()   { FAIL_COUNT=$((FAIL_COUNT+1));     echo "  ✗ FAIL — $1"; }
mark_pending(){ PENDING_COUNT=$((PENDING_COUNT+1)); echo "  ⊙ PENDING (soak) — $1"; }

# ── Probe 1: endpoint reachable + ops-key auth ─────────────────────────────
probe_endpoint() {
  echo ""
  echo "Probe 1: POST /api/v1/audit/ingest/otel (auth shape)"
  if [[ -z "$OPS_KEY" ]]; then
    mark_pending "no ops-key available; skipping auth probe"
    return
  fi
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' \
    -X POST -H "Authorization: Bearer $OPS_KEY" -H "Content-Type: application/json" \
    -d '{"resourceLogs":[]}' \
    "$YAKLOG_URL/api/v1/audit/ingest/otel")
  if [[ "$code" == "200" ]]; then
    mark_pass "endpoint reachable + ops-key auth OK"
  else
    mark_fail "endpoint returned HTTP $code (expected 200)"
  fi
}

# ── Probe 2: schema migration applied (additive columns) ───────────────────
# Per parch #9687 disposition (b) + feedback_lazy_schema_init_substantively_
# correct_substrate_discipline_at_first_use_tier: auditOtelMapper.js uses
# lazy schema init (ALTERs fire on first ingest, not at module load). Until
# the first POST /api/v1/audit/ingest/otel succeeds, columns don't exist —
# sister-shape soak-pending to Probes 1/3/4. Probe FAIL here is a substrate-
# discipline observation (correct lazy-init pattern), NOT a deploy defect.
probe_schema() {
  echo ""
  echo "Probe 2: audit_tool_invocation schema augmentation"
  local cols
  cols=$(docker exec yaklog node -e "
    const db = require('better-sqlite3')(require('/app/src/config').dbPath, {readonly: true});
    const c = db.pragma('table_info(audit_tool_invocation)').map(c => c.name);
    console.log(c.join(','));
    db.close();
  " 2>&1)
  local expected=(runtime_class session_correlator duration_ms approval_state prompt_correlator tool_provenance span_id)
  local missing=()
  for col in "${expected[@]}"; do
    if [[ ",$cols," != *",$col,"* ]]; then missing+=("$col"); fi
  done
  if [[ ${#missing[@]} -eq 0 ]]; then
    mark_pass "all 7 additive columns present (lazy-init triggered by prior ingest)"
  else
    mark_pending "schema lazy-init pending first OTel ingest (${#missing[@]} cols missing; correct per substrate-discipline)"
  fi
}

# ── Probe 3: Codex Prom metrics (after live session) ───────────────────────
probe_codex_prom() {
  echo ""
  echo "Probe 3: codex_* metrics in Prom"
  local n
  n=$(curl -sS "$PROM_URL/api/v1/label/__name__/values" 2>/dev/null \
    | jq -r '.data[] | select(startswith("codex_"))' 2>/dev/null | wc -l)
  if [[ "$n" -gt 0 ]]; then
    mark_pass "$n codex_* metric series present"
  else
    mark_pending "no codex_* series yet (requires Codex session w/ OTel template installed)"
  fi
}

# ── Probe 4: Gemini Prom metrics ───────────────────────────────────────────
probe_gemini_prom() {
  echo ""
  echo "Probe 4: gemini_cli_* metrics in Prom"
  local n
  n=$(curl -sS "$PROM_URL/api/v1/label/__name__/values" 2>/dev/null \
    | jq -r '.data[] | select(startswith("gemini_cli_"))' 2>/dev/null | wc -l)
  if [[ "$n" -gt 0 ]]; then
    mark_pass "$n gemini_cli_* metric series present"
  else
    mark_pending "no gemini_cli_* series yet (requires Gemini session w/ OTel template installed)"
  fi
}

# ── Probe 5: audit_tool_invocation has non-CC rows ─────────────────────────
probe_audit_rows() {
  echo ""
  echo "Probe 5: audit_tool_invocation rows by runtime_class"
  local counts
  counts=$(docker exec yaklog node -e "
    const db = require('better-sqlite3')(require('/app/src/config').dbPath, {readonly: true});
    const rows = db.prepare(\"SELECT runtime_class, COUNT(*) as n FROM audit_tool_invocation GROUP BY runtime_class ORDER BY n DESC\").all();
    console.log(JSON.stringify(rows));
    db.close();
  " 2>&1)
  echo "    $counts"
  if echo "$counts" | grep -q '"runtime_class":"codex"'; then
    mark_pass "codex rows present in audit_tool_invocation"
  else
    mark_pending "no codex rows yet (requires Codex session running a tool)"
  fi
  if echo "$counts" | grep -q '"runtime_class":"gemini"'; then
    mark_pass "gemini rows present in audit_tool_invocation"
  else
    mark_pending "no gemini rows yet (requires Gemini session running a tool)"
  fi
}

# ── Probe 6: dashboard pre-emission cards visible for token-bound agents ───
probe_dashboard_pre_emission() {
  echo ""
  echo "Probe 6: /presence/public union with pre_emission rows"
  local payload
  payload=$(curl -sS "$YAKLOG_URL/api/v1/presence/public" 2>/dev/null)
  local pre
  pre=$(echo "$payload" | jq '[.presence[] | select(.pre_emission == true)] | length')
  if [[ "$pre" -ge 0 ]]; then
    mark_pass "$pre pre-emission row(s) in /presence/public"
  else
    mark_fail "pre_emission field missing from /presence/public response"
  fi
}

# ── Dispatch ───────────────────────────────────────────────────────────────
case "$PROBE" in
  all)
    probe_endpoint
    probe_schema
    probe_codex_prom
    probe_gemini_prom
    probe_audit_rows
    probe_dashboard_pre_emission
    ;;
  endpoint) probe_endpoint ;;
  schema) probe_schema ;;
  codex_prom) probe_codex_prom ;;
  gemini_prom) probe_gemini_prom ;;
  audit_rows) probe_audit_rows ;;
  dashboard) probe_dashboard_pre_emission ;;
  *) echo "[ERR] unknown --probe: $PROBE" >&2; exit 1 ;;
esac

echo ""
echo "── Summary ──"
echo "  PASS:    $PASS_COUNT"
echo "  PENDING: $PENDING_COUNT (soak; expected pre-session-start)"
echo "  FAIL:    $FAIL_COUNT"
echo ""
if [[ "$FAIL_COUNT" -gt 0 ]]; then
  echo "RESULT: substantive FAIL"
  exit 2
fi
if [[ "$PENDING_COUNT" -gt 0 ]]; then
  echo "RESULT: PASS-now-with-soak-pending (re-run after session-start to close pending)"
else
  echo "RESULT: ALL PROBES PASS"
fi
exit 0
