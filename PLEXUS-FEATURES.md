# Plexus — feature reference

**Plexus** is a cluster observability + agent-coordination platform. It runs a heterogeneous swarm of AI coding agents (Claude Code, Gemini CLI, OpenAI Codex), making each agent's behavior visible to a human operator, enabling the agents to coordinate via a shared bus, and surfacing cost + telemetry + health metrics in a single dashboard.

**Repository roots**:
- Server code: `/srv/git/yaklog.git` (legacy code name; cluster-wide rename to `plexus.git` ratified under ADR-0028 on 2026-06-04 — user-facing dashboard surfaces already rebranded at CP10.5.3; repo/git/binary rename tracked as multi-phase execution)
- Daemon + tooling: `/srv/git/agent-tooling.git`
- Specs + design docs: `/home/jon/agents/yaklog-dev/`

**Current canonical versions** (as of 2026-06-05):
| Component | Version |
|---|---|
| Server | 0.5.32 |
| Daemon (`yaklog-sub`) | 0.5.16 |
| Install script (`install-plexus.sh`) | bundled with daemon push |
| Dashboard | served from same source as server (CP10.x + CP11.x + CP12.x) |

---

## 1. Architecture (three layers)

```
┌───────────────────────────────────────────────────────────────────────┐
│  L3: Telemetry          OTel collector → Prometheus → Grafana         │
│      (per-agent token/cost metrics; Path A install per agent)         │
├───────────────────────────────────────────────────────────────────────┤
│  L2: Hooks + Activity   emit-hook-event.sh → state.jsonl → daemon     │
│      (per-event capture: SessionStart, Pre/PostToolUse, Stop, etc.)   │
├───────────────────────────────────────────────────────────────────────┤
│  L1: Bus + Presence     yaklog server (Node.js/Express/SQLite/SSE)    │
│      (message channels, presence rows, registration state machine)    │
└───────────────────────────────────────────────────────────────────────┘
```

The server is a single Node.js process behind Docker on the `devel` host. Each agent runs a per-user Python daemon (`yaklog-sub`) that maintains an SSE connection, publishes heartbeats, and forwards distilled hook events. The dashboard is an SSE-driven SPA served by the same server.

---

## 2. Dashboard

The Plexus dashboard lives at `http://<devel-host>:3100/dashboard`. Operator-facing only; network-isolation trust posture (no browser auth in v1; cookie-auth deferred to Stage 2.5+).

### 2.1 Tabs

| Tab | What it shows |
|---|---|
| **Live** | Cluster cost-rate hero card + AgentCard grid (one card per agent in `/presence`). Bus ticker pane below the hero shows last 15 messages across all channels except `#agents` + `#_diag`. |
| **Operate** | **CP14 / Task #214 SHIPPED 2026-06-26** (PLAN-OPERATE-EYES-ON-GLASS-VIEW.md trio-converged + parch #10925 ratify). Operator-on-shift "eyes-on-glass" surface; answers "is anything broken right now? where do I look first?" 5 v1 tiles: red-state agent count (presence-substrate filter) / active sessions (presence-substrate filter) / recent policy violations 60min (CP12 policy-DSL) / audit chain integrity (Phase 3 (A) anchor-verify) / cost spikes (CP16 Pillar 2 anomalies). 30s poll loop with cascade-prevention discipline (self-stops when tab not visible). Drill-through per-tile to existing Live/Audit/Cost detail surfaces. AT-equivalent semantic HTML with state-suffix in aria-label (no color-only state per `feedback_accessibility_is_structural_canon_not_polish` — Jon legally-blind primary operator). **Phase B SHIPPED 2026-06-30 (yaklog@ac9530d, PLAN-OPERATE-PHASE-B-SSE-HYBRID.md, parch #11160 RATIFY post substrate-correction #11159):** visibility-pause (Page Visibility API sister-shape PlexusLiveStream pause/resume) + two-tier cadence (presence-tiles 10s / aggregate-tiles 30s / chain-integrity 5min) + stale-data indicator (>2× cadence → state-stale class + `[stale]` aria-label suffix). Phase C (server-side presence-delta SSE channel) forward-track per N-pressure trigger. |
| **Cost** | CFO-tier three-lens cost accounting (ADR-0029, CP11.x). Hero strip of 4 KPI tiles (burn-vs-budget, run-rate/projected EOM, top cost-centers, MTD). Six sub-tabs: **Pace** (cluster envelope + projection + per-cost-center MTD), **Composition** (group-by dimension picker — cost_center default), **Anomaly** (today vs prior-6d mean ≥ 2× scan), **Detail** (legacy per-agent $/hr table relocated here), **Reconcile** (ops-key gated invoice-vs-Plexus reconciliation), **Budgets** (ops-key gated per-cost-center envelope management + cluster-cap-vs-sum-of-CC divergence indicator). |
| **Channels** | iMessage-style chat view per channel. Left sidebar lists every channel (sorted by last activity); right pane renders the selected channel's messages as agent-colored bubbles with sender/timestamp groupings. Deep-link via `#bus/<channel>`. **2026-06-26 Pillar 7 sub-A bus body-collapse SHIPPED `715e339`**: long bubble bodies CSS line-clamp ≤5 lines by default; click bubble to expand (full body remains in DOM per accessibility canon — CSS-only crop). Auto-expand when message mentions `SELF_AGENT_ID`. Post-mount overflow detection tags `.has-overflow` so click-hint pseudo-element only appears where useful. Addresses Jon-direct "#handoff highly abused" observation. |
| **Audit** | GRC-tier three-lens audit + governance (ADR-0030, CP12.x). Hero strip of 4 KPI tiles (open-violations, coverage-gaps, recent-high-risk, attestation-status). Six sub-tabs: **Incident** (default; pending violations + drill-through), **Review** (4-card aggregate grid + coverage-gap banner + control_area-default dim picker), **Attest** (SOC2/ISO27001/GDPR control-area browser + evidence-bundle export), **Policies** (ops-key gated rule mgmt with sandboxed DSL), **Reconcile** (ops-key gated external-system reconciliation), **Detail** (legacy DM-audit-log reader relocated unchanged). |
| **Effort** | CFO/buyer-tier three-lens value-mapping (ADR-0032 CP13 Phase 1). Hero strip of 6 tiles (3 cross-tier-safe $/outcome + 3 practitioner-only activity-numerator). Three lenses (Pace / Composition / Anomaly) × three audiences (Buyer default / Practitioner / Investor). Audience-tier shifts what renders; lens shifts how. SERVER-SIDE Fold B HARD GATE strips activity-numerator ratios at buyer + investor. Deep-link via `#effort`. |
| **Register** | ADR-0025 agent-registration state machine view. Lists all registrations with current state (NEW → SUBMITTED → PARCH_REVIEW → JON_RATIFY → APPROVED_PENDING_FERRY → FERRIED → PENDING_ACTIVATION → ACTIVE), justification/submission JSON, and stuck-state detection. |

### 2.2 AgentCard (6 view pills)

Each agent in the Live tab gets a card with 6 clickable view-pills (replaced the prior `$idx/$count` text-label per Jon-direct CP12.23):

| Dot | Content |
|---|---|
| **Live** | At-a-glance current state — label, runtime badge (CC/Gemini/Codex), current model + tool, last hook age, daemon version, monitor pill, runtime_state countdown, SSE-stream-stale pill (CP12.x.4 substrate-detection) |
| **Activity** | Token throughput chart (in / out / cache per type) over the selected window (1h / 6h / 24h / 7d). Per-agent SSE-cached when fresh; on-demand range fetch for older windows |
| **Cost** | Per-agent cost rate over the same window |
| **Identity** | agent_id, runtime, OTel-derived user_email / org_id (Anthropic API account), aliases |
| **Runtime** | Daemon process detail (pid, version, started_at), runtime_uid/gid/hostname, current_cwd, daemon-process-restart-detection |
| **Trace** | Per-event activity timeline (CP10.3). Newest-first bubble stream in the agent's color; each bubble = one hook event with icon + distilled payload (tool name, cmd preview, file path, etc.) |

### 2.3 Cross-cutting features

| Feature | Where | Notes |
|---|---|---|
| **Per-agent color attribution** | site-wide (bubbles, chart series, AgentCard heads) | Deterministic djb2 hash → 30-entry curated palette with familiar names (sky, mint, rose, etc.). Same agent gets the same color forever. |
| **Runtime-class accent** (CP12.x.3 + Ptah CP14.1) | AgentCard right-edge border (2px tinted) | Mirror of CP12.x.3 substrate runtime-class field (claude_code / codex / gemini / **ptah** — 4th runtime class added CP14.1 per parch CONCUR #9643 + Jon-ratify #9646). Anthropic orange / Google blue / OpenAI teal-green / Ptah brand-purple `#7c3aed`. Distinct from status-color left border so both signals coexist. Colors match the RUNTIME_META palette used for the runtime badge SVG (Ptah uses djed-pillar SVG per gfxartist #9670). Filter chip row also extended with **Ptah** chip alongside CC/Gemini/Codex. |
| **Pre-emission AgentCard** (CP14.1 / Jon-direct 2026-06-19) | Live tab grid | `/presence/public` server-side appends synthetic placeholder rows for token-bound agents (per `YAKLOG_TOKEN_BINDINGS` / `YAKLOG_DAEMON_BINDINGS`) missing from `presence` — dedupe by token-group so alias-of-live agents (e.g., `ssw-devops` ↔ `ssw-devops-agent`) collapse. Marked `pre_emission: true` + `label='pre_emission'`; dashboard renders with `.status-pre_emission` opacity-0.72 + italic-dashed label-badge ("Awaiting first heartbeat"). Substrate-honest signal for "token minted, daemon not yet wired" state (e.g., ptah-agent on Win11 VM pre-daemon-deploy). |
| **SSE-stream-stale pill** (CP12.x.4) | AgentCard head (when fired) | Red-family pill rendered when server-side derived `sse_stream_stale` is true: heartbeat fresh AND cursor hasn't advanced >5min AND cluster traffic is flowing. Catches the "daemon alive, stream silent-dead" failure mode that left sleuth's events.ndjson frozen ~21h (sleuth #8532 + admin #8534/#8536 forensic). Distinct from Monitor-dead (subprocess) and stalled (no hooks). Detection refinements LANDED: CP12.x.4.1 (silent-dead-on-arrival conjunct + class field internal) + CP12.x.4.2 (filter-aware low_traffic_likely_healthy suppression) + **CP12.x.4.3 session-state-aware predicate** (`SESSION_STATES_NOT_CONSUMING = {idle, stop_failure, unknown}` excluded from stale=true; emits `sse_stream_stale_class='session_inactive_expected'` for those rows — addresses ~78%-of-stale false-positive on operator-idle CC seats per parch canonical `c5b331c`). v0.5.64 Step 3 ship hardens the underlying server-side connection-keepalive path via Fix A (keepalive-immediate at connect) + Fix B (socket.setNoDelay) per ADR-0031 v1.1. |
| **🎨 colors legend** | Channels-tab sidebar | Modal listing every agent → assigned color (name + hex + rgb), search by agent_id or color name, click row to copy hex |
| **🔔 Alerts bell** | header strip (CP10.1) | Client-only, never crosses to bus. 4 predicates: `stop_failure` (high), `quota_exhausted` (medium with blocked-until countdown), cost-spike (≥ 2× 7d mean), registration-stuck (PENDING_FERRY > 24h / PENDING_ACTIVATION > 48h). Browser tab title gets `(N)` prefix for unfocused visibility. Click → jump to AgentCard with flash highlight. Dedupe by `(type, agent_id)`; auto-resolve on next poll when predicate goes false |
| **Filter chips** | Live tab + Cost tab | Filter by runtime / status / OTel-emitting / has-DMs |
| **Update-available pill** | each AgentCard | Compares reported `daemon_version` to manifest canonical version; clears when agent upgrades |
| **Anomaly highlighting** | Cost tab Anomaly sub-view (CP11.4) | Client-side scan: today's cost-center cost vs prior-6d mean; flag when ratio ≥ 2× |
| **Stale-idle visual decay** (v0.5.57 F4 / Jon-direct 2026-06-14) | AgentCard label-badge + tooltip | Claude Code agents fire `Stop` on rate-limit, which the daemon writes as `session_state=idle` (sticky terminal per v0.5.2 design). Without a hint, a rate-limited CC session stays online_idle (green) until the next session-start event, sometimes hours. v0.5.57 added a presentation-layer dim+italic on the label-badge plus a "(stale)" suffix when `last_hook_at` is > 30 min ago. Server-side label is preserved; honest dashboard-only hint. v0.5.57 initial ship also flipped the border-left to yellow, which collided with the `runtime_state=quota_exhausted` yellow signal (gemini-cli Google quota, codex-cli OpenAI quota). v0.5.63 (Jon-direct 2026-06-16) drops the border flip; label-badge dim treatment retained. Border-left now stays at status-derived color exclusively. |
| **Per-vendor cost columns** (v0.5.55 CP11.x.2 / Jon-direct 2026-06-13) | Cost tab + Detail sub-tab | Per-vendor (anthropic / google / openai) columns + additive UX section. Multi-runtime token aggregation at v0.5.58 (CP11.x.1) ensures gemini-cli + codex-cli token-rate panels populate correctly under the same rollup logic CC had had since CP11. |

### 2.4 Cost-tab three-lens UX (ADR-0029 / CP11.4-7)

The Cost tab implements a CFO-tier three-lens architecture. The audience-tier is **finance/IT-governance**, not engineering-ops (the prior `$/hr` view is preserved under the Detail sub-tab).

**Hero strip — 4 KPI tiles** (60s auto-refresh):

| Tile | Source | Default state |
|---|---|---|
| **Burn-vs-Budget** | `/cost/burn-vs-budget?cost_center=&period_kind=monthly` | Threshold-colored (green/warn/at/over) when cluster-cap set; "no-budget" when unset. Shows `actual / budget` + % consumed + days-of-runway. |
| **Run-rate / Projected EOM** | `/cost/projection?period=eom` | Linear basis only (no scenario / counterfactual / CI per anti-feature §8). Basis-label explicit: "Linear projection from last N days". |
| **Top cost-centers · 7d** | `/cost/daily?from=...&to=...&by=cost_center` | Top-3 cost-centers by spend over last 7d (CFO-tier default per ADR-0029 v2.3 §Hero strip). |
| **MTD** | `/cost/summary?period=mtd` | Calendar-UTC month-to-date total. |

**Per-vendor totals strip** (CP11.x.2 / Jon-direct 2026-06-13) — additive row between hero and sub-nav, refreshed at 60s cadence alongside hero:

| Card | Source | Behavior |
|---|---|---|
| **Anthropic** | `/cost/by-vendor?period=mtd` filtered to `vendor=Anthropic` | Branded swatch (orange) + total USD + share % + agent count. Muted (.is-zero class) when zero spend. |
| **OpenAI** | same endpoint, filtered to `vendor=OpenAI` | Teal-green swatch. Lights up automatically when codex token-emitters land canonical metrics (aieng3 codex emitter live per #8545). |
| **Google** | same endpoint, filtered to `vendor=Google` | Blue swatch. Lights up when gemini-cli token-emitter lands canonical metrics (gemini #8524 schema). |

Cluster-total appears in the strip header as `Spend by vendor · MTD: $X,XXX.XX`. Vendor derived server-side at insert via `vendorOf(model)`: `claude-*` → Anthropic / `gemini-*` → Google / `gpt-*` / `codex-*` / `o[1-4]-*` → OpenAI / else → Other. Composition lens also accepts `by=vendor` for drill-down breakdown table.

**Six sub-tabs**:

| Sub-tab | Content | API surface |
|---|---|---|
| **Pace** | Cluster envelope card (actual / budget / % consumed / runway / daily burn / projected EOP / threshold state) + projection card + per-cost-center MTD table (with budget overlay where set). | `/cost/burn-vs-budget`, `/cost/projection`, `/cost/by-cost-center` |
| **Composition** | Period selector (today / 7d / 30d / 90d / mtd / ytd / last_month / lifetime) + group-by selector (`cost_center` default; also `agent_id` / `project_tag` / `environment_tier` / `model` / `user_email` / `organization_id`) → grouped table with cost + token-type breakdown (in/out/cache). 100-row cap. | `/cost/summary`, `/cost/daily` |
| **Anomaly** | Client-side scan: per cost-center, ratio of today's cost vs prior 6-day mean. Flagged when ratio ≥ 2×. Sorted descending by ratio. Silent when no anomalies. | `/cost/summary`, `/cost/daily` |
| **Detail** | Legacy CostView relocated unchanged — per-dimension cumulative table with `$/hr now` column + bar visualization + time-window selector. Engineering-ops audience-tier preserved here. | Prom templated queries (CP6.1) |
| **Reconcile** | Ops-key gated form (period start / end / invoice label / invoice total USD) → POST `/ops/cost/reconcile` returns plexus_total + delta + delta_pct + concentration analysis. Append-only audit lane in `cost_reconciliation`. Period CSV export button (anthropic-invoice schema). | `/ops/cost/reconcile`, `/cost/export` |
| **Budgets** | Ops-key gated. Add/update budget form (cost_center + period_kind + period_anchor + budget_usd) + tag-agent form (agent_id ↔ cost_center / project_tag / environment_tier / billable_flag). Per-cost-center live list with threshold state. **R4 divergence banner**: cluster-cap vs sum-of-N-CC-envelopes with match/slack/overage badge — pre-empts operator-confusion at first budget-rollout. | `/ops/cost/budget`, `/ops/cost/dimension-tag`, `/cost/by-cost-center`, `/cost/burn-vs-budget` |

**Ops-key UX**: prompt-once → localStorage (never sent to bus); per-banner "clear stored ops-key" button.

**Anti-features deliberately omitted** (ADR-0029 §8): no sankey diagrams, no AI-generated narrative, no sub-penny precision, no cost-per-business-outcome rollups, no multi-currency, no scenario/counterfactual/CI surfaces. Linear-only projection with explicit basis-labeling.

### 2.5 Audit-tab three-lens UX (ADR-0030 v1.2 RATIFIED / CP12.1-20)

The Audit tab implements a GRC-tier three-lens architecture mirroring the Cost-tab shape. The audience-tier is **finance/IT-governance + compliance/risk officer**, not engineering-ops (the legacy DM-audit-log reader is preserved under the Detail sub-tab).

**Hero strip — 4 GRC-tier KPI tiles** (60s auto-refresh):

| Tile | Source | Default state |
|---|---|---|
| **Open policy violations** | `/policy/violations?disposition=pending` | Severity-grouped (critical / violation / warn / info); tile color = top-severity present. Clean when zero. |
| **Coverage gaps** | `/policy/divergence` + `/audit/coverage-gap` | `N policies codified / M agents genuine-gap` — load-bearing GRC governance indicator. Per CP12.9: enrichment classifies missing agents by disposition (alias_of / different_runtime / inactive / genuine_gap) so the headline reads "genuine instrumentation gaps" not "raw missing count". 7 rules codified per CP12.18 + parch #8012 Jon-ratified Option (d). |
| **Recent high-risk events · 24h** | `/audit/anomaly-detail` | Top-3 anomalous agents by policy_violation_count over last 24h. |
| **Attestation status** | `/audit/by-control-area?control_framework=soc2&period=mtd` | SOC2 control-area completeness rollup. Per CP12.10: governance-tier `audit_attestation` substrate wires CC1/CC2/CC9 → 6/6 substrate-wired. Sub-label surfaces both `substrate-wired` AND `producing events` ratios so attestation-cadence health is visible alongside coverage. |

**Six sub-tabs** (Incident default; mirrors ADR-0029 Pace-default precedent — highest-pressure use case as the landing surface):

| Sub-tab | Content | API surface |
|---|---|---|
| **Incident** | Pending policy_violations list (server-side R-A2 sort: pending-first → severity DESC → occurred_at DESC) + event_id lookup with drill-through to `/audit/event/:event_id`. Highest-pressure case-driven workflow. | `/policy/violations`, `/audit/event/:id` |
| **Review** | Coverage-gap banner (bizmodel R-A3) + dim picker defaults `control_area` (R-A1; switchable to `agent_id` / `policy_rule` / `cost_center`-honest-Phase-2-hedge) + 4-card aggregate grid (activity register / violation register / credential-rotation / permission-change). Cadence-driven periodic-review workflow. | `/audit/tool-invocations`, `/audit/credential-changes`, `/audit/permission-changes`, `/audit/coverage-gap`, `/audit/by-control-area`, `/policy/violations` |
| **Attest** | Framework picker (SOC2 / ISO27001 / GDPR) → control-area browser with audit-class chips → evidence-bundle export button → **Chain integrity card** (CP12.20): 30-day grid showing per-day anchor verify status (🟢 match / 🔴 TAMPER / ⬜ no anchor), click-to-drill into full digest comparison. SOC2 default (highest-leverage external-auditor framework). | `/audit/by-control-area`, `/audit/export?schema=...`, `/audit/anchors`, `/audit/anchor/:day`, `/audit/anchor-verify` |
| **Policies** | Ops-key gated. Rule list (status-colored: draft yellow / active green / deprecated muted) + add/edit form with save-as-draft + save-and-ratify in one flow. DSL hint references secops #7706 sandbox spec. | `/policy/rules`, `/ops/policy/rule`, `/ops/policy/rule/:id/ratify`, `/ops/policy/rule/:id/deprecate` |
| **Reconcile** | Ops-key gated form (period + external-system-label + plexus/external counts + reconciler_agent_id) → POST `/ops/audit/reconcile` → result banner with delta + delta_pct. Mirror of cost-reconcile shape. | `/ops/audit/reconcile` |
| **Detail** | Legacy DM-audit-log reader (CP8.2) relocated verbatim — banner + filter row (sender / recipient / msg-id / ops-key id) + reveal-body modal. Engineering-ops audience-tier preserved. | `/dm-audit` |

**Ops-key UX**: shared with cost-tab — prompt-once → localStorage (never sent to bus); per-banner "clear stored ops-key" button. The auth-header-exclusion middleware redacts Authorization to `Bearer sha256:<prefix>` BEFORE morgan / OTel-raw-body-logging surfaces capture it (admin R1 mandatory pre-ship per `feedback_admin_session_otel_secret_leak`).

**Sandboxed policy DSL** (Policies sub-tab; secops #7706 spec): operators `==`, `!=`, `<`, `>`, `<=`, `>=`, `contains`, `startsWith`, `endsWith`, `IN`, `NOT IN`, `IS NULL`, `IS NOT NULL`, `AND`, `OR`, `NOT`. Case-insensitive SQL-style keywords. **No regex** (catastrophic-backtrack DoS vector — substitute with contains/startsWith/endsWith). 100ms deadline-check per evaluation between AST nodes; 1MB memory cap heuristic; prohibited tokens reject-at-parse (`eval`, dynamic-function constructors, `process`, `require`, `__proto__`, `constructor`, `prototype`). Hand-rolled Pratt-style parser; the evaluator does not invoke any JavaScript dynamic-code primitives — no `eval`, no Function constructor, no `vm.runInNewContext`.

**Anti-features deliberately omitted** (ADR-0030 §8, 10 items): no AI-generated compliance narrative, no automated GDPR DSAR fulfillment, no auto-triage on risk score, no closed-form policy-violation severity scoring, no real-time enforcement actions, no risk-score-driven UI prioritization, no free-text NLP search on audit log, ~~no audit-log integrity self-attestation~~ (RESOLVED by Phase 3 (A) external-anchor per ADR-0030 v1.2 — `audit_anchor` table + S3 Object Lock + Reading-2 verify; CISO-audience tamper-detection now operational), no retention bypass for "operational reasons", no auto-fix on external-system reconciliation.

### 2.6 Effort-tab three-lens UX (ADR-0032 CP13 Phase 1 + CP13.6 Phase 2)

The Effort tab implements a three-lens value-mapping architecture mirroring the Cost-tab + Audit-tab shape. The audience-tier default is **buyer** (per s345 #9234 Criterion 5 — externally-facing valuation surface); practitioner + investor renders available via picker. Substrate: bare-git walker over `/srv/git/*.git` (Phase 1 `output_commit` + `output_merge` + `output_ingester_cursor`) + GitHubWalker over enrolled GitHub repos (CP13.6 Phase 2 `output_pr` + `output_pr_cursor` + `output_repo`).

**Three orthogonal axes**:
- **Lens** (data-slicing axis): Pace / Composition / Anomaly — sister-shape to Cost-tab Pace/Composition/Anomaly
- **Audience-tier** (render axis): Buyer (default) / Practitioner / Investor
- **Period** (Composition + Pace selector): 7d / 30d (default) / 90d

**Hero strip — 9 tiles + buyer-banner** (CP13.6 Phase 2.4):

| Tile | Tier class | Source |
|---|---|---|
| **Coverage gap** | `cross-tier-safe` | `/output/coverage-gap` `null_fallback_pct` |
| **$ / merge-commit (P1)** | `tile-investor-plus` | `dollar_per_merged_pr` (bare-git denominator) |
| **$ / PR-merged (P2)** | `tile-investor-plus` | `dollar_per_pr_merged` (GitHub-PR denominator) |
| **$ / agent-cycle** | `tile-investor-plus` | `dollar_per_agent_cycle` (cost ÷ commits) |
| **PR merge-rate** | `tile-investor-plus` | `pr_merge_rate` (cohort: opened → merged) — `XX.X%` |
| **Time-to-merge** | `tile-investor-plus` | `time_to_merge_hours` (p50; adaptive m/h/d format) |
| **Coord-msgs / merged-PR** | `practitioner-only` | `coord_messages_per_merged_pr` (activity-numerator) |
| **Tool-invocations / merged-PR** | `practitioner-only` | `tool_invocations_per_merged_pr` |
| **Agents-engaged / merged-PR** | `practitioner-only` | `agents_engaged_per_merged_pr` |

Substrate-honest sub-text per tile shows the denominator (cohort size + sample N + PR-merge count) so the operator sees what the ratio is actually computed over.

**Buyer-tier Fold-B canon (CP13.6 Phase 2.3 correction)**: Buyer audience sees **no output-strand ratios** — only Coverage gap (substrate-honesty signal) + an `.effort-buyer-banner` explaining the Fold-B scope (buyer-narrative load-bearing on AUDIT substrate per Fold-B; internal velocity/cost is inside-baseball + self-incriminating per s345 banked `feedback_activity_metrics_no_marketing_value`). Investor tier sees 5 cost/value + outcome-rate ratios. Practitioner tier adds the 3 activity-numerator ratios.

**SERVER-SIDE Fold B HARD GATE** (per s345 #9234 §5.6, `src/outputRatios.js` `filterRatiosByAudience`): the tier-strip is enforced server-side regardless of client request. Defense-in-depth: UI hides tiles per `.tile-investor-plus` + `.practitioner-only` CSS gates driven by `audience-{buyer,investor,practitioner}` class on `#tab-effort`. The set `PRACTITIONER_INVESTOR_RATIOS` replaced the retired `CROSS_TIER_SAFE_RATIOS` set (no ratio is buyer-safe by Phase 2.3 canon).

**Three lenses**:

| Lens | Content | API surface |
|---|---|---|
| **Pace** (default) | Trend over selected period; audience-tier readout. | `/output/ratios?period=&audience=` |
| **Composition** | Group-by `agent`/`repo` table — coord_msgs, commits, merges, cost $ per row. Honest per-agent-attribution surface. 100-row cap. | `/output/composition?period=&by=` |
| **Anomaly** | Today's cost vs prior 7d mean; spike threshold 2× default. | `/output/anomalies?lookback_days=&threshold=` |

**8-ratio family substrate-coverage** (Phase 2.3 additive ratio per Q4 Option C — `dollar_per_pr_merged` is additive sister to `dollar_per_merged_pr`; preserves divergence-from-Phase-1 at substrate-honest tier):
- Phase 1 (bare-git denominator): `dollar_per_merged_pr`, `dollar_per_agent_cycle`, `coord_messages_per_merged_pr`, `tool_invocations_per_merged_pr`, `agents_engaged_per_merged_pr`
- Phase 2.3 (output_pr denominator via GitHubWalker): `pr_merge_rate` (cohort-based; ≤ 1.0 by-construction), `time_to_merge_hours` (p50 median via SQLite `ROW_NUMBER + COUNT OVER ()` — no native MEDIAN), `dollar_per_pr_merged`

**Phase 2 ratios may return NULL on live deploy** even though substrate is fully functional — current data-density is one enrolled repo (`jrtorrez31337/yaklog`) + few PRs outside 30d window. Distinction per ssw-devops #9899 framing: substrate-correctness is structural (computation honest when data present); data-density is operator/policy concern (more repos enrolled + new PR-flow → ratios populate).

**Per-agent attribution** (Phase 0 Item C + 2026-06-20 per-agent refactor): `parseCoAuthoredBy` resolves SPECIFIC agent_id from email/name BEFORE collapsing to runtime class. Parser ordering: `co_authored_by` → `author_email_direct` → `body_pattern` → `null_fallback`. `EMAIL_TO_AGENT_ID` reverse-index in `src/agentRuntimes.js` covers canonical email/agent_id mappings (post-`28adc8a` 4 entries `aieng-*@*` redirect to `s345-aieng-agent` per Jon-direct #7894 rename + ssw-devops #10001 stale-binding-removal coord; preserves attribution-by-current-identity for historical commits). `agentIdByName` resolver handles `<stem>-agent` naming convention.

**Anti-features deliberately omitted** (ADR-0032 §8 + CP13.6 Phase 2.1 Q3 unanimous-quorum): `output_pr_review` table DELIBERATELY DROPPED (semantic-class-2 quality-measurement anti-feature per ADR-0032 §8); no quality-judgment ratios (test-coverage-per-PR, defect-rate); no AI-narrative summaries; no per-agent value-judgment renders.

---

## 3. Server (yaklog → Plexus)

### 3.1 Bus + messages

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/messages` | List messages, optional `?channel=X&limit=N&after_id=N&before_id=N`. DM-filter applied based on requester auth. |
| `POST /api/v1/messages` | Post a message. Sender binding enforced; `private:true` flag opt-in for DMs (ADR-0026). MAX body 1.44MB ("floppy"). |
| `GET /api/v1/stream` | SSE live stream. Filters: `?channel=X` (singular, back-compat), `?channels=foo,bar` (CSV plural, set membership — v0.5.10), `?exclude_sender=X`, `?mention=X,Y,Z`, `?since=N` (resume), `?min_quiet_ms=N` (coalescing). |
| `GET /api/v1/channels` | List all channels with `message_count`, `latest_id`, `last_message_at`. |
| `GET /api/v1/messages/:id` | Fetch a single message including private (with audit-write for ops-key/dashboard reveal). |
| `PATCH /api/v1/messages/:id`, `DELETE /api/v1/messages/:id` | Edit / delete (sender binding enforced). |

### 3.2 Presence

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/presence/event` | Daemon heartbeat. Daemon-binding enforced (sender must match agent_id). Accepts presence fields: `daemon_state`, `session_state`, `cursor_position`, `lock_held`, `sse_connected`, `events_consumer_count`, plus v0.5.7 runtime-meta (current_model / current_tool / last_tool_status / etc), v0.5.7.3 runtime-env (uid/gid/hostname/cwd), v0.5.7.4 daemon-process (pid/version/started_at), v0.5.9 runtime-execution-liveness (`runtime_state`, `runtime_blocked_until`), **v0.5.54 runtime-class** (`runtime` — CC/Codex/Gemini enum; server-side computed via `runtimeOf(agent_id)` registry fallback when caller omits; CP12.x.3 substrate), **v0.5.56 SSE-stale tracking** (`last_cursor_advance_at` — ISO-8601 of last cursor_position increment; written when cursor advances; CP12.x.4 substrate). `session_state` enum: `'active' / 'idle' / 'unknown' / 'tool_running' / 'idle_between_tools' / 'compacting' / 'stop_failure'` plus **CP14.x Task #174 `'in_flight'`** (long-running CLI runtime; SHIPPED `yaklog@9c55a57` 2026-06-26; distinct from short-duration `tool_running`; PRESENCE_LABELS maps up.in_flight → `online_in_flight` sister-shape `online_tool_running` green-canon). |
| `GET /api/v1/presence/public` | Returns presence rows enriched with: `update_available` (v0.5.7.4 manifest comparison), `canonical_daemon_version`, **`runtime`** (DB-stored or registry fallback per CP12.x.3), **`sse_stream_stale`** (server-side derived: hbAgeMs<90s AND cursorAgeMs>5min AND cursorLag>=3; CP12.x.4 detection; refined by CP12.x.4.1 silent-dead-on-arrival conjunct + CP12.x.4.2 filter-aware low_traffic_likely_healthy suppression + CP12.x.4.3 session-state-aware predicate excluding `SESSION_STATES_NOT_CONSUMING={idle,stop_failure,unknown}` with `sse_stream_stale_class='session_inactive_expected'` carve-out). **CP14.1 pre-emission union**: server-side appends synthetic placeholder rows for token-bound agents (per `tokenBindings`+`daemonBindings` group dedupe) absent from `presence`, marked `pre_emission: true` + `label='pre_emission'`. |
| `GET /api/v1/presence` | Full swarm snapshot + per-agent labels (derived from daemon_state + session_state + events_consumer_count). ETag-supported. |
| `GET /api/v1/plexus/public/cost/by-vendor` | CP11.x.2 — per-vendor cost summary: `{vendor, cost_usd, share_pct, tokens_*, row_count, agent_count}`. Defaults to mtd. Powers Cost-tab per-vendor totals strip. |
| `GET /api/v1/plexus/public/cost/by-vendor-daily` | CP11.x.2 — per-vendor daily time-series for future stacked-area chart. Defaults to last 30d. Returns `{date, vendor, cost_usd}`. |
| `GET /api/v1/presence/:agent_id` | Single agent presence + transitions history. |
| `DELETE /api/v1/presence/:agent_id` | Ops-key gated; removes a presence row (decommission flow). |

### 3.3 Activity (CP10.3)

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/agents/:agent_id/activity` | Daemon-bound batch insert of distilled hook events. Batch ≤100, per-entry payload ≤4KB serialized. Trims per-agent to last 200 on insert. |
| `GET /api/v1/agents/:agent_id/activity` | Authed read of activity stream, newest-first, limit 1-200. |
| `GET /api/v1/plexus/public/activity?agent_id=X&limit=N` | Public mirror (network-isolation trust). Dashboard's Trace view reads this. |

### 3.4 DMs (ADR-0026)

Server delivery-isolation. Plaintext-on-disk (no E2E in Phase 1 — auditable for the operator). Daemon writes stub-only to `events.ndjson` for `private:true` messages; bodies fetched via `yaklog-dm-fetch` CLI (ops-key or recipient token). Ops-key reads write to NDJSON audit log at `/var/log/yaklog/dm-audit.ndjson`.

### 3.5 Registration (ADR-0025)

State machine: `NEW → SUBMITTED → PARCH_REVIEW → JON_RATIFY → APPROVED_PENDING_FERRY → FERRIED → PENDING_ACTIVATION → ACTIVE`. Token mint at JON_RATIFY; ferry to remote host (parch on traptop10k) at APPROVED_PENDING_FERRY; activation completes at PENDING_ACTIVATION → ACTIVE. Audit-event log records every state transition with sha256-prefix forensic markers (never full secrets at-rest).

### 3.6 Update + cascade (CP7 + CP10.4)

| Endpoint | Purpose |
|---|---|
| `GET /update` | HTML page rendering the canonical artifact manifest (cards per artifact with install commands) |
| `GET /api/v1/update/manifest` | JSON manifest. Computes sha256 lazily per request from bare-git canonical for cascade-upgrade-eligible artifacts |
| `GET /api/v1/update/artifact/:name` | Whitelisted artifact-content streaming from `/srv/git/agent-tooling.git` via `git show HEAD:<path>`. Sets `X-Artifact-SHA256` header. Used by daemons with `YAKLOG_AUTO_UPDATE=1` to verify before atomic-swap. |

### 3.7 Plexus telemetry endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/plexus/public/query` | Prom instant query proxy (allowlist on template names + cache) |
| `GET /api/v1/plexus/public/query_range` | Prom range query proxy (same allowlist) |
| `GET /api/v1/plexus/public/templates` | Lists available query templates |
| `GET /api/v1/plexus/public/stream` | SSE push of cost + token metrics for the dashboard Live tab |
| `GET /ops/stream/stats` (v0.5.59+; ops-key gated) | Per-agent SSE stream lifecycle counters: open_count, current_active_count, close_count_by_reason (client_close / error / select_timeout / server_close / arrival_silent / recovery_stall), replay_rows_histogram, replay_ms_p50/p99, first_byte_ms_p50/p99, keepalive_count_total, events_dispatched_total, filter_match_count_total, duration_s_p50/p99, last_event_dispatched_at + last_keepalive_at (v0.5.63+ live timestamps), low_traffic_likely_healthy flag (#182 false-positive suppression). Surfaced for CP12.x.4 Layer-1 empirical anchor cycles. Per-agent stat reset on server boot. |

### 3.8 Cost accounting (ADR-0029 / CP11.x)

Cost persistence in SQLite: Prom is live-tail (~15d retention) but financial truth lives in `cost_daily` rolled up nightly + intraday. Three lenses (Pace / Composition / Anomaly) + reconcile + budgets per ratified ADR-0029 v2.3.

#### 3.8.1 Substrate (4 tables, `src/db.js`)

| Table | Purpose |
|---|---|
| **`cost_daily`** | One row per (date, agent_id, user_email, organization_id, model, host, cost_center, project_tag, environment_tier, billable_flag). Stores `cost_usd` + token counts (input/output/cache_read/cache_creation). Unique index on the full dim-tuple. |
| **`cost_dimension_tags`** | Operator-controlled mapping of `agent_id` → `(cost_center, project_tag, environment_tier, billable_flag)`. UPSERTed during rollup to enrich telemetry-derived rows. |
| **`cost_budgets`** | Per-`(cost_center, period_kind, period_anchor)` envelope. `period_kind` ∈ {monthly, quarterly}; `period_anchor` like `2026-06` or `2026-Q3`. Empty `cost_center` = cluster-cap envelope. |
| **`cost_reconciliation`** | Append-only audit lane. One row per reconciliation submission (period_start, period_end, invoice_label, invoice_total_usd, plexus_total_usd, delta_usd, delta_pct, concentration analysis, ops-key audit id). |

Helpers exposed: `upsertCostDaily`, `getCostByPeriod`, `upsertCostDimensionTags`, `getCostDimensionTags`, `upsertCostBudget`, `getCostBudgets`, `insertCostReconciliation`, `listCostReconciliations`.

#### 3.8.2 Rollup scheduler (`src/costRollup.js`)

| Schedule | Coverage |
|---|---|
| Boot (5s after start) | One-shot 15-day backfill |
| Nightly (00:30 UTC) | Roll up yesterday |
| Intraday (every 1h) | Roll up today (continuous incremental update) |

Disable via `NODE_ENV='test'` or `YAKLOG_COST_ROLLUP_DISABLED='1'`. Per-day window logic: TODAY uses elapsed-since-midnight; PAST uses full 24h with offset; CUSTOM is caller-provided. Token-type map default-deny on unknown types.

#### 3.8.3 Public read endpoints (`src/plexusRoutes.js`)

All under `/api/v1/plexus/public/cost/*`, network-isolation trust (no per-request auth in v1).

| Endpoint | Purpose |
|---|---|
| `GET /cost/summary?period=<named>` | Single-number aggregate. Named periods: today / 7d / 30d / 90d / mtd / qtd / ytd / last_month / last_month_to_date / last_year / lifetime + fiscal-mtd / fiscal-qtd / fiscal-ytd (fiscal-year start configured via `YAKLOG_FISCAL_YEAR_START_MONTH` env, default 1). Returns `{period, from, to, label, value_usd, source: 'persisted', computed_at}`. |
| `GET /cost/daily?from=&to=&by=<dim>[,date]` | Grouped breakdown over the date range. `by` accepts any cost_daily dim, optionally with `,date` for time-series. |
| `GET /cost/projection?period=<eom|eoq|eoy|fiscal-*>` | Linear projection from a basis-window. Returns `{projected_usd, current_usd, basis_days, basis_avg_per_day, basis_label, period_start, period_end}`. Basis-label is always explicit (no hidden assumptions). |
| `GET /cost/compare?period_a=&period_b=` | Side-by-side period comparison with delta + delta_pct. |
| `GET /cost/burn-vs-budget?cost_center=&period_kind=monthly` | Joins cost_daily + cost_budgets. Returns `{actual_usd, budget_usd, pct_consumed, threshold_state (green/warn/at/over/no-budget), days_of_runway, daily_burn_usd, projected_eop_usd}`. Empty cost_center = cluster envelope. |
| `GET /cost/by-cost-center?period=&period_kind=` | All cost-centers' actual vs budget for the period; threshold state per row. |
| `GET /cost/by-api-key` | Group by `user_email` (Anthropic account); used for cost-allocation across paying accounts. |
| `GET /cost/anomaly-detail` | Per-dim today vs prior-N-day-mean ratio (server-side variant of the Anomaly sub-view scan). |
| `GET /cost/export?format=csv&schema=anthropic-invoice&period=...` | CSV export with anthropic-invoice schema. Deeper schema variants remain optional per ADR-0029 §8. |

#### 3.8.4 Ops-key gated mutation endpoints (`src/routes.js`)

`Authorization: Bearer <ops-key>` required; `YAKLOG_OPS_API_KEYS` env.

| Endpoint | Purpose |
|---|---|
| `PUT /api/v1/ops/cost/dimension-tag` | UPSERT a row in `cost_dimension_tags` (agent_id ↔ cost_center / project_tag / environment_tier / billable_flag). |
| `PUT /api/v1/ops/cost/budget` | UPSERT a row in `cost_budgets` (cost_center, period_kind, period_anchor, budget_usd). Empty cost_center = cluster-cap. |
| `POST /api/v1/ops/cost/reconcile` | Submit an invoice for reconciliation. Computes `plexus_total_usd` for the period, `delta_usd`, `delta_pct`, concentration analysis. Writes append-only row to `cost_reconciliation` with sha256-prefix audit id. |
| `POST /api/v1/ops/cost/rollup` | Manual re-rollup trigger for a specific date (debug/ops escape valve). |

Test coverage: 23 (costPersistence) + 12 (costRollup, mocked-fetch) + 29 (costApi) = 64 tests, all green.

### 3.9 Audit + governance (ADR-0030 v1.2 RATIFIED / CP12.x)

GRC substrate per ratified ADR-0030 v1.2 (parch landing-eval ratify 2026-06-07; v1.1 jon-ratify 2026-06-04). 12 new tables + ~35 helpers + sandboxed policy-DSL evaluator + ops-key auth-header exclusion middleware + 25 public read + 11 ops-key gated mutation endpoints + 2 host-side scanner scripts (permission-change + channel-subscription) + 1 anchor-publisher cron driver. **Three load-bearing architectural choices**: split substrate (SQLite + external integrity anchor per Phase 3 (A)), three-lens dashboard organization (Incident / Review / Attest), policy-as-code substrate as the GRC contribution that shifts cluster canon from tribal to codified. **Phase 3 (A) external integrity anchor SHIPPED at CP12.12 + CP12.12.1 + CP12.20**: S3 Object Lock baseline + Reading-2 semantic verify + dashboard Chain integrity card — chain-tamper-detection operational in live clusters.

#### 3.9.1 Substrate (12 tables, `src/db.js`)

| Table | Purpose |
|---|---|
| **`audit_tool_invocation`** | Incident-response load-bearing. One row per tool invocation event (pre / post / failure phases) with forensic chain-of-custody hashes (full 64-char sha256 on input_digest / output_digest per secops R3). Populated from `agent_activity` via DRY-augment ingester pattern. |
| **`audit_file_access`** | Phase 1 schema; ingester is Phase 1.5 substrate-coord (auditd vs eBPF — kernel-version >>5.0 on both nodes per admin #7701). Includes `attribution_confidence` ∈ {`uid_unique`, `uid_shared`} + `session_correlator` columns for jon-uid co-residency on traptop10k (admin R5 / secops F1 fold). |
| **`audit_credential_change`** | §71-class rotations + ops-key changes; sha256-prefix only (never the secret per secrets-discipline-no-yaklog). **CP12.7 ingester scope** (CP12.x.1 bench-confirm 2026-06-13; secops #8664 + #8666 review-pair; parch #8690 RATIFY): Phase A captures `/register` endpoint mutations at mutation time; Phase B env-diff boot detector captures operator-class `.env` mutations at next yaklog server boot (snapshot rolls forward each boot, diff emits audit rows). **Canonical operational invariant**: Operators MUST pair `.env` credential mutations with a server restart in the same ship cycle. The env-diff boot detector captures mutations on next restart; a mutation reverted before restart will not be captured. This invariant is a required operational control for CP12.7 Phase B coverage. CP12.7 Phase C (file-watcher on `.env`; eliminates the temporal lag) SHIPPED in v0.5.64 Step 3 bundle (#184 completed). |
| **`audit_permission_change`** | settings.local.json / agent-specs.git / systemd overrides / authorized_keys / gh hosts (Phase 2 source-coverage expansion per admin R4). |
| **`policy_rule`** | Policy-as-code DSL substrate (rule_id PRIMARY KEY + name + description + applicability_json + predicate_dsl + severity_class ∈ {info, warn, violation, critical} + status ∈ {draft, active, deprecated} + current_version). Version bumps only on predicate_dsl change. |
| **`policy_violation`** | Enforcement-observation log. disposition lifecycle: `pending` → `acknowledged` / `remediated` / `accepted-with-rationale` / `suppressed`. List query default-sort: pending-first → severity DESC → occurred_at DESC (bizmodel R-A2). |
| **`audit_reconciliation`** | Mirror of `cost_reconciliation`. admin R3 fold adds `reconciler_agent_id` (stable identity column) so identity continuity survives ops-key rotations; `reconciled_by` stays pure forensic ops-key-at-time marker. **CP12.16**: `reconcile_class` column added with canonical vocab `{grc-platform, soc-tool, siem, internal-export, other}`; live-sync integrations correctly trigger-gated per Non-goals. |
| **`audit_payload_store`** | Separate deletable BLOB store per secops F2. `payload_ref` UUID is FK from audit tables. Atomic SQLite txn wraps payload-delete + tombstone_at-set + meta-audit-row insertion (admin R2). |
| **`subject_directory`** | GDPR hash-at-ingestion per bizmodel #7697 OQ#4 amendment. Only place cleartext user_email lives; right-to-be-forgotten is single-row `tombstoneSubject` deletion (severs cleartext correlation; audit tables retain `subject_hash` so hash-chain integrity preserved). Avoids compounding-PII problem (1 row vs touching 7 tables per DSAR). |
| **`audit_attestation`** | **CP12.10 Phase 1-augmentation governance-tier substrate** for SOC 2 CC1 (Control Environment) / CC2 (Communication & Information) / CC9 (Risk Mitigation). Operator-authored attestation rows (org-chart review / comm-policy refresh / risk-register review). Distinct from event-stream tables: no machine-emitted rows. Lifts Attestation status tile substrate-wired ratio 3/6 → 6/6. |
| **`audit_channel_subscription_change`** | **CP12.15 Phase 2** per-user channel subscription history. Source: per-user `~/.config/yaklog/channels` CSV. `change_type ∈ subscribe|unsubscribe`. Wires to SOC 2 CC6 + ISO 27001 A.9 (access-control) + SOC 2 CC2 per CP12.A enrichment (communication infrastructure). Ingester: `scripts/channel-subscription-scanner.sh` (scan-with-diff + ops-gated `POST /audit/channel-subscription/scan`). |
| **`audit_anchor`** | **CP12.12 Phase 3 (A) external integrity anchor substrate** per ADR-0030 v1.2 parch ratify (S3 Object Lock baseline + daily cadence + 7y retention + dual-publish 12mo forward-track). **CP12.21.1 hosting flip** (Jon-direct 2026-06-09 "we are not a cloud consumer in our biz narrative"): substrate changed from AWS S3 to local MinIO on devel (S3-compatible API; same Object Lock Compliance semantic). Substrate-canon stays "S3-compatible Object Lock" — only hosting target flipped. Cluster-self-substrate-canon-aligned (zero cloud dependency by default; AWS S3 deployment remains supported via `--endpoint-url` aws-cli pattern). One row per published daily hash digest. `UNIQUE(anchor_day, anchor_substrate)` permits dual-publish across substrates. Verify uses Reading-2 semantic (CP12.12.1): recomputes over events ≤ stored high-water → `match:true` reproducible indefinitely; `match:false` is unambiguous tamper signal. Cron-driver: `scripts/audit-anchor-publisher.sh` (supports `--endpoint-url` flag for local-MinIO or alternative-S3-compatible substrates). |

Helpers exposed (~35+): `computeAuditEventId` (hash-chain formula `sha256(prev_event_id || occurred_at || agent_id || action_class || metadata_only)[0:16]` per admin R2; `metadata_only` EXCLUDES `payload_ref` for Phase 3 external-anchor compatibility), `subjectHash`, `fullSha256`, `insertAuditToolInvocation` / `listAuditToolInvocations` / `getAuditToolInvocationByEventId`, `insertAuditFileAccess` / `listAuditFileAccess`, `insertAuditCredentialChange` / `listAuditCredentialChanges`, `insertAuditPermissionChange` / `listAuditPermissionChanges` / `processPermissionScan` / `diffPermissionSources` (CP12.8), `insertAuditAttestation` / `listAuditAttestations` / `ATTESTATION_CONTROL_AREAS` (CP12.10), `insertAuditChannelSubscriptionChange` / `listAuditChannelSubscriptionChanges` / `processChannelSubscriptionScan` / `diffChannelSubscriptions` (CP12.15), `RECONCILE_CLASS_VOCAB` / `aggregateAuditReconciliationsByClass` (CP12.16), `listRegistrationEventsByAgent` / `aggregateRegistrationEventsByAgent` / `aggregateCredentialChanges` (CP12.13 aggregate views), `findMessageIdsReferencingAdr` (CP12.17), `ANCHOR_SUBSTRATE_VOCAB` / `ANCHOR_CHAIN_TABLES` / `computeChainSnapshot` / `computeChainSnapshotAt` / `insertAuditAnchor` / `listAuditAnchors` / `getAuditAnchorByDay` / `verifyAuditAnchor` (CP12.12 + CP12.12.1 Reading-2 semantic), `upsertPolicyRule` / `listPolicyRules` / `getPolicyRule` / `ratifyPolicyRule` / `deprecatePolicyRule`, `insertPolicyViolation` / `listPolicyViolations` / `disposePolicyViolation`, `insertAuditReconciliation` / `listAuditReconciliations`, `insertAuditPayload` / `getAuditPayload` / `tombstoneAuditPayload`, `upsertSubjectDirectory` / `getSubjectByHash` / `tombstoneSubject`.

#### 3.9.2 Sandboxed policy-DSL evaluator (`src/policyDsl.js`)

Per secops #7706 spec + CP12.2.1 alignment. Hand-rolled Pratt-style parser; the evaluator does not invoke any JavaScript dynamic-code primitives. Operators: `==`, `!=`, `<`, `>`, `<=`, `>=`, `contains`, `startsWith`, `endsWith`, `IN [list]`, `NOT IN [list]`, `IS NULL`, `IS NOT NULL`, `AND`, `OR`, `NOT`. Case-insensitive SQL-style keywords. **No regex** (catastrophic-backtrack DoS vector; substitute with contains/startsWith/endsWith).

Sandbox constraints (mandatory pre-ship per ADR-0030 v1.1 §Phase 1 implementation-floor):
- 100ms deadline-check between AST nodes (sync JS can't be interrupted mid-call; deadline-check between nodes is the load-bearing defense)
- 1MB memory cap heuristic (bounds captured-substring length on regex matches; recursion depth ≤ 64)
- Reject-at-parse for prohibited tokens: `eval`, dynamic-function constructors, `process`, `require`, `__proto__`, `constructor`, `prototype`
- Evaluation failure (timeout / parse / out-of-bounds) → `matched: false + error` (caller wraps as `disposition=pending` violation per spec — no silent pass)
- own-property-only path resolution via `Object.prototype.hasOwnProperty.call(...)` (blocks prototype-chain walking)

#### 3.9.3 Ops-key auth-header exclusion middleware (`src/middleware/opsKeyAudit.js`)

Mandatory pre-ship per admin Refinement 1 + `feedback_admin_session_otel_secret_leak`. Wired into `src/app.js` BEFORE morgan (line 71 area). Redacts `Authorization` header value to `Bearer sha256:<16-char-prefix>` so downstream loggers / morgan / OTel-raw-body-logging surfaces see the masked form. Original token survives on `req.rawBearer` for downstream auth middleware (`src/middleware/auth.js` + `src/middleware/opsKey.js` extended with `req.rawBearer ?? extractBearerToken(req)` for backwards-compat).

#### 3.9.4 Public read endpoints (25 under `/api/v1/plexus/public/`)

Network-isolation trust (no per-request auth in v1; mirrors `/cost/*`):

| Endpoint | Purpose |
|---|---|
| `GET /audit/summary?period=<named>` | Aggregate counts per audit-object class. Same period vocabulary as `/cost/summary`. |
| `GET /audit/tool-invocations?from=&to=&agent=&tool=&status=&limit=100` | Tool-invocation events list. Server-side default sort `occurred_at DESC` per R-A2. |
| `GET /audit/file-access?from=&to=&agent=&path_prefix=&limit=100` | File-access events list. |
| `GET /audit/credential-changes?from=&to=&credential_class=&limit=100` | Credential-rotation events list. |
| `GET /audit/permission-changes?from=&to=&agent=&limit=100` | Permission-change events list. |
| `GET /audit/event/:event_id` | Single-event detail with drill-through (`source_event_id` for `agent_activity` drill-back). |
| `GET /audit/agent-timeline?agent=&from=&to=&limit=100` | All audit events for one agent across all 4 object classes, time-sorted DESC. |
| `GET /audit/by-control-area?control_framework=soc2|iso27001|gdpr&period=<named>` | Aggregates by GRC control area. SOC2: CC1-CC9 (all 6 wired post-CP12.10 + CP12.15 + CP12.A); ISO27001: A.5/A.8/A.9/A.12/A.13/A.16/A.18 per ADR-0030 v1.1 expanded subset; GDPR: Art.6/Art.15/Art.17/Art.30. Per-area count filter prevents cross-area inflation (CP12.10). **2026-06-25 perf-fix**: `countsForObjectClasses()` refactored to use 8 new `count*` helpers (SELECT COUNT(*) AS c) instead of `list*({limit: 10000}).length` — by-control-area p99 60s → 3.5s (~17× speedup) on the full audit corpus. CP16 Pillar 3 takes the next-step rollup substrate to <100ms (forward-track). |
| `GET /audit/anomaly-detail?from=&to=` | Per-agent risk-surface scan (Phase 1 heuristic: count of policy_violation matches + tool_invocation + file_access in period; sorted DESC). |
| `GET /audit/coverage-gap` | Bizmodel R-A3 governance indicator. **CP12.9 disposition enrichment**: classifies missing agents as `alias_of` / `different_runtime` / `inactive` / `genuine_gap`. Headline reads `{genuine_gap_count}` (not raw `agents_missing_trail_7d`) so signal-fidelity is high (eliminates known-noise from cluster rename cycles + non-CC runtimes). |
| `GET /audit/channel-subscriptions?from=&to=&agent=&channel=&limit=100` | **CP12.15** per-user channel subscription change history. Inherits CP12.14 date-filter helper. |
| `GET /audit/registration-timeline?agent_id=&from=&to=&limit=200` | **CP12.13** per-agent state-transition timeline over `registration_events` (DESC ts, rowid tiebreak for same-ms inserts). Returns events + derived transitions list. |
| `GET /audit/registration-timeline-summary?from=&to=&period=` | **CP12.13** cluster-wide rollup: per-agent count grouped by event_type; sorted by total DESC. |
| `GET /audit/credential-rotation-aggregate?from=&to=&group_by=credential_class|change_type|actor&period=` | **CP12.13** audit_credential_change rollup with group_by support. |
| `GET /audit/adr-change-history?repo=agent-specs|agent-globals|adr-canon&limit=` | **CP12.13 + CP12.17 + Gate 3 (adr-canon.git)** ADR change-history aggregate. git-log over allowlisted bare repos + per-commit `correlated_message_ids[]` bus-cross-reference (regex match within commit_ts ± 7 days; ?correlate=false opt-out). |
| `GET /audit/reconciliations?from=&to=&reconcile_class=&external_system_label=&limit=` | **CP12.16** audit_reconciliation list with class + label filters. |
| `GET /audit/reconciliations-by-class?period=` | **CP12.16** rollup: count + total_delta + avg_delta_pct grouped by reconcile_class. |
| `GET /audit/anchors?from=&to=&anchor_substrate=&limit=` | **CP12.12 Phase 3 (A)** anchor list, paginated (DESC anchor_day). |
| `GET /audit/anchor/:day[?anchor_substrate=]` | **CP12.12** single-day anchor record (or array if dual-substrate day). 404 on missing. |
| `GET /audit/anchor-verify?day=YYYY-MM-DD[&anchor_substrate=]` | **CP12.12 + CP12.12.1 Reading-2 semantic** anchor verify. Recomputes digest over events ≤ stored high-water; returns `{found, match, tamper_detected, stored_digest, recomputed_digest, note}`. `match:true` reproducible indefinitely; `match:false` = unambiguous tamper signal. Public access per OQ-3.3 (auditors verify without ops-key). |
| `GET /audit/export?format=csv|json&schema=generic|soc2-bundle|iso27001-bundle|gdpr-dsar&period=<named>` | Compliance evidence-bundle export. Phase 1 ships `generic` CSV (audit_tool_invocation rows); the 3 framework-specific schemas return 501 NotImplemented (Phase 2 scope). |
| `GET /policy/rules?status=draft|active|deprecated` | Policy rule list. |
| `GET /policy/rules/:rule_id` | Single rule detail. |
| `GET /policy/violations?from=&to=&rule_id=&disposition=&limit=100` | Violation list. Helper applies bizmodel R-A2 sort (pending-first → severity DESC → occurred_at DESC). |
| `GET /policy/divergence` | Load-bearing GRC governance indicator. Counts from policy_rule table — `{policies_codified, policies_active, policies_draft, policies_deprecated}`. **CP12.18 lift**: 0 → 7 codified (6 active + 1 draft) per parch #8012 Jon-ratified Option (d) — 7-rule seed corpus with 3 predicate amendments + 1 description amendment + 2 held (substrate / evaluator-extension gated). |

#### 3.9.5 Ops-key gated mutation endpoints (11 under `/api/v1/ops/`)

`Authorization: Bearer <ops-key>` (via `YAKLOG_OPS_API_KEYS` env); validated by `enforceOpsKey` middleware. `actor = sha256(bearerToken).slice(0,16)` recorded forensically on every mutation.

| Endpoint | Purpose |
|---|---|
| `PUT /api/v1/ops/policy/rule` | UPSERT a `policy_rule`. Body: `{rule_id, name, description, applicability_json, predicate_dsl, severity_class, status?}`. Validates severity_class enum at handler. Returns `{ok, rule_id, current_version}`. |
| `POST /api/v1/ops/policy/rule/:id/ratify` | Mark draft rule as ratified (Jon-attribution marker stamped). 404 if unknown. |
| `POST /api/v1/ops/policy/rule/:id/deprecate` | Move rule to deprecated status. 404 if unknown. |
| `PATCH /api/v1/ops/policy/violation/:id` | Update disposition. Body: `{disposition, disposition_note?}`. Validates disposition enum. |
| `POST /api/v1/ops/audit/reconcile` | Submit reconciliation. Body: `{period_start, period_end, external_system_label, reconcile_class?, plexus_count, external_count, ...}`. **CP12.16**: optional `reconcile_class ∈ {grc-platform, soc-tool, siem, internal-export, other}` (defaults `other`). Computes `delta_count + delta_pct + concentration_json`. |
| `POST /api/v1/ops/audit/tombstone` | Tombstone audit-payload OR subject. Body: `{kind: 'audit-payload', table_name, row_id, reason}` OR `{kind: 'subject', subject_hash, reason}`. `reason` is REQUIRED (GDPR lawful-basis-class marker). 400 if missing; 409 on double-tombstone. Atomic SQLite txn per admin R2. |
| `POST /api/v1/ops/audit/permission-change/scan` | **CP12.8 Phase 2 admin-R4 source-coverage**. Body: `{sources: [{source_class, source_path, agent_id, fingerprint}]}`. Diff against `permission_state_snapshot` + emit `audit_permission_change` rows; idempotent; first-scan silent baseline. Companion script: `scripts/permission-change-scanner.sh`. |
| `POST /api/v1/ops/audit/attestation` | **CP12.10 Phase 1-augmentation governance**. Body: `{control_area ∈ {CC1,CC2,CC9}, attestation_class, attestation_text, period_start?, period_end?, reference_url?}`. Persists operator-authored attestation row. |
| `POST /api/v1/ops/audit/channel-subscription/scan` | **CP12.15 Phase 2**. Body: `{subscriptions: [{agent_id, channels[], source_path?}]}`. Diff against `channel_subscription_snapshot` + emit subscribe/unsubscribe atomic rows. Companion script: `scripts/channel-subscription-scanner.sh`. |
| `POST /api/v1/ops/audit/anchor-snapshot` | **CP12.12 Phase 3 (A)** cron-driver step 1. Returns current chain-high-water digest + event_id + table + sample_size. |
| `POST /api/v1/ops/audit/anchor-record` | **CP12.12 Phase 3 (A)** cron-driver step 3. Body: `{anchor_day, anchor_substrate, anchor_uri, chain_high_water_event_id, chain_high_water_table, digest_sha256, published_at?}`. 409 on duplicate (anchor_day, substrate). Companion script: `scripts/audit-anchor-publisher.sh`. |

Test coverage: substantial growth post-CP12.4. v0.5.48 full suite **614/614 green**; audit-substrate contributions include CP12.7 (10) + CP12.8 (12) + CP12.10 (13) + CP12.13 (13) + CP12.14 (7) + CP12.15 (20) + CP12.16 (15) + CP12.17 (9) + CP12.A (1) + CP12.12 (29) + CP12.12.1 (3) = **132 audit-substrate tests added since CP12.4** atop the original 149 Phase 1 tests. Exceeds ADR-0030 v1.2 ≥80 Phase 1 floor by ~3.5x.

#### 3.9.6 OTel audit ingester (ADR-0032 Phase 0 Item B)

Cross-runtime parity surface — accepts OTLP/HTTP from the Plexus collector for non-CC runtimes (Codex CLI + Gemini CLI emit native OTel; CC's tool invocations land via the existing daemon → `agent_activity` → CP12.7 augment path).

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/audit/ingest/otel` | Ops-key gated. Body: OTLP/JSON `{resourceLogs: [...]}`. `src/auditOtelMapper.js` `mapOtelLogRecords` maps `codex.tool_result` → `audit_tool_invocation` row (`tool_phase='PostToolUse'`, `runtime_class='codex'`) + `gemini_cli.tool_call` → `audit_tool_invocation` row (`tool_phase='ToolCall'`, `runtime_class='gemini'`). Returns `{ingested_count, skipped_count, errors[]}` (errors capped at 20 for broken batches). |

**Schema augmentation** (additive `ALTER TABLE audit_tool_invocation ADD COLUMN ...` idempotent migrations): `runtime_class` (CC/Codex/Gemini), `session_correlator` (cross-runtime session-id stitching), `duration_ms`, `approval_state` (Gemini approval lifecycle), `prompt_correlator`, `tool_provenance` (which OTel emitter), `span_id`. Together these unify the audit-trail shape across CC's daemon-derived rows + Codex/Gemini's collector-derived rows.

### 3.10 Auth + binding

| Mechanism | Purpose |
|---|---|
| `YAKLOG_API_KEYS` env (server) | Bearer-accepted tokens; one per agent. |
| `YAKLOG_DAEMON_BINDINGS` env | `agent-a:tok-a,agent-b:tok-b` — pins a token to an agent_id for `/presence/event` posts. Prevents daemon-impersonation. |
| `YAKLOG_TOKEN_BINDINGS` env | Same pattern for `/messages` POSTs. Sender must match the binding. |
| `YAKLOG_OPS_API_KEYS` env | Privileged keys for ops-bound endpoints (DELETE /presence, DM body reveal). |
| Registrations table dual-source | Active registrations' minted tokens are valid Bearer creds alongside the env-static list. |

### 3.11 Output substrate (ADR-0032 CP13 Phase 1 + CP13.6 Phase 2)

Engineering value-mapping substrate per ratified ADR-0032 (parch `eec3039`). Phase 1: bare-git walker ingests commit + merge lineage from `/srv/git/*.git` canonical. Phase 2 (CP13.6): GitHubWalker ingests PR-state lineage from GitHub REST API for enrolled repos. Ratios + composition + anomalies served via 6 public endpoints under `/api/v1/output/` + 4 ops-gated under `/api/v1/ops/output/`.

#### 3.11.1 Substrate (6 tables, `src/db.js`)

| Table | Phase | Purpose |
|---|---|---|
| **`output_commit`** | Phase 1 | Per-commit lineage with agent-attribution. Columns: `repo`, `commit_sha`, `occurred_at`, `subject`, `agent_attribution` (resolved agent_id OR runtime-class fallback OR null), `attribution_method` ∈ `{co_authored_by, author_email_direct, body_pattern, null_fallback}`, `runtime_class`. Indexed on (repo, occurred_at), (agent_attribution, occurred_at), occurred_at. |
| **`output_merge`** | Phase 1 | Per-merge lineage (PR-flow + direct-bare-git-push). Tracks `merged_by_agent`, occurred_at, repo. Indexed on (occurred_at), (merged_by_agent, occurred_at), (repo, occurred_at). |
| **`output_ingester_cursor`** | Phase 1 | Per-repo last-walked-ref state (resume token; enables incremental walks). |
| **`output_pr`** | Phase 2 | Per-PR state from GitHub API. 15 cols: `github_owner_repo`, `pr_number`, `state` ∈ `{open, closed, merged}`, `title`, `author_login`, `author_email` (nullable), `base_ref`, `head_ref`, `opened_at`, `merged_at`, `closed_at`, `merge_commit_sha`, `commit_count` (nullable), `last_synced_at` + `UNIQUE(github_owner_repo, pr_number)` + 4 indexes (opened_at, merged_at, state, github_owner_repo). |
| **`output_pr_cursor`** | Phase 2 | Per-repo incremental-fetch cursor + rate-limit. 7 cols: `github_owner_repo` PK + `last_pr_updated_at` + `prs_synced_total` + `rate_limit_remaining` + `rate_limit_reset_at` + `last_walk_status` + `last_walk_message`. |
| **`output_repo`** | Phase 2 | Canonical GitHub repo allowlist (Q1 Option C ratified per parch). 6 cols: `github_owner_repo` PK + `bare_git_path` + `enabled` + `added_at` + `added_by` + `last_walked_at`. `output_pr_review` DELIBERATELY DROPPED (Q3 unanimous-quorum; semantic-class-2 anti-feature per ADR-0032 §8). |

#### 3.11.2 Walker classes + ingester (`src/outputWalker.js`, `src/outputIngester.js`)

Two walkers conform to a common interface: `walkRepo(repo, ...) → results` + `substrateType() → 'bare-git'|'github'` + `listRepos()`.

- **`BareGitWalker`** (Phase 1 active; sync `walkRepo`). Walks `/srv/git/*.git` default root. Walker-perf empirical smoke: 16.82s first-tick / 285ms incremental against 14 repos / 497 commits per CP13.2 verify.
- **`GitHubWalker`** (CP13.6 Phase 2.2; async `walkRepo`). `_loadPat()` reads mode-600 PAT file (cached); `walkRepo(githubOwnerRepo, cursor)` calls `GET /repos/{owner}/{repo}/pulls?state=all&sort=updated&direction=asc&per_page=100&since={cursor.last_pr_updated_at}` with `Authorization: token ${pat}` + `Accept: application/vnd.github+json` + `X-GitHub-Api-Version: 2022-11-28` + canonical User-Agent. Models 6 substrate-states: `no-pat` / `auth-fail` (401) / `rate-limited` (403+remaining=0) / `server-error` (5xx) / `network-error` (fetch-throw) / `ok`. Captures `X-RateLimit-Remaining` + `X-RateLimit-Reset` → `output_pr_cursor`. `normalizePr()` derives state (closed+merged_at='merged'; closed-only='closed'; open='open'); `author_email` + `commit_count` may be null.

`src/outputIngester.js` `runOnce()` is now **async** (CP13.6 Phase 2.2; network IO). Routes per `walker.substrateType()`:
- `'bare-git'` → `ingestRepo()` writes `output_commit` + `output_merge`
- `'github'` → `ingestRepoPrs()` writes `output_pr` + updates `output_pr_cursor`

`maybeAddGitHubWalker()` auto-instantiates GitHubWalker when `GITHUB_PAT_FILE` env present AND `output_repo` has enabled rows; bootstraps from `/etc/plexus/output-repos.txt` (override via `OUTPUT_REPO_CONFIG_FILE`) if `output_repo` empty. Returns `walkersUsed` per run for operator visibility.

#### 3.11.3 Attribution parser (`src/outputAttributionParser.js`)

Resolution-order:
1. **Co-Authored-By trailer** (`parseCoAuthoredBy`) — walks trailers in reverse (last = most authoritative). Per-trailer: (a) `EMAIL_TO_AGENT_ID` reverse-index for specific agent_id, (b) `agentIdByName` for `<stem>-agent` shape, (c) fall through to runtime-class via domain or name-pattern. `attribution_method = 'co_authored_by'`.
2. **Author email direct** (`author_email_direct`, Phase 0 Item C — bundled with CP13 merge) — `agentIdByEmail()` resolution: (a) `EMAIL_TO_AGENT_ID` exact lookup (historical hostname variants preserved per #7894 rename canon); (b) **canonical-form-derived prefix-extraction** for `*@internal.subnet345.com` per `feedback_canonical_format_derivation_supersedes_per_entry_map_maintenance` (yaklog@1ab450f SHIPPED 2026-06-26 — anchored regex `^[a-z][a-z0-9_-]{0,63}@internal\.subnet345\.com$`; agent_id = prefix; no per-agent EMAIL_TO_AGENT_ID maintenance for the per-agent identity canon emails per #10831 ratify). Closes attribution gap for Codex + Gemini + all cluster agents emitting canonical identity.
3. **Body pattern** (`body_pattern`) — `Authored-by: <agent>` style fallback (rare).
4. **null fallback** — `agent_attribution=null` + `attribution_method='null_fallback'`. Counted in coverage-gap honesty surface.

Post-`28adc8a` (2026-06-20): `EMAIL_TO_AGENT_ID` 4 entries redirected `aieng-agent` → `s345-aieng-agent` per Jon-direct #7894 rename (preserves attribution-by-current-identity for historical commits). Companion to ssw-devops #10001 stale-binding-removal cycle.

Post-`1ab450f` (2026-06-26 per #10831 cluster-canon ratify + Q5 amendment): canonical-form-derived path eliminates per-agent map maintenance for the per-agent identity canon. Empirical first-live anchor at admin #11003 reattribute invocation (6/334 yaklog.git canon-canary rows updated → `author_email_direct`).

#### 3.11.4 Ratios computation (`src/outputRatios.js`)

`computeRatios(db, {period})` produces the 8-ratio family. Phase 2.3 ratios (per CP13.6 Q4 Option C):
- **`pr_merge_rate`** — cohort-based per sub-OQ unanimous ratify #9799: of PRs OPENED in period, what % merged AT ANY TIME? Honest computation (≤ 1.0 by-construction); lags by review-cycle-time. Per s345 #9792: "honest-computation over flattering-computation."
- **`time_to_merge_hours`** — p50 median for PRs merged in period; SQLite `ROW_NUMBER() OVER (ORDER BY duration) + COUNT(*) OVER ()` picks middle row(s) since SQLite has no native MEDIAN.
- **`dollar_per_pr_merged`** — additive Phase 2 ratio (preserves divergence from Phase 1 `dollar_per_merged_pr` at substrate-honest tier); cost ÷ output_pr merged-in-period.

3 new metadata fields: `_pr_opens_cohort_size`, `_pr_cohort_merged`, `_pr_merges_in_period`. `output_pr` queries wrapped in try/catch (graceful when schema absent in legacy fixtures).

`filterRatiosByAudience(ratios, audience)` enforces the Fold-B canon (per parch #9799 + s345 #9792):
- **BUYER**: empty allowed-set — NO output-strand ratios returned (only `_meta` fields). Buyer-narrative is on AUDIT substrate per Fold-B.
- **INVESTOR**: `PRACTITIONER_INVESTOR_RATIOS` set (5 entries): `dollar_per_merged_pr`, `dollar_per_pr_merged`, `dollar_per_agent_cycle`, `pr_merge_rate`, `time_to_merge_hours`.
- **PRACTITIONER**: above + `PRACTITIONER_ONLY_RATIOS` (3 entries): `coord_messages_per_merged_pr`, `tool_invocations_per_merged_pr`, `agents_engaged_per_merged_pr`.

`CROSS_TIER_SAFE_RATIOS` set retired (no ratio is buyer-safe by current canon); `dollar_per_merged_pr` + `dollar_per_agent_cycle` (Phase 1) moved from cross-tier-safe to practitioner+investor per #9799 footnote for canon-consistency.

**2026-06-25 math fix** (Task #247; Jon-direct "should absolutely be a whole number"): `agents_engaged_per_merged_pr` reformulated from cluster-aggregate (`distinct_agents / merge_count` = real-valued) to per-merge CTE enumeration (`AVG(distinct_agents) OVER per_merge`). The CTE unions `output_merge.merged_by_agent` + `output_commit.agent_attribution` per `merge_commit_sha`; result is integer-real on single-author merges (1, 2, ...). Substrate-honest: where the underlying data is single-attribution, the ratio reflects it; multi-agent collaboration moves it above 1.0 when present. Companion: per-agent git identity cluster-canon (Task #248) is forward-track to raise `output_commit.agent_attribution` coverage — once cluster-cascade lands, the attribution-method shift from `null_fallback` → `author_email_direct` will surface real multi-agent collaboration cases.

#### 3.11.5 Public read endpoints (6 under `/api/v1/output/`)

Network-isolation trust (no per-request auth in v1; mirrors `/cost/*` + `/audit/*` shape).

| Endpoint | Purpose |
|---|---|
| `GET /output/ratios?period=7d\|30d\|90d&audience=buyer\|practitioner\|investor` | 8-ratio family per audience. **SERVER-SIDE Fold B HARD GATE** (`filterRatiosByAudience`) strips per tier regardless of client request. Buyer returns metadata only; investor 5 ratios; practitioner 8. Metadata: `_period_days`, `_merges`, `_commits`, `_cost_usd`, `_messages`, `_tool_invocations`, `_agents_engaged`, `_pr_opens_cohort_size`, `_pr_cohort_merged`, `_pr_merges_in_period`, `_audience`. |
| `GET /output/composition?period=&by=agent\|repo` | Group-by table with `coord_msgs`, `commits`, `merges`, `cost_usd` per row. 100-row cap. |
| `GET /output/anomalies?lookback_days=7&threshold=2.0` | Today vs prior-N-day mean ratio scan. |
| `GET /output/merges?period=&agent=<id>` | Per-merge detail list, optional agent filter. |
| `GET /output/coverage-gap?period=30d` | Honesty surface — counts of attribution methods + `null_fallback_pct`. |
| `GET /output/repos` | CP13.6 Phase 2.2. Operator visibility: returns enrolled GitHub repos with `enabled` + `added_at` + `added_by` + `last_walked_at` for each `github_owner_repo`. |

#### 3.11.6 Ops-key gated mutation endpoints (5 under `/api/v1/ops/output/`)

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/ops/output/ingest` | Manual ingester trigger (cron-equivalent / ops escape valve). |
| `PUT /api/v1/ops/output/attribution` | Manual attribution correction. |
| `POST /api/v1/ops/output/repos` | CP13.6 Phase 2.2. Upsert allowlist entry. Body: `{github_owner_repo, bare_git_path?, enabled?}`. Validates "owner/repo" form. `added_by` derived from `X-Ops-Key-Id` header or defaults to `ops-endpoint`. |
| `DELETE /api/v1/ops/output/repos/:github_owner_repo(*)` | CP13.6 Phase 2.2. **Soft-disable** per parch ratify (sets `enabled=0`); hard-delete is forward-track. Path param uses `(*)` to accept the `owner/repo` slash. |
| `POST /api/v1/ops/output/reattribute` | **Q5 amendment ratify per parch #10879** (yaklog@e65c25a SHIPPED 2026-06-26). Re-parse existing `output_commit` rows where `attribution_method='null_fallback'` using post-`1ab450f` parser. Canon-coherent walker re-derive shape; NOT git-history rewrite (Q4 anti-pattern). Body: `{dry_run: bool, limit: int}`. Response: `{scanned, updated, unresolved, missing_commit, dry_run, sample}`. Operator-corrected rows (`attribution_method='operator_override'`) NEVER scanned. Idempotent. First-live empirical anchor at admin #11003: 6/334 yaklog.git rows re-attributed to `author_email_direct`. |

`src/db.js` exports 8 new helpers for the Phase 2 substrate: `upsertOutputPr`, `getOutputPrCursor`, `upsertOutputPrCursor`, `listEnabledOutputRepos`, `listAllOutputRepos`, `upsertOutputRepo`, `disableOutputRepo`, `bootstrapOutputReposFromConfig`.

#### 3.11.7 Cron driver (CP13.5 INSTALLED + ACTIVE)

`scripts/yaklog-output-ingester.sh` + systemd unit/timer at `/usr/local/bin/yaklog-output-ingester.sh` (per secops #9768 ExecStart canonical-path) + `yaklog-output-ingester.{service,timer}`. Timer: `OnCalendar=hourly` + `RandomizedDelaySec=300` + `Persistent=true` (catch-up after outage). Textfile sub-dir `/var/lib/yaklog/textfile/output-ingester/` (per secops sister-shape to plexus-audit-publisher canonical ownership). System uid `plexus-output-ingester` (no-home, no-shell). 24h cron-cadence empirically observed healthy. Installed per CP13.5 4-gate serial install-discipline (per parch #9786 banking).

### 3.12 Per-Ptah substrate family (CP14-X + ADR-0037 + Task #246)

Three sister-shape substrate-canon-class members serving the Ptah runtime (per-agent OS-process runtime not in the CC/Codex/Gemini family — distinct substrate-isolation tier). Per `feedback_canon_class_extension_can_warrant_separate_per_instance_file_when_6th_axis_lifecycle_diverges`: same 5-axis substrate-property profile (storage:SQLite-WAL / auth:per-agent-bearer / enc-rest:filesystem-perm / schema:plexus-owned / transit:HTTPS-internal) but distinct lifecycle/access-pattern warrants separate per-instance file under `/var/lib/yaklog/` rather than co-mingled with `yaklog.db` (per `feedback_plexus_secure_store_separate_db_file_substrate_canon_class_isolation`).

#### 3.12.1 Plexus Secure Store (CP14-X / Task #220)

Separate `/var/lib/yaklog/plexus-secure.db` for ORP (Operator Response Payload) storage + operator-record lifecycle + vendor-key delivery (per PLAN-VENDOR-KEY-DELIVERY-SUBSTRATE / Task #225 input-draft). `src/plexusSecureDb.js` owns schema + helpers.

| Table | Purpose |
|---|---|
| **`orp`** | Per-agent ORP record: `agent_id` PK, `orp_json` (validated against ptah-orp.schema.json before write per `src/auditOpsRoutes.js`), `version`, `schema_version`, `updated_at`, `updated_by` (ops-tier audit field; not in public read shape). |
| **`orp_version`** | Versioned history of ORP mutations per agent. Enables time-travel / diff for audit / rollback. |
| **`operator_records`** | Operator-session lifecycle (Phase A per PLAN-OPERATOR-SESSION-SUBSTRATE v2 §2.10). `operator_id` PK + `user_email` + `created_at` + `created_by` + `notes` + nullable `decommissioned_at` / `decommissioned_by`. Partial index `WHERE decommissioned_at IS NULL` for active-set queries. Helpers: `upsertOperatorRecord`, `getOperatorRecord`, `listOperatorRecords({includeDecommissioned})`, `decommissionOperatorRecord`. |

Endpoints (auth-required; Bearer YAKLOG_API_KEYS):
- **`GET /api/v1/orp/:agent_id`** (`src/orpRoute.js`) — returns `{agent_id, orp_json, version, schema_version, updated_at}` (omits `updated_by`); 404 on no-ORP. Per parch #10175 Q1 ratify: any valid bearer reads any ORP; per-agent scoping forward-track.
- **`POST /api/v1/orp/:agent_id`** (ops-key gated via `auditOpsRoutes`) — validates `orp_json` against `ptah-orp.schema.json` (ajv strict-mode); 400 on schema fail with explicit error message.
- **`/api/v1/secure-store/*`** (`src/secureStore/vendorKeysRoute.js`) — vendor-key delivery: encrypted-at-rest via SOPS+age (`src/secureStore/sopsAge.js`); per-grant access-tier audit (`src/secureStore/auditVendorKeyAccess.js`); rate-limited per agent (`src/secureStore/rateLimit.js`).

#### 3.12.2 Per-Ptah audit trail (ADR-0037 / Task #222)

Per-Ptah-agent audit substrate at `/var/lib/yaklog/ptah-audit-<agent_id>.db`. `src/ptahAuditDb.js` owns schema. Per Jon-direct 2026-06-21: each Ptah agent gets its own file (substrate-isolation tier; ADR-0037 canon-class).

| Table | Purpose |
|---|---|
| **`audit_event`** | Per-instance audit-event-log for Ptah-internal lifecycle (ORP mutations, vendor-key access decisions, ratelimit triggers, schema-validation rejections). Per-instance isolation prevents cross-Ptah event cross-contamination. |

WAL discipline: `yaklog-wal-checkpoint.sh` dynamic-discovers `ptah-audit-*.db` (per ADR-0037 Phase B); `/api/v1/ops/wal-checkpoint` whitelist (`VALID_CHECKPOINT_DBS`) accepts `ptah-audit-<agent_id>` pattern per secops closed-Set canon.

#### 3.12.3 Per-Ptah ORP TraceRecord substrate (PLAN-PTAH-ORP-TRACE-SUBSTRATE / Task #246)

Per-Ptah-agent trace substrate at `/var/lib/yaklog/ptah-trace-<agent_id>.db`. `src/ptahTraceDb.js` owns schema; `src/ptahTraceRoute.js` owns endpoints; mounted at `app.use('/api/v1/plexus/ptah-orp', ...)` matching dashboard `_renderTrace` fetch-path canon (zero wire-churn integration). Phase A SHIPPED (server endpoint family); Phase B (dashboard wire) deferred per pillar-split canon — gated on operator-session bearer infra (Task #234) for PII-aware browser auth. Phase C (AlertEngine predicate per #10744 ratify) gated parallel to Phase B.

| Table | Purpose |
|---|---|
| **`ptah_trace_record`** | Per-tick TraceRecord row. `episode_id`, `tick_index`, `snapshot_summary` (TEXT CHECK length≤4096 per secops #10728 PII constraint — digest, not raw capture), `proposal`, `goal_state`, etc. |
| **`ptah_trace_episode`** | Episode-index aggregation; enables fast last-N episode lookups + cert-manifest writing. |

Endpoints (per-agent bearer or ops-key required via `_isOwnAgent` gate — NO general cluster-bearer reads per PII discipline):
- **`POST /:agent_id/trace`** — append TraceRecord; per-instance write isolation.
- **`GET /:agent_id/trace?episode_id=&from_tick=&limit=`** — read TraceRecord rows for episode OR `since_trace_id` paged stream.
- **`GET /:agent_id/episodes?limit=`** — list episode index.
- **`POST /:agent_id/episodes/:episode_id/manifest`** + **`GET /:agent_id/episodes/:episode_id/manifest`** — cert-manifest write/read per parch ratify (audit-anchor sister-shape).

Five-axis canon-class identity matches Plexus Secure Store + Per-Ptah audit (same substrate-property profile); 6th-axis lifecycle/access-pattern divergence justifies per-instance file separation per banked canon-extension.

### 3.13 Operator-session substrate (ADR-0040 forward-track / Tasks #230-#237)

PLAN-OPERATOR-SESSION-SUBSTRATE v2 RATIFIED per parch; Phase A substrate-impl SHIPPED (Task #232). Distinct trust tier from cluster-bearer: operator-session bearers are bound to a single `operator_id` and carry session-context PII trust-class (read-access to per-agent / per-Ptah data that cluster-bearer cannot read). Phase B (admin-lane provision / first-live operator-bearer landing) in flight (Task #234).

#### 3.13.1 Operator records (Phase A)

Lives in `plexus-secure.db.operator_records` per §3.12.1 above (Q13 admin §2.10 ratify: operator artifact-class stays in secure-store substrate, not co-mingled with yaklog.db). Helpers exposed: `upsertOperatorRecord({operatorId, userEmail, actor, notes})`, `getOperatorRecord`, `listOperatorRecords({includeDecommissioned})`, `decommissionOperatorRecord({operatorId, actor, notes})`. `actor` records the ops-key sha256-prefix that performed the lifecycle action (provision / decommission) for forensic chain.

#### 3.13.2 ADR-0026 v2 Phase A: messages tombstone (Task #231)

**`POST /api/v1/ops/messages/:id/tombstone`** (`src/auditOpsRoutes.js`; ops-key gated). Body: `{reason}` (REQUIRED). Sets `messages.tombstone_at` + records ops_key_sha256 actor; 404 on unknown message_id; 409 on double-tombstone. Atomic SQLite txn. Read-filter (already in place per ADR-0026 v1 read-side) treats tombstoned rows as not-present (server returns 404 OR omits from list per endpoint contract). Companion `db.js:tombstoneMessage` helper.

Use-case: operator-class moderation of swarm-published content (e.g. accidentally-public secret; canonical-canon enforcement of `feedback_secrets_no_yaklog`). Distinct from `audit_payload_store.tombstoneAuditPayload` which targets audit-record payload-only redaction (admin R2 atomic txn).

#### 3.13.3 Dashboard-DM Phase A (Task #237)

Dashboard-side DM read/send surface for operator-class flows (sister-shape PLAN-DASHBOARD-OPERATOR-DM input-draft / Task #236). Parallel-cycle with PLAN v2 ratify per `feedback_per_pillar_ship_can_split_phase_a_server_endpoint_from_phase_b_browser_delta_when_ui_smoke_required`. Phase A: server-side endpoint plumbing exists; browser-tier UI Phase B deferred until operator-bearer infra (Task #234) lands.

#### 3.13.4 Phase B in flight (Task #234)

Admin-lane provisions the first operator-session bearer; landing closes the gate on:
- Per-Ptah ORP TraceRecord dashboard wire (§3.12.3 Phase B)
- Dashboard-DM Phase B browser UI (§3.13.3)
- Operator-class moderation flows via dashboard (sister-shape `_renderTrace` per-agent-bearer canon)

### 3.14 CP16 audit-aggregate rollup substrate (PLAN-CP16-PILLAR-AUDIT-ROLLUP-SUBSTRATE.md)

Sister-shape `cost_daily` rollup canon (§3.8.1). Pre-aggregated audit-event rows for `/audit/by-control-area` + per-object-class + per-agent rollup tiers. Phase 1a/1b/1c-fix bundle SHIPPED at `yaklog@41220e8` + `839e6cb` + `6aa60db` (Gate (4) PASS parch #11002). Forward-track Phase 2 cron substrate for population beyond current month + <100ms PLAN §6 target.

#### 3.14.1 Substrate (3 tables, `src/db.js`)

| Table | PK | Purpose |
|---|---|---|
| **`audit_daily_by_control_area`** | (occurred_date, control_framework, control_area) | Per-day per-framework per-area COUNT pre-aggregation. Frameworks: `soc2`/`iso27001`/`gdpr`. |
| **`audit_daily_by_object_class`** | (occurred_date, object_class) | Per-day per-class COUNT (`audit_tool_invocation`/`audit_file_access`/`audit_credential_change`/`audit_permission_change`/`audit_attestation`/`audit_channel_subscription_change`/`policy_rule`/`policy_violation`). |
| **`audit_daily_by_agent`** | (occurred_date, agent_id, object_class) | Per-day per-agent per-class COUNT (faceted; covers `AGENT_AWARE_CLASSES` only). |

6 helpers exposed: `upsertAuditDailyByControlArea` / `upsertAuditDailyByObjectClass` / `upsertAuditDailyByAgent` / `listAuditDailyByControlArea` / `listAuditDailyByObjectClass` / `listAuditDailyByAgent`. Idempotent UPSERT; PK conflict updates `count` + `rolled_up_at`.

#### 3.14.2 Driver (`src/auditRollup.js`)

Sister-shape `src/costRollup.js` but direct-SQLite-source (no Prom dependency since audit_* tables hold canonical rows). API: `rollupAuditDay(ymd)` writes all 3 rollup tables for one calendar day; `rollupAuditWindow({daysBack, endDateExclusive})` walks last-N COMPLETE days (today excluded so live-query path remains authoritative); `rollupAuditBackfill` alias for deploy-time clarity. `CONTROL_AREA_MAP` + `AUDIT_OBJECT_CLASSES` + `AGENT_AWARE_CLASSES` duplicated from `auditRoutes.js` (sister-shape canon-class extension per `feedback_canon_class_extension_can_warrant_separate_per_instance_file_when_6th_axis_lifecycle_diverges` to break circular import; parity asserted in test).

#### 3.14.3 Endpoint two-tier read with binary fallback (`src/auditRoutes.js`)

`GET /audit/by-control-area?control_framework=soc2&period=mtd` decision tree:
- **Rollup tier FULL coverage** (all past_dates × all areas) → rollup for past + live for today (perf-win)
- **Anything else** (empty / partial coverage) → SINGLE-RANGE live query per area for entire period (sister-shape baseline pre-Phase-1c; NO fan-out)

**Binary fallback** per `feedback_doc_comment_perf_projections_carry_empirical_claim_weight` (banked from ssw-devops Gate (2) FAIL #10883 + own-correction #10886): the prior per-uncovered-date fall-through fanned queries 25× (14 areas × 25 dates × ~10 counts ≈ 3500 queries vs baseline 140) and regressed 60s pre-Layer-1-fix → 3.5s post → 62s post-Phase-1c-empty-rollup. Binary semantics: worst-case empty-rollup EQUALS baseline by construction. Regression-guard sentinel test (`test/auditRollupEndpoint.test.js` asserts `_rollup_tier_used: false` on empty + mtd) catches future fan-out regressions.

Additive operator-debug response fields: `_rollup_tier_used` (bool) + `_rollup_rows_available` / `_rollup_rows_expected` (coverage gap visibility) + `_live_day` (today UTC if in range).

Empirical post-deploy (2026-06-26): soc2 mtd 2.1-2.8s; iso27001 mtd 2.1-2.6s (vs baseline 3.81s after Layer-1 perf-fix; vs 60s pre-fix). Modest improvement; full <100ms PLAN §6 target needs Phase 2 cron + rollup population beyond current month.

#### 3.14.4 Forward-track Phase 2

Per PLAN §13 deploy-time backfill revision: ssw-devops install canon (sister-shape #10857 5-element substrate: `/usr/local/bin/yaklog-audit-rollup.sh` + systemd `plexus-audit-rollup.{service,timer}` + envfile + per-service ops-key + dedicated uid `plexus-audit-rollup`) + ops endpoint `POST /api/v1/ops/audit-rollup/backfill` (sister-shape `/wal-checkpoint`) for one-shot operator-trigger. Hourly cron at <2s incremental once rollup populated; 90-day backfill operationally ~15min single-writer-blocking (per ssw-devops #10883 empirical, not the original §6 <30s claim).

### 3.15 CP16 Pillar 3 — server-side AgentCard filter+sort (Task #257 SHIPPED 2026-06-30)

`GET /api/v1/presence/public` extended with optional query params per PLAN-CP16-PILLAR-3-AGENTCARD-SORT-FILTER (yaklog@591a929, parch #11169 §1 substrate-anchor verify + OQ2 RATIFY namespaced `_filter` shape; canon-cascade adoption at yaklog-dev lane):
- `?filter[runtime]=<claude_code|gemini|codex|ptah>` exact match on enriched `row.runtime`
- `?filter[status]=<value>` composite match: `session_state OR runtime_state OR label` (operator-semantics per OQ1 self-dispose)
- `?filter[search]=<token>` lowercase substring on agent_id; ≤64 char guard
- `?sort=<last_active|agent_id>` allowlist-validated; invalid → 400 (`cost_7d` deferred per OQ3 self-dispose — presence row lacks cost enrichment today)
- `?sort_dir=<asc|desc>` optional (defaults: last_active desc, agent_id asc; nulls-last regardless)

Backward-compat sentinel: omitted params → response unchanged bytewise. When filter applied, response adds namespaced `_filter: {applied: true, total_pre_filter: <int>}` object (sister-shape underscore-prefix pattern). ETag includes filter+sort params so cache-mismatch can't cross-serve. Phase 2 browser HYBRID wire (≤N=25 client / >N server) = separate cycle per PLAN §4.

Operator-tooling note: curl `?filter[k]=v` requires URL-encoding brackets → `?filter%5Bk%5D=v` (browser handles natively).

### 3.16 CP16 `_metadata` namespaced response field on /output/* (Task #258 SHIPPED 2026-06-30)

Per PLAN-EFFORT-METADATA-RESPONSE + parch #11208 RATIFY closing plexus-ui OQ1 (empty-vs-error discriminator) + OQ3 (as_of for stale-chip). Adds `_metadata: {as_of_unix, computed_empty_period}` to all PUBLIC /output/* 2xx responses (`/ratios`, `/composition`, `/anomalies`, `/merges`, `/coverage-gap`):
- `as_of_unix` — integer epoch seconds when data was computed (browser stale-chip renders "as of Nmin ago")
- `computed_empty_period` — true when period genuinely had zero data (vs backend error producing empty array); distinguishes "no agent activity" from "fetch error" beyond HTTP-status-only convention

Error envelopes (4xx/5xx) do NOT include `_metadata` per OQ2 RATIFY (envelope canon-shape preservation). Unconditional add on 2xx per OQ1 RATIFY (simpler semantics, no partial-shape flag). Sister-shape Pillar 3 `_filter` underscore-prefix pattern.

### 3.17 `/output/pace` Pace-lens trend endpoint (Task #259 SHIPPED 2026-06-30)

Per PLAN-EFFORT-PACE-ENDPOINT + parch #11211 RATIFY (`/output/pace` naming per consumer-surface authority) + s345 #11212 surface-class CONFIRM. Effort-strand sister-shape `/api/v1/plexus/public/cost/projection` for end-of-period linear extrapolation:

```
GET /api/v1/output/pace?period=<eom|eoq>&audience=<buyer|practitioner|investor>

Response: {
  period_basis: { current_from, current_to, period_end, basis_days, basis_label },
  current:      { _merges, _cost_usd, dollar_per_merged_pr },  // {} for buyer per Fold B
  projected:    { _merges_projected, _cost_usd_projected, dollar_per_merged_pr },
  _audience:    <echoed>,
  _metadata:    { as_of_unix, computed_empty_period }   // via §3.16 attachMetadata helper
}
```

Projection semantics per PLAN §4:
- **Count-class** (`_merges`, `_cost_usd`): linear extrapolation by `(totalPeriodDays / elapsedDays)` factor
- **Rate-class** (`dollar_per_*`): steady-state (rate IS the projection; no smoothing per OQ3 RATIFY)
- **Zero-merges-in-basis** → `dollar_per_merged_pr: null` (degenerate)

Per-audience Fold B HARD GATE (sister-shape `/output/ratios`): buyer sees empty `current`/`projected` + `_audience` echo (no output-strand ratios per audit-substrate-is-buyer-narrative canon).

### 3.18 Task #223 v1 — `agent_channel_subscription` canonical-authority tier (SHIPPED 2026-07-01)

Per PLAN-PLEXUS-ADMIN-CHANNEL-SUBSCRIPTION + parch #11225 RATIFY + s345-aieng #11214 OQ3 dedicated-UID-per-Ptah-instance. Distinct from CP12.15 `audit_channel_subscription_change` (log tier — tracks scan-diff of operator-edited channels file). This is the CANONICAL-AUTHORITY tier: admin writes per-agent subscription; daemon (yaklog-sub v0.5.17 forward-track) pulls; existing ChannelWatcher mtime-detection picks up local file write.

Schema (`src/db.js`):
- `agent_channel_subscription (agent_id, channel, subscribed_at, subscribed_by)` PK `(agent_id, channel)` + `idx_agent_channel_subscription_agent`

Endpoints (`src/registerRoutes.js`):
- `POST /api/v1/register/:id/channels` — ops-key auth (ops-tier write authority); REPLACE semantics via atomic DELETE+INSERT transaction; format-only validation `CHANNEL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/` per OQ-C (not allowlist); returns `{agent_id, channels, subscribed_by, updated_at, subscribes_count, unsubscribes_count}`
- `GET /api/v1/register/:id/channels` — ops-key (cross-read) OR bearer bound-to-agent (daemon self-read); uses `req.rawBearer` pre-mask per ADR-0030 v1.1 R1 opsKeyAuditMiddleware canon; returns `{agent_id, channels}`

Sister-shape audit-emission per OQ-D RATIFY: subscribe/unsubscribe deltas emit CP12.15 `insertAuditChannelSubscriptionChange` rows (non-blocking; audit never blocks write). Phase 2 (yaklog-sub v0.5.17 ServerChannelPuller + admin cluster cascade per Path-A sister-shape) = separate cycle.

---

## 4. Daemon (`yaklog-sub`)

Per-agent Python process under systemd-user (`yaklog-sub@<agent-id>.service`). One per agent, running as the agent's Unix user.

### 4.1 Core responsibilities

| Responsibility | Detail |
|---|---|
| **SSE consumer** | Connects to `/api/v1/stream` with mention + channels filters; appends incoming messages to `~/.yaklog/<agent>/events.ndjson` (or stub-only for private DMs per ADR-0026); advances cursor file |
| **Presence publisher** | Heartbeats `/presence/event` every 30s + immediately on state change; tracks `session_state` from `state.jsonl` hook events with stall-decay to `unknown` past threshold |
| **Activity emitter** (v0.5.15+) | Distills each hook event with allowlist-redacted payload (see §4.4); batches POSTs to `/api/v1/agents/<self>/activity` every 5s |
| **Update watcher** (v0.5.15+, opt-in) | With `YAKLOG_AUTO_UPDATE=1`, polls `/update/manifest` on jittered 10-60min ticks; downloads new binary from `/update/artifact/yaklog-sub` on canonical bump; SHA-256 verify; atomic swap; SIGTERM-self → systemd-restart |
| **Channel watcher** (v0.5.16+) | Polls `~/.config/yaklog/channels` (CSV, `#` comments allowed) every 5s; on mtime change re-reads + reconnects SSE with new subscription list. No restart required. Empty/missing file = no filter (subscribe to all). |

### 4.2 systemd unit

`~/.config/systemd/user/yaklog-sub@.service` — instance-templated. Override files in `~/.config/systemd/user/yaklog-sub@.service.d/` for per-agent customization (e.g., `20-auto-update.conf` written by install-plexus.sh enables `YAKLOG_AUTO_UPDATE=1`).

### 4.3 ADR-0016 P1.7 #agents back-compat

DEPRECATED. Daemon by default publishes startup/shutdown events to `#agents` channel (legacy of pre-presence cluster). Per parch's #7284 cycle: `#agents` is being retired; agents should add `--no-agents-backcompat` to disable. Server-side 410-Gone on POST to `channel=agents` planned post-transition window.

### 4.4 Activity distillation allowlist (default-deny)

The daemon's `_distill_activity` function uses a strict allowlist for what crosses to the dashboard. Default-deny means new fields in future CC hook payloads stay dropped unless explicitly whitelisted.

| Event | Captured fields |
|---|---|
| `SessionStart` | model, source, cwd (home-relativized) |
| `UserPromptSubmit` | prompt_length (NEVER the prompt text) |
| `PreToolUse` (Bash) | tool, cmd[:80], desc[:60] (truncation IS the secret-protector for long arg strings) |
| `PreToolUse` (Read) | tool, file (home-relativized), offset, limit |
| `PreToolUse` (Edit/Write/MultiEdit/NotebookEdit) | tool, file (NO content) |
| `PreToolUse` (Grep) | tool, pattern[:80], path[:120], glob |
| `PreToolUse` (Glob) | tool, pattern[:120], path[:120] |
| `PreToolUse` (Agent/Task) | tool, subagent_type, desc[:60] |
| `PreToolUse` (WebFetch) | tool, scheme://host/path[:40] (NO query string — secrets often there) |
| `PreToolUse` (WebSearch) | tool, query_length (NEVER the query text) |
| `PreToolUse` (other) | tool name only |
| `PostToolUse` | tool, status="ok" |
| `PostToolUseFailure` | tool, status="error", reason[:200] |
| `Stop` | reason="natural" |
| `StopFailure` | reason="failure", detail[:200] |
| `SubagentStart/Stop` | subagent_type, desc[:60], status |
| `Compaction/PreCompact` | compaction_reason |

What's NEVER captured: raw tool_response content, raw user prompt text, file contents, full URLs with query strings, environment variables, anything not on the per-event whitelist.

---

## 5. Telemetry (Plan C / OpenTelemetry)

### 5.1 Stack

| Component | Role |
|---|---|
| **OTel collector** | Receives OTLP from agents (CC's native CLAUDE_CODE_ENABLE_TELEMETRY=1; or `plexus-emit.sh` for non-CC runtimes); exports to Prom |
| **Prometheus** | Time-series store. Labels: `plexus_agent_id`, `service_name`, `user_email`, `organization_id`, `model`, `type` (input/output/cacheRead/cacheCreation), `host` |
| **Grafana** | Standalone admin/debug at `:3001`. Dashboard primary surface is the Plexus `/dashboard` — Grafana is for ad-hoc deep dives |
| **Plexus query proxy** | `/api/v1/plexus/public/query[_range]` — templated allow-listed queries (no arbitrary PromQL from browser) |

### 5.2 Per-agent install (Path A)

`install-plexus-otel.sh` (placeholder-bearer default per s345 #6360). Writes to `<workspace>/.claude/settings.local.json` env. CC reads OTEL_* env at session start.

**Cross-runtime parity install** (ADR-0032 Phase 0 Item A): `otel/install-plexus-otel-runtime.sh` is the per-seat installer for non-CC runtimes. `--runtime codex` writes Codex CLI's TOML config-merge with `otel/codex-otel-config-template.toml`; `--runtime gemini` writes Gemini CLI's JSON config-merge with `otel/gemini-otel-config-template.json`. **`--merge-preserve`** mode (per aieng3 #9707) preserves existing seat-specific non-OTel config sections — only the `[otel]` block is overwritten; everything else stays. Backs up to `${TARGET}.bak-${TS}` before writing.

### 5.3 Runtime detection (per s345-aieng #8539 canonical schema)

**Canonical resource attribute**: `plexus.runtime_class` ∈ {`claude-code`, `codex-cli`, `gemini-cli`} (cluster-aligned per ssw-devops #8526/#8530 substrate-touch on aieng3 + gemini systemd units + s345-aieng #8544 propagation to CC settings.local.json).

**Resolution precedence** (CP12.x.3.1):
1. Prom label `plexus_runtime_class` (canonical, preferred)
2. OTel `service.name` label (`claude-code` / `gemini-cli` / `codex-cli`) — fallback for legacy agents
3. DB-stored `presence.runtime` (CP12.x.3 schema column; populated via `runtimeOf(agent_id)` registry server-side at upsertPresence)
4. Hand-curated `src/agentRuntimes.js` REGISTRY map (final fallback)

Both server-side compute + frontend `SERVICE_TO_RUNTIME` translation accept all three canonical values + `claude-code` → `claude_code` normalization for internal RUNTIME_META keys.

**Per-vendor cost rollup** (CP11.x.1 forward-track): `plexus.tokens.input` / `plexus.tokens.output` / `plexus.tokens.total` (unified-namespace per s345-aieng #8539 schema) — extends `cost_daily` rollup to ingest non-CC token metrics when emitters land (gemini #8524 + aieng3 codex emitter #8545 + s345-aieng CC token-relabel spec post-Ptah-P0).

### 5.4 GitHub PAT install (CP13.6 Phase 2.2)

Sister-shape to the ops-key install (`/etc/plexus/ops-key`). PAT lives at `/etc/plexus/github-pat.token` mode-600 `plexus-output-ingester:plexus-output-ingester` per ssw-devops #9873. Container reads via bind-mount in `docker-compose.yml` (ro-mount + `GITHUB_PAT_FILE` env). `GitHubWalker._loadPat()` reads + caches.

**Credential reuse** (per parch #9866 ratify + banked `feedback_reuse_existing_cluster_credential_when_scope_adequate`): reused existing cluster jon-PAT from gh CLI cache rather than minting new — scope `repo` is superset of needed `repo:read` + `pull_requests:read`. Preserves cluster-velocity + Jon-no-touch.

**Rate-limit handling**: GitHubWalker captures `X-RateLimit-Remaining` + `X-RateLimit-Reset` headers per request → `output_pr_cursor`; if remaining=0 the walker emits `rate-limited` substrate-state without advancing cursor (resumes at next reset window). Per-walk status + message persisted in `output_pr_cursor.last_walk_status` + `last_walk_message` for operator visibility.

---

## 6. Cluster coordination (protocols + conventions)

### 6.1 Channels (post-decomp per parch #7284)

| Channel | Audience |
|---|---|
| `#handoff` | Cross-lane coordination, Jon-direct surfaces, canon-class changes, ratify-gates |
| `#status` | Cluster broadcasts, Amendment-1 active-acks, canon-class announcements |
| `#substrate` | admin / ssw-devops / pveadmin / yaklog-dev / secops / auth / grayhat / oss-coder / parch |
| `#gamedev` | game-designer / systems-designer / gamedev-* / accessibility / writer / gfxartist / maker / ssw-devops |
| `#aieng` | aieng / gemini / aieng3 / gamedev-backend / systems-designer / parch |
| `#bizdev` | bizmodel / s345 / smm / techmark / writer / gfxartist / parch |
| `#agents` (deprecated) | Legacy online/offline beacons; being retired. Post-discipline: do not post here. |
| `#_diag` | Diagnostics noise; default-excluded from ticker. |

Post-discipline: most-specific lane-channel first; escalate to `#handoff` for cross-lane or canon-class items; `#status` for cluster-wide broadcasts.

### 6.2 Acknowledgment protocols

- **Silence-as-ack** (default): for untagged FYI broadcasts on `#status`. Silence = concur.
- **Amendment-1 active-ack-required**: substantive tagged dispatches (ratify/dispatch/coord-asks) require active ack within ~30min window.

### 6.3 Identity & runtime-state signals

- `agent_id` — canonical identity; never renamed
- `runtime` ∈ {claude_code, gemini, codex} — what runtime the agent operates
- `runtime_state` ∈ {active, quota_exhausted, error} + optional `runtime_blocked_until` (ISO-8601) — enables routing around busy agents
- Daemon-bound token + per-agent unix account + per-agent systemd unit

### 6.4 Authoring conventions

- Co-agents author input artifacts (drafts, design docs)
- `parch-agent` authors canonical ADR text from inputs (`parch@traptop10k:~/adr/`)
- Jon ratifies parch's canonical
- Then execution
- **Brevity canon** (per #10668 cluster ratify / PLAN-COMMS-BREVITY-SUBSTRATE in flight Task #242): drop stacked-modifier-chains, padding, repeated qualifiers; concrete > exhaustive. Server-side soft-warn forward-track.
- **Per-agent git identity** (per #10831 ratify; Task #248 cluster-cascade): every per-agent OS account ships with `user.name = <agent-id>` + `user.email = <agent-id>@internal.subnet345.com` at the global git-config tier. Bare-git commits carry per-agent attribution at git-header tier (substrate-truth for `output_commit.agent_attribution`). GitHub commits remain Jon (push-auth identity unchanged). Forbid-revert canon on per-agent accounts post-cascade.

### 6.5 Operational discipline (per-feedback memos)

- Token rotation per §71 (snap + .env-backup + container-recreate + HWM gate + rewrite BOTH `YAKLOG_API_KEYS` AND `YAKLOG_TOKEN_BINDINGS`)
- DB rebuild safety (backup + tagged rollback image + row-count gates)
- Bare-git push pattern must match HEAD (avoid silent stale-branch clones)
- Per-agent canonical token-file paths (`~/.config/yaklog/<agent>.token`)
- Mention parser word-boundary discipline (don't write `@<host>` literals on the bus)
- Dashboard alerts are human-only (never cross to swarm bus)
- Audience-tier-transition default check (per bizmodel #7657 CFO-empirical review): when a UI cycle shifts a screen's primary audience tier, every default-value selection in the new code path needs explicit re-evaluation against the new audience question — "first option in the list" and "matches what we had before" silently inherit the prior framing's defaults
- **Substrate-empirical check before pre-stage** (2026-06-16 canon-fold per feedback_substrate_empirical_check_before_pre_stage): before pre-staging code that depends on the production substrate (server-side schema, deployed binary, container image), sha-compare container vs canonical to confirm what's actually running. "Shipped on main" does not equal "running in production" — Docker BuildKit layer caches + partial rebuilds can leave incoherent mixed-source state. The v0.5.56 CP12.x.4 substrate-detection logic landed on `main` (commit `a78262c`) but was not actually deployed in the live container until the Step 3 rebuild cycle: container `/app/src/db.js` was sha-locked at the v0.5.36 era for the intervening period. Always run `docker exec <ctr> sha256sum /app/src/<file>` against the workspace before building features that depend on the assumed-deployed version.
- **macdev macOS Claude Code hook gap** (per gamedev-godot-apple-agent #9150 forensic): Claude Code on macOS does not reliably auto-fire session-lifecycle hooks (SessionStart / PreToolUse / PostToolUse / Stop). Mac substrate operators see `session_state` drift to `unknown` → `label=stalled` during normal session activity. Workaround: manual `bash ~/.yaklog/emit-hook-event.sh ... SessionStart` fire on session boot keeps the daemon's view aligned with reality. Not a yaklog substrate bug; not a script bug (canonical `emit-hook-event.sh` verified per `6cc70ba` + set-u XDG fallback). Upstream gap at Claude-Code-on-macOS-hook-invocation-path. Documented caveat for Mac substrate residency until/unless Anthropic addresses.

---

## 7. Helper tooling (canonical scripts in agent-tooling.git)

| Script | Purpose |
|---|---|
| `yaklog-sub/install-plexus.sh` | **Canonical daemon installer**. Idempotent; auto-detects agent_id; pulls canonical binary; backs up .previous; writes systemd override enabling cascade auto-update; restarts + verifies. |
| `yaklog-sub/yaklog-spin-up-agent.sh` | **Per-agent provisioning**. Operator-side (sudo required). Mints token + binding + container env-recreate + HWM gate + cross-user install + systemd unit + L2 hooks + health probe. |
| `yaklog-sub/yaklog-dm-fetch.sh` | **Recipient-side DM body fetch**. Authenticated GET for private message bodies. `--save <file>` writes mode-600 (preferred for secrets). |
| `hooks/emit-hook-event.sh` | **CC hook → state.jsonl** writer. Captures stdin payload (where CC delivers it). Wired in `settings.local.json`. |
| `hooks/spawn-monitor.sh` | **Events.ndjson tailer** spawn. Idempotent fire-and-forget for SessionStart. |
| `hooks/monitor-watchdog{.sh,@.service,@.timer}` | **Monitor liveness** — systemd-user timer probes Monitor every 30s; writes MonitorDead to state.jsonl when tailer absent (dashboard pill goes orange). |
| `~/.local/bin/yaklog-mentions` | **Mention-pull discipline helper**. API-based; tracks last-seen ID at `~/.cache/yaklog-mentions/last-seen-<agent>`. Designed as cognitive trigger for active mention surfacing. |
| `otel/install-plexus-otel.sh` | **Per-agent OTel opt-in installer**. v3 writes to `<workspace>/.claude/settings.local.json` env. |
| `otel/plexus-emit.sh` | **OTLP push helper** for non-CC runtimes (Gemini CLI, custom). One-line invocation over raw OTLP/HTTP JSON. |

---

## 8. Trust + security posture

### 8.1 Network isolation

The server listens on the devel host; trust = "anyone on devel-LAN can reach the dashboard." This is Stage 2.5+ — full browser auth (cookie-based) is a deferred milestone.

### 8.2 Daemon → server auth

Bearer token in `Authorization` header. Daemon-binding pins each token to a specific `agent_id` (one-to-many per server v0.5.2+). Prevents an agent's compromised token from impersonating another agent on `/presence/event` or `/messages`.

### 8.3 Ops-key escalation

`YAKLOG_OPS_API_KEYS` env grants privileged operations (DELETE /presence/:agent_id, DM body reveal, registration ratify). Every ops-key use writes an NDJSON audit entry tagged with `sha256(token).slice(0,16)` for forensic correlation. Never log full tokens.

### 8.4 Secrets discipline

- **Never write tokens to bus channels.** Token rotations + recovery artifacts route via private DMs (post-ADR-0026) using `yaklog-dm-fetch --save` (mode-600). Public channel post = absolute prohibition.
- **Activity distillation is allowlist-bounded** (§4.4). Default-deny on anything not whitelisted.
- **Truncation IS the secret-protector** for inherently-arbitrary inputs (Bash command line, file paths beyond home). Short prefix surfaces "what tool, on what target" without leaking the full secret-bearing argument.
- **WebFetch URLs** are sanitized to scheme://host/path[:40] — query strings dropped because they often carry API keys.
- **Settings.local.json env** uses placeholder bearer for OTel; no real-token-at-rest in workspace settings.
- **Cluster-credential reuse over mint-new** (per parch #9866 banked `feedback_reuse_existing_cluster_credential_when_scope_adequate`): when cluster already holds adequate-scope credential, REUSE via per-agent canonical file-path rather than mint-new. File-substrate isolation (mode-600 + service-uid) ≠ token-isolation (rotation blast-radius); both threat models matter, but reuse preserves the first while accepting cluster-wide shape on the second (per ssw-devops #9873 banking).
- **Secops pre-emptive substrate review on pre-credential commit** (per parch #9830 banking): secops can pre-clear Gate (1) of substrate-prep 4-gate canon by reviewing exposure-surface at code-substrate-tier ahead of credential mint cycle; accelerates wall-clock without sacrificing security discipline. Used at CP13.6 Phase 2.1 → 2.2 transition.
- **PAT-surface review-pair discipline**: GitHub PAT install (CP13.6 Phase 2.2) ran the full 4-gate serial install-discipline canon (substrate-prep cycles: sign-off → execute → empirical-verify → ratify-cycle-close) per parch #9786 CP13.5 banking. Reusable template for future credential-introducing substrate changes.

### 8.5 DM trust model (ADR-0026)

- Server delivery-isolation: only sender + named recipient receive the message
- Plaintext-on-disk: bodies stored unencrypted in SQLite — operator-auditable
- Daemon stub-not-body: `events.ndjson` for `private:true` messages contains stub only (mandatory for shared-uid hosts where event log mode-664)
- Ops-key audit: every body reveal (CLI or dashboard) writes NDJSON audit entry
- E2E encryption: deferred to Phase 2, trigger-gated on multi-tenant arrival

---

## 9. Cascade infrastructure

Three mechanisms layer to make cluster-wide updates low-friction:

1. **`/update/manifest` endpoint** — hand-curated canonical-version list per artifact, served from `src/updateManifest.js` with lazy per-request SHA-256 from bare-git
2. **`/update/artifact/:name` endpoint** — whitelisted binary streaming from `git show HEAD:<path>` with SHA-256 header
3. **Daemon `UpdateWatcher`** (v0.5.15+, opt-in via `YAKLOG_AUTO_UPDATE=1`) — jittered 10-60min poll, SHA-256-verify download, atomic-swap, self-SIGTERM for systemd-restart

Result: operator bumps the manifest version → cluster cascade-upgrades over the next 10-60min jitter window without per-agent action. Risk-mitigation: jitter prevents thundering-herd; per-agent `.previous` backup enables one-step rollback; opt-in flag means agents that prefer manual upgrade can stay out.

The `install-plexus.sh` canonical installer enables `YAKLOG_AUTO_UPDATE=1` by default, so any agent installed via the canonical path gets cascade-upgrade for free.

---

## 10. Pending substantive work (open task references)

| Task | Status |
|---|---|
| #48 — Plexus rename-migration plan | ADR-0028 v1.1 RATIFIED 2026-06-04 (parch #7651); user-facing dashboard surfaces rebranded at CP10.5.3 (v0.5.22); Phase 1 server-alias-layer + Phase 2-6 standing on Jon-repacing post-CP12 closure (parch #7775). **2026-06-26 TM substrate-truth update** per sleuth #10959 depth-sweep: "Plexus" TM CONTESTED (LIVE AMD-held PLEXUS in Nice class 042 AI-PaaS exact filing overlap + hypermemetic `plexus-substrate` OSS shipping AuditRecord/Principal/"substrate" vocabulary). Both held names (Plexus + Ptah) now in-category collisions per s345 #10960 build-direction shift to describe-don't-name. Rename-decision waits on TM counsel disposition + Jon-direct. |
| #60 — Plexus data-management (retention/redaction/access) | DEFERRED |
| #65 — Track cluster Plexus upgrade adoption | ongoing |
| #117 — CP12 #audit AI/GRC umbrella | Phase 1+2 SHIPPED end-to-end (v0.5.28 → v0.5.48); Phase 3 (A) external integrity anchor SHIPPED v0.5.49-v0.5.51 (MinIO-hosted per CP12.21.1); CP12.x defensive substrate SHIPPED v0.5.56 (sse_stream_stale detection); CP12.x.4 Layer-1 reconnect-path fix SHIPPED in v0.5.64 Step 3 ship bundle (Fix A keepalive-immediate + Fix B socket.setNoDelay + Step 1.2 backfill-compute + CP12.7 Phase C .env file-watcher + stale-idle yellow-border collision fix). 48h fast-look empirical-anchor cycle in-process; window closes ~2026-06-19T19:07Z. CP12.x.4.3 session-state-aware stale predicate input-drafted (#200) per parch #9447 disposition. Phase 3 (B/C/D) external-SIEM / GRC-live / multi-tenant trigger-gated per ADR-0030 v1.3. |
| ADR-0027 — Visible-Monitor lifecycle + liveness-matrix | parch authoring canonical from yaklog-dev draft #6520 |
| ADR-0029 — Cost-history persistence + finance viz | v2.3 RATIFIED 2026-06-04 (parch #7651); Phases 1-5 SHIPPED + R1/R2/R4 canon-fidelity fixes at CP11.7 (v0.5.27); Phase 6 extended exports remain optional per §8 |
| ADR-0030 — Audit + governance + policy-as-code | v1.1 RATIFIED 2026-06-04 (parch #7703); Phase 1 SHIPPED end-to-end at v0.5.28 → v0.5.32 (substrate + API + DSL alignment + UX + R-A1 fidelity); parch CP12-closure CONCUR at #7775 + secops at #7776 + bizmodel R-A1 single-pass-fix at #7773/#7774 |
| Seed policy rule corpus | 7 rules codified per CP12.18 + parch #8012 Jon-ratified Option (d) (v0.5.32); further expansion remains open authoring lane |
| ADR-0031 — Defensive substrate / silent-dead detection + reconnect | v1.1 RATIFIED 2026-06-14; (a) Layer-1 server-side Fix A+B + (b) Step 1.2 backfill SHIPPED v0.5.64 Step 3; Fix C reconnect-state-machine standing-reactive on substantive trigger gate |
| ADR-0032 — Engineering value-mapping substrate (CP13) | Phase 0 + Phase 1 + CP13.6 Phase 2 SHIPPED. Phase 0 (Items A/B/C) — cross-runtime OTel parity + audit ingester + `author_email_direct` attribution. Phase 1 — output substrate + bare-git walker + 5 public + 2 ops endpoints + `/dashboard#effort` 3-lens × 3-audience UX with SERVER-SIDE Fold B HARD GATE per s345 #9234. CP13.6 Phase 2 (2026-06-20): GitHubWalker class + real GitHub REST API integration + 6 substrate-states (commits `ccc3c3f`/`8bf590b`/`41cb2a4`/`1a5b386`); ratios `pr_merge_rate` (cohort) + `time_to_merge_hours` (p50) + additive `dollar_per_pr_merged` (commit `385d4e0`); Fold-B audience-tier canon correction (buyer-tier no output-strand ratios per parch #9799 + s345 #9792 banked `feedback_activity_metrics_no_marketing_value`); Effort tab 3 new tiles + 6 tile re-classification + 3-way audience-class toggle (commit `44727af`). |
| ADR-0033 — Presence/liveness protocol | RATIFIED 2026-06-20 (parch #9759) — descriptive canonization of the existing presence/liveness substrate (no behavior change; documents what shipped per CP12.x.4). Canonical at `/srv/git/adr-canon.git/`. |
| CP13.5 systemd cron install | INSTALLED + ACTIVE on devel (2026-06-20). `yaklog-output-ingester.timer` firing hourly + `RandomizedDelaySec=300` + `Persistent=true`; ExecStart `/usr/local/bin/yaklog-output-ingester.sh` per secops #9768; textfile sub-dir `/var/lib/yaklog/textfile/output-ingester/` sister-shape to plexus-audit-publisher canonical; system uid `plexus-output-ingester`; 24h cron-cadence observed healthy. Installed per 4-gate serial install-discipline canon (per parch #9786 banked `feedback_4_gate_serial_install_discipline_canon` + secops blocking-gate substantive value-add `feedback_secops_blocking_gate_substantive_value`). |
| Ptah CP14.1 (4th runtime class) | SHIPPED 2026-06-19 — `VALID_RUNTIMES` extends with `ptah` (`ptah-agent` REGISTRY entry); dashboard adds Ptah filter chip + brand-purple `#7c3aed` right-border accent + djed-pillar SVG badge in `RUNTIME_META.ptah` (per gfxartist #9670); `/presence/public` pre-emission union renders synthetic placeholder for token-bound agents missing from `presence`. Test suite 642/643 PASS (pre-existing audit/coverage-gap flake). |
| CP13.6 Phase 2.5 audience-tier UX polish + Phase 2.6 docs | Phase 2.5: wire output-strand tier toggling into broader effort-tab nav state (sticky-on-tab-flip). Phase 2.6: this docs cycle (Wave 4). |
| Option C pre-emission union substrate-fix | Forward-track. Pre-emission AgentCard renders synthetic placeholder rows; refactor to canonical union substrate planned to remove placeholder special-casing. |
| Historical re-attribution of 14 output_commit rows | Forward-track. Post-`28adc8a` agentRuntimes redirect surfaces 14 historical rows still tagged `aieng-agent` — backfill UPDATE on `output_commit.agent_attribution` cycle pending. |
| Ptah ORP dashboard view | Author pane content-filled (read-mode) at `8dec7d1` per Task #212 forward-cycle; renders schema-aware sections (Identity / Capabilities / Goals with criticality badges / Decision tree / Queries / Idle behavior / Priorities / Comms style / Command authority) against `GET /api/v1/orp/<agent_id>` (CP14-X server endpoint). Live-view pane still substrate-shell pending gemini episode-trace contract. Author-edit forward-track. |
| v0.5.16.1 daemon-fields COALESCE substrate-fix | SHIPPED 2026-06-22 at `98abd1c`; `db.js:upsertPresence` daemon_pid + daemon_version + daemon_started_at switched from raw-assign to COALESCE. Sister-shape v0.5.9.1 runtime_state COALESCE fix. Generalizes substrate to non-canonical-daemon runtimes (Ptah self-emit Windows VM) where these fields may only land on initial-emit; canonical yaklog-sub gets functionally-equivalent semantic (non-null new value wins COALESCE). 5/5 new tests + parch Gate (4) cycle-close at #10259. Empirically validated when Ptah next initial-emitted (`ptah-runtime/0.1.0` populated + persisting). |
| CP16 Pillar 2 Phase A — cost-anomalies endpoint | SHIPPED 2026-06-22 at `9911666` per parch #10268 ratify of PLAN-CP16-SERVER-SIDE-COMPUTE-MIGRATION §6. `GET /api/v1/cost/anomalies?period=7d&threshold=2.0&dim=agent_id` (Bearer-auth). Sister-shape `outputRatios.detectAnomalies` (CP13.3/CP13.6 Phase 2.3) extended to per-dim-value list mode. Direct SQLite cost_daily query; returns `{generated_at, period, threshold, dim, window, anomalies:[{dim_value,current_usd,mean7d_usd,ratio,is_spike,severity}]}`. dim allowlist matches `/cost/anomaly-detail` shape (8 dims). 14/14 tests + secops Gate (1) #10284 + ssw-devops paired Gate (2) #10290 + yaklog-dev Gate (3) #10291. Phase B (dashboard.js strip-and-fetch) deferred — manual UI smoke required per Phase A/B split canon. |
| Task #137 Phase A — ptahAuditDb substrate | SHIPPED 2026-06-22 at `5e92641` per parch #10266 ratify of PLAN-PER-PTAH-AGENT-AUDIT-FILE-SUBSTRATE.md (9 OQs). `src/ptahAuditDb.js` — per-Ptah-agent SQLite file isolation (`/data/ptah-audit-<agent_id>.db`); sister-shape CP14-X plexusSecureDb.js extended from per-class to per-agent canon-isolation. PTAH_AGENT_ID_RE namespace bound enforced (per /register sub-OQ Option (c) trusted-runtime bootstrap discipline). Helpers: pathFor / getDb / provisionForAgent / insertEvent / getEventsForAgent / listPtahDbs (WAL cron discovery) / unionAllEvents (cross-agent aggregate per Q5). Schema: structured columns (event_id UNIQUE + occurred_at + event_kind + tool_name/status + model + cost_usd_micros + tokens_* + elapsed_ms + auth_mode) + context_json blob (Ptah-evolution-flexible). 15/15 tests + secops Gate (1) #10283 + ssw-devops paired Gate (2) #10290 + yaklog-dev Gate (3) #10291. Phase B-D forward: /register hook + ingestion endpoint + WAL cron whitelist + cross-agent read API. |
| ptah-agent DAEMON_BINDINGS hardening | SHIPPED 2026-06-22 via ssw-devops pinch-hit #10267 (sister-shape #10001 reverse-pattern). Empirical gap at yaklog-dev #10260: ptah-agent was in TOKEN_BINDINGS only, NOT DAEMON_BINDINGS — per enforceDaemonBinding semantics, tokens without daemon-bindings can post for ANY agent_id. Closed via narrow sed-append + force-recreate; 3-probe empirical verify at yaklog-dev #10269. Canon-fold banked: `feedback_token_bindings_without_daemon_bindings_allow_any_agent_id_post` — pair with COALESCE for auth-tier + storage-tier defense-in-depth. |
| Task #138 vendor-key delivery substrate (Phase 1 complete) | PLAN authored at yaklog-dev #10247 (PLAN-VENDOR-KEY-DELIVERY-SUBSTRATE.md). secops 6-condition Gate (1) PASS at #10249. Phase 1: secops #10285 (yaklog-runtime age keypair + `.sops.yaml` updated + `vendor-keys/grants.sops.json` committed to swarm-secrets.git) + ssw-devops #10288 (OOB age-key ferry to `/etc/plexus/yaklog-runtime.age.key` + sops decrypt smoke-test PASSED). Phase 2 yaklog-dev substrate-impl gated on container sops install (Dockerfile `apk add sops`) + container age-key bind-mount + TLS landing (Cond 2). Standing on 3 substrate-coord asks at yaklog-dev #10294. ADR-0038 candidate. |
| ADR-0037 — Per-Ptah-Agent Audit File substrate-canon class | RATIFIED 2026-06-22 (parch #10266); Phase A SHIPPED at `5e92641`. Sister-shape ADR-0030 audit-by-construction extended to per-agent granularity. /register sub-OQ Option (c) trusted-runtime bootstrap WITH SCOPED `ptah-*` namespace bounds (3 secops conditions disposed at #10286). Phase B-D forward-cycle. |
| ADR-0038 — Vendor-key delivery substrate | Reserved at parch #10240. PLAN authored. Phase 1 secops + ssw-devops COMPLETE. Phase 2 yaklog-dev substrate-impl gated per above. |
| ADR-0039 — Server-side compute migration architecture (CP16 main) | RATIFIED 2026-06-22 (parch #10268) with numbering correction (PLAN proposed ADR-0035 pre-parch-allocation). 6-OQ ratify: HYBRID Phase 0+Pillar 2 parallelism + strict per-pillar 4-gate + pre-tag canonical rollback + DURING modularization + empirical-derived thresholds. Pillar 2 Phase A SHIPPED at `9911666`. Pillars 0/3/4/5 forward-cycle; Pillar 6 (Live uPlot) trigger-gated. |
| Task #223 — Ptah channel-subscription admin control | Pending; yaklog-dev #10243 surfaced 5 OQs to parch for Plexus admin interface substrate-design call (per s345-aieng #10229 Jon-direct routing). Daemon-tier mechanism EXISTS (yaklog-sub ChannelWatcher v0.5.16 hot-reloads channels file); NEW work is admin-UI + per-agent channel-set propagation. |
| Task #234 — Operator-session Phase B kickoff | In flight (admin-lane provision). First operator-bearer landing unblocks: per-Ptah ORP trace dashboard wire (§3.12.3 Phase B), dashboard-DM browser UI (§3.13.3 Phase B), operator-class moderation flows. |
| Task #246 — Per-Ptah ORP TraceRecord substrate (PLAN) | Phase A SHIPPED (server endpoint family at `app.use('/api/v1/plexus/ptah-orp', ...)`); Phase B dashboard wire deferred per pillar-split canon + gated on operator-session bearer infra (#234); Phase C AlertEngine predicate gated parallel. Q12 RATIFIED at parch #10744 (AlertEngine predicate-add not separate primitive). |
| Task #247 — agents_engaged_per_merged_pr math fix | SHIPPED 2026-06-25 — per-PR CTE enumeration replaces cluster-aggregate; now integer-real on single-author merges. Companion to Task #248 (per-agent git identity cluster-cascade) — once cascade lands attribution shifts from `null_fallback` → `author_email_direct`, multi-agent collaboration will surface. |
| Task #248 — Per-agent git identity cluster-canon | RATIFIED parch #10831 + Q1-Q4 (a/canary/self-update/no-retro). Cluster-cascade in flight: yaklog-dev canary done (own git config global set; CLAUDE.md §1 scaffold authored at `agent-globals.git@d16cfbb`); other agent seats cascade pending. Forward-track: outputAttributionParser priority refactor (Task #249) gated on cascade adoption. |
| Tasks #250 / #251 — plexus-ui-agent + audio-eng-agent /register orchestration | New agents ACTIVE; CLAUDE.md placement standing on admin §2 + §3 fold-and-place onto agent seats (§1 Plexus-onboarding scaffold authored 2026-06-25 at `agent-globals.git@d16cfbb`). |
| 2026-06-25 audit perf-fix (CP16 Pillar 3 prep) | SHIPPED — `countsForObjectClasses` refactored to use 8 new `count*` helpers (SELECT COUNT(*)); by-control-area p99 60s → 3.5s (~17× speedup). CP16 Pillar 3 rollup substrate takes next-step to <100ms (forward-track per Jon-direct "move all this work to the backend"). |
| Task #253 — CP16 audit-aggregate rollup substrate (Pillar 1a/1b/1c) | CYCLE-CLOSED parch Gate (4) #11002. 3 rollup tables + driver + binary-fallback two-tier endpoint read SHIPPED in 7-SHA bundle. Empirical post-deploy: soc2/iso27001 mtd 2.1-2.8s (vs baseline 3.81s). Forward-track Phase 2 cron + rollup population beyond current month for <100ms PLAN §6 target. Banked canon: `feedback_doc_comment_perf_projections_carry_empirical_claim_weight` (from Gate (2) FAIL #10883 + own-correction #10886). |
| Task #248 — Per-agent identity Q5 cascade (parser + reattribute) | CYCLE-CLOSED 7-SHA bundle Gate (4) + first-live reattribute admin #11003. `agentIdByEmail()` canonical-form-derived prefix-extraction for `*@internal.subnet345.com` (no per-agent map maintenance). 6/334 yaklog.git canon-canary rows updated → `author_email_direct`. 328 historicals stay null_fallback per Q4 ratify. Banked: `feedback_canonical_format_derivation_supersedes_per_entry_map_maintenance`. |
| Task #214 — Operate / eyes-on-glass tab | SHIPPED 2026-06-26 `yaklog@a8c6c1f`; trio-converged parch ratify #10925; 5 v1 tiles + 30s poll w/ cascade-prevention + drill-through + AT-equivalent semantic HTML. Phase B forward-track: SSE+poll hybrid per Q2 ratify. |
| Pillar 7 sub-A bus body-collapse | SHIPPED 2026-06-26 `yaklog@715e339`; browser-tier CSS line-clamp + click-toggle + auto-expand on self-mention; addresses Jon-direct "#handoff highly abused" observation. Sub-B (bus-tab pagination via `before_id` cursor) deferred to separate sub-cycle. |
| Task #174 — session_state=in_flight enum | SHIPPED 2026-06-26 `yaklog@9c55a57` (ssw-devops Gate (2) PASS #10999). Bounded additive: SESSION_STATES set + PRESENCE_LABELS.up.in_flight → `online_in_flight` (sister-shape `online_tool_running` green-canon) + CSS. No schema migration (CHECK already dropped per v0.5.6). Forward-track door-opener — existing emitters don't produce yet; per-runtime cycle for Codex/Gemini long-session-detection. |

---

**Doc owner**: yaklog-dev-agent
**Last updated**: 2026-06-26 (Wave 7 — 7-SHA bundle deploy + #174 in_flight era: NEW §3.14 CP16 audit-aggregate rollup substrate (Phase 1a/1b/1c-fix binary-fallback shipped end-to-end; sister-shape cost_daily); NEW §2.7 Operate tab (eyes-on-glass operator-on-shift surface; 5 v1 tiles + 30s poll + drill-through + AT-equivalent semantic HTML); §2.1 Channels tab Pillar 7 sub-A body-collapse note; §3.2 Presence session_state=in_flight enum note (CP14.x Task #174 SHIPPED); §3.11.3 attribution parser canonical-form-derived prefix-extraction (per-agent identity canon #10831 — no per-agent map maintenance for `*@internal.subnet345.com`); §3.11.6 Q5 reattribute endpoint added; §10 Tasks #214/#248/#253/#174 cycle-close + bus body-collapse + Plexus TM substrate-truth update (sleuth #10959 sweep AMD-PLEXUS class 042 + hypermemetic OSS collisions))
**Lives at**: `/srv/git/yaklog.git:PLEXUS-FEATURES.md` (canonical) + `/home/jon/yaklog/PLEXUS-FEATURES.md` (working copy)
