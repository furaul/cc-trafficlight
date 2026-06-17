#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$HERE/cc-trafficlight-hook.sh"
TMP="$(mktemp -d)"
export CC_TL_DIR="$TMP/sessions"
export CC_TL_TTY="$TMP/tty.out"
: > "$CC_TL_TTY"
fail=0
check(){ if [ "$1" != "$2" ]; then echo "FAIL: $3 (got '$1' want '$2')"; fail=1; else echo "ok: $3"; fi; }

# UserPromptSubmit -> working
echo '{"session_id":"s1","cwd":"/Users/x/dev/web-dashboard"}' | "$HOOK" UserPromptSubmit
state=$(jq -r .state "$CC_TL_DIR/s1.json"); check "$state" "working" "UserPromptSubmit=>working"
proj=$(jq -r .project "$CC_TL_DIR/s1.json"); check "$proj" "web-dashboard" "project=basename(cwd)"

# Notification -> waiting
echo '{"session_id":"s1","cwd":"/Users/x/dev/web-dashboard"}' | "$HOOK" Notification
state=$(jq -r .state "$CC_TL_DIR/s1.json"); check "$state" "waiting" "Notification=>waiting"

# Stop -> idle
echo '{"session_id":"s1","cwd":"/Users/x/dev/web-dashboard"}' | "$HOOK" Stop
state=$(jq -r .state "$CC_TL_DIR/s1.json"); check "$state" "idle" "Stop=>idle"

# Notification (permission message) -> waiting
echo '{"session_id":"s3","cwd":"/Users/x/dev/api","message":"Claude needs your permission to use Bash"}' | "$HOOK" Notification
state=$(jq -r .state "$CC_TL_DIR/s3.json"); check "$state" "waiting" "permission notification=>waiting"

# Notification (idle waiting message) -> attention
echo '{"session_id":"s3","cwd":"/Users/x/dev/api","message":"Claude is waiting for your input"}' | "$HOOK" Notification
state=$(jq -r .state "$CC_TL_DIR/s3.json"); check "$state" "attention" "idle-wait notification=>attention"

# tab title OSC written to CC_TL_TTY
echo '{"session_id":"s2","cwd":"/Users/x/dev/api"}' | "$HOOK" Notification
grep -q $'\033]0;🔴 api\007' "$CC_TL_TTY"; check "$?" "0" "waiting writes red OSC title"
echo '{"session_id":"s2","cwd":"/Users/x/dev/api"}' | "$HOOK" UserPromptSubmit
grep -q $'\033]0;🟡 api\007' "$CC_TL_TTY"; check "$?" "0" "working writes amber OSC title"

# SessionEnd -> file removed
echo '{"session_id":"s1","cwd":"/Users/x/dev/web-dashboard"}' | "$HOOK" SessionEnd
[ ! -f "$CC_TL_DIR/s1.json" ]; check "$?" "0" "SessionEnd removes file"

rm -rf "$TMP"
exit $fail
