#!/usr/bin/env bash
# Yaklog per-agent OTel opt-in env template — Stage 1.
#
# Copy-paste the BLOCK below into the shell/env that launches `claude` for
# your agent. Profile C minus TOOL_CONTENT (CC beta-tracing-gated; add later
# when org allowlist available) is the enterprise default per Plan C
# Q4 ratify (Jon-direct 2026-05-24).
#
# What this captures:
#   ✓ Token usage + USD cost (per request, per model)
#   ✓ Per-tool latency + success/error
#   ✓ User prompt text (OTEL_LOG_USER_PROMPTS=1)
#   ✓ Bash commands + tool args (OTEL_LOG_TOOL_DETAILS=1)
#   ✓ Full API response JSON (OTEL_LOG_RAW_API_BODIES=1)
#   ✗ Tool input/output bodies in spans (OTEL_LOG_TOOL_CONTENT needs beta-tracing)
#
# Privacy posture: this is the FULL enterprise data capture per Yaklog
# positioning. Data lands in the Yaklog collector + Prom + Grafana on devel
# (~/yaklog otel-stack). Customer data does NOT leave the devel boundary
# under Stage 1 default config. Data-management mechanism (retention,
# redaction, access-control) deferred to future workstream w/ s345-agent.
# See PLAN-C-OTEL-DESIGN.md §6 + task #60.
#
# Substitute <YOUR-AGENT-ID> (e.g. parch-agent, writer-agent) below.

# === BEGIN COPY-PASTE BLOCK ============================================
export CLAUDE_CODE_ENABLE_TELEMETRY=1

# Where to push (OTLP/HTTP). Stage 1: collector accepts any Bearer; auth is
# network-isolation (devel LAN). If you're not on devel LAN, OTel push will
# fail silently — that's fine, your CC session still works.
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT=http://192.168.122.76:4328

# Reuse your yaklog API token as the OTel Bearer (Plan C Q3 ratify;
# acceptable trade-off because Yaklog collector is in the API trust
# boundary). Assumes you have $YAKLOG_TOKEN exported OR a token file
# at ~/.config/yaklog/token.
if [[ -z "${YAKLOG_TOKEN:-}" && -r ~/.config/yaklog/token ]]; then
  export YAKLOG_TOKEN="$(cat ~/.config/yaklog/token)"
fi
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer ${YAKLOG_TOKEN}"

# Per-agent identity binding via resource attributes (yaklog.agent_id labels
# every metric/event with your agent_id so Grafana panels can filter).
# REPLACE <YOUR-AGENT-ID> below with your actual yaklog agent_id.
export OTEL_RESOURCE_ATTRIBUTES="yaklog.agent_id=<YOUR-AGENT-ID>,yaklog.cluster_id=ssw-dev,yaklog.deployment=devel"

# Exporters: metrics + logs to OTLP. Traces deferred (CC beta-tracing gate).
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_TRACES_EXPORTER=none

# Profile C minus TOOL_CONTENT — enterprise full-data-capture default.
export OTEL_LOG_USER_PROMPTS=1
export OTEL_LOG_TOOL_DETAILS=1
export OTEL_LOG_RAW_API_BODIES=1
# OTEL_LOG_TOOL_CONTENT=1  # uncomment when CC beta-tracing org-allowlisted
# CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1  # ditto

# Cardinality knob: keep session_id off Prom labels (sessions are
# unbounded; would explode cardinality at scale).
export OTEL_METRICS_INCLUDE_SESSION_ID=false

# Export intervals (defaults; explicit for visibility)
export OTEL_METRIC_EXPORT_INTERVAL=60000   # 60s
export OTEL_LOGS_EXPORT_INTERVAL=5000      # 5s
# === END COPY-PASTE BLOCK ==============================================

# Verification commands once your CC session has run for ~5min:
#   Yaklog Prom query:
#     curl -s 'http://192.168.122.76:9090/api/v1/query?query=claude_code_token_usage_total' | jq .
#   Yaklog Grafana dashboard:
#     open http://192.168.122.76:3001/d/yaklog-hello-world
#     (login admin/yaklog-stage-1; change in CP4 hardening)
