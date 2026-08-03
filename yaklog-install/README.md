# yaklog-install — portable Yaklog install bundle

Every Yaklog build ships two things:

1. **A source directory** (`yaklog-install/` in the yaklog repo). Contains the installer, templates, and configs. Used by developers.
2. **A shippable bundle** (`dist/yaklog-install-bundle-<sha>-<utc>/`). Contains the source directory PLUS pre-saved OCI images. Portable: scp to any fresh Linux host and run `./install.sh`. No network access needed at install time.

## Build the bundle (on a build-host with docker + git)

```bash
cd yaklog-install
./build-bundle.sh
# → dist/yaklog-install-bundle-<sha>-<utc>/
# → dist/yaklog-install-bundle-<sha>-<utc>.tar.gz  (~1.5GB)
```

`build-bundle.sh` produces both a directory + a tarball. The tarball is what you ship.

## Install on a fresh host

```bash
# On the target host
tar xzf yaklog-install-bundle-<sha>-<utc>.tar.gz
cd yaklog-install-bundle-<sha>-<utc>/
sudo ./install.sh
```

The installer asks 5 questions (all with sensible defaults):

```
Instance name [yaklog]:                     ← used as container-name prefix + label
Install dir [/opt/yaklog]:                  ← where .env + docker-compose.yml live
Dashboard bind IP [0.0.0.0]:                ← 0.0.0.0=external / 127.0.0.1=local-only
External hostname/IP for URLs [autodetect]: ← printed in handoff banner
Track a public GitHub repo? [none]:         ← optional: register a repo at install
Proceed with install? [Y/n]:
```

Then it:
1. Loads OCI images from `images/*.tar` (no `docker pull`, no `docker build` — offline)
2. Mints a fresh yaklog-admin bearer (256-bit hex; single token for both regular API + ops-key)
3. Mints Grafana admin password + MinIO root credentials
4. Materializes `.env` + `otel/prometheus.yml` from templates (envsubst)
5. `docker compose up -d`
6. Waits for yaklog + Grafana health
7. Installs the output-ingester systemd timer (if run as root)
8. Prints URLs + bearer + verify command

**Save the printed bearer.** It's mode-600 in `.env` on the box, and NOT shown again at any handoff other than the initial install.

## What you get

Every service uses the instance name as prefix. If INSTANCE_NAME=my-yaklog, containers are:

| Container | Image | Default port |
|---|---|---|
| `my-yaklog` (yaklog + dashboard) | yaklog:latest (built from source) | 3100 |
| `my-yaklog-otel-collector` | otel/opentelemetry-collector-contrib:0.112.0 | 4327 gRPC / 4328 HTTP |
| `my-yaklog-prometheus` | prom/prometheus:v2.55.0 | 9090 |
| `my-yaklog-grafana` | grafana/grafana:11.6.0 | 3001 |
| `my-yaklog-minio` | minio/minio:latest | 9000 / 9001 (127.0.0.1 only) |

All services point at themselves — no cross-cluster subscribe / export. Isolation posture: VM-level network isolation is the security boundary.

## Verify

```bash
sudo ./verify.sh --install-dir /opt/yaklog
```

Runs container-status + endpoint-reachability + self-reference audit (Prom `deployment` label matches instance name) + systemd timer state.

## Non-interactive install

```bash
INSTANCE_NAME=demo-vm \
INSTALL_DIR=/opt/demo-vm \
YAKLOG_BIND_IP=0.0.0.0 \
EXTERNAL_HOSTNAME=demo.example.com \
sudo ./install.sh --non-interactive
```

All prompts have env-var equivalents (see `./install.sh --help`).

## Bring down

```bash
cd /opt/yaklog && docker compose down          # keeps data
cd /opt/yaklog && docker compose down -v       # drops volumes (destroys data)
```

## Full uninstall

```bash
sudo ./uninstall.sh --install-dir /opt/yaklog --force
```

Removes: docker containers + volumes + systemd units + `/etc/yaklog-<instance>/` + `/var/lib/yaklog-<instance>/` + install dir. Dry-run by default; `--force` executes.

## Re-install / migrate

Installer refuses to overwrite an existing `.env` by default. Use `--force` to wipe the current identity + start fresh (destroys current yaklog-admin bearer + all bus data unless you `--keep-data` on uninstall first).

## Ports + firewall

Only two ports typically need external exposure:

- **3100** (yaklog / dashboard) — bind to `0.0.0.0` if operators reach from LAN
- **4327/4328** (OTLP receivers) — bind to `0.0.0.0` if agents on OTHER hosts emit here

Everything else (Prometheus, Grafana, MinIO) defaults to `127.0.0.1`-bound. SSH-forward to reach.

## Prerequisites on the install host

- Linux (amd64 — arm64 is v2 forward-track)
- docker + docker compose plugin (`docker compose version` reports `v2.x+`)
- `curl`, `openssl`, `envsubst` (gettext-base)
- Ports free per the config you pick (defaults: 3100 / 3001 / 9090 / 4327-4328 / 9000-9001 / 13134)
- Root for the systemd timer install (installer detects + skips gracefully if not root)

## Architecture note

The yaklog-admin agent is the **sole operator identity** per instance. It holds both regular API bearer + ops-key privileges (same string in this MVP). Additional agents register via `POST /api/v1/register` and yaklog-admin ratifies them with the same bearer.

Sister-shape production discipline: yaklog-admin is a **local** identity — never cross-instance. Two Yaklog installations = two distinct yaklog-admin bearers = two distinct identity boundaries.

## Files created (mode 600 — DO NOT commit)

Inside `$INSTALL_DIR/`:
- `.env` — yaklog config + yaklog-admin bearer + port bindings
- `yaklog-grafana.env` — Grafana admin creds
- `yaklog-minio.env` — MinIO root creds
- `docker-compose.yml` — copied from bundle
- `otel/prometheus.yml` — generated from template with instance label
- `otel/collector-config.yaml` — copied from bundle
- `data/` — yaklog SQLite database (host bind)
- `pat/` — GitHub PAT mount point (empty until operator places a fine-grained PAT)

Under `/etc/yaklog-<instance>/` + `/var/lib/yaklog-<instance>/` (if root install):
- `ops-key` (mode 0400) — read by systemd ingester timer
- `textfile/output-ingester/` — Prom scrape target

## Deploy discipline (Task #285)

Every push to `/srv/git/yaklog.git` main triggers an automatic bundle rebuild via the `post-receive` hook. The bundle in `dist/` is always fresh.

**One-command deploy from bundle:**

```bash
# On devel — update internal Yaklog + demo VM to the latest bundle
/home/jon/yaklog/yaklog-install/deploy-from-bundle.sh --target both

# Or one at a time
deploy-from-bundle.sh --target devel   # local devel yaklog only
deploy-from-bundle.sh --target demo    # remote demo VM only (SSH: yaklog-admin@10.71.1.184)
```

The script:
1. Locates the freshest bundle in `dist/`
2. Backs up the target's `/data/yaklog.db` per `feedback_db_rebuild_safety`
3. `docker load < images/yaklog.tar` on the target
4. `docker compose up -d --force-recreate --no-build yaklog`
5. Health-checks the new container

Both devel `docker-compose.yml` and `docker-compose.demo.yml` declare `image: yaklog:latest`, so the freshly-loaded image is picked up automatically.

**Auto-deploy is deliberately not enabled.** The post-receive hook only rebuilds the bundle. Operator manually invokes `deploy-from-bundle.sh` after inspecting the build. Full auto-deploy is a forward-track once discipline is trusted.

**Bundle rotation:** the hook keeps the last 5 bundles in `dist/`. Older ones are auto-purged.

### Install the post-receive hook

```bash
sudo install -m 0755 /home/jon/yaklog/yaklog-install/hooks/post-receive \
  /srv/git/yaklog.git/hooks/post-receive
```

Verify it fires: `git push origin main` on any commit + watch `/var/log/yaklog-hook/post-receive.log` (or `/tmp/yaklog-hook/` if `/var/log/` unwritable).

## Refs

- PLAN-YAKLOG-INSTALL-BUNDLE.md
- Task #284 (bundle)
- Task #285 (auto-rebuild + deploy discipline)
- Task #278 (v1 yaklog-install)
- Task #185 (external-party clean-install milestone — closed by Jon's manual install of this bundle)
