//! 系统托盘（GUI 壳专属，headless 不涉及）。
//!
//! 行为约定：
//! - 托盘常驻：图标 = 应用图标，菜单 = 「显示主窗口」「退出」，左键单击 = 显示并聚焦主窗口。
//! - 关闭主窗口（标题栏关闭按钮 / 系统关闭）= **隐藏到托盘**而非退出——串口连接、
//!   运行中的脚本、设备连接全部保留（与最小化的区别：任务栏不占位，入口在托盘）。
//!   拦截在 main.rs 的 CloseRequested；本模块以 [`Active`] 登记托盘是否就绪，
//!   未就绪时退回默认关闭行为（托盘失败不该让应用关不掉）。
//! - 「退出」走 `app.exit(0)`：窗口 Destroyed 清理（release_all / 停脚本）与今日关窗退出同路。
//! - macOS 额外入口：Dock 图标点击（RunEvent::Reopen，main.rs 转发到 [`show_main_window`]）。

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewWindow};

/// 托盘是否就绪（就绪才启用"关闭=隐藏到托盘"，见模块注释）。
/// managed state + AtomicBool：CloseRequested 在主线程同步路径上查，不能 await。
#[derive(Default)]
pub struct Active(std::sync::atomic::AtomicBool);

/// 创建托盘。失败不致命（warn 后应用照常运行，关闭主窗口退回退出语义）。
pub fn setup(app: &AppHandle) {
    let show = match MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>) {
        Ok(i) => i,
        Err(e) => {
            tracing::warn!("托盘菜单项创建失败: {e}");
            return;
        }
    };
    let quit = match MenuItem::with_id(app, "quit", "退出", true, None::<&str>) {
        Ok(i) => i,
        Err(e) => {
            tracing::warn!("托盘菜单项创建失败: {e}");
            return;
        }
    };
    let menu = match Menu::with_items(app, &[&show, &quit]) {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!("托盘菜单创建失败: {e}");
            return;
        }
    };
    // 图标用应用默认图标（bundle icons 的多分辨率源）。
    let icon = app.default_window_icon().cloned();
    let builder = TrayIconBuilder::with_id("main")
        .tooltip("Serial Studio")
        .menu(&menu)
        // 左键不弹菜单（留给"显示主窗口"），菜单走右键 / macOS 状态栏点击。
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    let builder = match icon {
        Some(i) => builder.icon(i),
        None => builder,
    };
    match builder.build(app) {
        Ok(_) => {
            if let Some(state) = app.try_state::<Active>() {
                state.0.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        }
        Err(e) => tracing::warn!("托盘创建失败: {e}"),
    }
}

/// 关闭主窗口的拦截判定：托盘就绪时隐藏窗口（返回 true = 已拦截），
/// 否则返回 false 走默认关闭。main.rs 的 CloseRequested 调用。
pub fn intercept_close(app: &AppHandle) -> bool {
    let active = app
        .try_state::<Active>()
        .map(|s| s.0.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false);
    if !active {
        return false;
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    true
}

/// 显示并聚焦主窗口（托盘左键 / 菜单「显示主窗口」/ macOS Dock 点击共用）。
/// 先 unminimize 再 show：最小化 + 隐藏并存时一步到位（顺序反了在 Windows 上
/// 只解除最小化不显窗）。
pub fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 主窗口当前是否对用户可见（可见且未最小化）。供脚本结束通知判定：
/// 窗口可见时运行卡已展示结果，不再推系统通知免打扰。
/// Tauri Rust 侧 is_visible/is_minimized 为同步 IPC（与 JS API 的 async 不同）。
pub fn window_shown(window: &WebviewWindow) -> bool {
    window.is_visible().unwrap_or(true) && !window.is_minimized().unwrap_or(false)
}
