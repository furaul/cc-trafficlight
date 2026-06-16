#!/usr/bin/env bash
set -euo pipefail
HOOK_PATH="$(cd "$(dirname "$0")" && pwd)/cc-trafficlight-hook.sh"
SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
mkdir -p "$(dirname "$SETTINGS")"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"

events=(SessionStart UserPromptSubmit PreToolUse PostToolUse Notification Stop SubagentStop SessionEnd)
tmp="$(mktemp)"
cp "$SETTINGS" "$tmp"
for ev in "${events[@]}"; do
  jq --arg ev "$ev" --arg cmd "$HOOK_PATH $ev" '
    .hooks[$ev] = ((.hooks[$ev] // [])
      | map(select(.hooks[0].command != $cmd))
      + [{matcher:"", hooks:[{type:"command", command:$cmd}]}])
  ' "$tmp" > "$tmp.next" && mv "$tmp.next" "$tmp"
done
mv "$tmp" "$SETTINGS"
echo "Installed cc-trafficlight hooks into $SETTINGS"
