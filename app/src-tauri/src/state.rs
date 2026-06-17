use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Session {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub project: String,
    pub state: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: u64,
    #[serde(default)]
    pub tty: String,
    #[serde(default)]
    pub cwd: String,
}

pub fn priority(state: &str) -> u8 {
    match state {
        "waiting" => 4,
        "attention" => 3,
        "working" => 2,
        _ => 1,
    }
}

/// 最紧急优先；空列表返回 "idle"
pub fn aggregate(sessions: &[Session]) -> String {
    sessions
        .iter()
        .max_by_key(|s| priority(&s.state))
        .map(|s| s.state.clone())
        .unwrap_or_else(|| "idle".to_string())
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// 该 tty 上是否还有进程（tab 是否还开着）。tty 未知时返回 true（无法判断则保留）。
fn tty_alive(tty: &str) -> bool {
    let name = tty.trim_start_matches("/dev/").trim();
    if name.is_empty() || name == "unknown" {
        return true;
    }
    match Command::new("ps").args(["-t", name, "-o", "pid="]).output() {
        Ok(o) => !String::from_utf8_lossy(&o.stdout).trim().is_empty(),
        Err(_) => true,
    }
}

/// 扫描目录，解析所有 *.json；超过 stale_secs 未更新的删除并跳过。
pub fn scan_dir(dir: &Path, stale_secs: u64) -> Vec<Session> {
    let mut out = Vec::new();
    let now = now_secs();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for e in entries.flatten() {
        let path = e.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(sess) = serde_json::from_str::<Session>(&text) else {
            continue;
        };
        // tab 已关闭（tty 上没进程）→ 立即移除，不管空闲多久
        if !tty_alive(&sess.tty) {
            std::fs::remove_file(&path).ok();
            continue;
        }
        // 兜底：tty 未知的僵尸文件按超长时限清理
        if now.saturating_sub(sess.updated_at) > stale_secs {
            std::fs::remove_file(&path).ok();
            continue;
        }
        out.push(sess);
    }
    out.sort_by(|a, b| a.session_id.cmp(&b.session_id));
    out
}

/// 仅在聚合状态从“非 waiting”跨入“waiting”时返回 true。
pub fn should_alert(prev: &str, next: &str) -> bool {
    next == "waiting" && prev != "waiting"
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn s(id: &str, st: &str, at: u64) -> Session {
        Session {
            session_id: id.into(),
            project: "p".into(),
            state: st.into(),
            updated_at: at,
            tty: String::new(),
            cwd: String::new(),
        }
    }

    #[test]
    fn aggregate_picks_worst() {
        let v = vec![s("a", "idle", 1), s("b", "working", 1), s("c", "waiting", 1)];
        assert_eq!(aggregate(&v), "waiting");
    }
    #[test]
    fn aggregate_empty_is_idle() {
        assert_eq!(aggregate(&[]), "idle");
    }
    #[test]
    fn aggregate_working_over_idle() {
        let v = vec![s("a", "idle", 1), s("b", "working", 1)];
        assert_eq!(aggregate(&v), "working");
    }

    #[test]
    fn aggregate_waiting_beats_attention_beats_working() {
        let v = vec![s("a", "working", 1), s("b", "attention", 1)];
        assert_eq!(aggregate(&v), "attention");
        let v2 = vec![s("a", "attention", 1), s("b", "waiting", 1)];
        assert_eq!(aggregate(&v2), "waiting");
    }

    #[test]
    fn scan_reads_and_drops_stale() {
        let dir = std::env::temp_dir().join(format!("cctl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fresh = dir.join("a.json");
        let stale = dir.join("b.json");
        let now = now_secs();
        write!(
            std::fs::File::create(&fresh).unwrap(),
            r#"{{"sessionId":"a","project":"p","state":"working","updatedAt":{}}}"#,
            now
        )
        .unwrap();
        write!(
            std::fs::File::create(&stale).unwrap(),
            r#"{{"sessionId":"b","project":"p","state":"waiting","updatedAt":{}}}"#,
            now - 99999
        )
        .unwrap();
        let sessions = scan_dir(&dir, 1800);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "a");
        assert!(!stale.exists(), "stale file should be deleted");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn alert_only_on_entering_waiting() {
        assert!(should_alert("working", "waiting"));
        assert!(should_alert("idle", "waiting"));
        assert!(!should_alert("waiting", "waiting"));
        assert!(!should_alert("waiting", "idle"));
        assert!(!should_alert("idle", "working"));
    }
}
