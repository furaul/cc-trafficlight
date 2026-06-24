# 探出动作条 + 一键/快捷键跳转 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当某会话进入「待确认(红)」或「刚完成(绿)」时，右下角药丸自动探出一条可点跳转的动作条（只显最紧急一个 + `+N` 计数 + 运行时长），并提供全局快捷键 ⌥⌘J 在待响应会话间循环跳转。

**Architecture:** 全局快捷键在 Rust 端注册（失焦也生效），按下时只 `emit("hotkey-cycle")`；所有「待响应集合」的判定、tab 匹配、循环游标、动作条渲染都在前端 `widget.js`（数据与 Ghostty AX 匹配逻辑已在那里）。绿框复用独立 pulse 窗口，由前端在「无红且刚出现绿」的边沿 `emit("done-alert")` 触发一次性绿色脉冲。

**Tech Stack:** Tauri v2（Rust + 原生 HTML/JS, withGlobalTauri）、tauri-plugin-global-shortcut、Ghostty 辅助功能跳转（现有 `cc_jump_index`）。

参考：设计 `docs/superpowers/specs/2026-06-22-jump-action-bar-design.md`；交互原型 `docs/prototypes/jump-action-bar-prototype.html`。

> 说明：本项目前端是 webview 原生 JS，无 JS 单测框架，前端任务用「构建 + 真机手动验证」收尾（与现有 widget.js 的验证方式一致）；Rust 侧用 `cargo build` 验证编译。

---

### Task 1: 注册全局快捷键 ⌥⌘J（Rust）

**Files:**
- Modify: `app/src-tauri/Cargo.toml`
- Modify: `app/src-tauri/src/main.rs`

- [ ] **Step 1: 加依赖**

在 `app/src-tauri/Cargo.toml` 的 `[dependencies]` 段末尾（`notify = "6"` 下一行）加入：

```toml
tauri-plugin-global-shortcut = "2"
```

- [ ] **Step 2: 在 main.rs 引入类型并注册插件 + 快捷键**

把 `app/src-tauri/src/main.rs` 顶部的 `use tauri::Manager;` 替换为：

```rust
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
```

把 `fn main()` 整体替换为下面内容（在原有基础上：注册 global-shortcut 插件 + 在 setup 里 register ⌥⌘J）：

```rust
fn main() {
    // ⌥⌘J：在待响应 tab 间循环跳转
    let jump_sc = Shortcut::new(Some(Modifiers::ALT | Modifiers::SUPER), Code::KeyJ);
    let jump_sc_handler = jump_sc;

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &jump_sc_handler && event.state() == ShortcutState::Pressed {
                        app.emit("hotkey-cycle", ()).ok();
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![cc_tabs, cc_jump, cc_jump_index])
        .setup(move |app| {
            if let Some(pulse) = app.get_webview_window("pulse") {
                if let Ok(Some(mon)) = pulse.primary_monitor() {
                    let s = mon.size();
                    let p = mon.position();
                    pulse.set_position(tauri::PhysicalPosition::new(p.x, p.y)).ok();
                    pulse.set_size(tauri::PhysicalSize::new(s.width, s.height)).ok();
                }
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
            app.global_shortcut().register(jump_sc)?;
            watcher::start(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running cc-trafficlight");
}
```

- [ ] **Step 3: 编译验证**

Run: `cd app/src-tauri && cargo build`
Expected: 编译通过（首次会拉取 `tauri-plugin-global-shortcut`），无 error。

- [ ] **Step 4: Commit**

```bash
cd ~/Documents/Documents/dev/2026_workspace/cc-trafficlight
git add app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock app/src-tauri/src/main.rs
git commit -m "feat: register global shortcut Alt+Cmd+J emitting hotkey-cycle"
```

---

### Task 2: 探出动作条 + 待响应模型（前端）

**Files:**
- Modify: `app/ui/widget.html`
- Modify: `app/ui/common.css`
- Modify: `app/ui/widget.js`

- [ ] **Step 1: 在 widget.html 加入动作条 DOM**

把 `app/ui/widget.html` 的 `.widget` 块替换为（在 list 与 wbody 之间插入 `#peek`）：

```html
  <div class="widget">
    <div class="list" id="list"></div>
    <div class="peek" id="peek">
      <div class="actionbar" id="actionbar">
        <span class="adot" id="adot"></span>
        <div class="ameta">
          <div class="aname" id="aname"></div>
          <div class="astate" id="astate"></div>
        </div>
        <span class="ago">跳转 →</span>
        <span class="amore" id="amore"></span>
      </div>
    </div>
    <div class="wbody" id="wbody">
      <span class="wdot" id="wdot"></span>
      <span class="wtxt" id="wtxt">全部就绪</span>
    </div>
  </div>
```

- [ ] **Step 2: 在 common.css 末尾加动作条样式**

追加到 `app/ui/common.css` 末尾：

```css
/* 探出动作条 */
.peek {
  width: 268px;
  background: rgba(8, 11, 17, 0.92);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.6);
  overflow: hidden;
  display: none;
}
.peek.show { display: block; }
.actionbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 11px;
  cursor: pointer;
  position: relative;
}
.actionbar:hover { background: rgba(255, 255, 255, 0.06); }
.actionbar:active { background: rgba(255, 255, 255, 0.12); }
.adot { width: 12px; height: 12px; border-radius: 50%; flex: 0 0 auto; }
.ameta { flex: 1; min-width: 0; }
.aname { font-size: 13px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.aname .rcmd { margin-left: 6px; }
.astate { font-size: 10.5px; color: var(--muted); margin-top: 2px; }
.ago {
  font-size: 11px; color: #dfe4ee; background: rgba(255, 255, 255, 0.08);
  border-radius: 8px; padding: 6px 10px; white-space: nowrap;
}
.actionbar:hover .ago { background: rgba(255, 255, 255, 0.14); }
.amore {
  position: absolute; top: 6px; right: 8px; font-size: 9.5px; color: var(--muted);
  background: rgba(8, 11, 17, 0.9); border: 1px solid var(--line);
  border-radius: 7px; padding: 0 5px;
}
.amore:empty { display: none; }
```

- [ ] **Step 3: 在 widget.js 顶部加常量与待响应模型**

在 `app/ui/widget.js` 顶部，把第 1 行
`const { listen } = window.__TAURI__.event;`
替换为：

```js
const { listen, emit } = window.__TAURI__.event;
```

在 `let last = { sessions: [], agg: "idle" };`（约第 78 行）之后追加：

```js
// 「刚完成」绿的有效期：idle 且距上次更新不超过此秒数才算“待查看”
const DONE_TTL = 300;
const PEEK_PRIO = { waiting: 2, idle: 1 };
const viewed = new Set();   // 已点开查看过的绿（跳转后标记，状态再变时清除）
let jumpCursor = 0;
let prevGreen = false;      // 绿框边沿触发用

function nowSecs() { return Math.floor(Date.now() / 1000); }
function isPending(s) {
  if (s.state === "waiting") return true;
  if (s.state === "idle" && nowSecs() - s.updatedAt < DONE_TTL) return true;
  return false;
}
// 待响应集合（带 tab 分配），按 红>绿、再 (win,tab) 升序
function pendingList() {
  const asn = buildAssignments(last.sessions);
  return last.sessions
    .filter((s) => isPending(s) && !viewed.has(s.sessionId))
    .map((s) => ({ ...s, asn: asn[s.sessionId] }))
    .sort((a, b) => {
      const pa = PEEK_PRIO[a.state] || 0, pb = PEEK_PRIO[b.state] || 0;
      if (pa !== pb) return pb - pa;
      const A = a.asn, B = b.asn;
      if (A && B) return A.win - B.win || A.tab - B.tab;
      return A ? -1 : B ? 1 : 0;
    });
}
function hasPending() { return last.sessions.some((s) => isPending(s) && !viewed.has(s.sessionId)); }
```

- [ ] **Step 4: 在 widget.js 加渲染动作条与跳转函数**

在 `render(p)` 函数定义之前追加这两个函数：

```js
function renderPeek() {
  // 清理已失效的“已查看”标记：会话没了或不再是 idle 就移除
  for (const id of [...viewed]) {
    const s = last.sessions.find((x) => x.sessionId === id);
    if (!s || s.state !== "idle") viewed.delete(id);
  }
  const pl = pendingList();
  const peek = $("#peek");
  if (!pl.length) { peek.classList.remove("show"); maybeGreen(false); return; }
  if (jumpCursor >= pl.length) jumpCursor = 0;
  const cur = pl[0]; // 动作条始终显示最紧急的那一个
  $("#adot").style.background = COLORS[cur.state];
  $("#adot").style.boxShadow = "0 0 7px " + COLORS[cur.state];
  $("#adot").style.animation = cur.state === "waiting" ? "blink .6s steps(1) infinite" : "none";
  const cmd = cur.asn ? ` <span class="rcmd">⌘${cur.asn.tab}</span>` : "";
  $("#aname").innerHTML = cur.project + cmd;
  $("#astate").textContent = LABEL[cur.state] + " · " + dur(cur.updatedAt);
  $("#amore").textContent = pl.length > 1 ? "+" + (pl.length - 1) : "";
  peek.classList.add("show");
  // 绿框：无红 且 有刚完成绿 → 触发一次
  const hasWaiting = pl.some((x) => x.state === "waiting");
  maybeGreen(!hasWaiting && pl.some((x) => x.state === "idle"));
}

function maybeGreen(on) {
  if (on && !prevGreen) emit("done-alert");
  prevGreen = on;
}

function jumpTo(item) {
  if (!item || !item.asn) return;
  invoke("cc_jump_index", { win: item.asn.win, tab: item.asn.tab });
  if (item.state === "idle") viewed.add(item.sessionId); // 绿点了=已查看
  renderPeek();
}
```

- [ ] **Step 5: 在 render(p) 末尾调用 renderPeek，并让 tab 轮询覆盖 pending**

在 `render(p)` 函数体的最后一行 `maybeLayout();` 之前插入：

```js
  renderPeek();
```

把文件底部的
```js
setInterval(() => {
  if (expanded) refreshTabs();
}, 4000);
```
替换为：

```js
setInterval(() => {
  if (expanded || hasPending()) refreshTabs();
}, 4000);
```

- [ ] **Step 6: 给动作条绑定点击跳转**

在 `$("#list").addEventListener("click", ...)` 这段之后追加：

```js
$("#actionbar").addEventListener("click", () => {
  const pl = pendingList();
  if (pl.length) jumpTo(pl[0]);
});
```

- [ ] **Step 7: 构建并手动验证**

Run: `cd app && npm run tauri build`
然后覆盖安装并打开（与现有流程一致）：

```bash
pkill -x cc-trafficlight 2>/dev/null; sleep 1
rm -rf /Applications/cc-trafficlight.app
cp -R src-tauri/target/release/bundle/macos/cc-trafficlight.app /Applications/
xattr -dr com.apple.quarantine /Applications/cc-trafficlight.app
open /Applications/cc-trafficlight.app
```

手动验证（用真实 claude 会话或临时写状态文件）：
- 一个会话进入 waiting → 药丸上方探出红色动作条，含「项目名 ⌘N · 需要交互 · 时长」+「跳转 →」。
- 再造一个 waiting + 一个刚 idle → 动作条仍只显最紧急（红），右上角出现 `+N`。
- 点动作条 → 跳到对应 Ghostty tab；绿的点完后从动作条消失。
- 所有待响应解除 → 动作条收起。

> 临时造状态文件示例：
> ```bash
> D=~/.local/state/cc-trafficlight/sessions; mkdir -p $D
> printf '{"sessionId":"demo1","project":"demo","cwd":"/x","state":"waiting","tty":"unknown","updatedAt":%s}' $(date +%s) > $D/demo1.json
> # 验证完删除： rm $D/demo1.json
> ```

- [ ] **Step 8: Commit**

```bash
cd ~/Documents/Documents/dev/2026_workspace/cc-trafficlight
git add app/ui/widget.html app/ui/common.css app/ui/widget.js
git commit -m "feat: peek action bar for waiting/just-done sessions with jump"
```

---

### Task 3: 快捷键循环跳转（前端）

**Files:**
- Modify: `app/ui/widget.js`

- [ ] **Step 1: 监听 hotkey-cycle 并循环跳转**

在 `listen("alert", ...)` 这段之后追加：

```js
listen("hotkey-cycle", async () => {
  await refreshTabs();          // 确保 tabMap 最新（药丸没展开过时也能跳）
  const pl = pendingList();
  if (!pl.length) return;
  const item = pl[jumpCursor % pl.length];
  jumpTo(item);
  jumpCursor = (jumpCursor + 1) % pl.length; // 下次跳下一个
});
```

- [ ] **Step 2: 构建并手动验证快捷键**

Run: `cd app && npm run tauri build` 然后按 Task 2 Step 7 覆盖安装、打开。

手动验证：
- 造 2 个 waiting（不同 tab）。按 **⌥⌘J** → 跳到第一个；再按 → 跳到第二个；再按 → 回到第一个（循环）。
- App 失焦（点到别的应用）时按 ⌥⌘J 仍能跳转。
- 无任何待响应时按 ⌥⌘J → 无动作、不报错。

> 注：若按键无反应，确认 App 已授予「输入监控/辅助功能」权限且 Ghostty 跳转权限正常（沿用现有授权说明）。

- [ ] **Step 3: Commit**

```bash
cd ~/Documents/Documents/dev/2026_workspace/cc-trafficlight
git add app/ui/widget.js
git commit -m "feat: cycle through pending sessions on Alt+Cmd+J"
```

---

### Task 4: 绿色完成边框（pulse 窗口）

**Files:**
- Modify: `app/ui/pulse.html`
- Modify: `app/ui/pulse.js`

- [ ] **Step 1: pulse.html 加绿色脉冲样式**

把 `app/ui/pulse.html` 的 `<style>` 内容替换为（新增 `#border.firegreen` 绿色覆盖与 `fireGreen` 关键帧，红色保持不变）：

```css
    html, body { margin: 0; background: transparent; overflow: hidden; }
    #border {
      position: fixed;
      inset: 0;
      pointer-events: none;
      opacity: 0;
      box-shadow: inset 0 0 0 6px #ef4444, inset 0 0 80px rgba(239, 68, 68, 0.5);
    }
    #border.fire { animation: firePulse 2.2s ease-out; }
    @keyframes firePulse {
      0% { opacity: 0; }
      12% { opacity: 1; }
      40% { opacity: 0.85; }
      100% { opacity: 0; }
    }
    #border.firegreen {
      box-shadow: inset 0 0 0 5px #22c55e, inset 0 0 60px rgba(34, 197, 94, 0.32);
      animation: fireGreen 2.4s ease-out;
    }
    @keyframes fireGreen {
      0% { opacity: 0; }
      14% { opacity: 0.75; }
      45% { opacity: 0.55; }
      100% { opacity: 0; }
    }
```

- [ ] **Step 2: pulse.js 监听 done-alert**

把 `app/ui/pulse.js` 整体替换为：

```js
const { listen } = window.__TAURI__.event;
const border = document.getElementById("border");

function fire(cls) {
  border.classList.remove("fire", "firegreen");
  void border.offsetWidth; // 强制 reflow 重启动画
  border.classList.add(cls);
}

listen("alert", () => fire("fire"));          // 红：需要确认
listen("done-alert", () => fire("firegreen")); // 绿：刚完成
```

- [ ] **Step 3: 构建并手动验证绿框**

Run: `cd app && npm run tauri build` 然后覆盖安装、打开（同上）。

手动验证：
- 让一个会话从 working 转为 idle（真实：让 claude 结束一次回答；或临时写 idle 状态文件且 updatedAt=now）→ 在没有任何 waiting 时，屏幕四周出现一次**柔和绿色**脉冲。
- 存在 waiting 时只出现红框，不出现绿框。

- [ ] **Step 4: Commit**

```bash
cd ~/Documents/Documents/dev/2026_workspace/cc-trafficlight
git add app/ui/pulse.html app/ui/pulse.js
git commit -m "feat: soft green border pulse on session completion"
```

---

### Task 5: 收尾验证与推送

- [ ] **Step 1: 跑提交前敏感信息扫描**

按 `pre-commit-secret-scan` skill 对全部改动复扫（含 `git config user.email` 应为 `furaul@users.noreply.github.com`）。

- [ ] **Step 2: 完整回归手测**

打开 App，跑一遍设计里的全流程：探出动作条、`+N`、运行时长、点击跳转、⌥⌘J 循环（含失焦）、红/绿框联动、自动收起。对照 `docs/prototypes/jump-action-bar-prototype.html` 的演示效果。

- [ ] **Step 3: 推送**

```bash
cd ~/Documents/Documents/dev/2026_workspace/cc-trafficlight
git push
```
