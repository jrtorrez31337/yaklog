#!/usr/bin/env bash
# uninstall.sh — tear down a Yaklog instance.
# Task #284 / PLAN-YAKLOG-INSTALL-BUNDLE.md.
#
# Destructive: removes docker containers + volumes + systemd units + install
# dir. Requires --force to actually execute (dry-run default).

set -u

INSTALL_DIR="${INSTALL_DIR:-/opt/yaklog}"
FORCE=0
KEEP_DATA=0

for arg in "$@"; do
  case "$arg" in
    --install-dir=*) INSTALL_DIR="${arg#*=}"; shift ;;
    --install-dir)   shift; INSTALL_DIR="$1"; shift ;;
    --force)         FORCE=1; shift ;;
    --keep-data)     KEEP_DATA=1; shift ;;
    --help|-h)
      cat <<EOF
Usage: $0 [--install-dir <path>] [--keep-data] [--force]

By default this is a DRY-RUN. Pass --force to actually delete.

  --install-dir <path>  Yaklog install dir (default: /opt/yaklog)
  --keep-data           Retain docker volumes (yaklog_data, prom, grafana, minio)
  --force               Actually delete. Without this, prints what would happen.
EOF
      exit 0
      ;;
  esac
done

if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  echo "uninstall: no .env at $INSTALL_DIR/ (nothing to uninstall here?)" >&2
  exit 2
fi

# shellcheck disable=SC1091
source "$INSTALL_DIR/.env"
INSTANCE_NAME="${INSTANCE_NAME:-yaklog}"

run() {
  if [[ "$FORCE" -eq 1 ]]; then
    echo "  \$ $*"
    "$@"
  else
    echo "  (dry-run) $*"
  fi
}

echo "=== Uninstalling Yaklog '$INSTANCE_NAME' from $INSTALL_DIR ==="
[[ "$FORCE" -eq 0 ]] && echo "(dry-run mode — pass --force to actually delete)"
echo

# ── 1. Bring down docker stack ──────────────────────────────────────────
echo 'Docker:'
if [[ "$KEEP_DATA" -eq 1 ]]; then
  run bash -c "cd $INSTALL_DIR && docker compose --env-file .env down"
else
  run bash -c "cd $INSTALL_DIR && docker compose --env-file .env down -v"
fi

# ── 2. Remove systemd units + ops-key ───────────────────────────────────
if command -v systemctl >/dev/null && [[ "$(id -u)" == "0" || -n "${SUDO_UID:-}" ]]; then
  echo
  echo 'Systemd:'
  for unit in \
    "yaklog-output-ingester-${INSTANCE_NAME}.timer" \
    "yaklog-output-ingester-${INSTANCE_NAME}.service"; do
    if systemctl list-unit-files "$unit" 2>/dev/null | grep -q "$unit"; then
      run systemctl disable --now "$unit" 2>/dev/null || true
      run rm -f "/etc/systemd/system/$unit"
    fi
  done
  run rm -f "/usr/local/bin/yaklog-output-ingester-${INSTANCE_NAME}.sh"
  run rm -rf "/etc/yaklog-${INSTANCE_NAME}"
  run rm -rf "/var/lib/yaklog-${INSTANCE_NAME}"
  run systemctl daemon-reload
fi

# ── 3. Remove install dir ───────────────────────────────────────────────
echo
echo 'Install dir:'
run rm -rf "$INSTALL_DIR"

echo
if [[ "$FORCE" -eq 1 ]]; then
  echo "Uninstall complete."
else
  echo "Dry-run complete. Re-run with --force to actually delete."
fi
