#!/usr/bin/env bash
# deploy-from-bundle.sh — deploy the latest Yaklog install bundle to one
# or more targets. Task #285.
#
# Usage:
#   deploy-from-bundle.sh --target local
#   deploy-from-bundle.sh --target demo
#   deploy-from-bundle.sh --target both
#   deploy-from-bundle.sh --target local --bundle-dir <path>
#
# Loads the freshest bundle from dist/ (or a specific dir via --bundle-dir),
# `docker load`s the yaklog.tar image, then force-recreates the target's
# yaklog container. Non-destructive to data (docker compose up -d
# --force-recreate keeps volumes; sqlite is untouched).
#
# Targets:
#   local     — local yaklog (this host, ./docker-compose.yml)
#   demo      — remote demo VM (SSH: yaklog-admin@$DEMO_HOST)
#   both      — local then demo (fail-fast: demo skipped if devel fails)
#
# Env overrides:
#   DEMO_HOST         — default <demo-vm-ip>
#   DEMO_INSTALL_DIR  — default /opt/yaklog-demo
#   DEMO_USER         — default yaklog-admin
#   LOCAL_YAKLOG_DIR  — default <install-dir>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TARGET=""
BUNDLE_DIR=""
DEMO_HOST="${DEMO_HOST:-<demo-vm-ip>}"
DEMO_USER="${DEMO_USER:-yaklog-admin}"
DEMO_INSTALL_DIR="${DEMO_INSTALL_DIR:-/opt/yaklog-demo}"
LOCAL_YAKLOG_DIR="${LOCAL_YAKLOG_DIR:-<install-dir>}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)      TARGET="$2"; shift 2 ;;
    --bundle-dir)  BUNDLE_DIR="$2"; shift 2 ;;
    --help|-h)
      sed -n '3,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

log() { printf '\033[36m[deploy]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[deploy]\033[0m %s\n' "$*" >&2; }
ok()  { printf '\033[32m[deploy]\033[0m %s\n' "$*"; }

if [[ -z "$TARGET" ]]; then
  err "--target required (local|demo|both)"
  exit 2
fi

# ── 1. Locate the bundle ────────────────────────────────────────────────

if [[ -z "$BUNDLE_DIR" ]]; then
  DIST="$REPO_ROOT/dist"
  BUNDLE_DIR=$(ls -td "$DIST"/yaklog-install-bundle-*/ 2>/dev/null | head -1 | sed 's|/$||')
  if [[ -z "$BUNDLE_DIR" ]]; then
    err "no bundle found in $DIST. Run yaklog-install/build-bundle.sh first."
    exit 3
  fi
fi

if [[ ! -f "$BUNDLE_DIR/images/yaklog.tar" ]]; then
  err "$BUNDLE_DIR/images/yaklog.tar missing. Bundle malformed."
  exit 3
fi

BUNDLE_TARBALL="$(dirname "$BUNDLE_DIR")/$(basename "$BUNDLE_DIR").tar.gz"
BUNDLE_NAME="$(basename "$BUNDLE_DIR")"

log "Bundle: $BUNDLE_NAME"

# ── 2. Deploy locally ──────────────────────────────────────────────────

deploy_local() {
  log "Deploying to DEVEL (local host)…"

  # Backup running db per feedback_db_rebuild_safety
  local backup
  backup="yaklog.db.bak-$(date -u +%Y%m%d-%H%M%S)-pre-deploy-${BUNDLE_NAME##*-}"
  if docker exec yaklog test -f /data/yaklog.db 2>/dev/null; then
    docker exec yaklog sh -c "cp /data/yaklog.db /data/$backup"
    ok "  db backup: /data/$backup"

    # Prune stale pre-deploy backups per feedback_db_backup_retention_two_week_expiry
    # + bus #12787 cluster-wide git outage precedent (7GB * 10+ deploys/day
    # filled 118GB root disk in 24h). Keep last-3 (current + 2 rollback tiers),
    # delete older. Belt+suspenders: OR-gate on 2wk canon.
    docker exec yaklog sh -c "
      cd /data
      # Keep 3 newest by mtime; delete rest
      ls -1t yaklog.db.bak-*-pre-deploy-* 2>/dev/null | tail -n +4 | xargs -r rm -f
      # Also expire anything >14 days regardless (canon backstop)
      find . -maxdepth 1 -name 'yaklog.db.bak-*-pre-deploy-*' -mtime +14 -delete 2>/dev/null || true
    "
    remaining=$(docker exec yaklog sh -c "ls -1 /data/yaklog.db.bak-*-pre-deploy-* 2>/dev/null | wc -l")
    ok "  db backups on volume: ${remaining} retained (keep-last-3 + 14d canon)"
  fi

  # Load fresh yaklog image
  log "  docker load < $BUNDLE_DIR/images/yaklog.tar"
  docker load -i "$BUNDLE_DIR/images/yaklog.tar" >/dev/null
  ok "  yaklog:latest loaded"

  # Force-recreate. Compose file now specifies image: yaklog:latest per
  # Task #285 tag-alignment, so this consumes the freshly-loaded image.
  log "  docker compose up -d --force-recreate --no-build yaklog"
  (cd "$LOCAL_YAKLOG_DIR" && docker compose up -d --force-recreate --no-build yaklog >/dev/null 2>&1)

  # Health-check
  for i in $(seq 1 30); do
    if curl -sf --max-time 2 http://127.0.0.1:3100/api/v1/health >/dev/null 2>&1; then
      ok "  local yaklog healthy after ${i}s"
      return 0
    fi
    sleep 1
  done
  err "  local yaklog did NOT become healthy within 30s"
  return 1
}

# ── 3. Deploy to demo ───────────────────────────────────────────────────

deploy_demo() {
  log "Deploying to DEMO (${DEMO_USER}@${DEMO_HOST})…"

  # Ferry bundle tarball (small tar of just the images subset would be
  # more efficient but complicates. Full bundle tarball is honest.)
  if [[ ! -f "$BUNDLE_TARBALL" ]]; then
    err "  bundle tarball missing: $BUNDLE_TARBALL"
    return 1
  fi

  log "  scp $BUNDLE_TARBALL to $DEMO_HOST:/tmp/"
  scp -q "$BUNDLE_TARBALL" "${DEMO_USER}@${DEMO_HOST}:/tmp/" || {
    err "  scp failed. Check SSH access to ${DEMO_USER}@${DEMO_HOST}."
    return 1
  }

  local tar_base bundle_name_remote
  tar_base="$(basename "$BUNDLE_TARBALL")"
  bundle_name_remote="${tar_base%.tar.gz}"

  ssh -q "${DEMO_USER}@${DEMO_HOST}" "bash -s" <<REMOTE || return 1
    set -e
    cd /tmp
    # Extract
    tar xzf "$tar_base"
    # Backup demo db + prune stale (keep-last-3 + 14d canon per
    # feedback_db_backup_retention_two_week_expiry / bus #12787 precedent)
    if sudo docker exec yaklog-demo test -f /data/yaklog.db 2>/dev/null; then
      sudo docker exec yaklog-demo sh -c "cp /data/yaklog.db /data/yaklog.db.bak-\$(date -u +%Y%m%d-%H%M%S)-pre-deploy"
      sudo docker exec yaklog-demo sh -c "cd /data && ls -1t yaklog.db.bak-*-pre-deploy* 2>/dev/null | tail -n +4 | xargs -r rm -f; find . -maxdepth 1 -name 'yaklog.db.bak-*-pre-deploy*' -mtime +14 -delete 2>/dev/null || true"
    fi
    # Load fresh yaklog image
    sudo docker load -i "/tmp/${bundle_name_remote}/images/yaklog.tar" >/dev/null
    # Force-recreate demo yaklog (demo compose already uses image: yaklog:latest)
    cd "$DEMO_INSTALL_DIR" && sudo docker compose -f docker-compose.demo.yml up -d --force-recreate --no-build yaklog >/dev/null 2>&1
    # Cleanup the extracted bundle (keep the tarball for one-cycle rollback)
    rm -rf "/tmp/${bundle_name_remote}"
REMOTE

  # Remote health-check via HTTP from here
  for i in $(seq 1 30); do
    if curl -sf --max-time 3 "http://${DEMO_HOST}:3100/api/v1/health" >/dev/null 2>&1; then
      ok "  demo yaklog healthy after ${i}s"
      return 0
    fi
    sleep 1
  done
  err "  demo yaklog did NOT become healthy within 30s"
  return 1
}

# ── 4. Dispatch ─────────────────────────────────────────────────────────

case "$TARGET" in
  devel) deploy_local ;;
  demo)  deploy_demo ;;
  both)
    deploy_local || { err "local deploy failed; skipping demo (fail-fast)"; exit 4; }
    deploy_demo
    ;;
  *)
    err "unknown target: $TARGET (want local|demo|both)"
    exit 2
    ;;
esac
