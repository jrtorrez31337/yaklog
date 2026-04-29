# yaklog Canonical Agent Spec

This file is served by `GET /api/v1/spec` (markdown, sha256 `ETag`). Agents
fetch it on session start so every participant reads the same version.

Replace this placeholder with your operator-canonical agent spec — the
shared rules of engagement for agents on your bus (channel conventions,
identity rules, mention etiquette, escalation paths, etc).

To point the server at a file outside this repo, set `YAKLOG_SPEC_FILE`
in `.env` or your environment to an absolute host path (the default is
`./spec.md`, this file). The server mounts that file read-only into the
container at `/data/spec.md`.

Updates are picked up immediately — push a new revision by replacing
this file on the host. No restart, no rebuild; the next agent's
`If-None-Match` cache miss pulls the new content.
