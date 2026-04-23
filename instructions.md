# Install & run: AWC Gateway + Slack channel

This composition lets you talk to a long-lived Claude Code session from
Slack. Inbound Slack messages are routed to the session; the session's
final reply is posted back into the same Slack thread.

## Prereqs

- **macOS or Linux.** Windows is untested.
- **Node.js 20+.** `node --version` must report `v20` or higher.
- **`claude` CLI installed** and able to start an interactive session.
  Anthropic's installer is the simplest path.
- **`jq` and `curl`.** Already present on macOS and most Linux distros.
- **A Slack workspace** you can install apps into.
- **A publicly reachable URL** for Slack to deliver webhooks to the
  adapter. Development: an `ngrok`, `tailscale funnel`, or
  `cloudflared tunnel` pointed at `http://127.0.0.1:9512`. The gateway
  itself is never exposed publicly — only the Slack adapter.

## 1. Create a Slack app

1. Go to https://api.slack.com/apps and create a new app "from scratch".
   Name it something like `awc-agent` and pick your workspace.
2. **Basic Information → App Credentials.** Copy the **Signing Secret**.
3. **OAuth & Permissions → Scopes → Bot Token Scopes.** Add:
   - `app_mentions:read`  — receive `@awc-agent` mentions
   - `chat:write`         — post replies
   - `im:history`         — read direct messages (optional; only if you
     want DM support in addition to mentions)
   - `im:read`            — list DM channels (pairs with `im:history`)
4. **Install App → Install to Workspace.** Copy the **Bot User OAuth Token**
   (starts with `xoxb-`).
5. **Event Subscriptions → Enable Events.**
   - **Request URL:** your public tunnel URL + `/slack/events`
     (e.g. `https://awc.your-tunnel.ngrok.app/slack/events`). Save once
     Slack shows "Verified".
   - **Subscribe to bot events:** add `app_mention`. Add `message.im`
     if you also want DMs.
   - Reinstall the app if Slack asks you to.
6. **App Home → Show Tabs → Messages Tab.** Enable the tab *and* tick
   **"Allow users to send Slash commands and messages from the messages
   tab."** Without this, the DM composer is disabled and Slack shows
   *"Sending messages to this app has been turned off"* (localized — e.g.
   PT: *"O envio de mensagens para esse app foi desativado"*) when a user
   opens a DM with the bot. Reinstall if Slack asks you to.

## 2. Configure env vars

```bash
cp .env.example .env
$EDITOR .env
```

Fill in `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` from the Slack app you
just created. Leave the other lines commented unless you're moving ports.

## 3. Run the gateway + adapter

```bash
./start.sh
```

This backgrounds `gateway.js` (port 9511) and `slack-adapter.js`
(port 9512), writing logs to `logs/*.log` and PIDs to `logs/*.pid`.

Check health:

```bash
curl -sf http://127.0.0.1:9511/health
# {"ok":true,"pending":0,"subscribers":1}
```

`subscribers` should be `1` (the slack adapter's SSE connection).

## 4. Start the long-lived Claude Code session

In a separate terminal, from this directory:

```bash
claude
```

The session picks up `.claude/settings.json` (the Stop hook) and
`CLAUDE.md` (session boot instructions). On first prompt or first
`INBOUND` event, the session should call the `Monitor` tool to watch
the gateway's stdout — `CLAUDE.md` tells it how. If it doesn't start
the monitor on its own, ask it once: *"Start watching the gateway for
inbound messages per CLAUDE.md."*

Leave this terminal open. This is the agent.

## 5. Verify end-to-end

From a third terminal:

```bash
# Simulate a Slack message reaching the gateway directly.
curl -sf -X POST http://127.0.0.1:9511/inbound \
  -H 'Content-Type: application/json' \
  -d '{"from":"test:cli","text":"ping","reply_to":"test"}' \
  && echo ok
```

Expected:

- The gateway writes one `INBOUND {...}` line to its stdout
  (`logs/gateway.stdout.log`).
- The Claude Code session picks it up via `Monitor` and replies.
- The Stop hook POSTs the reply to `/outbound`.
- The Slack adapter's SSE subscriber receives an outbound event.
  With `reply_to: "test"` (not a valid Slack channel) the adapter
  will log a `chat.postMessage failed` error — that's expected for
  this test.

Then try the real thing: DM or `@awc-agent` in Slack. You should
see a reply threaded under your message.

## Logs & troubleshooting

- `logs/gateway.stdout.log`        — only `INBOUND {...}` lines.
- `logs/gateway.stderr.log`        — gateway startup and errors.
- `logs/slack-adapter.stderr.log`  — Slack signature failures,
   SSE reconnects, Slack API errors.
- `~/.local/state/awc-gateway-slack/stop-hook.log` — Stop hook failures
   (e.g. gateway down at reply time).

Common issues:

- **`[slack] rejected: bad signature`** — your `SLACK_SIGNING_SECRET`
  is wrong, or your tunnel is rewriting headers.
- **DM composer shows *"Sending messages to this app has been turned
  off"*** (PT: *"O envio de mensagens para esse app foi desativado"*) —
  enable the Messages Tab in **App Home** and tick "Allow users to send
  Slash commands and messages from the messages tab" (step 1.6 above).
- **`chat.postMessage failed: ... invalid_auth`** — your
  `SLACK_BOT_TOKEN` is wrong, or the bot has no scopes.
- **Gateway healthy but session never replies** — the session isn't
  running the `Monitor` tool. Ask it to start watching per `CLAUDE.md`.
- **First real session**: verify the Stop hook actually fires at end of
  a turn. Check `~/.local/state/awc-gateway-slack/stop-hook.log` after
  the first turn in the live session. If empty, the hook didn't run —
  confirm `.claude/settings.json` is picked up (`claude --help` shows
  project dir) and that `hooks/stop-to-gateway.sh` is executable.
