# AWC Gateway + Slack session

This Claude Code session is the agent behind an AWC Gateway. It receives inbound
messages from external channels (Slack, etc.) and replies back through the same
channels. You (Claude) are the one doing the work; a small local gateway
process just shuttles messages in and out.

## Architecture in one paragraph

`gateway.js` runs as a local HTTP service on `127.0.0.1:9511`. Channel adapters
(e.g. `slack-adapter.js`) POST inbound user messages to it. The gateway prints
each inbound as an `INBOUND {…json…}` line on its stdout. This session watches
that stdout via the `Monitor` tool. When an `INBOUND` event arrives, treat the
embedded `text` as a user message and respond normally. The Stop hook defined
in `.claude/settings.json` automatically POSTs your final reply to the
gateway's `/outbound`, which fans it out to subscribed channel adapters via
SSE. You do not post the reply yourself — just answer.

## On session start

If no gateway monitor is currently running in this session, start one. Use the
`Monitor` tool with:

- `command`: `tail -n 0 -F "$CLAUDE_PROJECT_DIR/logs/gateway.stdout.log" | grep --line-buffered '^INBOUND '`
- `description`: `awc gateway inbound messages`
- `persistent`: `true`

Critical: **do not run `node gateway.js` from the Monitor**. The gateway is
already started by `start.sh` and is listening on port 9511 — launching a
second instance fails immediately with EADDRINUSE and the session stops
receiving events silently. Always tail the existing stdout log instead.
`-n 0` starts at end-of-file so previously-delivered messages are not
replayed on session restart; `-F` follows by name across log rotation.

If `curl -sf http://127.0.0.1:9511/health` fails, tell the user the gateway is
down — do not try to start it from inside this session.

## Handling an INBOUND event

Each event arrives as one stdout line of the form:

```
INBOUND {"id":"<uuid>","from":"<channel>:<user>","text":"…","reply_to":"<opaque>"}
```

When you see one:

1. Parse the JSON.
2. Treat the `text` field as the user's turn. Respond to it as you normally
   would — ask for clarification, run tools, produce an answer.
3. Do nothing special for delivery. The Stop hook will send whatever your
   final text reply is back through the gateway. The hook ignores tool calls,
   thinking blocks, and partial output — only the last assistant-message text
   blocks are delivered.

The gateway pairs one inbound with one outbound in FIFO order. Multiple
inbounds arriving during a single turn are not supported in v1 — reply to
whatever the most recent `INBOUND` was, and the pairing will still be correct
because serial processing is assumed.

## What not to do

- Do not post replies via curl yourself. The Stop hook handles it.
- Do not attempt to restart the gateway or adapter processes from this
  session. They are managed by `start.sh` / `stop.sh` outside the session.
- Do not clear or compact on your own. Session lifecycle is out of scope
  in v1.
