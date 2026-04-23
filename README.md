# awc-gateway-slack

AWC seed composition: a stateless local **gateway** + a **Slack channel**
adapter. Together they let you talk to a long-lived Claude Code session
from Slack — replacing `claude.ai` for cases where you are OK waiting
for a reply and don't need to see the session's reasoning.

## Shape

```
   Slack user
       │  (event)
       ▼
  [slack-adapter.js]  ── POST /inbound ──▶  [gateway.js]
                                              │  stdout: INBOUND {…}
                                              ▼
                                    Claude Code session
                                    (Monitor tool)
                                              │  Stop hook
                                              ▼
                                     POST /outbound
                                              │  SSE event
                                              ▼
  [slack-adapter.js]  ── chat.postMessage ──▶  Slack
```

- **Gateway** is channel-agnostic. Three endpoints: `POST /inbound`,
  `POST /outbound`, `GET /events` (SSE). In-memory FIFO pairing.
  Only `INBOUND` lines go to stdout — everything else to stderr so the
  Claude Code `Monitor` tool sees a clean signal.
- **Slack adapter** talks to Slack's Events API and Web API, subscribes
  to the gateway's SSE for outbound replies, decodes `reply_to` →
  `chat.postMessage`.
- **Stop hook** (`hooks/stop-to-gateway.sh`) extracts the last assistant
  message text from the session transcript and POSTs it to the gateway.

## Quickstart

See **[instructions.md](instructions.md)** for the full walk-through
(Slack app setup, env vars, running, verifying).

To tear down: **[uninstall.md](uninstall.md)**.

## v1 limits (documented, not bugs)

- One inbound channel → one active turn → one outbound reply. FIFO pairing.
  Concurrent inbounds are not supported.
- No persistence. Restart = empty queue; in-flight messages are lost.
- If the Slack adapter is disconnected when `/outbound` fires (e.g. during
  its SSE-reconnect backoff), the gateway still pops the head of the queue
  and broadcasts to zero subscribers. The message is lost; the pairing
  stays consistent. User sees no reply in Slack.
- No auth on the gateway HTTP surface. Bind is `127.0.0.1` only; do not
  expose 9511 externally.
- Session lifecycle is manual. Start `claude` yourself.

## Layout

```
gateway.js                 # local HTTP + SSE gateway
slack-adapter.js           # Slack inbound webhook + outbound SSE consumer
hooks/stop-to-gateway.sh   # Stop hook: transcript → /outbound
.claude/settings.json      # registers the Stop hook
CLAUDE.md                  # boot instructions for the long-lived session
start.sh / stop.sh         # run/stop both processes
instructions.md            # install guide
uninstall.md               # teardown guide
.env.example               # required env vars
```
