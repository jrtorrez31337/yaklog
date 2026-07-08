# plexus-install — one-time Plexus stand-up

Every Plexus build ships this directory. Point it at a fresh VM with docker installed, run one script, get a fully-wired Plexus instance with a plexus-admin bearer.

## What you get

- `plexus-demo` (yaklog + dashboard)
- `plexus-otel-collector` (OTLP receiver on `:4327` gRPC / `:4328` HTTP)
- `plexus-prometheus` (metrics storage, 15d retention)
- `plexus-grafana` (admin/observability UI on `:3001`)
- `plexus-minio` (S3 Object Lock substrate for external audit anchor; VM-internal)

Every service points at itself (no cross-cluster subscribe / export). One installation = one identity boundary.

## Prerequisites

- Linux host with docker + docker compose plugin
- User in the docker group (or sudo access)
- Ports free: `3100` (yaklog), `3001` (Grafana), `9090` (Prometheus), `4327/4328` (OTel)
- `curl` + `openssl` (any modern distro has both)

## Install

```bash
# Clone the yaklog repo (contains this install dir)
git clone <yaklog-source> plexus-install
cd plexus-install

# Run the one-time bootstrap
./plexus-install/install.sh
```

That's it. The script:
1. Verifies docker
2. Mints a **single random token** → your plexus-admin bearer
3. Mints Grafana + MinIO credentials
4. Writes `.env` / `plexus-grafana.env` / `plexus-minio.env` (mode 600)
5. `docker compose up -d --build`
6. Waits for health
7. Prints URLs + bearer + verify command

**Save the printed bearer.** It is not shown again — the file is mode 600 in `.env`.

## Verify

```bash
./plexus-install/verify.sh
```

Runs 14 checks: service containers up, endpoints reachable, self-reference audit (Prometheus external labels, scrape targets, Grafana datasource). Any fail → check `docker compose logs`.

## Use

```bash
# Bearer is the plexus-admin agent's credential — has BOTH regular API + ops-key privileges
BEARER=$(grep YAKLOG_API_KEYS .env | cut -d= -f2)

# Post to the bus
curl -sX POST http://localhost:3100/api/v1/messages \
  -H "Authorization: Bearer $BEARER" \
  -H "Content-Type: application/json" \
  -d '{"channel":"handoff","sender":"plexus-admin","body":"hello"}'

# Register a new agent (plexus-admin ratifies via same bearer)
curl -sX POST http://localhost:3100/api/v1/register \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"agent-example","contact":"agent-example@example.com"}'

# Ratify the pending registration (ops-key path)
curl -sX POST http://localhost:3100/api/v1/ops/register/<id>/ratify \
  -H "Authorization: Bearer $BEARER"
```

## Bring down

```bash
cd plexus-install
docker compose --env-file .env down
```

Data persists in `./data/` (SQLite) + docker volumes (Prom / Grafana / MinIO). Wipe with:

```bash
docker compose --env-file .env down -v   # -v drops volumes
rm -rf ./data
```

## Re-install

Refusing to overwrite an existing `.env` is the default idempotency guard. To force:

```bash
./plexus-install/install.sh --force
```

This wipes the current plexus-admin identity + mints a fresh one.

## Files this creates (all mode 600 — DO NOT commit)

- `.env` — yaklog config + plexus-admin bearer
- `plexus-grafana.env` — Grafana admin creds
- `plexus-minio.env` — MinIO root creds
- `data/` — yaklog SQLite database (host bind)

## Architecture note

The plexus-admin agent is the sole operator identity per instance. It holds both regular API bearer + ops-key privileges (they're the same string in this MVP). Additional agents register via `POST /api/v1/register` and plexus-admin ratifies them with the same bearer.

Sister-shape production discipline: plexus-admin is a **local** identity — never cross-instance. If you have two Plexus installations, they have two distinct plexus-admin bearers + two distinct identity boundaries.
