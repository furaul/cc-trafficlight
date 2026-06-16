# CC 状态灯（cc-trafficlight）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Claude Code 做一个 macOS 桌面状态灯：hook 把每个会话状态写成文件并改 Ghostty tab 标题，独立 Tauri 悬浮灯聚合展示，需要交互时触发边框脉冲 + 系统通知 + 提示音。

**Architecture:** 两层。第 1 层是纯 shell 的 hook 脚本（写状态 JSON + 用 OSC 转义改 tab 标题）。第 2 层是 Tauri v2 App，Rust 后端用 `notify` 监听状态目录、聚合"最紧急优先"状态、检测"进入 waiting"边沿，向两个前端窗口（角落挂件 + 全屏边框）emit 事件；macOS 专属窗口行为（全 Space、鼠标穿透、盖全屏）用 objc2 设置。

**Tech Stack:** Bash + jq（hook），Rust + Tauri v2 + notify crate + objc2-app-kit（后端），原生 HTML/JS（前端，`withGlobalTauri`，无打包器），`tauri-plugin-notification`。

设计文档：`docs/superpowers/specs/2026-06-12-cc-trafficlight-design.md`

---

## 文件结构

```
cc-trafficlight/
├── hook/
│   ├── cc-trafficlight-hook.sh     # hook 入口：写状态 JSON + 改 tab 标题
│   ├── install.sh                  # 把 hooks 合并进 ~/.claude/settings.json
│   └── tests/hook_test.sh          # hook 的 shell 测试
├── app/
│   ├── package.json                # 仅 devDeps：@tauri-apps/cli
│   ├── ui/
│   │   ├── widget.html             # 角落挂件窗口
│   │   ├── widget.js
│   │   ├── pulse.html              # 全屏边框窗口
│   │   ├── pulse.js
│   │   └── common.css
│   └── src-tauri/
│       ├── Cargo.toml
│       ├── tauri.conf.json
│       ├── build.rs
│       └── src/
│           ├── main.rs             # 入口：setup 窗口、起 watcher
│           ├── state.rs            # Session 模型 + 聚合 + 陈旧过滤 + 边沿检测
│           ├── watcher.rs          # notify 监听目录 → 重算 → emit
│           └── macos.rs            # objc2：全 Space / 穿透 / 盖全屏 / window level
└── docs/superpowers/{specs,plans}/...
```

**状态契约（贯穿全项目）** — 状态文件 `~/.local/state/cc-trafficlight/sessions/<session_id>.json`：

```json
{ "sessionId":"abc","project":"web-dashboard","cwd":"/Users/x/dev/web-dashboard",
  "state":"waiting","tty":"/dev/ttys003","updatedAt":1781254553 }
```

`state` ∈ `working | waiting | idle`。聚合优先级 `waiting(3) > working(2) > idle(1)`。

---

## Task 0: 项目脚手架与 git

**Files:**
- Create: `.gitignore`
- Create: `app/src-tauri/` (via tauri init)

- [ ] **Step 1: 初始化 git 并写 .gitignore**

```bash
cd ~/Documents/Documents/dev/2026_workspace/cc-trafficlight
git init
cat > .gitignore <<'EOF'
.superpowers/
app/src-tauri/target/
app/node_modules/
app/src-tauri/gen/
EOF
```

- [ ] **Step 2: 提交已有设计与计划**

```bash
git add .gitignore docs/
git commit -m "docs: add cc-trafficlight design spec and implementation plan"
```

- [ ] **Step 3: 创建目录骨架**

```bash
mkdir -p hook/tests app/ui app/src-tauri/src
```

---

## Task 1: hook — 写状态文件（TDD）

hook 从 stdin 读 Claude Code 传入的 JSON（含 `session_id`、`cwd`），按命令行参数 `<event>` 决定状态，写/删状态文件。为可测试，状态目录用 `CC_TL_DIR`（默认 `~/.local/state/cc-trafficlight/sessions`）、tab 标题输出目标用 `CC_TL_TTY`（默认 `/dev/tty`）覆盖。

**Files:**
- Create: `hook/cc-trafficlight-hook.sh`
- Test: `hook/tests/hook_test.sh`

- [ ] **Step 1: 写失败测试**

```bash
# hook/tests/hook_test.sh
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$HERE/cc-trafficlight-hook.sh"
TMP="$(mktemp -d)"
export CC_TL_DIR="$TMP/sessions"
export CC_TL_TTY="$TMP/tty.out"
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

# SessionEnd -> file removed
echo '{"session_id":"s1","cwd":"/Users/x/dev/web-dashboard"}' | "$HOOK" SessionEnd
[ ! -f "$CC_TL_DIR/s1.json" ]; check "$?" "0" "SessionEnd removes file"

rm -rf "$TMP"
exit $fail
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bash hook/tests/hook_test.sh`
Expected: FAIL（脚本不存在 / not executable）

- [ ] **Step 3: 写最小实现**

```bash
# hook/cc-trafficlight-hook.sh
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
```

(标题输出在 Task 2 追加，本步先让状态文件测试通过。)

- [ ] **Step 4: 赋可执行并跑测试**

Run: `chmod +x hook/cc-trafficlight-hook.sh && bash hook/tests/hook_test.sh`
Expected: 全部 `ok:`，退出码 0

- [ ] **Step 5: 提交**

```bash
git add hook/ && git commit -m "feat(hook): write per-session state files from CC hooks"
```

---

## Task 2: hook — 改 Ghostty tab 标题（TDD）

**Files:**
- Modify: `hook/cc-trafficlight-hook.sh`
- Modify: `hook/tests/hook_test.sh`

- [ ] **Step 1: 追加失败测试**

在 `hook_test.sh` 的 `SessionEnd` 测试之前插入：

```bash
# tab title OSC written to CC_TL_TTY
echo '{"session_id":"s2","cwd":"/Users/x/dev/api"}' | "$HOOK" Notification
grep -q $'\033]0;🔴 api\007' "$CC_TL_TTY"; check "$?" "0" "waiting writes red OSC title"
echo '{"session_id":"s2","cwd":"/Users/x/dev/api"}' | "$HOOK" UserPromptSubmit
grep -q $'\033]0;🟡 api\007' "$CC_TL_TTY"; check "$?" "0" "working writes amber OSC title"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bash hook/tests/hook_test.sh`
Expected: FAIL（OSC 未写入）

- [ ] **Step 3: 在写完状态文件后追加标题输出**

在 `hook/cc-trafficlight-hook.sh` 末尾、写 `$file` 之后追加：

```bash
case "$state" in
  waiting) glyph="🔴" ;;
  working) glyph="🟡" ;;
  *)       glyph="🟢" ;;
esac
title_target="${CC_TL_TTY:-/dev/tty}"
# 写 OSC 0 标题；目标不可写则静默跳过（无控制终端时）
if [ -w "$title_target" ] || [ ! -e "$title_target" ]; then
  printf '\033]0;%s %s\007' "$glyph" "$project" > "$title_target" 2>/dev/null || true
fi
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bash hook/tests/hook_test.sh`
Expected: 全部 `ok:`，退出码 0

- [ ] **Step 5: 提交**

```bash
git add hook/ && git commit -m "feat(hook): set Ghostty tab title with state glyph via OSC"
```

---

## Task 3: hook 安装脚本

把 hook 注册进 `~/.claude/settings.json` 的 `hooks` 字段。每个事件配一条 command。用 jq 合并，幂等。

**Files:**
- Create: `hook/install.sh`

- [ ] **Step 1: 写安装脚本**

```bash
# hook/install.sh
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
```

- [ ] **Step 2: 用临时 settings 验证幂等**

Run:
```bash
chmod +x hook/install.sh
T="$(mktemp)"; echo '{}' > "$T"
CLAUDE_SETTINGS="$T" hook/install.sh
CLAUDE_SETTINGS="$T" hook/install.sh   # 再跑一次
jq '.hooks.Notification | length' "$T"
```
Expected: 输出 `1`（两次安装不重复），无报错。

- [ ] **Step 3: 提交**

```bash
git add hook/install.sh && git commit -m "feat(hook): idempotent installer merging hooks into settings.json"
```

---

## Task 4: Tauri 脚手架 + Rust 状态模型与聚合（TDD）

**Files:**
- Create: `app/package.json`, `app/src-tauri/Cargo.toml`, `app/src-tauri/build.rs`, `app/src-tauri/src/state.rs`

- [ ] **Step 1: 写 package.json 与 Cargo.toml**

`app/package.json`:
```json
{
  "name": "cc-trafficlight",
  "private": true,
  "scripts": { "tauri": "tauri" },
  "devDependencies": { "@tauri-apps/cli": "^2" }
}
```

`app/src-tauri/Cargo.toml`:
```toml
[package]
name = "cc-trafficlight"
version = "0.1.0"
edition = "2021"

[lib]
name = "cc_trafficlight_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-notification = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
notify = "6"

[target.'cfg(target_os = "macos")'.dependencies]
objc2 = "0.5"
objc2-app-kit = { version = "0.2", features = ["NSWindow"] }
objc2-foundation = "0.2"
```

`app/src-tauri/build.rs`:
```rust
fn main() { tauri_build::build() }
```

- [ ] **Step 2: 写 state.rs 的失败测试**

```rust
// app/src-tauri/src/state.rs
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Session {
    #[serde(rename = "sessionId")] pub session_id: String,
    pub project: String,
    pub state: String,
    #[serde(rename = "updatedAt")] pub updated_at: u64,
    #[serde(default)] pub tty: String,
    #[serde(default)] pub cwd: String,
}

pub fn priority(state: &str) -> u8 {
    match state { "waiting" => 3, "working" => 2, _ => 1 }
}

/// 最紧急优先；空列表返回 "idle"
pub fn aggregate(sessions: &[Session]) -> String {
    sessions.iter()
        .max_by_key(|s| priority(&s.state))
        .map(|s| s.state.clone())
        .unwrap_or_else(|| "idle".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn s(id: &str, st: &str, at: u64) -> Session {
        Session { session_id: id.into(), project: "p".into(), state: st.into(),
                  updated_at: at, tty: String::new(), cwd: String::new() }
    }
    #[test]
    fn aggregate_picks_worst() {
        let v = vec![s("a","idle",1), s("b","working",1), s("c","waiting",1)];
        assert_eq!(aggregate(&v), "waiting");
    }
    #[test]
    fn aggregate_empty_is_idle() {
        assert_eq!(aggregate(&[]), "idle");
    }
    #[test]
    fn aggregate_working_over_idle() {
        let v = vec![s("a","idle",1), s("b","working",1)];
        assert_eq!(aggregate(&v), "working");
    }
}
```

- [ ] **Step 3: 跑测试确认通过（实现已含在内）**

Run: `cd app/src-tauri && cargo test state::tests`
Expected: 3 个测试 PASS。（首次会拉依赖，耗时较长。）

- [ ] **Step 4: 提交**

```bash
git add app/ && git commit -m "feat(app): scaffold Tauri app and add session model + aggregation"
```

---

## Task 5: Rust — 目录扫描与陈旧过滤（TDD）

**Files:**
- Modify: `app/src-tauri/src/state.rs`

- [ ] **Step 1: 追加失败测试**

在 `state.rs` 的 `mod tests` 内追加：

```rust
#[test]
fn scan_reads_and_drops_stale() {
    use std::io::Write;
    let dir = std::env::temp_dir().join(format!("cctl-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let fresh = dir.join("a.json");
    let stale = dir.join("b.json");
    let now = now_secs();
    write!(std::fs::File::create(&fresh).unwrap(),
        r#"{{"sessionId":"a","project":"p","state":"working","updatedAt":{}}}"#, now).unwrap();
    write!(std::fs::File::create(&stale).unwrap(),
        r#"{{"sessionId":"b","project":"p","state":"waiting","updatedAt":{}}}"#, now - 99999).unwrap();
    let sessions = scan_dir(&dir, 1800);
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_id, "a");
    assert!(!stale.exists(), "stale file should be deleted");
    std::fs::remove_dir_all(&dir).ok();
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd app/src-tauri && cargo test state::tests::scan_reads_and_drops_stale`
Expected: 编译失败（`scan_dir`/`now_secs` 未定义）

- [ ] **Step 3: 实现 scan_dir 与 now_secs**

在 `state.rs`（`mod tests` 之外）追加：

```rust
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

/// 扫描目录，解析所有 *.json；超过 stale_secs 未更新的删除并跳过。
pub fn scan_dir(dir: &Path, stale_secs: u64) -> Vec<Session> {
    let mut out = Vec::new();
    let now = now_secs();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    for e in entries.flatten() {
        let path = e.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(sess) = serde_json::from_str::<Session>(&text) else { continue };
        if now.saturating_sub(sess.updated_at) > stale_secs {
            std::fs::remove_file(&path).ok();
            continue;
        }
        out.push(sess);
    }
    out.sort_by(|a, b| a.session_id.cmp(&b.session_id));
    out
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd app/src-tauri && cargo test state::tests`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add app/src-tauri/src/state.rs && git commit -m "feat(app): scan state dir and prune stale session files"
```

---

## Task 6: Rust — 进入 waiting 的边沿检测（TDD）

**Files:**
- Modify: `app/src-tauri/src/state.rs`

- [ ] **Step 1: 追加失败测试**

```rust
#[test]
fn alert_only_on_entering_waiting() {
    assert!(should_alert("working", "waiting"));   // 进入 waiting -> 报警
    assert!(should_alert("idle", "waiting"));
    assert!(!should_alert("waiting", "waiting"));  // 持续 waiting -> 不重复
    assert!(!should_alert("waiting", "idle"));     // 离开 waiting -> 不报警
    assert!(!should_alert("idle", "working"));
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd app/src-tauri && cargo test state::tests::alert_only_on_entering_waiting`
Expected: 编译失败（`should_alert` 未定义）

- [ ] **Step 3: 实现**

```rust
/// 仅在聚合状态从“非 waiting”跨入“waiting”时返回 true。
pub fn should_alert(prev: &str, next: &str) -> bool {
    next == "waiting" && prev != "waiting"
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd app/src-tauri && cargo test state::tests`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add app/src-tauri/src/state.rs && git commit -m "feat(app): edge detection for entering waiting state"
```

---

## Task 7: Rust — watcher 监听目录并 emit（实现 + 手动验证）

监听状态目录，任意变化 → 重算聚合 → emit `state-update`（全量会话+聚合）；若 `should_alert` 为真则额外 emit `alert`（含等待中的项目名）。维护上一次聚合态。

**Files:**
- Create: `app/src-tauri/src/watcher.rs`

- [ ] **Step 1: 写 watcher.rs**

```rust
// app/src-tauri/src/watcher.rs
use crate::state::{aggregate, scan_dir, should_alert, Session};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::mpsc::channel;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

pub fn state_dir() -> PathBuf {
    dirs_state().join("cc-trafficlight").join("sessions")
}
fn dirs_state() -> PathBuf {
    std::env::var_os("CC_TL_DIR")
        .map(PathBuf::from)
        .map(|p| p.parent().map(|x| x.to_path_buf()).unwrap_or(p))
        .unwrap_or_else(|| dirs_home().join(".local/state"))
}
fn dirs_home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

#[derive(Serialize, Clone)]
struct StatePayload { sessions: Vec<Session>, agg: String }
#[derive(Serialize, Clone)]
struct AlertPayload { project: String }

const STALE_SECS: u64 = 1800;

pub fn start(app: AppHandle) {
    let dir = if let Some(d) = std::env::var_os("CC_TL_DIR") { PathBuf::from(d) } else { state_dir() };
    std::fs::create_dir_all(&dir).ok();
    let prev = Mutex::new(String::from("idle"));

    let emit_now = move |app: &AppHandle, dir: &PathBuf, prev: &Mutex<String>| {
        let sessions = scan_dir(dir, STALE_SECS);
        let agg = aggregate(&sessions);
        let mut p = prev.lock().unwrap();
        if should_alert(&p, &agg) {
            let project = sessions.iter().find(|s| s.state == "waiting")
                .map(|s| s.project.clone()).unwrap_or_default();
            app.emit("alert", AlertPayload { project }).ok();
        }
        *p = agg.clone();
        app.emit("state-update", StatePayload { sessions, agg }).ok();
    };

    // 初始全量
    emit_now(&app, &dir, &prev);

    std::thread::spawn(move || {
        let (tx, rx) = channel();
        let mut watcher: RecommendedWatcher = match Watcher::new(tx, notify::Config::default()) {
            Ok(w) => w, Err(_) => return,
        };
        if watcher.watch(&dir, RecursiveMode::NonRecursive).is_err() { return; }
        for res in rx {
            if res.is_ok() { emit_now(&app, &dir, &prev); }
        }
    });
}
```

- [ ] **Step 2: 在 main.rs 接线（见 Task 8 一起编译）**

本任务先单独 `cargo check` 确认 watcher 编译：
Run: `cd app/src-tauri && cargo check`
Expected: 编译通过（可能有未使用告警，OK）。

- [ ] **Step 3: 提交**

```bash
git add app/src-tauri/src/watcher.rs && git commit -m "feat(app): watch state dir, aggregate, emit state-update/alert"
```

---

## Task 8: 窗口配置 + main.rs 接线

两个窗口：`widget`（角落挂件）与 `pulse`（全屏边框）。`withGlobalTauri` 开启以便前端用 `window.__TAURI__`。

**Files:**
- Create: `app/src-tauri/tauri.conf.json`, `app/src-tauri/src/main.rs`, `app/src-tauri/src/lib.rs`

- [ ] **Step 1: 写 tauri.conf.json**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "cc-trafficlight",
  "version": "0.1.0",
  "identifier": "io.github.furaul.cctrafficlight",
  "build": { "frontendDist": "../ui" },
  "app": {
    "withGlobalTauri": true,
    "windows": [
      {
        "label": "widget", "url": "widget.html",
        "width": 280, "height": 220, "x": 1100, "y": 700,
        "decorations": false, "transparent": true, "alwaysOnTop": true,
        "skipTaskbar": true, "resizable": false, "shadow": false,
        "acceptFirstMouse": true
      },
      {
        "label": "pulse", "url": "pulse.html",
        "width": 1440, "height": 900, "x": 0, "y": 0,
        "decorations": false, "transparent": true, "alwaysOnTop": true,
        "skipTaskbar": true, "resizable": false, "shadow": false,
        "focus": false
      }
    ],
    "security": { "csp": null }
  },
  "plugins": { "notification": {} },
  "bundle": { "active": true, "targets": ["app", "dmg"], "icon": ["icons/icon.icns"] }
}
```

> 注：`icons/icon.icns` 用 `cargo tauri icon <png>` 生成，或先放占位图标。

- [ ] **Step 2: 写 lib.rs（run 入口）**

```rust
// app/src-tauri/src/lib.rs
mod state;
mod watcher;
#[cfg(target_os = "macos")] mod macos;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // pulse 窗口：铺满主屏、鼠标穿透、跨全 Space、盖全屏
            if let Some(pulse) = app.get_webview_window("pulse") {
                pulse.set_ignore_cursor_events(true).ok();
                pulse.set_visible_on_all_workspaces(true).ok();
                #[cfg(target_os = "macos")]
                macos::elevate_overlay(&pulse);
            }
            if let Some(widget) = app.get_webview_window("widget") {
                widget.set_visible_on_all_workspaces(true).ok();
                #[cfg(target_os = "macos")]
                macos::elevate_overlay(&widget);
            }

            watcher::start(handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running cc-trafficlight");
}
```

- [ ] **Step 3: 写 main.rs**

```rust
// app/src-tauri/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() { cc_trafficlight_lib::run() }
```

- [ ] **Step 4: 先放一个 macos.rs 占位（Task 9 实现真身）**

```rust
// app/src-tauri/src/macos.rs
use tauri::WebviewWindow;
pub fn elevate_overlay(_window: &WebviewWindow) { /* implemented in Task 9 */ }
```

- [ ] **Step 5: 写最简前端占位，确保能起**

`app/ui/widget.html`:
```html
<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:transparent}</style></head>
<body><div id="app">widget</div><script src="widget.js"></script></body></html>
```
`app/ui/pulse.html`:
```html
<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:transparent;overflow:hidden}</style></head>
<body><div id="border"></div><script src="pulse.js"></script></body></html>
```
`app/ui/widget.js` 与 `app/ui/pulse.js` 先写空文件（Task 10/11 填充）。

- [ ] **Step 6: 编译运行验证**

Run: `cd app && npm install && npm run tauri dev`
Expected: App 启动，出现两个透明窗口（widget 显示 "widget" 文字，pulse 全屏透明）。确认无崩溃后 Ctrl-C。

- [ ] **Step 7: 提交**

```bash
git add app/ && git commit -m "feat(app): two-window setup (widget + fullscreen pulse) and wiring"
```

---

## Task 9: macOS 窗口行为（盖全屏 + 跨 Space）

用 objc2 把窗口的 `collectionBehavior` 设为 `canJoinAllSpaces | fullScreenAuxiliary`，level 提到 screenSaver 级，确保浮在别的全屏 App 之上。

**Files:**
- Modify: `app/src-tauri/src/macos.rs`

- [ ] **Step 1: 实现 elevate_overlay**

```rust
// app/src-tauri/src/macos.rs
use tauri::WebviewWindow;

#[allow(unexpected_cfgs)]
pub fn elevate_overlay(window: &WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let Ok(ns_window) = window.ns_window() else { return };
    let ns_window = ns_window as *mut AnyObject;
    if ns_window.is_null() { return; }

    // NSWindowCollectionBehavior:
    //   CanJoinAllSpaces = 1 << 0, FullScreenAuxiliary = 1 << 8
    let behavior: u64 = (1 << 0) | (1 << 8);
    // NSScreenSaverWindowLevel = 1000
    let level: i64 = 1000;

    unsafe {
        let _: () = msg_send![ns_window, setCollectionBehavior: behavior];
        let _: () = msg_send![ns_window, setLevel: level];
    }
}
```

- [ ] **Step 2: 编译运行验证盖全屏**

Run: `cd app && npm run tauri dev`
手动验证：把另一个 App（如全屏的浏览器）切到全屏，触发 pulse（见 Task 11 后再完整测；此步先确认 App 仍能启动、widget 浮在全屏 App 之上）。
Expected: widget 在全屏 App 上方可见；无崩溃。

- [ ] **Step 3: 提交**

```bash
git add app/src-tauri/src/macos.rs && git commit -m "feat(app): elevate overlay windows above fullscreen apps on macOS"
```

---

## Task 10: 前端 — 角落挂件（主灯 + 会话清单）

监听 `state-update`，渲染聚合主灯（颜色随状态，waiting 闪烁），点击展开会话清单（项目名 + 状态 + 持续时长 + ⌘N 提示，等待中高亮）。视觉对齐已确认的高保真原型 `live-demo.html`。

**Files:**
- Modify: `app/ui/widget.html`, `app/ui/widget.js`
- Create: `app/ui/common.css`

- [ ] **Step 1: 写 widget.html + common.css**

`app/ui/widget.html` 结构（含 `.wbody`/`.wdot`/`.wtxt`/`.list`），样式从 `live-demo.html` 的 `.widget/.wbody/.wdot/.list/.row` 段落移植到 `common.css`。背景必须透明（`html,body{background:transparent}`）。

- [ ] **Step 2: 写 widget.js**

```javascript
// app/ui/widget.js
const { listen } = window.__TAURI__.event;
const COLORS = { working:'#f59e0b', waiting:'#ef4444', idle:'#22c55e' };
const LABEL  = { working:'工作中', waiting:'需要交互', idle:'空闲/完成' };
const $ = s => document.querySelector(s);
let expanded = false;

function dur(sec){ const d=Math.floor(Date.now()/1000)-sec; return d<60? d+'s' : Math.floor(d/60)+'m'; }

function render(p){
  const agg = p.agg;
  const dot = $('#wdot');
  dot.style.background = COLORS[agg];
  dot.style.boxShadow = '0 0 12px ' + COLORS[agg];
  dot.style.animation = agg==='waiting' ? 'blink .6s steps(1) infinite' : 'none';
  const waiting = p.sessions.filter(s=>s.state==='waiting').length;
  $('#wtxt').textContent = waiting ? (waiting+' 个等你交互')
                        : agg==='working' ? '工作中' : '全部就绪';
  $('#list').innerHTML = p.sessions.map(s=>`
    <div class="row ${s.state==='waiting'?'hot':''}">
      <span class="rdot" style="background:${COLORS[s.state]};box-shadow:0 0 7px ${COLORS[s.state]}"></span>
      <div><div class="rname">${s.project}</div><div class="rstate">${LABEL[s.state]}</div></div>
      <span class="rdur">${dur(s.updatedAt)}</span>
    </div>`).join('') || '<div class="row"><div class="rstate">无活跃会话</div></div>';
}

let last = { sessions: [], agg: 'idle' };
listen('state-update', e => { last = e.payload; render(last); });
$('#wbody').addEventListener('click', () => {
  expanded = !expanded; $('#list').classList.toggle('show', expanded);
});
setInterval(()=>render(last), 5000); // 刷新持续时长
render(last);
```

- [ ] **Step 3: 运行验证**

Run: `cd app && npm run tauri dev`
另开终端制造状态：
```bash
mkdir -p ~/.local/state/cc-trafficlight/sessions
printf '{"sessionId":"a","project":"web-dashboard","state":"waiting","updatedAt":%s}' $(date +%s) \
  > ~/.local/state/cc-trafficlight/sessions/a.json
```
Expected: 挂件主灯变红闪烁、文字"1 个等你交互"，点击展开能看到 web-dashboard 一行高亮。

- [ ] **Step 4: 提交**

```bash
git add app/ui/ && git commit -m "feat(ui): corner widget shows aggregate light and session list"
```

---

## Task 11: 前端 — 全屏边框脉冲

监听 `alert` 事件，播放一次约 2.2s 的红色边框脉冲后淡出（窗口保持透明常驻）。CSS 从 `live-demo.html` 的 `.pulse/.fire/@keyframes firePulse` 移植，但作用于整窗（`position:fixed;inset:0`）。

**Files:**
- Modify: `app/ui/pulse.html`, `app/ui/pulse.js`

- [ ] **Step 1: 写 pulse.html**

```html
<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="common.css">
<style>
 html,body{margin:0;background:transparent;overflow:hidden}
 #border{position:fixed;inset:0;pointer-events:none;opacity:0;
   box-shadow:inset 0 0 0 6px #ef4444, inset 0 0 80px rgba(239,68,68,.5)}
 #border.fire{animation:firePulse 2.2s ease-out}
 @keyframes firePulse{0%{opacity:0}12%{opacity:1}40%{opacity:.85}100%{opacity:0}}
</style></head>
<body><div id="border"></div><script src="pulse.js"></script></body></html>
```

- [ ] **Step 2: 写 pulse.js**

```javascript
// app/ui/pulse.js
const { listen } = window.__TAURI__.event;
const border = document.getElementById('border');
listen('alert', () => {
  border.classList.remove('fire');
  void border.offsetWidth;   // 强制 reflow 以重启动画
  border.classList.add('fire');
});
```

- [ ] **Step 3: 运行验证**

Run: `cd app && npm run tauri dev`，然后制造"进入 waiting"：
```bash
# 先 idle 再 waiting，触发边沿
printf '{"sessionId":"a","project":"api","state":"idle","updatedAt":%s}' $(date +%s) \
  > ~/.local/state/cc-trafficlight/sessions/a.json; sleep 1
printf '{"sessionId":"a","project":"api","state":"waiting","updatedAt":%s}' $(date +%s) \
  > ~/.local/state/cc-trafficlight/sessions/a.json
```
Expected: 屏幕四周红色脉冲一下后淡出。

- [ ] **Step 4: 提交**

```bash
git add app/ui/ && git commit -m "feat(ui): fullscreen border pulse on alert"
```

---

## Task 12: 系统通知

在 `alert` 时弹 macOS 通知。用 notification 插件的全局 JS API，在 widget.js 中处理（widget 常驻、有 DOM）。

**Files:**
- Modify: `app/ui/widget.js`
- Modify: `app/src-tauri/capabilities/default.json`（授权 notification）

- [ ] **Step 1: 配置 capability**

`app/src-tauri/capabilities/default.json`:
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "default capability",
  "windows": ["widget", "pulse"],
  "permissions": [
    "core:default",
    "notification:default"
  ]
}
```

- [ ] **Step 2: 在 widget.js 顶部加通知处理**

```javascript
const { isPermissionGranted, requestPermission, sendNotification } =
  window.__TAURI__.notification;

async function ensureNotifyPerm(){
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === 'granted';
  return granted;
}
ensureNotifyPerm();

listen('alert', async (e) => {
  if (await isPermissionGranted()) {
    sendNotification({ title: 'CC 状态灯',
      body: (e.payload.project || '某会话') + ' 需要你确认' });
  }
});
```

- [ ] **Step 3: 运行验证**

Run: `cd app && npm run tauri dev`，首启授予通知权限，再制造"进入 waiting"（同 Task 11）。
Expected: 通知中心弹出"api 需要你确认"。

- [ ] **Step 4: 提交**

```bash
git add app/ && git commit -m "feat(app): system notification on alert"
```

---

## Task 13: 提示音 + 设置开关

`alert` 时按开关播放 WebAudio 提示音。开关存 `localStorage`，默认开。在 widget 上加一个小齿轮切换提示音（最小实现：右键挂件切换并显示状态）。

**Files:**
- Modify: `app/ui/widget.js`

- [ ] **Step 1: 加声音与开关**

```javascript
const SOUND_KEY = 'cctl_sound';
function soundOn(){ return localStorage.getItem(SOUND_KEY) !== 'off'; }
function beep(){
  if (!soundOn()) return;
  try {
    const ac = new (window.AudioContext||window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain();
    o.connect(g); g.connect(ac.destination); o.type='sine';
    o.frequency.setValueAtTime(880, ac.currentTime);
    o.frequency.setValueAtTime(660, ac.currentTime+0.12);
    g.gain.setValueAtTime(0.0001, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime+0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime+0.32);
    o.start(); o.stop(ac.currentTime+0.34);
  } catch(_) {}
}
// 在已有的 alert 监听里调用 beep()
// 右键挂件切换提示音
$('#wbody').addEventListener('contextmenu', ev => {
  ev.preventDefault();
  localStorage.setItem(SOUND_KEY, soundOn() ? 'off' : 'on');
  $('#wtxt').textContent = '提示音' + (soundOn() ? '开' : '关');
});
```

将 `beep();` 加入 Task 12 的 `alert` 监听回调中。

- [ ] **Step 2: 运行验证**

Run: `cd app && npm run tauri dev`，制造"进入 waiting"。
Expected: 听到一声提示音；右键挂件能切换开/关，关闭后再次触发无声。

- [ ] **Step 3: 提交**

```bash
git add app/ui/widget.js && git commit -m "feat(ui): alert sound with toggle"
```

---

## Task 14: 端到端验收 + 打包说明

**Files:**
- Create: `README.md`

- [ ] **Step 1: 写 README（安装与使用）**

内容包含：
1. 安装 hook：`bash hook/install.sh`（写入 `~/.claude/settings.json`）。
2. 构建 App：`cd app && npm install && npm run tauri build`，产物 `app/src-tauri/target/release/bundle/`。
3. 开发调试：`npm run tauri dev`。
4. 首次启动授予通知权限。
5. 已知限制（引用设计文档 §9）。

- [ ] **Step 2: 真机端到端验收**

开 3 个 Ghostty tab，各跑一个 `claude` 会话，分别制造工作/等待/完成，确认：
- tab 标题出现 🟡/🔴/🟢 + 项目名；
- 角落挂件聚合灯与清单正确；
- 某会话进入 waiting 时：边框脉冲 + 系统通知 + 提示音同时触发，且仅触发一次；
- 把 Ghostty 退后台 / 切到全屏 App，通知与脉冲仍可见；
- 退出会话后该项从清单消失（SessionEnd）。

- [ ] **Step 3: hook 全测试 + Rust 全测试回归**

Run:
```bash
bash hook/tests/hook_test.sh
cd app/src-tauri && cargo test
```
Expected: 全绿。

- [ ] **Step 4: 提交**

```bash
git add README.md && git commit -m "docs: usage and packaging instructions"
```

---

## 自检备注（spec 覆盖）

- §4 状态模型/聚合 → Task 4、5
- §5 hook 映射 → Task 1、2、3
- §6 状态存储/file-watch/陈旧清理 → Task 1、5、7
- §7 tab 标题 OSC → Task 2
- §8.1 双窗口/置顶/穿透/全 Space → Task 8、9
- §8.2 边框脉冲 + 挂件清单 → Task 10、11
- §8.3 聚合 emit/边沿触发 → Task 6、7
- §8.4 系统通知 + 提示音 + 盖全屏 → Task 9、12、13
- §9 限制 → README（Task 14）记录；error 态不实现（与 spec 一致）
- §11 测试 → Task 1/2/4/5/6 单测 + Task 14 手动验收
