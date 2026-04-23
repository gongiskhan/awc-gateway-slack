#!/usr/bin/env bash
# Stop the gateway and Slack adapter. Reads PIDs from logs/*.pid.

set -u

cd "$(dirname "$0")"

stop_proc() {
  local name=$1
  local pidfile="logs/${name}.pid"
  if [[ ! -f "$pidfile" ]]; then
    echo "[stop] ${name} no pid file; skipping"
    return
  fi
  local pid
  pid=$(cat "$pidfile")
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "[stop] ${name} did not exit; sending SIGKILL"
      kill -9 "$pid" 2>/dev/null || true
    fi
    echo "[stop] ${name} stopped (pid $pid)"
  else
    echo "[stop] ${name} not running"
  fi
  rm -f "$pidfile"
}

stop_proc slack-adapter
stop_proc gateway
