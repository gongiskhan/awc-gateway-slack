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

# Concatenate every assistant text block emitted since the most recent
# real user turn. Keying on the last .message.id (as we used to) is
# unreliable: a single user turn spans multiple API responses (one per
# tool cycle), each with its own message.id, and if the last one carries
# only thinking/tool_use blocks — or the transcript writer hasn't flushed
# the final text block yet when Stop fires — the extract comes back empty
# and the gateway pairs an empty reply with the inbound, so Slack sees
# nothing. "Real" user turns exclude tool_result entries (which also land
# as type=="user" in the transcript JSONL).
#
# Retry the extract a few times if it comes back empty: the final text
# block may not have been flushed to the JSONL when Stop fires. Past
# turns hit this — three of four in the 6bf8e75a session — so waiting
# briefly beats posting empty and losing the reply.
extract_text() {
  jq -sr '
    . as $all
    | ($all
       | to_entries
       | map(select(
           .value.type == "user"
           and (
             ((.value.message.content | type) == "string")
             or ((.value.message.content | type) == "array"
                 and (.value.message.content[0].type // "") != "tool_result")
           )
         ))
       | last | .key // -1) as $cut
    | $all[$cut+1:]
    | map(select(.type == "assistant"))
    | map(.message.content[]? | select(.type == "text") | .text)
    | join("")
  ' "$transcript_path" 2>>"$LOG_FILE"
}

text=$(extract_text)
for delay in 0.2 0.5 1.0; do
  [[ -n "$text" ]] && break
  sleep "$delay"
  text=$(extract_text)
done

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
