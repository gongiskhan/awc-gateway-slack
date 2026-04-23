#!/usr/bin/env bash
# Stop hook: extract the assistant's final reply text from the transcript
# and POST it to the gateway's /outbound endpoint.
#
# Design:
#   - Fire-and-forget. Always exit 0; never block the session.
#   - All diagnostics go to a local log file; nothing on stdout/stderr.
#   - If gateway is down or jq/curl fails, we silently drop the reply.

set +e

LOG_DIR="${AWC_GATEWAY_LOG_DIR:-$HOME/.local/state/awc-gateway-slack}"
LOG_FILE="$LOG_DIR/stop-hook.log"
GATEWAY_URL="${AWC_GATEWAY_URL:-http://127.0.0.1:9511}"

mkdir -p "$LOG_DIR" 2>/dev/null
exec 2>>"$LOG_FILE"

ts() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }
log() { echo "[$(ts)] $*" >&2; }

payload=$(cat)
transcript_path=$(printf '%s' "$payload" | jq -r '.transcript_path // empty')

if [[ -z "$transcript_path" || ! -f "$transcript_path" ]]; then
  log "no transcript_path or file missing: '$transcript_path'"
  exit 0
fi

# Find the last assistant message.id, then concatenate all text content
# blocks belonging to that message. The transcript JSONL represents each
# content block as a separate line; blocks from one turn share .message.id.
text=$(jq -sr '
  map(select(.type == "assistant")) as $a
  | ($a | last | .message.id) as $mid
  | $a
  | map(select(.message.id == $mid))
  | map(.message.content[] | select(.type == "text") | .text)
  | join("")
' "$transcript_path" 2>>"$LOG_FILE")

if [[ -z "$text" ]]; then
  # Still POST an empty reply. The gateway's pending queue must advance
  # in lockstep with inbounds, or subsequent replies get paired with the
  # wrong reply_to. Channel adapters are responsible for skipping empty
  # text rather than posting a blank message.
  log "no final assistant text extracted from $transcript_path; posting empty"
fi

body=$(jq -nc --arg t "$text" '{text: $t}')

# Fire and forget. Short timeout; swallow output.
curl -sS -m 5 -o /dev/null \
  -X POST "$GATEWAY_URL/outbound" \
  -H 'Content-Type: application/json' \
  --data-binary "$body" 2>>"$LOG_FILE" \
  || log "POST to $GATEWAY_URL/outbound failed"

exit 0
