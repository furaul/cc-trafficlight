use tauri::WebviewWindow;

/// 把 overlay 窗口提到 screenSaver 级、可跨所有 Space、并能浮在别的全屏 App 之上。
pub fn elevate_overlay(window: &WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let Ok(ns_window) = window.ns_window() else {
        return;
    };
    let ns_window = ns_window as *mut AnyObject;
    if ns_window.is_null() {
        return;
    }

    // NSWindowCollectionBehavior: CanJoinAllSpaces = 1<<0, FullScreenAuxiliary = 1<<8
    let behavior: u64 = (1 << 0) | (1 << 8);
    // NSScreenSaverWindowLevel = 1000
    let level: i64 = 1000;

    unsafe {
        let _: () = msg_send![ns_window, setCollectionBehavior: behavior];
        let _: () = msg_send![ns_window, setLevel: level];
    }
}
