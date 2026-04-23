# Uninstall: AWC Gateway + Slack channel

## 1. Stop the processes

```bash
./stop.sh
```

Expected output:

```
[stop] slack-adapter stopped (pid ...)
[stop] gateway stopped (pid ...)
```

## 2. Remove the Stop hook

The Stop hook lives in `.claude/settings.json`. Two options:

- **If this directory is the Claude Code project root** and you're
  removing the whole composition: delete the directory or its
  `.claude/settings.json` file.
- **If the hook was merged into an existing project's settings**: open
  `.claude/settings.json` and remove the `Stop` entry under `hooks`.
  Leave any other hooks intact.

Either way, also delete the hook script if you copied it out of the
composition dir:

```bash
rm -rf hooks/
```

## 3. (Optional) Remove the Slack app

- https://api.slack.com/apps → your app → Basic Information →
  "Delete App" at the bottom.
- If you're keeping the app but retiring this composition, at least
  disable Event Subscriptions and rotate the signing secret.

## 4. (Optional) Remove logs and state

```bash
rm -rf logs/
rm -rf "$HOME/.local/state/awc-gateway-slack"
```

## 5. Verify

```bash
# No processes listening on our ports.
pgrep -f 'node gateway.js' || echo 'gateway gone'
pgrep -f 'node slack-adapter.js' || echo 'adapter gone'

# Gateway port closed.
curl -sf http://127.0.0.1:9511/health || echo 'port closed'

# No pid files left.
ls logs/*.pid 2>/dev/null || echo 'no pid files'
```

All four commands should print their respective "gone / closed / no pid
files" markers. If any process is still alive, kill it by pid:

```bash
pkill -f 'node gateway.js'
pkill -f 'node slack-adapter.js'
```
