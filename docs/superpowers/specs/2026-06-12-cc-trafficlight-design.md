# CC 状态灯（cc-trafficlight）设计文档

日期：2026-06-12
状态：已与用户确认，待评审

## 1. 目标

为 Claude Code 提供一个**醒目但不遮挡内容**的桌面状态提示，解决"开多个 CC tab 时错过 CC 在等我交互"的问题，替代现有不够醒目的 CodeIsland 插件。

成功标准：
- 任一 CC 会话进入"需要交互"时，用户在数秒内被吸引注意，即使当前没在看 tab 栏。
- 能分辨出是哪个会话/项目在等待。
- 常驻运行不打扰、不遮挡正在阅读的内容、资源占用低。

## 2. 使用场景与约束

- 主场景：**单窗口多 tab**，终端为 **Ghostty 1.3.1**（macOS），每个 tab 一个 CC 会话。
- Ghostty **无对外脚本/自动化接口**，由此带来两个硬约束：
  - 悬浮窗**无法自动切换到目标 tab**。
  - 进程**拿不到自己的 tab 序号**（⌘N 不可知）。
- 因此"精确定位是哪个 tab"必须由**终端内**承担（tab 标题），悬浮窗只负责"报警 + 列出有哪些会话在等"。

## 3. 总体架构：两层互补

```
┌─────────────────────────────────────────────────────┐
│  CC 会话 (tab)  ── hooks ──▶  hook 脚本               │
│                                  │                    │
│                    ┌─────────────┴──────────────┐     │
│                    ▼                            ▼     │
│         (a) 写 tab 标题 OSC          (b) 写状态文件    │
│            到 /dev/tty                到状态目录       │
│                    │                            │     │
│            ┌───────┘                            │     │
│            ▼                                    ▼     │
│   第1层：Ghostty tab 栏              第2层：Tauri 悬浮灯 │
│   显示 🟡/🔴/🟢 + 项目名             (file-watch 聚合)  │
│   → 用户定位 + 手动 ⌘N               → 抢眼 + 会话清单  │
└─────────────────────────────────────────────────────┘
```

- **第 1 层（定位）**：纯 hook + shell，零依赖。
- **第 2 层（抢眼 + 好看）**：独立 Tauri App，读状态文件聚合呈现。
- 两层共享同一份状态来源（hook 脚本），互不强依赖：即使悬浮灯没开，tab 标题照常工作。

## 4. 状态模型

五种逻辑状态，颜色与优先级：

| 状态 | 颜色 | tab 符号 | 聚合优先级（高→低） | 触发报警 |
|------|------|---------|--------------------|---------|
| 需要交互 waiting（真阻塞，如权限请求） | 🔴 红（闪） | 🔴 | 1（最高） | 是（脉冲+通知+声音） |
| 空闲等待 attention（CC 空闲等你输入） | 🔵 蓝（常亮） | 🔵 | 2 | 否 |
| 工作中 working | 🟡 黄 | 🟡 | 3 | 否 |
| 空闲/完成 idle | 🟢 绿 | 🟢 | 4 | 否 |
| 已结束 ended | ⚫ 灰 | （移除该 tab 项） | — | 否 |

**聚合规则（worst-state-wins）**：悬浮灯主灯颜色取所有活跃会话中优先级最高的状态。
**attention vs waiting**：CC 的 `Notification` 既在"请求权限（真阻塞）"也在"空闲等你输入"时触发。按 message 区分——含 "waiting for ... input" 归为 attention（蓝、不报警），其余归为 waiting（红、报警）。这样晾着的空闲会话不会让灯一直红。
（error 态仍不实现，见 §9。）

## 5. Hook 映射

使用 Claude Code 真实 hook 事件，映射到状态：

| Hook 事件 | 动作 |
|-----------|------|
| `SessionStart` | 注册会话，state=idle |
| `UserPromptSubmit` | state=working |
| `PreToolUse` | state=working |
| `PostToolUse` | state=working |
| `Notification` | 按 message 区分：权限请求 → waiting；"等你输入" → attention |
| `Stop` | state=idle（一轮完成） |
| `SubagentStop` | state=working（主流程通常仍在继续） |
| `SessionEnd` | 删除该会话状态文件 |

每个 hook 触发同一个脚本 `cc-trafficlight-hook.sh <event>`，脚本做两件事：
1. 更新状态文件（见 §6）。
2. 把 tab 标题写到 `/dev/tty`（见 §7）。

## 6. 状态存储与数据流

- 状态目录：`~/.local/state/cc-trafficlight/sessions/`
- 每个会话一个文件：`<session_id>.json`
  ```json
  {
    "sessionId": "abc123",
    "project": "web-dashboard",
    "cwd": "/Users/x/dev/web-dashboard",
    "state": "waiting",
    "tty": "/dev/ttys003",
    "updatedAt": 1781254553
  }
  ```
- `session_id`、`cwd` 从 hook 的 stdin JSON 读取；`project` 取 `cwd` 的 basename；`tty` 用 `tty` 命令获取。
- `SessionEnd` 删除对应文件。
- Tauri 后端用 `notify` crate **监听状态目录变化**，变化时重新聚合并 emit 给前端；同时启动时全量扫描一次。
- 兜底：对超过 N 分钟未更新的文件视为陈旧，扫描时清理（防止崩溃残留）。

## 7. 第 1 层：Tab 标题机制

hook 脚本按状态拼标题并写入控制终端：

```sh
printf '\033]0;%s %s\007' "$glyph" "$project" > /dev/tty
```

- `$glyph` ∈ {🟡, 🔴, 🟢}；`$project` 为项目名。
- 写到 `/dev/tty` 而非 stdout，确保转义序列到达 Ghostty 而不污染 hook 输出。
- Ghostty 在 tab 上渲染该标题，用户扫 tab 栏即可分辨。

## 8. 第 2 层：Tauri 悬浮灯

### 8.1 技术栈与窗口配置

- **Tauri v2**（Rust 后端 + Web 前端）。
- 两个窗口：

  **窗口 A · 角落挂件（widget）**
  - `decorations: false`、`transparent: true`、`alwaysOnTop: true`、`skipTaskbar: true`
  - 可拖拽（自定义拖拽区）。
  - 默认收起为一个小灯（主灯颜色=聚合状态），hover/点击展开会话清单。

  **窗口 B · 全屏边框脉冲（border-pulse）**
  - 全屏、透明、`alwaysOnTop`、`set_ignore_cursor_events(true)`（鼠标穿透）。
  - macOS 用 `set_visible_on_all_workspaces(true)` 跟随所有 Space。
  - 为盖住别的全屏 App：设置 NSWindow `collectionBehavior` 含 `.fullScreenAuxiliary`、并把窗口 level 提到 `.screenSaver` 级别（通过 Tauri/objc 调用）。见 §9 限制。
  - 平时完全透明无内容；仅在触发时画一圈发光边框。

### 8.2 交互行为

- **常驻**：角落挂件显示聚合主灯。working 黄、idle 绿。
- **进入 waiting 的瞬间**（聚合状态从非 waiting → waiting）：
  1. 窗口 B 触发**一次约 1 秒的红色边框脉冲**（呼吸一下后淡出），用于抢眼，不长期遮挡。
  2. 角落挂件主灯转为**红色闪烁**，持续到该 waiting 被消解。
- **展开清单**：hover/点击挂件，列出每个活跃会话：状态点 + 项目名 + 已持续时长。点击某项**不自动跳转**（Ghostty 限制），但高亮提示用户去 tab 栏找对应颜色（见 §9）。
- **可选声音**：waiting 触发时可配置播放一次轻提示音（开关，默认关）。

### 8.3 聚合逻辑

- 后端 watch 状态目录 → 重算聚合状态 → emit `state-changed` 事件（含完整会话列表 + 聚合态）。
- 前端据此更新挂件、清单，并判断是否需要触发边框脉冲（仅在"非 waiting → waiting"边沿触发，避免重复闪）。

### 8.4 后台通知渠道

解决"Ghostty 退到后台 / 你切到别的 App / 没在看屏幕"时如何及时收到提醒。前提：悬浮灯是独立 App（alwaysOnTop + 全 Space），本身就跨应用可见；以下渠道在此之上**按需补强**，全部仅在"非 waiting → waiting"边沿触发：

| 渠道 | 行为 | 备注 |
|------|------|------|
| 系统通知横幅 | macOS 通知中心弹"`<项目名>` 需要你确认" | 跨 App/桌面可见；需 App 打包+通知权限（见 §9） |
| 提示音 | 播放一次轻提示音 | 最简单，"没看屏幕"时有效；可在设置中关 |
| 盖住全屏 App | 边框脉冲/挂件浮在别的全屏 App 之上 | 靠 §8.1 的 `fullScreenAuxiliary` + 高 window level；不保证 100%（见 §9） |

不做：手机推送（ntfy / Pushover）—— 列入未来。
所有渠道默认开启、可在设置中单独开关。触发节流：同一会话的连续 waiting 不重复发通知/响声。

## 9. 已知限制（如实记录）

1. **无法自动切 tab / 无 ⌘N**：Ghostty 无脚本接口，悬浮灯只能"报警 + 列出项目名"，定位最终靠第 1 层 tab 标题颜色 + 用户手动 ⌘N。
2. **无干净的"错误"事件**：CC 没有专门的 error hook。v1 中 error 态先不单独实现（保留状态模型位置），后续可探索从 `PostToolUse` 的失败结果或退出码近似推断。
3. **依赖 `/dev/tty` 写标题**：若某 hook 执行环境无控制终端，则该会话 tab 标题不更新（状态文件仍正常，悬浮灯不受影响）。
4. **系统通知需打包+授权**：macOS 通知要求 App 正确打包（有 bundle id），并由用户授予通知权限；未授权时该渠道静默失效，需在首启引导授权。
5. **盖住全屏 App 不保证 100%**：`fullScreenAuxiliary` + 高 window level 能覆盖大多数情况，但 macOS 对全屏独占 Space 的浮层行为有不确定性；此时以系统通知 + 提示音兜底。

## 10. v1 范围

包含：
- hook 脚本（状态文件 + tab 标题），覆盖 §5 全部事件（error 除外）。
- 安装/配置说明：把 hook 写进 `~/.claude/settings.json`。
- Tauri 悬浮灯：角落挂件（主灯 + 展开会话清单）+ **全屏边框脉冲**。
- file-watch 聚合、陈旧文件清理。
- 后台通知渠道（§8.4）：**系统通知横幅 + 提示音 + 盖住全屏 App**，各自可开关。

不包含（未来）：
- error 态推断。
- 手机推送（ntfy / Pushover）等更多通知渠道。
- 跨终端（非 Ghostty）适配。
- 自动跳转 tab（受平台限制，除非 Ghostty 未来开放接口）。

## 11. 测试策略

- **hook 脚本**：用伪造的 hook stdin JSON 调用脚本，断言状态文件内容正确、`/dev/tty` 输出含预期转义序列。
- **聚合逻辑（Rust）**：单元测试 worst-state-wins 与陈旧清理。
- **边沿触发**：测试"非 waiting → waiting"才触发脉冲/通知/响声、连续 waiting 不重复触发。
- **后台通知**：把 Ghostty 退到后台、切到别的（含全屏）App，确认系统通知横幅、提示音、边框脉冲仍能触达。
- **手动验收**：开 3 个 Ghostty tab 跑 CC，制造 working/waiting/idle，确认 tab 标题、挂件、边框脉冲表现符合预期，且不遮挡内容、资源占用低。
