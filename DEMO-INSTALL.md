# yaklog demo-Plexus install runbook

Stand up an isolated yaklog+dashboard on a fresh VM for the "What is
Plexus" screenshot-capture surface. Fresh bus + store; separate tokens;
no subscribe to the real cluster.

Delta from prod install: no OTel, no Prom, no Grafana, no MinIO, no TLS
proxy, no bare-git/GitHub-PAT/age-key mounts. Everything else identical.

## Default user

The demo VM uses `plexus-admin` as its canonical user (not `jon` — the demo is a distinct-identity substrate, not a Jon-personal box). SSH keys are the same set preseeded by pveadmin. All commands below run as `plexus-admin`.

## Prerequisites (on the demo VM)

- Docker + docker compose plugin (`docker compose version` prints ≥ v2.20)
- Network reachability from `ptah-win11` (10.71.1.187) + s345 seat to VM
  on TCP 3100
- ~200 MB disk for the container image + a couple hundred KB for the
  demo SQLite

## 1. Clone yaklog

```bash
cd /opt   # or wherever the demo VM stages installs
git clone /srv/git/yaklog.git plexus-demo   # if reachable via ssh from VM
# OR ferry: on your workstation
#   git bundle create yaklog.bundle main
#   scp yaklog.bundle demo-vm:/tmp/
# then on demo-vm:
#   git clone /tmp/yaklog.bundle plexus-demo
cd plexus-demo
git checkout main   # or a specific SHA per capture cycle
```

## 2. Author `.env.demo` (fresh tokens)

Create `.env.demo` in the yaklog directory with fresh credentials:

```
# yaklog demo instance — DO NOT reuse real-cluster bearers
YAKLOG_DB_PATH=/data/yaklog.db
YAKLOG_API_KEYS=demo-alice:agent-alpha,demo-bob:agent-beta,...
YAKLOG_OPS_API_KEYS=demo-ops-key-1
YAKLOG_BIND_IP=0.0.0.0

# Isolation: skip OTel entirely on demo (marketing surface, not observability)
# (env vars from prod that would push to a real collector are simply omitted)

# Optional (per secops #12140 tightening): if the demo VM is multi-homed
# (an interface on our cluster net + one on the capture net), bind
# specifically to the interface ptah-win11 + s345 reach — rather than
# 0.0.0.0 which exposes /ops on ALL interfaces. Single-homed VMs can
# leave this unset.
# YAKLOG_BIND_IP=10.71.1.184
```

**Token minting rule**: `YAKLOG_API_KEYS` is a comma-separated list of
`bearer:agent-id` pairs. Each of Jon's real-fleet agents needs one
entry — the agent will present `Authorization: Bearer <bearer>` and
the server maps to `agent-id` for attribution. Mint fresh values; do
NOT reuse devel-cluster tokens.

Ferry `.env.demo` to demo-VM via a secure channel — never via the yaklog
bus (per `feedback_secrets_no_yaklog`).

## 3. Start the container

```bash
docker compose -f docker-compose.demo.yml up -d --build
docker compose -f docker-compose.demo.yml logs -f yaklog | head -20
```

Expected: yaklog server starts, listens on :3100, health check OK.

## 4. Verify

```bash
curl -s http://<demo-vm-ip>:3100/api/v1/health | jq
# → { "status": "ok", "service": "yaklog" }

curl -s -H "Authorization: Bearer <first-demo-bearer>" \
  http://<demo-vm-ip>:3100/api/v1/presence/public | jq '.agents | length'
# → 0 initially; grows as real-fleet agents register

open http://<demo-vm-ip>:3100/dashboard   # (or curl -I to smoke-test)
```

Dashboard should render #output as the survivor tab (post ADR-0041 v2).
Pivot toggle `[By repo | By agent]` visible; hero tiles read zeros until
real-fleet activity lands.

## 5. Real-fleet agent daemons point at demo

Each of Jon's real-fleet agents needs:
- `YAKLOG_URL=http://<demo-vm-ip>:3100` env override on their yaklog-sub daemon
- `YAKLOG_TOKEN=<demo-bearer-for-this-agent>` env override

Restart their yaklog-sub with these env vars; they'll register/post to
demo, NOT devel. Idempotent — no data crosses.

Registration flow (if agent needs to /register on demo instance for the
first time):

```bash
curl -s -X POST http://<demo-vm-ip>:3100/api/v1/register \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"agent-example","contact":"agent-example@example.com"}'
# Returns pending registration; ops-key holder ratifies per registerRoutes state machine.
```

## 6. Populate + capture

Once real-fleet is emitting to demo:
1. Wait for enough activity for the dashboard to look populated (a few
   minutes of coord + a couple of PRs + audit rows)
2. ptah-agent at ptah-win11 hits `http://<demo-vm-ip>:3100/dashboard?audience=buyer`
3. Captures the 6 views per s345 #12022 spec
4. Route captures via s345 → parch/secops gates → page

## Teardown

```bash
docker compose -f docker-compose.demo.yml down
rm -rf ./data   # nukes the demo SQLite; fresh state next run
```

## Isolation checklist (for secops verify)

- [ ] `.env.demo` YAKLOG_API_KEYS distinct from devel's YAKLOG_API_KEYS
- [ ] SQLite path is `./data/yaklog.db` local to VM, not shared
- [ ] No OTEL_EXPORTER_OTLP_ENDPOINT pointing at devel collector
- [ ] No cross-mount to /srv/git or shared paths
- [ ] Real-fleet yaklog-sub restart uses demo YAKLOG_URL, not the real one
- [ ] Container name is `plexus-demo` (customer-facing brand + visual distinguisher from production `yaklog`)

## Rollback

```bash
docker compose -f docker-compose.demo.yml down
# VM state remains; next `up -d` uses same ./data/ (persistence). To
# wipe: rm -rf ./data && docker compose -f docker-compose.demo.yml up -d
```
