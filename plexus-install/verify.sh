#!/usr/bin/env bash
# plexus-install/verify.sh — post-install smoke.
#
# Verifies every service in the Plexus stack is up + reachable + wired to
# itself (no external pointers). Run after install.sh; safe to re-run.

set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
ENV_FILE="${ENV_FILE:-$INSTALL_DIR/.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[verify] .env not found at $ENV_FILE — has install.sh run yet?" >&2
  exit 1
fi

# Read plexus-admin bearer for authed checks
# shellcheck disable=SC1090
source "$ENV_FILE"
BEARER="${YAKLOG_API_KEYS%%,*}"

ok=0; fail=0

check() {
  local name="$1" cmd="$2"
  printf '  %-40s ' "$name"
  if eval "$cmd" >/dev/null 2>&1; then
    printf '\033[32mPASS\033[0m\n'
    ok=$((ok+1))
  else
    printf '\033[31mFAIL\033[0m\n'
    fail=$((fail+1))
  fi
}

echo
echo 'Plexus install smoke — service reachability + self-reference'
echo '─────────────────────────────────────────────────────────────'

check 'docker daemon reachable'          'docker info'
check 'plexus-demo (yaklog) container up' 'docker ps --format "{{.Names}}" | grep -qw plexus-demo'
check 'plexus-otel-collector container up' 'docker ps --format "{{.Names}}" | grep -qw plexus-otel-collector'
check 'plexus-prometheus container up'   'docker ps --format "{{.Names}}" | grep -qw plexus-prometheus'
check 'plexus-grafana container up'      'docker ps --format "{{.Names}}" | grep -qw plexus-grafana'
check 'plexus-minio container up'        'docker ps --format "{{.Names}}" | grep -qw plexus-minio'

echo
echo 'Endpoints:'
check 'yaklog /api/v1/health'            'curl -sf --max-time 5 http://127.0.0.1:3100/api/v1/health'
check 'yaklog /dashboard'                'curl -sf --max-time 5 http://127.0.0.1:3100/dashboard'
check 'yaklog authed presence (bearer)'  "curl -sf --max-time 5 -H 'Authorization: Bearer $BEARER' http://127.0.0.1:3100/api/v1/presence"
check 'Prometheus /-/healthy'            'curl -sf --max-time 5 http://127.0.0.1:9090/-/healthy'
check 'Grafana /api/health'              'curl -sf --max-time 5 http://127.0.0.1:3001/api/health'
check 'MinIO health (internal only)'     'docker exec plexus-minio curl -sf --max-time 5 http://localhost:9000/minio/health/live'
check 'OTel collector OTLP HTTP accepts' "curl -sf --max-time 5 -X POST http://127.0.0.1:4328/v1/logs -H 'Content-Type: application/json' -d '{}'"

echo
echo 'Self-reference audit (no external pointers):'
check 'Prom external_labels: deployment=demo' \
  "curl -sf --max-time 5 http://127.0.0.1:9090/api/v1/status/config | grep -q 'deployment: demo'"
check 'Prom scrape targets are all internal' \
  "curl -sf --max-time 5 http://127.0.0.1:9090/api/v1/targets | grep -qv '192.168.\|:3100/metrics'"
check 'Grafana datasource is local Prom' \
  "curl -sfu 'admin:$(grep GF_SECURITY_ADMIN_PASSWORD $INSTALL_DIR/plexus-grafana.env | cut -d= -f2)' --max-time 5 http://127.0.0.1:3001/api/datasources 2>/dev/null | grep -q 'plexus-prometheus'"

echo
echo '─────────────────────────────────────────────────────────────'
echo "Passed: $ok    Failed: $fail"
if [[ "$fail" -gt 0 ]]; then
  echo
  echo 'Diagnostics:'
  echo '  docker compose logs --tail=50'
  echo '  docker ps -a'
  exit 1
fi
echo 'Plexus install verified clean.'
