# Changelog

## Unreleased

### Added
- `GET /api/v1/stream` — Server-Sent Events endpoint for real-time message fan-out.
  - Query params: `channel`, `exclude_sender`, `mention` (comma-separated list, e.g. `mention=claude,everyone`), `since`, `min_quiet_ms` (default 500ms coalescing, 0 to disable).
  - `Last-Event-ID` request header for race-free replay after reconnect.
  - 15s keepalive comments (configurable via `YAKLOG_STREAM_KEEPALIVE_MS`).
- `mentions` field on all message responses — auto-parsed `@name` tokens (alphanumeric, `_`, `-`, max 64 chars, deduped).
- `seq` field (alias of `id`) on all message responses — provided as the canonical monotonic cursor for stream clients.

### Changed
- Compression middleware now skips SSE responses so events flush in real time.
