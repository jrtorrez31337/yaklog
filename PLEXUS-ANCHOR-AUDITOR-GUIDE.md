# Plexus Anchor Auditor Guide

> External-auditor-facing guide to verifying Plexus audit-chain integrity.
>
> **Audience tier:** CISO, GRC officer, SOC 2 Type II auditor, ISO 27001 auditor, external GRC assessor.
> **Sister doc** (operator-facing): `PLEXUS-ANCHOR-OPERATIONS.md`.

## What Plexus claims about audit-chain integrity

Plexus persists every audit event with a cryptographic hash-chain (`event_id = sha256(prev_event_id || occurred_at || agent_id || action_class || metadata_only)[0:16]`). The chain is **append-only by substrate design**: tables have no UPDATE / DELETE paths in the production code path; data is mutated only via:

1. **Tombstone with lawful-basis-reason** (GDPR Art.17 right-to-be-forgotten) — produces a meta-audit event documenting the deletion
2. **No other write paths exist** — appends only

Without external evidence, this is *self-attestation* — circular trust. Phase 3 (A) external integrity anchor closes this gap.

## The external anchor

Daily, the cluster publishes a cryptographic hash digest of the audit chain's recent horizon to an external append-only store. Per ADR-0030 v1.2 ratify:

| Property | Value | Why it matters |
|---|---|---|
| **Substrate** | S3-compatible Object Store with Object Lock in Compliance mode (AWS S3, MinIO, or any S3-compatible substrate per CP12.21.1 hosting-target flexibility; substrate-canon remains "S3-compatible Object Lock" regardless of hosting choice) | Admin-override-proof — even the bucket owner cannot delete or modify locked objects |
| **Retention** | 7 years | Covers SOC 2 + GDPR + most jurisdictions |
| **Cadence** | Daily at 01:00 UTC | Bounded latency on tamper-detection: at most 24h between events landing and being anchored |
| **Verify access** | Public read | Auditors verify without ops-key issuance from Plexus |
| **Digest formula** | `sha256(chain_high_water_event_id ‖ last_100_event_ids)` | Sample-based anchor (high-water + 100-event horizon); NOT full Merkle root |

### Sample-based anchor scope (honest documentation)

The anchor digest covers the chain's *recent horizon* (high-water event_id + last 100 event_ids in the highest-water table), not the entire chain. This is an engineering trade-off:

- Sample-based anchor: O(1) per daily publish; bounded operational cost; catches **tamper in recent horizon** (last ~100 events)
- Full Merkle: O(N) per daily publish; unbounded operational cost; catches **tamper anywhere**

The sample-based approach builds up tamper-coverage over time: each daily anchor anchors *that day's* recent horizon. After 30 days of anchors, the cluster has 30 different recent-horizon anchors, each independently verifiable. An adversary tampering with a historical event must collide ALL anchors that covered that event's horizon at publish time — practically infeasible.

### Reading-2 verify semantic (CP12.12.1)

The verify endpoint recomputes the digest over the **same event set** that existed at anchor time, not the current chain tip. This is critical:

- Live cluster has continuous event flow; chain advances continuously
- Reading-1 (compare against current tip): always returns `match:false` post-anchor — useless
- **Reading-2 (recompute over events ≤ stored high-water occurred_at)**: returns reproducible `match:true` indefinitely; `match:false` is genuine tamper signal

Tamper signals are unambiguous under Reading-2:
- **Class A**: stored high-water event_id no longer present in chain → event was deleted post-anchor
- **Class B**: recomputed digest differs from stored digest → event payload was modified post-anchor

### Two-source verification architecture (security property per secops #8068)

The verify chain has **two independent sources that must agree** for a clean pass:

1. **Cluster API source**: `/audit/anchor-verify?day=YYYY-MM-DD` returns the digest stored in the local `audit_anchor` SQLite table (database-driven; not derived from S3 at request time)
2. **External substrate source**: the S3 object at the content-addressed key `YYYY/MM/DD/<digest-first-16>.txt` returns the same digest, immutably preserved per Object Lock Compliance

**Why this matters**: an attacker who compromises ONLY S3 (e.g. gains PutObject) cannot fool an auditor who cross-checks both sources. The local verify endpoint still returns the original database digest; the S3 content (if tampered) would disagree → tamper-detection fires at the cross-check step. Compromising BOTH the cluster database AND the S3 bucket simultaneously is a substantially harder attack, bounded by Plexus's trust-boundary discipline.

**Auditor implication**: do NOT rely on a single source. The verification procedure below explicitly fetches from BOTH and confirms agreement; that's where the load-bearing security property lives. Content-addressed S3 key schema (CP12.21 per secops #8068 §2) further hardens this: an attacker overwriting at the original key cannot do so without knowing the original digest (since the key name IS derived from that digest).

## How to verify the cluster's chain integrity

### Step 1: List recent anchors

```
GET https://<plexus-host>/api/v1/plexus/public/audit/anchors?limit=30
```

Returns last 30 days of anchors with `anchor_day`, `anchor_substrate`, `anchor_uri`, `chain_high_water_event_id`, `chain_high_water_table`, `digest_sha256`, `published_at`, `published_by`.

### Step 2: Pick an arbitrary historical day; fetch the stored digest from S3

```
GET s3://plexus-audit-anchor-devel/2026/06/07/digest.txt
```

(S3 bucket name varies per deployment; obtain from operator. Object Lock Compliance retention means the file cannot be modified or deleted post-publish.)

The S3 object body is the same `digest_sha256` value as stored in the Plexus `audit_anchor` table for that day. **Compare**: S3 body should equal `audit_anchor.digest_sha256`. If they differ, that's substrate-side tamper (either the S3 object was tampered — Object Lock should prevent — or the Plexus table was tampered).

### Step 3: Verify the chain still matches the anchor

```
GET https://<plexus-host>/api/v1/plexus/public/audit/anchor-verify?day=2026-06-07
```

Returns:
```json
{
  "found": true,
  "match": true,
  "tamper_detected": false,
  "stored_digest": "7ee27bf3e6375369...",
  "recomputed_digest": "7ee27bf3e6375369...",
  "stored_high_water_event_id": "306efef5002a421a",
  "recomputed_high_water_event_id": "306efef5002a421a",
  "sample_size": 100,
  "note": "chain state up to stored anchor matches anchor digest — no tampering detected"
}
```

- `match:true` + `tamper_detected:false` → chain ≤ stored high-water unchanged since anchor publish (no tamper)
- `match:false` + `tamper_detected:true` + Class A note → event was deleted from the chain post-anchor
- `match:false` + `tamper_detected:true` + Class B note → event payload was modified post-anchor

### Step 4: Independent cryptographic verification (recommended)

You can independently compute the expected digest yourself:

```
1. Fetch the event at stored_high_water_event_id from /api/v1/plexus/public/audit/event/:event_id
2. Fetch the last 100 events from the high-water table ordered by occurred_at DESC
   where occurred_at ≤ stored_high_water_occurred_at
3. Compute: sha256(high_water_event_id || event_ids.join('|'))[0:64]
4. Compare to anchor_day's digest_sha256
```

If your computed digest matches the S3-stored digest AND the Plexus-table-stored digest, the chain is verified end-to-end without needing to trust Plexus's verify endpoint at all.

## What this DOES NOT cover (honest scope)

- **Events outside the 100-event recent-horizon at anchor time**: an adversary tampering with very-old events (more than 100 events deep from the anchor's high-water at the day it was published) might not be caught by THAT day's anchor. They WOULD be caught by anchors from days when those events were in the recent horizon. After 30 days of anchors, coverage stacks up.
- **Events between anchor publishes (≤24h window)**: an adversary tampering then immediately reverting before the next anchor would not be caught by either anchor. This is a real gap; mitigation is more-frequent anchoring (hourly?) — currently daily per OQ-3.1.
- **AWS account compromise**: if the AWS account hosting the bucket is compromised + IAM allows Object Lock policy mutation, the entire bucket integrity is compromised. Mitigation: customer can verify bucket policy + AWS CloudTrail for unauthorized account changes (out of Plexus's scope).

## Anti-features (deliberately out of scope per ADR-0030 v1.2 §Non-goals)

- **Real-time enforcement actions on tamper-detection**: Plexus surfaces the tamper signal; response action is operator's playbook (see `PLEXUS-ANCHOR-OPERATIONS.md` incident response).
- **Cross-cluster anchor reconciliation**: each Plexus cluster anchors its own chain. Multi-cluster integrity reconciliation is Phase 3 (D) multi-tenant scope.
- **Customer-side SIEM integration of anchor verify**: customer can poll the verify endpoint and forward results to their SIEM, but Plexus does not push verify results.
- **Auditor-supplied verify schedule**: auditor can run verify on any cadence; Plexus does not throttle / rate-limit public read endpoint.

## Customer questions answered

**Q: How do I verify chain integrity for SOC 2 Type II audit?**
A: Pull last 90 days of anchors via Step 1. For each, perform Steps 2 + 3 (and optionally Step 4 for independent crypto). Expected: 90/90 `match:true`. Any `match:false` is reportable; investigate root cause with operator.

**Q: Can I export the anchor history for our records?**
A: Yes — `GET /api/v1/plexus/public/audit/anchors?from=2026-01-01&to=2026-12-31&limit=365` returns the full year's anchors. Per-day digest comparison against S3 is reproducible at any future point.

**Q: What if the cluster operator stops publishing anchors?**
A: Visible immediately on the Audit-tab Chain integrity card (gray cells appear for missed days). Auditor can also detect via Step 1 (anchor list will have gap). Gap is honest signal; investigate root cause with operator.

**Q: What if the substrate hosting provider goes away (AWS account closed / MinIO host failure / S3 bucket deleted)?**
A: 7-year Object Lock Compliance retention means the bucket and its contents cannot be deleted before retention expiry, **even by the bucket owner**. For AWS S3 hosting: if the AWS account itself is closed, AWS retains the bucket for the Object Lock retention period before deletion; customer can verify this via AWS support. For local MinIO hosting (CP12.21.1 default per Jon-direct 2026-06-09): the substrate-canon stays S3-compatible Object Lock, but DR posture is the operator's responsibility — operators SHOULD pair MinIO with off-host replication of the Object Lock substrate for retention durability. Both hosting targets preserve substrate-canon; only DR ownership differs.

**Q: Is the anchor format substrate-portable?**
A: Yes. The anchor is plain-text `(anchor_day, digest_sha256, chain_high_water_event_id, chain_high_water_table)`. If Plexus migrates from S3 to RFC 3161 TSA or IPFS later (parch #7984 OQ-3.4 dual-publish 12mo forward-track), the digest content is identical; only wrappers change. No data migration required.

## References

- ADR-0030 v1.2 §Phase 3 (A) (canonical anchor substrate-choice)
- ADR-0025 (registration substrate; event_id chain origin)
- ADR-0026 (audit + DM substrate)
- secops #8024 (trust-boundary ruling on bounded-substrate exposure)
- secops #8034 + bizmodel #8029 (Reading-2 semantic CONCUR; chain-tamper-detection operational claim)
- `PLEXUS-ANCHOR-OPERATIONS.md` (operator-facing sister doc)
- `PLEXUS-FEATURES.md` §3.9 (audit + governance substrate)
