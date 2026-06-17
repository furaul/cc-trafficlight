#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use cc_trafficlight_lib::watcher;
#[cfg(target_os = "macos")]
use cc_trafficlight_lib::macos;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            if let Some(pulse) = app.get_webview_window("pulse") {
                // 铺满主显示器，让边框脉冲贴着屏幕/全屏窗口四边
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
            watcher::start(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running cc-trafficlight");
}
