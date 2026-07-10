#!/usr/bin/env bash
# verify.sh — post-install sanity for a Plexus instance.
# Task #284 / PLAN-PLEXUS-INSTALL-BUNDLE.md §5.
#
# Sources $INSTALL_DIR/.env so it works against any renamed instance +
# non-default ports. Safe to re-run.

set -u

INSTALL_DIR="${INSTALL_DIR:-/opt/plexus}"

for arg in "$@"; do
  case "$arg" in
    --install-dir=*) INSTALL_DIR="${arg#*=}"; shift ;;
    --install-dir)   shift; INSTALL_DIR="$1"; shift ;;
    --help|-h)       echo "Usage: $0 [--install-dir <path>]"; exit 0 ;;
  esac
done

ENV_FILE="$INSTALL_DIR/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "verify: no .env at $ENV_FILE (installer never ran here?)" >&2
  exit 2
fi

# Source env for port + bearer + INSTANCE_NAME
set -a
# shellcheck disable=SC1091
source "$ENV_FILE"
set +a

PLEXUS_ADMIN_BEARER="${YAKLOG_OPS_API_KEYS%%,*}"
INSTANCE_NAME="${INSTANCE_NAME:-plexus}"
DASHBOARD_PORT="${DASHBOARD_PORT:-3100}"
PROM_PORT="${PROM_PORT:-9090}"
GRAFANA_PORT="${GRAFANA_PORT:-3001}"
OTLP_HTTP_PORT="${OTLP_HTTP_PORT:-4328}"

PASS=0; FAIL=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; FAIL=$((FAIL+1)); }

echo
echo "=== Plexus '$INSTANCE_NAME' verify (${INSTALL_DIR}) ==="
echo

# ── 1. Docker containers up ─────────────────────────────────────────────
echo 'Containers:'
CONTAINERS=(
  "${INSTANCE_NAME}"
  "${INSTANCE_NAME}-otel-collector"
  "${INSTANCE_NAME}-prometheus"
  "${INSTANCE_NAME}-grafana"
  "${INSTANCE_NAME}-minio"
)
for c in "${CONTAINERS[@]}"; do
  status=$(docker ps --filter "name=^${c}$" --format '{{.Status}}' | head -1)
  if [[ -n "$status" && "$status" == Up* ]]; then
    pass "$c ($status)"
  else
    fail "$c not Up (status: '$status')"
  fi
done

# ── 2. Endpoints ─────────────────────────────────────────────────────────
echo
echo 'Endpoints:'
if curl -sf --max-time 3 "http://127.0.0.1:${DASHBOARD_PORT}/api/v1/health" >/dev/null; then
  pass "yaklog /api/v1/health → 200 (port $DASHBOARD_PORT)"
else
  fail "yaklog /api/v1/health did not return 200"
fi

if curl -sf --max-time 3 "http://127.0.0.1:${DASHBOARD_PORT}/dashboard" >/dev/null; then
  pass "yaklog /dashboard → 200"
else
  fail "yaklog /dashboard did not return 200"
fi

if [[ -n "$PLEXUS_ADMIN_BEARER" ]]; then
  body=$(curl -sf --max-time 3 -H "Authorization: Bearer $PLEXUS_ADMIN_BEARER" \
         "http://127.0.0.1:${DASHBOARD_PORT}/api/v1/presence/public" 2>/dev/null || echo "")
  if [[ -n "$body" ]]; then
    pass "plexus-admin bearer authenticated + presence returned"
  else
    fail "plexus-admin bearer failed to authenticate"
  fi
else
  fail "no bearer in .env (YAKLOG_OPS_API_KEYS)"
fi

if curl -sf --max-time 3 "http://127.0.0.1:${PROM_PORT}/-/healthy" >/dev/null; then
  pass "Prometheus /-/healthy → 200 (port $PROM_PORT)"
else
  fail "Prometheus /-/healthy did not return 200"
fi

if curl -sf --max-time 3 "http://127.0.0.1:${GRAFANA_PORT}/api/health" >/dev/null; then
  pass "Grafana /api/health → 200 (port $GRAFANA_PORT)"
else
  fail "Grafana /api/health did not return 200"
fi

if curl -sf --max-time 3 -X POST -H 'Content-Type: application/json' \
        "http://127.0.0.1:${OTLP_HTTP_PORT}/v1/logs" -d '{}' >/dev/null; then
  pass "OTel collector OTLP HTTP accepts POST (port $OTLP_HTTP_PORT)"
else
  fail "OTel collector OTLP HTTP not reachable"
fi

# ── 3. Self-reference audit ─────────────────────────────────────────────
echo
echo 'Self-reference audit:'
prom_deployment=$(curl -sf --max-time 3 "http://127.0.0.1:${PROM_PORT}/api/v1/status/config" 2>/dev/null | \
                  grep -oE "deployment: [a-zA-Z0-9_-]+" | head -1 | awk '{print $2}')
if [[ "$prom_deployment" == "$INSTANCE_NAME" ]]; then
  pass "Prometheus external_labels: deployment=$INSTANCE_NAME"
else
  fail "Prometheus external_labels deployment='$prom_deployment' expected '$INSTANCE_NAME'"
fi

# ── 4. Systemd timer (if root-installed) ────────────────────────────────
echo
echo 'Systemd:'
timer_name="yaklog-output-ingester-${INSTANCE_NAME}.timer"
if command -v systemctl >/dev/null && systemctl list-timers --all "$timer_name" 2>/dev/null | grep -q "$timer_name"; then
  pass "timer enabled: $timer_name"
else
  printf '  \033[33m·\033[0m timer %s not installed (may be intentional if non-root install)\n' "$timer_name"
fi

# ── Summary ──────────────────────────────────────────────────────────────
echo
echo '─────────────────────────────────────────────────────────────'
echo "Passed: $PASS    Failed: $FAIL"
if [[ "$FAIL" -gt 0 ]]; then
  echo
  echo 'Diagnostics:'
  echo "  cd $INSTALL_DIR && docker compose logs --tail=50"
  echo "  docker ps -a"
  exit 1
fi
echo 'Plexus install verified clean.'
