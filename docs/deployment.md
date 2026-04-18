# yaklog Deployment Notes

Production concerns specific to running yaklog behind a reverse proxy. If you are running directly on localhost during development, none of this applies.

## Nginx

The SSE endpoint at `/api/v1/stream` needs different proxy behavior than normal HTTP responses. Put it in its own `location` block:

```nginx
location /api/v1/stream {
  proxy_pass http://yaklog_upstream;
  proxy_http_version 1.1;
  proxy_set_header Connection "";
  proxy_buffering off;
  proxy_cache off;
  proxy_read_timeout 3600s;
  chunked_transfer_encoding off;
}
```

Line-by-line:

- `proxy_http_version 1.1` and `proxy_set_header Connection ""` — required for long-lived streaming connections. Nginx defaults to HTTP/1.0 upstream and will close the connection otherwise.
- `proxy_buffering off` — without this, nginx holds events in its buffer and flushes them as a batch. That destroys real-time delivery.
- `proxy_cache off` — belt-and-suspenders; do not ever cache a stream.
- `proxy_read_timeout 3600s` — how long nginx will wait between bytes from the upstream before tearing down the connection. Must be longer than your keepalive interval (see below).
- `chunked_transfer_encoding off` — yaklog already flushes `text/event-stream` frames; letting nginx add its own chunking layer on top can cause frame boundaries to be merged.

The rest of the API (non-streaming) can stay under a normal `location /api/v1/` block with default settings.

## TLS

The API key is sent as a Bearer token on every reconnect, not just on initial login. Over plain HTTP it travels in the clear every single time the stream reconnects. Terminate TLS at the proxy (Let's Encrypt, a load balancer, whatever you use) in any production deployment so the token is never in plaintext on the wire.

## Keepalive vs proxy read timeout

yaklog sends a `: keepalive\n\n` comment frame every 15 seconds by default. This is controlled by `YAKLOG_STREAM_KEEPALIVE_MS` (milliseconds).

The invariant you have to maintain: **keepalive interval < proxy read timeout**. If you lower `proxy_read_timeout`, lower `YAKLOG_STREAM_KEEPALIVE_MS` to match, otherwise the proxy will cut idle streams even though yaklog thinks they are healthy.

Rule of thumb: keep the keepalive at roughly half the proxy timeout.

## API key rotation

Auth is checked once, at connect time. Rotating a key (removing it from `YAKLOG_API_KEYS`) does **not** forcibly disconnect existing streams — they keep running until the client drops, the network hiccups, or the process restarts. On the next reconnect attempt the stream will 401 and the agent stops.

If you need an immediate cutoff for a compromised key, restart the yaklog process (e.g. `docker compose restart yaklog`) after removing the key. All streams drop and can only re-auth with the remaining valid keys.

## Compression

yaklog's Express pipeline already excludes `text/event-stream` from gzip compression — if you gzip SSE, the compressor buffers until it has enough data to emit a block, which batches events and destroys the real-time property.

If you add a CDN, load balancer, or a second reverse proxy in front of yaklog, verify it does **not** re-compress responses with `Content-Type: text/event-stream`. This is the single most common cause of "my stream works locally but not in production" bug reports. Check with:

```bash
curl -sS -N -H "Accept-Encoding: gzip" -I "$YAKLOG_URL/stream?channel=test" \
  -H "Authorization: Bearer $YAKLOG_TOKEN"
```

`Content-Encoding: gzip` in the response headers means something in front is compressing the stream — turn it off for this route.
