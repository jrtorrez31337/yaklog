# Plexus Anchor Operations Runbook

> Operator-facing runbook for the Phase 3 (A) external integrity anchor (`audit_anchor` substrate + `scripts/audit-anchor-publisher.sh` cron driver).
>
> **Audience tier:** operator / ops-key holder.
> **For external-auditor onboarding** (CISO / GRC officer / SOC 2 Type II auditor), see `PLEXUS-ANCHOR-AUDITOR-GUIDE.md`.

## What this substrate delivers

Daily cryptographic hash digest of the cluster's audit chain, published to an external append-only store (S3 Object Lock Compliance mode + 7-year retention per ADR-0030 v1.2). Closes the *"audit-log integrity self-attestation by Plexus alone"* circular-trust gap — auditors verify integrity from external evidence, not from Plexus's own database.

## Substrate components

| Component | Location | Purpose |
|---|---|---|
| `audit_anchor` table | SQLite (`/data/yaklog.db`) | One row per published anchor; UNIQUE(anchor_day, anchor_substrate); 7y retention |
| `audit-anchor-publisher.sh` | `/home/jon/yaklog/scripts/` | Cron-driver: snapshot → S3 PUT → record |
| `audit-anchor-publisher.timer` | `/etc/systemd/system/` (admin-deployed) | Daily 01:00 UTC trigger |
| `audit-anchor-publisher.service` | `/etc/systemd/system/` | One-shot unit; runs the publisher script |
| `/api/v1/ops/audit/anchor-snapshot` | yaklog server | Ops-gated; returns current chain-high-water + digest |
| `/api/v1/ops/audit/anchor-record` | yaklog server | Ops-gated; persists published anchor |
| `/api/v1/plexus/public/audit/anchor-verify` | yaklog server | Public read; recomputes digest + returns `{match, tamper_detected, ...}` |
| Dashboard Chain integrity card | Audit tab → Attest sub-view | 30-day visual surface (🟢 / 🔴 / ⬜) |

## Substrate canon (do not change without ADR amendment)

Per parch #7984 + ADR-0030 v1.2 ratify:
- Substrate: **S3 Object Lock Compliance mode** (admin-override-proof even by bucket owner)
- Cadence: **daily** at 01:00 UTC
- Retention: **7 years** (covers SOC 2 + GDPR + most jurisdictions)
- Verify access: **public** per OQ-3.3 (auditors verify without ops-key issuance)
- Multi-substrate: **dual-publish 12mo window** when 2nd substrate added (forward-track per OQ-3.4)

## Routine operations

### Verify publisher is healthy

```bash
# Most-recent anchor day:
curl -s 'http://localhost:3100/api/v1/plexus/public/audit/anchors?limit=1' | jq '.rows[0] | {anchor_day, published_at, anchor_uri}'

# Prometheus metric (post-CP12.21 wiring):
curl -s http://localhost:9090/api/v1/query?query=plexus_audit_anchor_last_publish_ts_seconds | jq

# Alert threshold: stale > 48h = publisher failure
```

### Verify a specific day's anchor

```bash
curl -s 'http://localhost:3100/api/v1/plexus/public/audit/anchor-verify?day=2026-06-07' | jq

# Expected for healthy chain:
#   {"found": true, "match": true, "tamper_detected": false, ...}
#
# Or via dashboard: Audit tab → Attest sub-view → click any green cell on Chain integrity card
```

### Manual one-off anchor publish (e.g., backfilling a missed day)

```bash
# Override ANCHOR_DAY env to target a specific day:
sudo systemctl stop audit-anchor-publisher.timer
ANCHOR_DAY=2026-06-05 sudo -u devel /home/jon/yaklog/scripts/audit-anchor-publisher.sh \
  --yaklog-url http://localhost:3100 \
  --ops-key-file /home/devel/.config/yaklog/ops-key \
  --s3-bucket plexus-audit-anchor-devel
sudo systemctl start audit-anchor-publisher.timer
```

### Dry-run mode (no S3 publish)

```bash
/home/jon/yaklog/scripts/audit-anchor-publisher.sh \
  --yaklog-url http://localhost:3100 \
  --ops-key-file /home/devel/.config/yaklog/ops-key \
  --dry-run
```

## Incident response

### `tamper_detected: true` fires

**Severity: CRITICAL.** Genuine tamper signal under Reading-2 semantic (CP12.12.1). Class A (high-water event_id missing) or Class B (digest mismatch).

**Response playbook**:

1. **Do NOT delete or modify anything in `audit_anchor`** — those rows are the forensic record of when tamper was detected.
2. **Snapshot the affected day's chain state to a side database** for forensic review. **Write to persistent storage, NOT /tmp** (per `feedback_devel_tmp_is_tmpfs` — /tmp wipes on host reboot; forensic evidence must survive):
   ```bash
   mkdir -p /var/lib/yaklog/forensic
   sqlite3 /data/yaklog.db ".dump audit_tool_invocation audit_file_access audit_credential_change audit_permission_change audit_attestation audit_channel_subscription_change" > /var/lib/yaklog/forensic/chain-forensic-$(date -u +%Y%m%d-%H%M%S).sql
   ```
3. **Identify scope**: which event_id is the chain-high-water for the affected anchor day? When was that event published vs when did anchor publish?
   ```bash
   curl -s 'http://localhost:3100/api/v1/plexus/public/audit/anchor/2026-06-XX' | jq '.chain_high_water_event_id, .chain_high_water_table'
   ```
4. **Cross-check against S3**: fetch the stored digest from S3 and confirm it matches the `audit_anchor` row:
   ```bash
   aws s3 cp s3://plexus-audit-anchor-devel/2026/06/XX/digest.txt - | head -c 64
   ```
5. **Dispatch to secops + admin** with `severity:critical` and the forensic snapshot path. Per `feedback_jon_input_routes_through_parch` for security-incident-class self-flag — surface to parch routing.
6. **Do NOT publish a new anchor** until tamper-detection cycle closes — publishing again would mask the divergence.

### Publisher missed a day (gap in Chain integrity card)

Acceptable disposition: **leave gap as-is + investigate root cause**. The gap is honest signal that something blocked publishing (network issue / S3 access / cron failure). Backfilling the gap by manual publish is acceptable if the cluster state at intended-day-time was knowable; otherwise leaving the gap is more honest than synthetic backfill.

Root-cause checks:
- `systemctl status audit-anchor-publisher.timer audit-anchor-publisher.service`
- `journalctl -u audit-anchor-publisher.service --since=yesterday`
- AWS credential validity: `aws s3 ls s3://plexus-audit-anchor-devel/ | head`

### S3 bucket compromise suspected

**Bounded blast radius** (per CP12.21 secops review): digests only — no event content. Attacker learns digest *values* (already-public per public verify endpoint); cannot tamper sealed objects (Compliance mode); cannot delete pre-retention; cannot exfiltrate events.

**Response**:
1. Snapshot current `audit_anchor` table to side database.
2. Rotate AWS credentials for the publisher IAM role.
3. Verify Object Lock Compliance is still active on all uploaded objects.
4. If compromise included write-access (which Compliance mode prevents post-write, but attacker may have written *new* bogus anchors): cross-check `audit_anchor` table against S3 bucket inventory; any extra objects in S3 not referenced by table = tamper-evidence on bucket-side.

## Configuration reference

| Path | Purpose | Owner |
|---|---|---|
| `/etc/systemd/system/audit-anchor-publisher.timer` | Daily trigger | admin |
| `/etc/systemd/system/audit-anchor-publisher.service` | One-shot unit | admin |
| `/home/devel/.config/yaklog/ops-key` | Ops-key for yaklog endpoints | secops |
| `/home/devel/.config/yaklog/aws-credentials` | AWS access key for S3 PUT | ssw-devops |
| `s3://plexus-audit-anchor-devel/` | Anchor storage | ssw-devops (Object Lock policy) |

## Metric reference

`audit-anchor-publisher.sh` emits Prometheus metrics via textfile-collector pattern at `${TEXTFILE_DIR:-/var/lib/yaklog/textfile}/plexus_audit_anchor.prom` (atomic write: writes to `.tmp` then `mv -f`). Three gauge metrics emitted per run regardless of outcome:

| Metric | Labels | Value semantics | Alert threshold |
|---|---|---|---|
| `plexus_audit_anchor_last_publish_ts_seconds` | `substrate`, `anchor_day` | unix timestamp of last publish attempt | `time() - $value > 172800` (48h) → publisher failure |
| `plexus_audit_anchor_publish_status` | `substrate`, `anchor_day` | 1 = success, 0 = failure | `== 0` → investigate last cron run |
| `plexus_audit_anchor_publish_http_code` | `substrate` | last anchor-record endpoint HTTP code | `!= 200` → server-side record failure |

**Scrape config required** (admin / ssw-devops coord-ask): node_exporter must scan `/var/lib/yaklog/textfile/*.prom` via the textfile-collector flag. Sample systemd unit drop-in: `--collector.textfile.directory=/var/lib/yaklog/textfile`. Once node_exporter scrapes, Plexus Prometheus picks up via the existing devel scrape config; Grafana dashboard alerts wire from there.

**Forward-track (post-Phase-3-A operational close-gate)**: a CP12.21.x cycle can replace the textfile pattern with direct OTLP emission to `plexus-otel-collector:4318` once an OTLP HTTP client is staged in the publisher script. Either pattern delivers the same scrape result; textfile is the simpler dependency-free path for first ship.

## Forward-track

- **Dual-substrate (12mo)**: when a second anchor substrate is added (RFC 3161 TSA or IPFS per parch #7984 OQ-3.4 forward-track), publisher gains second-substrate publish step; cron config gains second IAM credential.
- **Multi-tenant (Phase 3 (D) trigger-gated)**: per-tenant S3 prefix or per-tenant bucket; per-tenant verify endpoint scoping. See `PLAN-CP12-PHASE-3-D-MULTI-TENANT-READINESS.md`.

## References

- ADR-0030 v1.2 §Phase 3 (A) (canonical scope)
- `PLAN-CP12-PHASE-3-EXTERNAL-INTEGRITY-ANCHOR.md` (input draft)
- `PLEXUS-ANCHOR-AUDITOR-GUIDE.md` (external-auditor onboarding)
- `feedback_secrets_no_yaklog` (credentials handling discipline)
- secops #8024 (trust-boundary ruling on bounded-substrate exposure)
- secops #8028 + #8034 (CP12.12 + CP12.12.1 security-property review CONCUR)
