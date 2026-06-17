use std::process::Command;

#[derive(serde::Serialize, Clone)]
pub struct Tab {
    pub win: u32,
    pub tab: u32,
    pub title: String,
}

const LIST_SCRIPT: &str = r#"tell application "System Events" to tell process "ghostty"
set o to ""
set wi to 0
repeat with w in windows
  set wi to wi + 1
  try
    set ti to 0
    repeat with rb in (radio buttons of tab group 1 of w)
      set ti to ti + 1
      set o to o & wi & "|" & ti & "|" & (name of rb) & linefeed
    end repeat
  end try
end repeat
return o
end tell"#;

/// 通过辅助功能读取所有 Ghostty 窗口的标签（编号即 ⌘N，按窗口内顺序）。
pub fn list_tabs() -> Vec<Tab> {
    let mut v = Vec::new();
    let Ok(out) = Command::new("osascript").arg("-e").arg(LIST_SCRIPT).output() else {
        return v;
    };
    let s = String::from_utf8_lossy(&out.stdout);
    for line in s.lines() {
        let parts: Vec<&str> = line.splitn(3, '|').collect();
        if parts.len() == 3 {
            if let (Ok(w), Ok(t)) =
                (parts[0].trim().parse::<u32>(), parts[1].trim().parse::<u32>())
            {
                v.push(Tab {
                    win: w,
                    tab: t,
                    title: parts[2].to_string(),
                });
            }
        }
    }
    v
}

/// 把标题包含 `needle` 的标签切到前台。
pub fn jump(needle: &str) -> bool {
    let safe = needle.replace('"', "").replace('\\', "");
    let script = format!(
        r#"tell application "Ghostty" to activate
tell application "System Events" to tell process "ghostty"
  repeat with w in windows
    try
      repeat with rb in (radio buttons of tab group 1 of w)
        if (name of rb) contains "{needle}" then
          perform action "AXRaise" of w
          click rb
          return "ok"
        end if
      end repeat
    end try
  end repeat
end tell
return "notfound""#,
        needle = safe
    );
    let Ok(out) = Command::new("osascript").arg("-e").arg(script).output() else {
        return false;
    };
    String::from_utf8_lossy(&out.stdout).contains("ok")
}

/// 按 (窗口序号, 标签序号) 精确切换标签。
pub fn jump_index(win: u32, tab: u32) -> bool {
    let script = format!(
        r#"tell application "Ghostty" to activate
tell application "System Events" to tell process "ghostty"
  try
    perform action "AXRaise" of window {win}
    click radio button {tab} of tab group 1 of window {win}
    return "ok"
  end try
end tell
return "notfound""#,
        win = win,
        tab = tab
    );
    let Ok(out) = Command::new("osascript").arg("-e").arg(script).output() else {
        return false;
    };
    String::from_utf8_lossy(&out.stdout).contains("ok")
}
