#!/usr/bin/env bash
# Start the gateway and Slack adapter as background processes.
# Logs go to ./logs/, PIDs to ./logs/*.pid. Use ./stop.sh to stop them.
#
# Env vars are read from .env if present. SLACK_BOT_TOKEN and
# SLACK_SIGNING_SECRET are required.

set -euo pipefail

cd "$(dirname "$0")"

if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
fi

: "${SLACK_BOT_TOKEN:?SLACK_BOT_TOKEN not set (put it in .env)}"
: "${SLACK_SIGNING_SECRET:?SLACK_SIGNING_SECRET not set (put it in .env)}"

mkdir -p logs

start_proc() {
  local name=$1 cmd=$2
  local pidfile="logs/${name}.pid"
  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "[start] ${name} already running (pid $(cat "$pidfile"))"
    return
  fi
  # shellcheck disable=SC2086
  nohup bash -c "$cmd" > "logs/${name}.stdout.log" 2> "logs/${name}.stderr.log" &
  echo $! > "$pidfile"
  echo "[start] ${name} started (pid $(cat "$pidfile"))"
}

start_proc gateway      "node gateway.js"
start_proc slack-adapter "node slack-adapter.js"

sleep 0.5

if curl -sf "http://127.0.0.1:${PORT:-9511}/health" >/dev/null; then
  echo "[start] gateway healthy on port ${PORT:-9511}"
else
  echo "[start] WARN: gateway health check failed (check logs/gateway.stderr.log)"
fi
