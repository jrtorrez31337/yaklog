#!/usr/bin/env bash
# yaklog-emit.sh — push one OTLP metric (or log) to the Yaklog collector
# from a non-Claude-Code runtime (Gemini CLI, Codex, custom wrappers, etc).
#
# CC has a native OTel exporter; runtimes that don't (e.g. Google Gemini CLI)
# need to emit OTLP/HTTP directly. This helper hides the JSON-payload shape
# behind a one-line invocation that the runtime's wrapper script can call.
#
# Usage:
#   yaklog-emit.sh <metric-name> <kind> <value> [attr=value ...]
#     kind ∈ {counter, gauge}
#     metric-name dots are auto-underscored at Prom export
#     attrs become DATA-POINT attributes (analytical slicing dims)
#
#   yaklog-emit.sh --log <severity> <body-text> [attr=value ...]
#     severity ∈ {trace, debug, info, warn, error, fatal}
#
#   yaklog-emit.sh --dry-run …    # print payload + curl, don't POST
#
# Resource attributes (agent identity) come from env, set ONCE by the
# calling runtime's launcher:
#   YAKLOG_AGENT_ID       e.g. gemini-agent
#   YAKLOG_CLUSTER_ID     default ssw-dev
#   YAKLOG_DEPLOYMENT     default devel
#   YAKLOG_SERVICE_NAME   e.g. gemini-cli   (free-form; analogous to CC's "claude-code")
#   YAKLOG_OTLP_ENDPOINT  default http://192.168.122.76:4328
#   YAKLOG_TOKEN          reused as OTLP Bearer (no separate credential)
#
# Examples:
#   # counter: gemini hit Google's quota cap
#   yaklog-emit.sh gemini.quota_exhausted counter 1 \
#     model=gemini-2.5-pro reset_seconds=13200
#
#   # gauge: how many minutes until quota resets
#   yaklog-emit.sh gemini.quota_reset_seconds gauge 13200 model=gemini-2.5-pro
#
#   # log line tied to the same resource attrs
#   yaklog-emit.sh --log warn "Gemini CLI exited status 1: QUOTA_EXHAUSTED" \
#     model=gemini-2.5-pro reset_seconds=13200
#
# Exit codes:
#   0  posted (HTTP 2xx)
#   1  bad usage / missing env
#   2  Yaklog collector returned non-2xx (body printed to stderr)

set -euo pipefail

YAKLOG_OTLP_ENDPOINT="${YAKLOG_OTLP_ENDPOINT:-http://192.168.122.76:4328}"
YAKLOG_CLUSTER_ID="${YAKLOG_CLUSTER_ID:-ssw-dev}"
YAKLOG_DEPLOYMENT="${YAKLOG_DEPLOYMENT:-devel}"
YAKLOG_SERVICE_NAME="${YAKLOG_SERVICE_NAME:-unknown}"

err() { printf 'yaklog-emit: %s\n' "$*" >&2; }

if [[ -z "${YAKLOG_AGENT_ID:-}" ]]; then
  err "YAKLOG_AGENT_ID env var required"
  exit 1
fi
if [[ -z "${YAKLOG_TOKEN:-}" && -r "$HOME/.config/yaklog/token" ]]; then
  YAKLOG_TOKEN="$(cat "$HOME/.config/yaklog/token")"
fi
if [[ -z "${YAKLOG_TOKEN:-}" ]]; then
  err "YAKLOG_TOKEN env var (or ~/.config/yaklog/token) required for OTLP Bearer"
  exit 1
fi

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=1; shift; fi

NOW_NS=$(date +%s%N)

# Build resource-attrs block (JSON array of {key, value: {stringValue}}).
# Resource attrs = stable identity per emitter process. Match the CC recipe.
build_resource_attrs() {
  cat <<EOF
[
  {"key": "yaklog.agent_id",   "value": {"stringValue": "${YAKLOG_AGENT_ID}"}},
  {"key": "yaklog.cluster_id", "value": {"stringValue": "${YAKLOG_CLUSTER_ID}"}},
  {"key": "yaklog.deployment", "value": {"stringValue": "${YAKLOG_DEPLOYMENT}"}},
  {"key": "service.name",      "value": {"stringValue": "${YAKLOG_SERVICE_NAME}"}}
]
EOF
}

# Parse key=value pairs into OTLP attribute JSON. Auto-types: int-like → intValue, else stringValue.
build_kv_attrs() {
  local out="["
  local first=1
  for kv in "$@"; do
    local k="${kv%%=*}"
    local v="${kv#*=}"
    if [[ "$first" -eq 0 ]]; then out+=","; fi
    first=0
    if [[ "$v" =~ ^-?[0-9]+$ ]]; then
      out+="{\"key\":\"$k\",\"value\":{\"intValue\":\"$v\"}}"
    elif [[ "$v" =~ ^-?[0-9]+\.[0-9]+$ ]]; then
      out+="{\"key\":\"$k\",\"value\":{\"doubleValue\":$v}}"
    else
      # Escape backslash + quotes for JSON string safety
      local esc="${v//\\/\\\\}"
      esc="${esc//\"/\\\"}"
      out+="{\"key\":\"$k\",\"value\":{\"stringValue\":\"$esc\"}}"
    fi
  done
  out+="]"
  printf '%s' "$out"
}

post_payload() {
  local path="$1"
  local payload="$2"
  if (( DRY_RUN )); then
    echo "=== yaklog-emit DRY-RUN ==="
    echo "POST ${YAKLOG_OTLP_ENDPOINT}${path}"
    echo "Authorization: Bearer <REDACTED>"
    echo "Content-Type: application/json"
    echo "$payload" | python3 -m json.tool 2>/dev/null || echo "$payload"
    return 0
  fi
  local resp http
  resp="$(mktemp)"
  http=$(curl -sS -o "$resp" -w '%{http_code}' \
    -X POST "${YAKLOG_OTLP_ENDPOINT}${path}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${YAKLOG_TOKEN}" \
    --data-binary @- <<<"$payload")
  if [[ "$http" =~ ^2 ]]; then
    rm -f "$resp"
    return 0
  fi
  err "OTLP POST failed: HTTP $http"
  cat "$resp" >&2
  rm -f "$resp"
  return 2
}

# ── logs path ─────────────────────────────────────────────────────────
if [[ "${1:-}" == "--log" ]]; then
  shift
  SEVERITY="${1:?usage: --log <severity> <body> [attr=val ...]}"; shift
  BODY="${1:?usage: --log <severity> <body> [attr=val ...]}"; shift
  case "$SEVERITY" in
    trace) SEV_NUM=1  ;;
    debug) SEV_NUM=5  ;;
    info)  SEV_NUM=9  ;;
    warn)  SEV_NUM=13 ;;
    error) SEV_NUM=17 ;;
    fatal) SEV_NUM=21 ;;
    *)     err "unknown severity: $SEVERITY"; exit 1 ;;
  esac
  RES_ATTRS="$(build_resource_attrs | tr -d '\n' | tr -s ' ')"
  KV_ATTRS="$(build_kv_attrs "$@")"
  BODY_ESC="${BODY//\\/\\\\}"
  BODY_ESC="${BODY_ESC//\"/\\\"}"
  PAYLOAD=$(cat <<EOF
{"resourceLogs":[{"resource":{"attributes":${RES_ATTRS}},"scopeLogs":[{"scope":{"name":"yaklog.emit"},"logRecords":[{"timeUnixNano":"${NOW_NS}","observedTimeUnixNano":"${NOW_NS}","severityNumber":${SEV_NUM},"severityText":"$(echo "$SEVERITY" | tr a-z A-Z)","body":{"stringValue":"${BODY_ESC}"},"attributes":${KV_ATTRS}}]}]}]}
EOF
)
  post_payload "/v1/logs" "$PAYLOAD"
  exit $?
fi

# ── metrics path ──────────────────────────────────────────────────────
METRIC_NAME="${1:?usage: yaklog-emit.sh <metric-name> <counter|gauge> <value> [attr=val ...]}"; shift
KIND="${1:?missing kind (counter|gauge)}"; shift
VALUE="${1:?missing value}"; shift

RES_ATTRS="$(build_resource_attrs | tr -d '\n' | tr -s ' ')"
KV_ATTRS="$(build_kv_attrs "$@")"

# Choose numeric type field by integer-ness
if [[ "$VALUE" =~ ^-?[0-9]+$ ]]; then
  VAL_FIELD="\"asInt\":\"$VALUE\""
elif [[ "$VALUE" =~ ^-?[0-9]+\.[0-9]+$ ]]; then
  VAL_FIELD="\"asDouble\":$VALUE"
else
  err "value must be integer or float: $VALUE"; exit 1
fi

case "$KIND" in
  counter)
    METRIC_BODY=$(cat <<EOF
"sum":{"dataPoints":[{${VAL_FIELD},"startTimeUnixNano":"${NOW_NS}","timeUnixNano":"${NOW_NS}","attributes":${KV_ATTRS}}],"aggregationTemporality":2,"isMonotonic":true}
EOF
)
    ;;
  gauge)
    METRIC_BODY=$(cat <<EOF
"gauge":{"dataPoints":[{${VAL_FIELD},"timeUnixNano":"${NOW_NS}","attributes":${KV_ATTRS}}]}
EOF
)
    ;;
  *)
    err "unknown kind: $KIND (use counter or gauge)"
    exit 1
    ;;
esac

PAYLOAD=$(cat <<EOF
{"resourceMetrics":[{"resource":{"attributes":${RES_ATTRS}},"scopeMetrics":[{"scope":{"name":"yaklog.emit"},"metrics":[{"name":"${METRIC_NAME}",${METRIC_BODY}}]}]}]}
EOF
)

post_payload "/v1/metrics" "$PAYLOAD"
