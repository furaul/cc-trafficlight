use crate::state::{aggregate, scan_dir, should_alert, Session};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::mpsc::channel;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

// tab 存活由 tty 判断；这里只是 tty 未知僵尸文件的超长兜底（24h）
const STALE_SECS: u64 = 86400;

pub fn state_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("CC_TL_DIR") {
        return PathBuf::from(d);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    home.join(".local/state/cc-trafficlight/sessions")
}

#[derive(Serialize, Clone)]
struct StatePayload {
    sessions: Vec<Session>,
    agg: String,
}

#[derive(Serialize, Clone)]
struct AlertPayload {
    project: String,
}

fn emit_now(app: &AppHandle, dir: &PathBuf, prev: &Mutex<String>) {
    let sessions = scan_dir(dir, STALE_SECS);
    let agg = aggregate(&sessions);
    {
        let mut p = prev.lock().unwrap();
        if should_alert(&p, &agg) {
            let project = sessions
                .iter()
                .find(|s| s.state == "waiting")
                .map(|s| s.project.clone())
                .unwrap_or_default();
            app.emit("alert", AlertPayload { project }).ok();
        }
        *p = agg.clone();
    }
    app.emit("state-update", StatePayload { sessions, agg }).ok();
}

pub fn start(app: AppHandle) {
    let dir = state_dir();
    std::fs::create_dir_all(&dir).ok();

    // 初始全量
    let prev = Mutex::new(String::from("idle"));
    emit_now(&app, &dir, &prev);

    std::thread::spawn(move || {
        let (tx, rx) = channel();
        let mut watcher: RecommendedWatcher = match Watcher::new(tx, notify::Config::default()) {
            Ok(w) => w,
            Err(_) => return,
        };
        if watcher.watch(&dir, RecursiveMode::NonRecursive).is_err() {
            return;
        }
        for res in rx {
            if res.is_ok() {
                emit_now(&app, &dir, &prev);
            }
        }
    });
}
