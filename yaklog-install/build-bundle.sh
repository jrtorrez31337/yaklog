#!/usr/bin/env bash
# build-bundle.sh — produce a portable Yaklog install bundle.
#
# Per Task #284 / PLAN-YAKLOG-INSTALL-BUNDLE.md. Run on the build-host
# (yaklog-host) to produce dist/yaklog-install-bundle-<sha>-<timestamp>/ which
# contains all OCI images + installer + templates. Tarball + scp the
# dist dir to the target install host.
#
# Requirements on build-host: docker, git.
# Produces: dist/yaklog-install-bundle-<yaklog-sha-short>-<utc>/
# Bundle size: ~1.5GB (yaklog + 4 upstream images).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="${DIST_DIR:-$REPO_ROOT/dist}"

log() { printf '\033[36m[build-bundle]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[build-bundle]\033[0m %s\n' "$*" >&2; }
ok()  { printf '\033[32m[build-bundle]\033[0m %s\n' "$*"; }

# ── 1. Prerequisites ─────────────────────────────────────────────────────

command -v docker >/dev/null || { err "docker not on PATH"; exit 1; }
command -v git >/dev/null    || { err "git not on PATH";    exit 1; }
docker info >/dev/null 2>&1  || { err "docker daemon not reachable"; exit 1; }

# ── 2. Compute bundle version + destination ─────────────────────────────

YAKLOG_SHA="$(cd "$REPO_ROOT" && git rev-parse --short=12 HEAD)"
UTC_TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BUNDLE_NAME="yaklog-install-bundle-${YAKLOG_SHA}-${UTC_TIMESTAMP}"
BUNDLE_DIR="$DIST_DIR/$BUNDLE_NAME"

log "yaklog SHA: $YAKLOG_SHA"
log "bundle dir: $BUNDLE_DIR"

if [[ -d "$BUNDLE_DIR" ]]; then
  err "$BUNDLE_DIR already exists; refusing to overwrite. Delete or move it first."
  exit 1
fi

mkdir -p "$BUNDLE_DIR/images" "$BUNDLE_DIR/templates" "$BUNDLE_DIR/otel" "$BUNDLE_DIR/systemd"

# ── 3. Build yaklog image from source ───────────────────────────────────

log "Building yaklog image (fresh from source, no cache-skip)…"
docker build -t "yaklog:${YAKLOG_SHA}" -t "yaklog:latest" "$REPO_ROOT" >/dev/null
ok "yaklog image built."

# ── 4. Pull upstream images (pinned versions from docker-compose.demo.yml) ─

IMAGES=(
  "yaklog:latest|yaklog.tar"
  "otel/opentelemetry-collector-contrib:0.112.0|otel-collector.tar"
  "prom/prometheus:v2.55.0|prometheus.tar"
  "grafana/grafana:11.6.0|grafana.tar"
  "minio/minio:latest|minio.tar"
)

for spec in "${IMAGES[@]}"; do
  image="${spec%|*}"
  tar_name="${spec##*|}"
  log "Preparing $image → $tar_name"
  # Pull upstream (skip for yaklog:latest which we just built locally)
  if [[ "$image" != "yaklog:latest" ]]; then
    docker pull --platform linux/amd64 "$image" >/dev/null 2>&1 || {
      err "Failed to pull $image"; exit 1;
    }
  fi
  docker save "$image" -o "$BUNDLE_DIR/images/$tar_name"
  size=$(du -h "$BUNDLE_DIR/images/$tar_name" | awk '{print $1}')
  ok "$tar_name saved ($size)"
done

# ── 5. Copy installer + templates + configs ─────────────────────────────

log "Copying installer + templates + configs…"

install -m 0755 "$SCRIPT_DIR/install.sh"   "$BUNDLE_DIR/install.sh"
install -m 0755 "$SCRIPT_DIR/verify.sh"    "$BUNDLE_DIR/verify.sh"
install -m 0755 "$SCRIPT_DIR/uninstall.sh" "$BUNDLE_DIR/uninstall.sh"
install -m 0644 "$SCRIPT_DIR/README.md"    "$BUNDLE_DIR/README.md"

# docker-compose.yml is the STATIC canonical form; ${VAR} placeholders
# come from the .env produced by install.sh at target-time.
install -m 0644 "$SCRIPT_DIR/docker-compose.yml" "$BUNDLE_DIR/docker-compose.yml"

# Templates that need envsubst at install time (embedded values that can't
# be ${VAR}-expanded by docker compose).
for tmpl in env.tmpl prometheus.yml.tmpl yaklog-output-ingester.service.tmpl; do
  install -m 0644 "$SCRIPT_DIR/templates/$tmpl" "$BUNDLE_DIR/templates/$tmpl"
done

# OTel collector config (static; Stage 1 accepts any Bearer)
install -m 0644 "$SCRIPT_DIR/otel/collector-config.yaml" "$BUNDLE_DIR/otel/collector-config.yaml"

# Systemd unit driver + timer (copies unchanged; service is envsubst'd
# from the template at install time to bake in INSTALL_DIR path)
install -m 0755 "$SCRIPT_DIR/systemd/yaklog-output-ingester.sh"    "$BUNDLE_DIR/systemd/yaklog-output-ingester.sh"
install -m 0644 "$SCRIPT_DIR/systemd/yaklog-output-ingester.timer" "$BUNDLE_DIR/systemd/yaklog-output-ingester.timer"

# ── 6. Emit VERSION manifest ────────────────────────────────────────────

cat > "$BUNDLE_DIR/VERSION" <<EOF
yaklog-install-bundle
yaklog_sha: $YAKLOG_SHA
built_at: $UTC_TIMESTAMP
built_by: $(whoami)@$(hostname)
docker_version: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)
images:
  - yaklog:$YAKLOG_SHA
  - otel/opentelemetry-collector-contrib:0.112.0
  - prom/prometheus:v2.55.0
  - grafana/grafana:11.6.0
  - minio/minio:latest
architecture: linux/amd64
EOF

# ── 7. Compute bundle size + emit tarball ───────────────────────────────

BUNDLE_SIZE="$(du -sh "$BUNDLE_DIR" | awk '{print $1}')"
ok "Bundle assembled: $BUNDLE_SIZE"

log "Creating tarball…"
TARBALL="$DIST_DIR/${BUNDLE_NAME}.tar.gz"
(cd "$DIST_DIR" && tar czf "$TARBALL" "$BUNDLE_NAME")
TARBALL_SIZE="$(du -sh "$TARBALL" | awk '{print $1}')"

ok "Tarball: $TARBALL ($TARBALL_SIZE)"

cat <<HANDOFF

═══════════════════════════════════════════════════════════════════════
  Yaklog install bundle built
═══════════════════════════════════════════════════════════════════════

  Dir:      $BUNDLE_DIR
  Tarball:  $TARBALL ($TARBALL_SIZE)

  To install on a fresh host:
    scp $TARBALL <user>@<target>:/tmp/
    ssh <user>@<target> "cd /tmp && tar xzf $(basename "$TARBALL")"
    ssh <user>@<target> "cd /tmp/$BUNDLE_NAME && sudo ./install.sh"

═══════════════════════════════════════════════════════════════════════
HANDOFF
