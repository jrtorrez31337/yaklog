#!/usr/bin/env bash
# plexus-install — one-time bootstrap for a fresh Plexus instance.
#
# Per Jon-direct 2026-07-08: every Plexus build ships with an install
# directory containing all artifacts + scripts to bring up a full instance
# with a single command. Each install generates ONE plexus-admin bearer;
# that agent operates the instance.
#
# What this script does:
#   1. Verify docker + docker compose are installed + running
#   2. Mint a strong random token → PLEXUS_ADMIN_BEARER (single token; used
#      as both ops-key AND regular API bearer for the plexus-admin agent)
#   3. Mint Grafana admin password + MinIO root credentials
#   4. Write .env + service env files (mode 600)
#   5. `docker compose up -d --build`
#   6. Wait for all services healthy
#   7. Print operator handoff: URLs + bearer (one-time; save it now)
#
# Idempotency: if .env already exists, script refuses to overwrite unless
# --force is passed. Prevents accidentally destroying an existing instance.

set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
COMPOSE_FILE="${COMPOSE_FILE:-$INSTALL_DIR/docker-compose.demo.yml}"
ENV_FILE="${ENV_FILE:-$INSTALL_DIR/.env}"
GRAFANA_ENV="${GRAFANA_ENV:-$INSTALL_DIR/plexus-grafana.env}"
MINIO_ENV="${MINIO_ENV:-$INSTALL_DIR/plexus-minio.env}"
DATA_DIR="${DATA_DIR:-$INSTALL_DIR/data}"
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --help|-h)
      cat <<HELP
Usage: $0 [--force]

Bootstraps a fresh Plexus instance in $INSTALL_DIR.

Options:
  --force      Overwrite existing .env / service env files. Destroys the
               current instance's identity. Use with care.
  -h, --help   Show this help.

Environment:
  INSTALL_DIR    Base install directory (default: script's parent)
  COMPOSE_FILE   Path to docker-compose.yml (default: \$INSTALL_DIR/docker-compose.yml)
HELP
      exit 0
      ;;
    *)
      echo "Unknown arg: $arg (use --help)" >&2
      exit 2
      ;;
  esac
done

log() { printf '\033[36m[plexus-install]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[plexus-install]\033[0m %s\n' "$*" >&2; }
ok()  { printf '\033[32m[plexus-install]\033[0m %s\n' "$*"; }

# ── 1. Prerequisites ─────────────────────────────────────────────────────

log 'Checking prerequisites…'

if ! command -v docker >/dev/null 2>&1; then
  err 'docker not installed. Install docker first (see https://docs.docker.com/engine/install/).'
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  err 'docker compose plugin not installed. Install docker-compose-plugin.'
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  err 'docker daemon not reachable. Start docker (systemctl start docker) or fix docker permissions.'
  exit 1
fi

ok 'docker + docker compose reachable.'

if [[ ! -f "$COMPOSE_FILE" ]]; then
  err "Compose file not found at $COMPOSE_FILE. Are you running install.sh from a valid yaklog checkout?"
  exit 1
fi

# ── 2. Idempotency guard ─────────────────────────────────────────────────

if [[ -f "$ENV_FILE" ]] && [[ "$FORCE" -eq 0 ]]; then
  err ".env already exists at $ENV_FILE."
  err 'This looks like an already-installed instance. Refusing to overwrite (would destroy identity).'
  err 'If you really want to re-install: pass --force (this wipes the current plexus-admin bearer).'
  exit 1
fi

# ── 3. Mint credentials ──────────────────────────────────────────────────

log 'Minting credentials…'

# Single token for plexus-admin — used as both regular bearer AND ops-key.
# 32 bytes hex = 64 hex chars = 256-bit entropy. Standard-strong.
PLEXUS_ADMIN_BEARER="plexus_$(openssl rand -hex 32)"

# Grafana admin password (separate; Grafana has its own auth model)
GRAFANA_ADMIN_PW="$(openssl rand -hex 16)"

# MinIO root credentials
MINIO_ROOT_PW="$(openssl rand -hex 24)"

ok 'Credentials minted (kept in memory; written to env files at mode 600).'

# ── 4. Write env files ───────────────────────────────────────────────────

log 'Writing service env files…'

install -m 600 /dev/null "$ENV_FILE"
cat > "$ENV_FILE" <<EOF
# plexus-install generated $(date -u +%Y-%m-%dT%H:%M:%SZ)
# DO NOT commit or share. This file contains the plexus-admin bearer.
YAKLOG_DB_PATH=/data/yaklog.db
YAKLOG_API_KEYS=${PLEXUS_ADMIN_BEARER}
YAKLOG_OPS_API_KEYS=${PLEXUS_ADMIN_BEARER}
YAKLOG_BIND_IP=0.0.0.0
EOF

install -m 600 /dev/null "$GRAFANA_ENV"
cat > "$GRAFANA_ENV" <<EOF
GF_SECURITY_ADMIN_USER=admin
GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_ADMIN_PW}
EOF

install -m 600 /dev/null "$MINIO_ENV"
cat > "$MINIO_ENV" <<EOF
MINIO_ROOT_USER=plexus-admin
MINIO_ROOT_PASSWORD=${MINIO_ROOT_PW}
EOF

# Ensure data dir exists (host bind for SQLite)
mkdir -p "$DATA_DIR"

ok 'env files written (mode 600).'

# ── 5. Bring up the stack ────────────────────────────────────────────────

log 'Building + starting Plexus stack (docker compose up -d --build)…'
log 'First build downloads images + compiles yaklog; expect 2-5 minutes.'

(cd "$INSTALL_DIR" && docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build)

ok 'Stack starting.'

# ── 6. Wait for health ────────────────────────────────────────────────────

log 'Waiting for yaklog health check…'
for i in $(seq 1 60); do
  if curl -sf --max-time 2 http://127.0.0.1:3100/api/v1/health >/dev/null 2>&1; then
    ok "yaklog healthy after ${i}s."
    break
  fi
  sleep 1
  if [[ $i -eq 60 ]]; then
    err 'yaklog did not become healthy within 60s. Check `docker compose logs yaklog`.'
    exit 1
  fi
done

log 'Waiting for Grafana health check…'
for i in $(seq 1 60); do
  if curl -sf --max-time 2 http://127.0.0.1:3001/api/health >/dev/null 2>&1; then
    ok "Grafana healthy after ${i}s."
    break
  fi
  sleep 1
  if [[ $i -eq 60 ]]; then
    err 'Grafana slow to start; continuing (may still be initializing).'
    break
  fi
done

# ── 7. Operator handoff ──────────────────────────────────────────────────

HOSTNAME_LOCAL="$(hostname -I 2>/dev/null | awk '{print $1}' || echo '127.0.0.1')"

cat <<HANDOFF

════════════════════════════════════════════════════════════════════════
  Plexus installation complete
════════════════════════════════════════════════════════════════════════

  Dashboard:       http://${HOSTNAME_LOCAL}:3100/dashboard
  Yaklog API:      http://${HOSTNAME_LOCAL}:3100/api/v1
  Grafana admin:   http://${HOSTNAME_LOCAL}:3001/       user=admin  pass=${GRAFANA_ADMIN_PW}
  MinIO admin:     http://127.0.0.1:9001/               user=plexus-admin  pass=${MINIO_ROOT_PW}
                     (VM-internal only; SSH-forward to reach)

  ── plexus-admin agent bearer (SAVE THIS NOW; not shown again) ──
  ${PLEXUS_ADMIN_BEARER}

  Use it as:
    Authorization: Bearer ${PLEXUS_ADMIN_BEARER}

  The plexus-admin agent has BOTH regular API + ops-key privileges (it's
  the sole operator identity on this instance). Register additional agents
  via POST /api/v1/register + ratify with this same bearer.

  Verify install:
    $INSTALL_DIR/plexus-install/verify.sh

  Bring down:
    cd $INSTALL_DIR && docker compose --env-file .env down

  Files (mode 600 — DO NOT commit):
    .env                    (yaklog + plexus-admin bearer)
    plexus-grafana.env      (Grafana admin creds)
    plexus-minio.env        (MinIO root creds)

════════════════════════════════════════════════════════════════════════
HANDOFF
