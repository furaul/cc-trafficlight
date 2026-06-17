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
  Notification)
    # 区分“真阻塞（请求权限）”与“空闲等你输入”。
    msg="$(printf '%s' "$payload" | jq -r '.message // ""')"
    case "$msg" in
      *[Ww]"aiting for"*[Ii]nput*) state="attention" ;;
      *) state="waiting" ;;
    esac
    ;;
  Stop) state="idle" ;;
  SessionStart) state="idle" ;;
  *) state="idle" ;;
esac

now="$(date +%s)"
# hook 的 stdin 是管道，`tty` 会报 "not a tty"；但进程的控制终端
# （从 CC 继承来的 Ghostty pty）仍能用 ps 读出，用它来定位要写标题的 pty。
tty_dev=""
for pid in $$ "${PPID:-}"; do
  [ -n "$pid" ] || continue
  t="$(ps -o tty= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
  case "$t" in
    ""|"?"|"??") ;;
    /dev/*) tty_dev="$t"; break ;;
    *) tty_dev="/dev/$t"; break ;;
  esac
done

jq -n --arg sid "$sid" --arg p "$project" --arg c "$cwd" \
      --arg s "$state" --arg t "${tty_dev:-unknown}" --argjson u "$now" \
  '{sessionId:$sid,project:$p,cwd:$c,state:$s,tty:$t,updatedAt:$u}' > "$file"

case "$state" in
  waiting)   glyph="🔴" ;;
  attention) glyph="🔵" ;;
  working)   glyph="🟡" ;;
  *)         glyph="🟢" ;;
esac
title_target="${CC_TL_TTY:-$tty_dev}"
if [ -n "$title_target" ] && { [ -w "$title_target" ] || [ ! -e "$title_target" ]; }; then
  printf '\033]0;%s %s\007' "$glyph" "$project" > "$title_target" 2>/dev/null || true
fi
