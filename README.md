# cc-trafficlight

给 Claude Code 做的 macOS 桌面状态灯。两层：

1. **hook 层**：每个 CC 会话的 hook 把状态写成文件，并用 OSC 转义序列改 Ghostty 的 tab 标题（🟡 工作中 / 🔴 需要交互 / 🟢 空闲）。
2. **悬浮灯层**：独立 Tauri App，监听状态目录，聚合呈现：
   - 角落挂件（聚合主灯 + 可展开的会话清单）
   - 进入"需要交互"时：全屏边框红色脉冲 + 系统通知 + 提示音
   - 置顶、跨所有 Space、可浮在别的全屏 App 之上

设计与计划见 `docs/superpowers/`。

## 安装

### 1. 安装 hook

```bash
bash hook/install.sh
```

把 8 个 hook 事件写进 `~/.claude/settings.json`（幂等，可重复运行）。
状态目录默认 `~/.local/state/cc-trafficlight/sessions/`。

### 2. 构建悬浮灯 App

```bash
cd app
npm install
npm run tauri build      # 产物在 app/src-tauri/target/release/bundle/
```

开发调试：

```bash
cd app
npm run tauri dev
```

首次启动时授予**通知权限**，否则系统通知渠道静默失效。

## 使用

- 在 Ghostty 里开多个 tab，每个 tab 跑一个 `claude`。
- tab 标题会实时显示 🟡/🔴/🟢 + 项目名。
- 悬浮灯角落挂件显示聚合状态；点击展开会话清单。
- 任一会话进入"需要交互"时触发边框脉冲 + 通知 + 提示音。
- **右键挂件**切换提示音开/关。

## 已知限制（详见设计文档 §9）

- Ghostty 无脚本接口：悬浮灯**无法自动切 tab、报不出准确 ⌘N**，定位靠 tab 标题颜色 + 手动 ⌘N。
- CC 无干净的"错误"事件：本版**不实现 error 态**。
- 系统通知需 App 正确打包并授予权限。
- 盖住全屏 App 靠 `fullScreenAuxiliary` + 高 window level，macOS 下不保证 100%，兜底用通知 + 提示音。

## 测试

```bash
bash hook/tests/hook_test.sh          # hook 脚本
cd app/src-tauri && cargo test --lib  # Rust 聚合/扫描/边沿逻辑
```
