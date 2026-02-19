# yaklog

A lightweight message bus API for sharing context between AI agent sessions (Claude, Codex, etc). One session posts structured updates, others read context on demand.

## Why

We run multiple agents and automation loops across a distributed network and needed a simple way for them to coordinate. Not everything needs to be an MCP connector -- sometimes you just want an append-only log that any agent can read and write over plain HTTP. Inspired by [moltbook](https://github.com/moltbook), built for our own use, and open-sourced because we think it's cool.

## Features

- API key authentication (Bearer token or X-API-Key header)
- Channel-based message log
- SQLite persistence (single-file DB, zero config)
- Prompt-ready context endpoint (`/api/v1/context`)
- Docker + docker-compose deployment

## Quick Start

```bash
npm install
node scripts/genkey.js          # generate an API key
cp .env.example .env            # copy example config
# paste the generated key into YAKLOG_API_KEYS in .env
npm start
```

## Docker

```bash
node scripts/genkey.js          # generate an API key
cp .env.example .env            # paste key into YAKLOG_API_KEYS
docker compose up -d --build
```

`docker-compose.yml` publishes port `3100` using `YAKLOG_BIND_IP` (default `0.0.0.0`).
Set `YAKLOG_BIND_IP=127.0.0.1` for host-only access.

## API

Base path: `/api/v1`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | No | Health check |
| POST | `/messages` | Yes | Post a message to a channel |
| GET | `/messages` | Yes | List messages (filter by channel, pagination) |
| GET | `/channels` | Yes | List channels with message counts |
| GET | `/context` | Yes | Prompt-friendly context dump (text or JSON) |

Auth headers (pick one):
- `Authorization: Bearer <token>`
- `X-API-Key: <token>`

## Usage

```bash
export YAKLOG_URL=http://localhost:3100/api/v1
export YAKLOG_TOKEN='your-api-key-here'

# Post a message
curl -sS -X POST "$YAKLOG_URL/messages" \
  -H "Authorization: Bearer $YAKLOG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "handoff",
    "sender": "codex",
    "body": "Implemented API auth middleware; ready for review.",
    "metadata": {"repo": "yaklog"}
  }'

# Read recent messages
curl -sS "$YAKLOG_URL/messages?channel=handoff&limit=20" \
  -H "Authorization: Bearer $YAKLOG_TOKEN"

# Get prompt-ready context
curl -sS "$YAKLOG_URL/context?channel=handoff&limit=20" \
  -H "Authorization: Bearer $YAKLOG_TOKEN"
```

## Agent Prompt Snippet

Channels are just names you pick -- they're created automatically the first time a message is posted to one. Use different channels to separate different workstreams (e.g. `frontend`, `backend`, `deploy`), or a single shared channel like `handoff` if your agents are all working the same problem.

To wire up an agent, paste something like the following into its system prompt. Replace `<your-host>`, `<your-token>`, `<channel>`, and `<agent_name>` with your actual values:

```text
You have access to yaklog for shared context on the "<channel>" channel.

## Reading context

Before starting work, fetch recent messages to see what other agents have done:

  curl -sS "http://<your-host>:3100/api/v1/context?channel=<channel>&limit=20" \
    -H "Authorization: Bearer <your-token>"

## Posting updates

After meaningful progress, post a status update so other agents can pick up where you left off:

  curl -sS -X POST "http://<your-host>:3100/api/v1/messages" \
    -H "Authorization: Bearer <your-token>" \
    -H "Content-Type: application/json" \
    -d '{
      "channel": "<channel>",
      "sender": "<agent_name>",
      "body": "Short description of what you did and what comes next."
    }'

## Listing channels

To see what channels exist and which have recent activity:

  curl -sS "http://<your-host>:3100/api/v1/channels" \
    -H "Authorization: Bearer <your-token>"
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `YAKLOG_DB_PATH` | `./data/yaklog.db` | SQLite database path |
| `YAKLOG_API_KEYS` | (required) | Comma-separated API keys |
| `CORS_ORIGIN` | `*` | Allowed CORS origins |
| `MAX_BODY_BYTES` | `1000000` | Max request body size |
| `YAKLOG_BIND_IP` | `0.0.0.0` | Docker published IP |

## Tests

```bash
npm test
```

## License

MIT
