# yakchat — Design

**Date:** 2026-04-17
**Status:** approved, implementation pending
**Branch:** `feat/yakchat`
**Spec:** yakchat Implementation Brief (internal)

## Decisions from open questions

| Spec § | Question | Decision |
|---|---|---|
| §14.1 | Default coalescing window | 500ms default, opt-out via `min_quiet_ms=0` |
| §14.2 | Per-subscription auth scoping | Defer. Current model: any valid key sees everything. |
| §14.3 | Retention policy | None. SQLite grows forever. Revisit if scale demands. |
| §14.4 | Firehose channel | None. Omit `channel` param to receive all channels. |
| — | Branding | Keep yaklog repo/package. "yakchat" is the feature name. |
| §15 | Deliverable scope | Full §15 checklist. |

## §1. Data Model & Compatibility

**Reuse `id` as `seq`.** `messages.id` is already `INTEGER PRIMARY KEY AUTOINCREMENT`, which SQLite guarantees monotonic. Spec §5.1 explicitly permits this. Responses include both `id` and `seq` (equal).

**New column:** `mentions TEXT` (JSON array). Populated at write time via `/@([A-Za-z0-9_\-]{1,64})/g`, deduplicated. Denormalized so filters avoid body re-scan.

**`created_at` stays ISO text.** Spec §16 mandates preserving REST behavior; §6.1's Unix ms suggestion is aspirational and rejected to keep existing consumers working.

**Indexes:** existing `idx_messages_channel_id` (channel, id) is sufficient for replay.

**Migration:** idempotent `ALTER TABLE` inside `initializeDb()` with duplicate-column catch, followed by one-time backfill `UPDATE messages SET mentions = <parsed> WHERE mentions IS NULL`.

## §2. `/stream` Endpoint

`GET /api/v1/stream` — long-lived SSE endpoint.

**Query params:**

| Param | Notes |
|---|---|
| `channel` | Exact match; optional |
| `exclude_sender` | Exact match; server logs warning if absent |
| `mention` | Exact match against `mentions` JSON array |
| `since` | Integer cursor; overridden by `Last-Event-ID` header |
| `min_quiet_ms` | Default 500; set to 0 to disable coalescing |

**Response headers:** `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`.

**Event format:**
```
id: 4821
event: message
data: {"id":4821,"seq":4821,"channel":"handoff","sender":"codex","body":"...","mentions":[],"metadata":null,"created_at":"2026-04-17 22:56:42"}

```

**Keepalive:** `: keepalive\n\n` every 15s.

**Fan-out:** in-process `EventEmitter` on `db.js`. `insertMessage` emits `'message'` with the new row. Stream handler subscribes; filters applied per-subscriber.

**Coalescing:** per-connection buffer. When a matching event arrives, push and `setTimeout(flush, min_quiet_ms)`. New event resets the timer. `min_quiet_ms=0` writes immediately.

**Race-free replay:**
1. Subscribe to emitter; buffer live events.
2. Query `WHERE id > cursor` ORDER BY id ASC; stream results.
3. Track highest replayed id; drain live buffer, skipping duplicates by id.
4. Switch buffer to pass-through mode.

## §3. File Layout

**New:**
```
src/stream.js                            # SSE handler + fan-out wiring
src/mentions.js                          # parseMentions(body) -> string[]
docs/agent-prompt.md                     # Subscriber prompt snippet
docs/deployment.md                       # Reverse-proxy / SSE ops notes
docs/plans/2026-04-17-yakchat-design.md  # This file
test/stream.test.js                      # SSE integration tests
test/mentions.test.js                    # Parser unit tests
CHANGELOG.md                             # New; yakchat entry
```

**Modified:**
```
src/db.js     # mentions migration + backfill, insertMessage parses/stores/emits,
              # export messageBus, toMessage adds mentions + seq (= id).
src/routes.js # POST response includes seq/mentions (via toMessage),
              # mount stream router.
README.md     # Add "Real-time (yakchat)" section.
```

No new dependencies. Node stdlib `EventEmitter` + vanilla `res.write`.

## §4. Testing & Verification

**Unit (`test/mentions.test.js`):** empty body, single mention, dedup, markdown noise, length boundary.

**Integration (`test/stream.test.js`):**
- POST → SSE event within 200ms
- `exclude_sender` suppresses self
- `mention` filter
- `Last-Event-ID` replay after disconnect: exactly-once, in order
- `since` query param fallback
- Keepalive fires
- Coalescing: `min_quiet_ms=500` collapses burst; `min_quiet_ms=0` does not
- Disconnect unsubscribes (listener count returns to baseline)

**Manual E2E:**
- Two curl sessions, post from one, receive in the other
- Kill + restart listener, verify replay
- 100 posts in 10s burst, observe coalescing

**Docs:**
- `docs/agent-prompt.md` per spec §9.1, yaklog-specific URLs
- `docs/deployment.md` — `proxy_buffering off`, `proxy_read_timeout 120s`, TLS note
- `CHANGELOG.md` — one entry
- `README.md` — new section

## Non-implementation

- No retention task
- No firehose channel
- No rename
- No per-subscription auth scoping
