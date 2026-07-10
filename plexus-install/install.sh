#!/usr/bin/env bash
# install.sh — Plexus interactive installer (Task #284 / PLAN-PLEXUS-
# INSTALL-BUNDLE.md). Consumes an install bundle produced by
# build-bundle.sh (which pre-saves all OCI images so no registry access
# is needed at install time).
#
# Discovery order for OCI images:
#   1. ./images/*.tar in this script's directory (pre-built bundle)
#   2. Falls back to `docker pull` if the tar is missing AND `--allow-pull`
#      is set (build-host convenience; NOT the portable-install path).
#
# Usage:
#   sudo ./install.sh                    # interactive
#   sudo ./install.sh --non-interactive  # uses env vars for all prompts
#   ./install.sh --help                  # show all env-var overrides
#
# Env-var equivalents for each prompt (usable in --non-interactive mode):
#   INSTANCE_NAME       default: plexus
#   INSTALL_DIR         default: /opt/${INSTANCE_NAME}
#   YAKLOG_BIND_IP      default: 0.0.0.0
#   PLEXUS_BIND_IP      default: 127.0.0.1
#   EXTERNAL_HOSTNAME   default: autodetected via `hostname -I`
#   DASHBOARD_PORT      default: 3100
#   PROM_PORT           default: 9090
#   GRAFANA_PORT        default: 3001
#   OTLP_GRPC_PORT      default: 4327
#   OTLP_HTTP_PORT      default: 4328
#   OTEL_HEALTH_PORT    default: 13134
#   MINIO_PORT          default: 9000
#   MINIO_CONSOLE_PORT  default: 9001

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NON_INTERACTIVE=0
ALLOW_PULL=0
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --non-interactive) NON_INTERACTIVE=1 ;;
    --allow-pull)      ALLOW_PULL=1 ;;
    --force)           FORCE=1 ;;
    --help|-h)
      sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '\033[36m[plexus-install]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[plexus-install]\033[0m %s\n' "$*" >&2; }
ok()  { printf '\033[32m[plexus-install]\033[0m %s\n' "$*"; }

# ── 0. Bundle sanity ────────────────────────────────────────────────────

[[ -f "$SCRIPT_DIR/docker-compose.yml" ]] || {
  err "docker-compose.yml missing from bundle. Are you running install.sh from the bundle directory?"
  exit 2
}
[[ -d "$SCRIPT_DIR/templates" ]] || {
  err "templates/ missing from bundle."
  exit 2
}
[[ -d "$SCRIPT_DIR/otel" ]] || {
  err "otel/ missing from bundle."
  exit 2
}
[[ -d "$SCRIPT_DIR/systemd" ]] || {
  err "systemd/ missing from bundle."
  exit 2
}

# ── 1. Prerequisite check ───────────────────────────────────────────────

log 'Checking prerequisites…'

command -v docker  >/dev/null || { err "docker not installed"; exit 1; }
command -v openssl >/dev/null || { err "openssl not installed"; exit 1; }
command -v envsubst >/dev/null || { err "envsubst not installed (install gettext-base)"; exit 1; }
docker compose version >/dev/null 2>&1 || {
  err "docker compose plugin missing (install docker-compose-plugin)"
  exit 1
}
docker info >/dev/null 2>&1 || {
  err "docker daemon not reachable. systemctl start docker (or fix docker permissions)."
  exit 1
}

ok "docker + docker compose + openssl + envsubst reachable."

# ── 2. Prompt helper ────────────────────────────────────────────────────

ask() {
  local prompt="$1"
  local default="$2"
  local var="$3"
  # Non-interactive: env var must be set OR default applies
  if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
    local current="${!var:-$default}"
    printf -v "$var" '%s' "$current"
    log "  $var=$current"
    return
  fi
  local reply
  local default_display="${default:-<none>}"
  read -r -p "  $prompt [$default_display]: " reply
  if [[ -z "$reply" ]]; then
    printf -v "$var" '%s' "$default"
  else
    printf -v "$var" '%s' "$reply"
  fi
}

# ── 3. Collect settings ─────────────────────────────────────────────────

echo
log 'Collecting install settings…'
echo

: "${INSTANCE_NAME:=plexus}"
: "${INSTALL_DIR:=/opt/${INSTANCE_NAME}}"
: "${YAKLOG_BIND_IP:=0.0.0.0}"
: "${PLEXUS_BIND_IP:=127.0.0.1}"
: "${DASHBOARD_PORT:=3100}"
: "${PROM_PORT:=9090}"
: "${GRAFANA_PORT:=3001}"
: "${OTLP_GRPC_PORT:=4327}"
: "${OTLP_HTTP_PORT:=4328}"
: "${OTEL_HEALTH_PORT:=13134}"
: "${MINIO_PORT:=9000}"
: "${MINIO_CONSOLE_PORT:=9001}"
: "${TRACK_GITHUB_REPO:=}"

# Autodetect external hostname if not set
if [[ -z "${EXTERNAL_HOSTNAME:-}" ]]; then
  EXTERNAL_HOSTNAME="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [[ -z "$EXTERNAL_HOSTNAME" ]] && EXTERNAL_HOSTNAME="127.0.0.1"
fi

ask "Instance name"                                "$INSTANCE_NAME"     INSTANCE_NAME
# Re-derive INSTALL_DIR default if it uses the OLD instance name
if [[ "$INSTALL_DIR" == "/opt/plexus" ]]; then
  INSTALL_DIR="/opt/$INSTANCE_NAME"
fi
ask "Install dir"                                  "$INSTALL_DIR"       INSTALL_DIR
ask "Dashboard bind IP (0.0.0.0 or 127.0.0.1)"     "$YAKLOG_BIND_IP"    YAKLOG_BIND_IP
ask "External hostname/IP for URLs"                "$EXTERNAL_HOSTNAME" EXTERNAL_HOSTNAME
ask "Track a public GitHub repo? (owner/name)"     "$TRACK_GITHUB_REPO" TRACK_GITHUB_REPO

# ── 4. Confirm + create install dir ─────────────────────────────────────

echo
log 'Settings:'
echo "  INSTANCE_NAME     = $INSTANCE_NAME"
echo "  INSTALL_DIR       = $INSTALL_DIR"
echo "  YAKLOG_BIND_IP    = $YAKLOG_BIND_IP"
echo "  PLEXUS_BIND_IP    = $PLEXUS_BIND_IP"
echo "  EXTERNAL_HOSTNAME = $EXTERNAL_HOSTNAME"
echo "  DASHBOARD_PORT    = $DASHBOARD_PORT"
[[ -n "$TRACK_GITHUB_REPO" ]] && echo "  TRACK_GITHUB_REPO = $TRACK_GITHUB_REPO"
echo

if [[ "$NON_INTERACTIVE" -eq 0 ]]; then
  read -r -p "Proceed with install? [Y/n]: " reply
  [[ "$reply" =~ ^[nN] ]] && { log 'Aborted by operator.'; exit 0; }
fi

if [[ -d "$INSTALL_DIR" ]] && [[ "$FORCE" -eq 0 ]]; then
  err "$INSTALL_DIR already exists. Pass --force to overwrite (destroys existing instance identity)."
  exit 1
fi

mkdir -p "$INSTALL_DIR"

# ── 5. Load OCI images from bundle (or pull as fallback) ────────────────

log 'Loading OCI images from bundle…'

IMAGES=(
  "yaklog.tar|yaklog:latest"
  "otel-collector.tar|otel/opentelemetry-collector-contrib:0.112.0"
  "prometheus.tar|prom/prometheus:v2.55.0"
  "grafana.tar|grafana/grafana:11.6.0"
  "minio.tar|minio/minio:latest"
)

for spec in "${IMAGES[@]}"; do
  tar_name="${spec%|*}"
  image="${spec##*|}"
  tar_path="$SCRIPT_DIR/images/$tar_name"
  if [[ -f "$tar_path" ]]; then
    docker load -i "$tar_path" >/dev/null
    ok "  loaded $image (from bundle)"
  elif [[ "$ALLOW_PULL" -eq 1 ]]; then
    docker pull --platform linux/amd64 "$image" >/dev/null
    ok "  pulled $image (registry fallback)"
  else
    err "  $tar_name missing from bundle + --allow-pull not set. Bundle is incomplete."
    exit 3
  fi
done

# ── 6. Mint credentials ──────────────────────────────────────────────────

log 'Minting credentials…'

PLEXUS_ADMIN_BEARER="plexus_$(openssl rand -hex 32)"
GRAFANA_ADMIN_PW="$(openssl rand -hex 16)"
MINIO_ROOT_PW="$(openssl rand -hex 24)"
GENERATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

ok 'Credentials minted (kept in memory; written to env files at mode 600).'

# ── 7. Materialize configs into INSTALL_DIR ─────────────────────────────

log "Materializing config into $INSTALL_DIR…"

# Copy static docker-compose.yml + otel dir + create pat/ mount point + data
install -m 0644 "$SCRIPT_DIR/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"
mkdir -p "$INSTALL_DIR/otel" "$INSTALL_DIR/pat" "$INSTALL_DIR/data"
install -m 0644 "$SCRIPT_DIR/otel/collector-config.yaml" "$INSTALL_DIR/otel/collector-config.yaml"

# envsubst the .env template
export PLEXUS_ADMIN_BEARER INSTANCE_NAME YAKLOG_BIND_IP PLEXUS_BIND_IP \
       DASHBOARD_PORT PROM_PORT GRAFANA_PORT OTLP_GRPC_PORT OTLP_HTTP_PORT \
       OTEL_HEALTH_PORT MINIO_PORT MINIO_CONSOLE_PORT GENERATED_AT
envsubst < "$SCRIPT_DIR/templates/env.tmpl" > "$INSTALL_DIR/.env"
chmod 600 "$INSTALL_DIR/.env"

# envsubst prometheus.yml.tmpl → otel/prometheus.yml
envsubst < "$SCRIPT_DIR/templates/prometheus.yml.tmpl" > "$INSTALL_DIR/otel/prometheus.yml"

# Grafana + MinIO env files (simple, no template)
cat > "$INSTALL_DIR/plexus-grafana.env" <<EOF
GF_SECURITY_ADMIN_USER=admin
GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_ADMIN_PW}
EOF
chmod 600 "$INSTALL_DIR/plexus-grafana.env"

cat > "$INSTALL_DIR/plexus-minio.env" <<EOF
MINIO_ROOT_USER=plexus-admin
MINIO_ROOT_PASSWORD=${MINIO_ROOT_PW}
EOF
chmod 600 "$INSTALL_DIR/plexus-minio.env"

ok 'Config materialized (mode 600 on secrets).'

# ── 8. Bring up the stack ────────────────────────────────────────────────

log "Bringing up Plexus stack…"

(cd "$INSTALL_DIR" && docker compose --env-file .env up -d)

ok 'Stack starting; waiting for health…'

# ── 9. Wait for yaklog + grafana healthy ────────────────────────────────

for i in $(seq 1 60); do
  if curl -sf --max-time 2 "http://127.0.0.1:${DASHBOARD_PORT}/api/v1/health" >/dev/null 2>&1; then
    ok "yaklog healthy after ${i}s."
    break
  fi
  sleep 1
  if [[ "$i" -eq 60 ]]; then
    err 'yaklog did not become healthy within 60s. Check `docker compose logs yaklog`.'
    exit 4
  fi
done

for i in $(seq 1 60); do
  if curl -sf --max-time 2 "http://127.0.0.1:${GRAFANA_PORT}/api/health" >/dev/null 2>&1; then
    ok "Grafana healthy after ${i}s."
    break
  fi
  sleep 1
  if [[ "$i" -eq 60 ]]; then
    log 'Grafana slow to start; continuing (may still be initializing).'
    break
  fi
done

# ── 10. Install output-ingester systemd timer (root only) ───────────────

if [[ "$(id -u)" == "0" || -n "${SUDO_UID:-}" ]] && command -v systemctl >/dev/null; then
  log 'Installing output-ingester systemd timer…'

  ETC_DIR="/etc/plexus-${INSTANCE_NAME}"
  TEXTFILE_DIR="/var/lib/plexus-${INSTANCE_NAME}/textfile/output-ingester"
  OPS_USER="root"
  OPS_KEY_PATH="${ETC_DIR}/ops-key"
  INGESTER_SCRIPT="/usr/local/bin/yaklog-output-ingester-${INSTANCE_NAME}.sh"

  install -d -m 0755 "$ETC_DIR"
  install -d -m 0755 "$TEXTFILE_DIR"

  printf '%s\n' "$PLEXUS_ADMIN_BEARER" > "$OPS_KEY_PATH"
  chmod 0400 "$OPS_KEY_PATH"

  install -m 0755 "$SCRIPT_DIR/systemd/yaklog-output-ingester.sh" "$INGESTER_SCRIPT"

  # envsubst .service template
  export OPS_USER OPS_KEY_PATH TEXTFILE_DIR INGESTER_SCRIPT
  envsubst < "$SCRIPT_DIR/templates/yaklog-output-ingester.service.tmpl" \
    > "/etc/systemd/system/yaklog-output-ingester-${INSTANCE_NAME}.service"

  cp "$SCRIPT_DIR/systemd/yaklog-output-ingester.timer" \
    "/etc/systemd/system/yaklog-output-ingester-${INSTANCE_NAME}.timer"
  # Timer file references the .service by name; fix the Unit= line
  sed -i "s|Requires=yaklog-output-ingester.service|Requires=yaklog-output-ingester-${INSTANCE_NAME}.service|" \
    "/etc/systemd/system/yaklog-output-ingester-${INSTANCE_NAME}.timer"
  sed -i "s|Unit=yaklog-output-ingester.service|Unit=yaklog-output-ingester-${INSTANCE_NAME}.service|" \
    "/etc/systemd/system/yaklog-output-ingester-${INSTANCE_NAME}.timer"

  systemctl daemon-reload
  systemctl enable --now "yaklog-output-ingester-${INSTANCE_NAME}.timer"

  ok 'output-ingester timer installed + enabled (hourly cadence).'
else
  log 'Skipping systemd install (not root, or systemctl unavailable).'
  log 'To install manually: sudo bash -c "cd $SCRIPT_DIR && ./install.sh --systemd-only INSTANCE_NAME=$INSTANCE_NAME"'
fi

# ── 11. Optional: register the GitHub repo Jon asked about ──────────────

if [[ -n "$TRACK_GITHUB_REPO" ]]; then
  log "Registering GitHub repo $TRACK_GITHUB_REPO on this instance…"
  curl -sf -X POST -H "Authorization: Bearer $PLEXUS_ADMIN_BEARER" \
       -H "Content-Type: application/json" \
       "http://127.0.0.1:${DASHBOARD_PORT}/api/v1/repos" \
       -d "{\"github_owner_repo\":\"${TRACK_GITHUB_REPO}\"}" | \
    grep -q '"ok":true' && ok "Repo registered." || \
    log "Repo register response was unexpected; check via curl."
fi

# ── 12. Operator handoff ────────────────────────────────────────────────

cat <<HANDOFF

═══════════════════════════════════════════════════════════════════════
  Plexus '${INSTANCE_NAME}' installation complete
═══════════════════════════════════════════════════════════════════════

  Dashboard:  http://${EXTERNAL_HOSTNAME}:${DASHBOARD_PORT}/dashboard
  API:        http://${EXTERNAL_HOSTNAME}:${DASHBOARD_PORT}/api/v1
  Grafana:    http://${EXTERNAL_HOSTNAME}:${GRAFANA_PORT}/  (user=admin  pass=${GRAFANA_ADMIN_PW})
  MinIO:      http://127.0.0.1:${MINIO_CONSOLE_PORT}/       (user=plexus-admin  pass=${MINIO_ROOT_PW})
              (127.0.0.1-bound; SSH-forward to reach)

  ── plexus-admin bearer (SAVE THIS NOW; not shown again) ──
  ${PLEXUS_ADMIN_BEARER}

  Use it as:
    Authorization: Bearer ${PLEXUS_ADMIN_BEARER}

  This bearer has BOTH regular API + ops-key privileges — the sole
  operator identity on this instance. Register additional agents via
  POST /api/v1/register + ratify with this same bearer.

  Verify install:
    ${SCRIPT_DIR}/verify.sh --install-dir ${INSTALL_DIR}

  Bring down:
    cd ${INSTALL_DIR} && docker compose down

  Fully uninstall (removes volumes + systemd):
    ${SCRIPT_DIR}/uninstall.sh --install-dir ${INSTALL_DIR} --force

  Files (mode 600 — DO NOT commit):
    ${INSTALL_DIR}/.env
    ${INSTALL_DIR}/plexus-grafana.env
    ${INSTALL_DIR}/plexus-minio.env

═══════════════════════════════════════════════════════════════════════
HANDOFF
