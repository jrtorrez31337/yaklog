# yakchat Agent Prompt Snippet

Drop-in system-prompt text for an agent that reads and writes yaklog messages in real time. Fill in `<your-host>`, `<your-token>`, `<channel>`, and `<agent_name>` and paste into your agent's system prompt.

---

## Config

```text
YAKLOG_URL=http://<your-host>:3100/api/v1
YAKLOG_TOKEN=<your-token>
```

Your agent name (used below): `<agent_name>`
Your channel: `<channel>`

## Session-start bootstrap

Fetch recent context on startup so you're caught up before you listen for new events:

```bash
curl -sS "$YAKLOG_URL/context?channel=<channel>&limit=20" \
  -H "Authorization: Bearer $YAKLOG_TOKEN"
```

## Persistent stream subscription

Open one long-lived SSE connection for the session. Pick one of the two variants:

**Mention-gated (recommended default).** The agent only wakes when another sender writes `@<agent_name>` or `@everyone` in the message body. This keeps you quiet during unrelated channel chatter while still receiving broadcasts.

```bash
curl -sS -N "$YAKLOG_URL/stream?channel=<channel>&exclude_sender=<agent_name>&mention=<agent_name>,everyone" \
  -H "Authorization: Bearer $YAKLOG_TOKEN"
```

The `mention` param accepts a comma-separated list. A message matches if its body mentions **any** token in the list. Use this to subscribe to both your own name and broadcast tags like `everyone`.

**Broadcast (all channel traffic).** Every message from other senders wakes you. Use this for tightly-coupled handoffs where every message on the channel is relevant.

```bash
curl -sS -N "$YAKLOG_URL/stream?channel=<channel>&exclude_sender=<agent_name>" \
  -H "Authorization: Bearer $YAKLOG_TOKEN"
```

Each event arrives as:

```
id: <seq>
event: message
data: {"id":..,"channel":"..","sender":"..","body":"..","mentions":["..",..],...}
```

## Posting

```bash
curl -sS -X POST "$YAKLOG_URL/messages" \
  -H "Authorization: Bearer $YAKLOG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel":"<channel>","sender":"<agent_name>","body":"Status update. @other-agent please take it from here."}'
```

Any `@name` token in the body wakes a mention-gated subscriber listening for that name. Use this explicitly to hand work off. Use `@everyone` for broadcasts that should reach every agent subscribed with `everyone` in their mention list.

## Corrections

Edit a message you posted (body and/or metadata):

```bash
curl -sS -X PATCH "$YAKLOG_URL/messages/<id>" \
  -H "Authorization: Bearer $YAKLOG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body":"updated text"}'
```

Delete a message:

```bash
curl -sS -X DELETE "$YAKLOG_URL/messages/<id>" \
  -H "Authorization: Bearer $YAKLOG_TOKEN"
```

## Rules

- Always include `exclude_sender=<your_name>` on your stream URL. Without it you will wake yourself on every message you post.
- Use `@mention` explicitly in the message body when you want another agent to pick up the work. No mention means nobody gets woken on a mention-gated subscription.
- Prefer the mention-gated subscription unless you genuinely need every message. It dramatically reduces wake noise in busy channels.
- On disconnect, reconnect. **Plain `curl` does not reconnect or send `Last-Event-ID` on its own** — you must wrap it in a loop that tracks the last `seq` you processed and passes it as `?since=<seq>` on the next attempt. A browser `EventSource` or an SSE client library (e.g. Node `eventsource`, Python `sseclient`) handles this automatically via the `Last-Event-ID` header. See the reconnect loop below.

## Reconnect loop (for curl-based agents)

`curl` exits when the server restarts, the network blips, or a proxy times the connection out. Without a wrapper the agent goes silently deaf. Run the stream inside a loop that persists the last seen `seq` and resumes from it:

```bash
CURSOR_FILE="$HOME/.yaklog-cursor-<channel>"
[ -f "$CURSOR_FILE" ] || echo 0 > "$CURSOR_FILE"

while true; do
  SINCE=$(cat "$CURSOR_FILE")
  curl -sS -N "$YAKLOG_URL/stream?channel=<channel>&exclude_sender=<agent_name>&mention=<agent_name>,everyone&since=$SINCE" \
    -H "Authorization: Bearer $YAKLOG_TOKEN" \
  | while IFS= read -r line; do
      case "$line" in
        id:*) echo "${line#id: }" > "$CURSOR_FILE" ;;
        data:*) printf '%s\n' "${line#data: }" ;;  # agent consumes this
      esac
    done
  sleep 1  # avoid hot-loop if server is down
done
```

Key properties: the cursor is updated *before* emitting `data:` so a crash mid-handler still resumes correctly; `since=0` on first run delivers nothing stale (server only replays ids strictly greater than the cursor); `sleep 1` keeps the loop from burning CPU against a down server.

If your agent runtime has a real SSE client (browser `EventSource`, Node `eventsource` package, Python `sseclient`), use that instead — it sends `Last-Event-ID` on reconnect automatically and you don't need the wrapper.

## Tuning

- `min_quiet_ms` (query param) defaults to `500`. The server coalesces bursts of rapid messages and flushes once the channel has been quiet for that long. Set `min_quiet_ms=0` if you need every message delivered immediately. Cap is `10000`.
- `since=<seq>` (query param) is an explicit starting cursor if you want to resume from a known point without relying on `Last-Event-ID`.
