#!/usr/bin/env bash
# Yaklog Prom + Grafana volume backup -- Stage 1 minimum.
#
# Produces two tarballs in $BACKUP_DIR (default ~/yaklog-backups):
#   yaklog-prom-YYYYMMDD-HHMMSS.tar.gz     -- Prom WAL + TSDB blocks
#   yaklog-grafana-YYYYMMDD-HHMMSS.tar.gz  -- Grafana sqlite + plugin state
#
# Both tars are taken from inside short-lived alpine containers that bind
# the named docker volumes -- no host-side sudo needed; portable across
# any docker host where the volumes are mounted.
#
# Restore: see RESTORE block at the bottom of this script.
#
# Stage 1 scope: manual run-on-demand. CP4+ work could schedule via cron
# or systemd timer (offered but not built; ~10 min add when desired).
#
# Usage:
#   ./otel/backup-yaklog-data.sh                     # backup both volumes
#   BACKUP_DIR=/somewhere ./otel/backup-yaklog-data.sh
#   ./otel/backup-yaklog-data.sh --prom-only         # just Prom
#   ./otel/backup-yaklog-data.sh --grafana-only      # just Grafana
#   ./otel/backup-yaklog-data.sh --verify <tarball>  # integrity test
#
# Safety: backup does NOT stop the running containers. Prom + Grafana both
# tolerate file-system snapshot during operation (they fsync on write).
# In the rare case of a torn write at backup-time, restore will lose at
# most the last in-flight WAL segment -- acceptable for Stage 1.
# Production-grade would use `prometheus snapshot` API for atomicity.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-$HOME/yaklog-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DO_PROM=1
DO_GRAFANA=1

case "${1:-}" in
  --prom-only)    DO_GRAFANA=0 ;;
  --grafana-only) DO_PROM=0 ;;
  --verify)
    shift
    TARBALL="${1:?usage: --verify <tarball>}"
    echo "verifying $TARBALL ..."
    gzip -t "$TARBALL" && tar -tzf "$TARBALL" >/dev/null && echo "OK"
    exit 0
    ;;
  --help|-h)
    sed -n '2,/^set -/p' "$0" | sed -e 's/^# //' -e 's/^#//'
    exit 0
    ;;
  "") ;;
  *)  echo "unknown arg: $1" >&2; exit 2 ;;
esac

mkdir -p "$BACKUP_DIR"

backup_volume() {
  local volume="$1"
  local label="$2"
  local out="$BACKUP_DIR/yaklog-${label}-${STAMP}.tar.gz"
  echo "[$(date --iso-8601=seconds)] backing up volume=$volume -> $out"
  docker run --rm \
    -v "${volume}:/data:ro" \
    -v "${BACKUP_DIR}:/backup" \
    alpine:3.20 \
    sh -c "cd /data && tar -czf /backup/$(basename "$out") ."
  # ownership: docker run as root -> tarball owned by root. Chown to invoker.
  if [[ -O "$out" ]] || command -v sudo >/dev/null 2>&1; then
    chown "$(id -u):$(id -g)" "$out" 2>/dev/null || sudo chown "$(id -u):$(id -g)" "$out" 2>/dev/null || true
  fi
  local size
  size="$(du -h "$out" | awk '{print $1}')"
  echo "  -> ${out} (${size})"
  # Immediate integrity verify
  gzip -t "$out" && tar -tzf "$out" >/dev/null && echo "  -> integrity OK"
}

[[ $DO_PROM    == 1 ]] && backup_volume yaklog_yaklog_prom_data    prom
[[ $DO_GRAFANA == 1 ]] && backup_volume yaklog_yaklog_grafana_data grafana

echo ""
echo "== existing backups in $BACKUP_DIR =="
ls -lh "$BACKUP_DIR"/yaklog-*.tar.gz 2>/dev/null | tail -10 || echo "(none)"

# ---------------------------------------------------------------------------
# RESTORE PROCEDURE (manual; rare; data-loss possible -- read carefully)
# ---------------------------------------------------------------------------
# 1. Stop the consumer of the volume:
#      docker compose stop yaklog-prometheus   # or yaklog-grafana
# 2. Blow away the existing volume data:
#      docker run --rm -v yaklog_yaklog_prom_data:/data alpine sh -c 'rm -rf /data/*'
# 3. Restore from tarball:
#      docker run --rm \
#        -v yaklog_yaklog_prom_data:/data \
#        -v "$BACKUP_DIR:/backup:ro" \
#        alpine:3.20 \
#        sh -c "cd /data && tar -xzf /backup/yaklog-prom-<STAMP>.tar.gz"
# 4. Restart the consumer:
#      docker compose start yaklog-prometheus
# 5. Verify:
#      curl -sS http://192.168.122.76:9090/api/v1/query?query=up
#      Visit Grafana, confirm dashboards intact + historical metrics present.
# ---------------------------------------------------------------------------
