#!/usr/bin/env bash
set -euo pipefail
event="${1:-}"
dir="${CC_TL_DIR:-$HOME/.local/state/cc-trafficlight/sessions}"
mkdir -p "$dir"

payload="$(cat)"
sid="$(printf '%s' "$payload" | jq -r '.session_id // empty')"
cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty')"
[ -n "$sid" ] || exit 0
project="$(basename "${cwd:-unknown}")"
file="$dir/$sid.json"

case "$event" in
  SessionEnd) rm -f "$file"; exit 0 ;;
  UserPromptSubmit|PreToolUse|PostToolUse|SubagentStop) state="working" ;;
  Notification) state="waiting" ;;
  Stop) state="idle" ;;
  SessionStart) state="idle" ;;
  *) state="idle" ;;
esac

now="$(date +%s)"
tty_dev="$(tty 2>/dev/null || echo unknown)"
jq -n --arg sid "$sid" --arg p "$project" --arg c "$cwd" \
      --arg s "$state" --arg t "$tty_dev" --argjson u "$now" \
  '{sessionId:$sid,project:$p,cwd:$c,state:$s,tty:$t,updatedAt:$u}' > "$file"

case "$state" in
  waiting) glyph="🔴" ;;
  working) glyph="🟡" ;;
  *)       glyph="🟢" ;;
esac
title_target="${CC_TL_TTY:-/dev/tty}"
if [ -w "$title_target" ] || [ ! -e "$title_target" ]; then
  printf '\033]0;%s %s\007' "$glyph" "$project" > "$title_target" 2>/dev/null || true
fi
