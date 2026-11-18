//! topo-hub 桌面壳：进程内起 topo-hub 服务（axum），Tauri 窗口加载本机 URL。
//!
//! 与 serial-studio 桌面壳（重 IPC 命令层：端口数据/命令/文件全走 invoke）不同，
//! topo-hub 前端是纯 Web 架构（WS/REST/SSE 同源直连本地服务）——桌面化=窗口壳，
//! 唯一的 IPC 是自绘标题栏的右键系统菜单（show_system_menu，仅 Windows 生效）。
//!
//! 端口先同步 bind 再开窗：窗口加载时服务必然已在监听，无竞态白屏。

use clap::Parser;

#[derive(Parser)]
#[command(name = "topo-hub-desktop", version, about = "topo-hub 桌面壳")]
struct Args {
    /// HTTP 端口（REST/WS/MCP 同端口；与 headless bin 同默认）
    #[arg(long, default_value_t = 18800)]
    port: u16,
    /// 绑定地址：默认仅本机（GUI 程序保守默认——服务无认证，静默暴露到
    /// 局域网不负责任）；要局域网访问显式 --host 0.0.0.0（headless 同参）
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
}

fn main() {
    // 配置目录默认与 headless bin 一致（%APPDATA%/topo-hub），两形态共用同一份数据
    if std::env::var(ss_server::config::CONFIG_DIR_ENV).is_err() {
        if let Some(dir) = dirs::config_dir() {
            std::env::set_var(ss_server::config::CONFIG_DIR_ENV, dir.join("topo-hub"));
        }
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let args = Args::parse();
    let port = args.port;
    let host = args.host;

    tauri::Builder::default()
        // 自绘标题栏的系统菜单（仅 Windows 有实现；mac/Linux stub no-op）
        .invoke_handler(tauri::generate_handler![show_system_menu])
        .setup(move |app| {
            // 组装状态 + 租约定时清扫（与 headless bin 的 main 相同），服务
            // 跑在 tauri 自带的 tokio 运行时上；bind 同步完成——失败（端口
            // 被占用）直接弹窗退出，不开一个白屏窗口。
            let listener = tauri::async_runtime::block_on(async {
                let base = ss_server::create_state();
                base.devices.start();
                let state = topo_hub::TopoState::create(base);
                {
                    let leases = std::sync::Arc::clone(&state.leases);
                    let base = std::sync::Arc::new(state.base.clone());
                    tauri::async_runtime::spawn(async move {
                        let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
                        loop {
                            tick.tick().await;
                            leases.sweep(&base).await;
                        }
                    });
                }
                let router = topo_hub::create_router(state);
                let listener = tokio::net::TcpListener::bind((host.as_str(), port)).await;
                listener.map(|l| (l, router))
            });
            let (listener, router) = match listener {
                Ok(pair) => pair,
                Err(e) => {
                    let msg = format!("端口 {port} 被占用或不可用：{e}\n\n用 --port 换一个端口重试。");
                    rfd::MessageDialog::new()
                        .set_title("topo-hub 启动失败")
                        .set_level(rfd::MessageLevel::Error)
                        .set_description(&msg)
                        .show();
                    return Err(Box::new(std::io::Error::other(msg)));
                }
            };
            tauri::async_runtime::spawn(async move {
                if let Err(e) = axum::serve(listener, router).await {
                    tracing::error!("HTTP 服务异常退出: {e}");
                }
            });

            // 窗口加载本机服务 URL（同源直连，Web/桌面同一份前端；
            // 窗口恒走 127.0.0.1——host 是给局域网浏览器用的，与窗口无关）。
            // Windows 去系统装饰，窗口头由前端 .titlebar 自绘；mac 壳用原生
            // Overlay 红绿灯（去窗口 title 字样）；Linux 保留系统装饰
            // （无装饰 GTK 窗口没有边缘 resize 把手，不可拖边调大小）。
            let url = format!("http://127.0.0.1:{port}/");
            let mut builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(url.parse().expect("本机 URL 解析失败")),
            )
            .title("topo-hub")
            .inner_size(1440.0, 900.0)
            .min_inner_size(900.0, 600.0);
            #[cfg(target_os = "windows")]
            {
                builder = builder.decorations(false);
            }
            let win = builder.build()?;
            // macOS 的 Overlay 标题栏层会居中渲染窗口 title（自绘标题栏管不到），
            // 清空窗口标题以隐藏；Dock/菜单栏显示的是应用名，不受影响。
            #[cfg(target_os = "macos")]
            {
                let _ = win.set_title("");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("topo-hub 桌面壳运行失败");
}

/// 自绘标题栏右键 → 原生系统菜单（还原/移动/大小/最小化/最大化/关闭）。
/// 自绘窗口头后系统菜单没了，右键由此补回（VS Code 同款体验）。仅 Windows；
/// mac/Linux 无此习惯，stub no-op（前端不浪费 IPC）。
#[cfg(target_os = "windows")]
#[tauri::command]
fn show_system_menu(window: tauri::WebviewWindow) {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, GetSystemMenu, PostMessageW, SendMessageW, SetForegroundWindow,
        TrackPopupMenu, TPM_RETURNCMD, TPM_RIGHTBUTTON, WM_NULL, WM_SYSCOMMAND,
    };
    let Ok(h) = window.hwnd() else { return };
    // tauri(windows crate) HWND → windows-sys HWND(同为 *mut c_void 包裹)
    let hwnd = h.0 as windows_sys::Win32::Foundation::HWND;
    unsafe {
        let mut pt = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut pt) == 0 {
            return;
        }
        let menu = GetSystemMenu(hwnd, 0);
        if menu.is_null() {
            return;
        }
        // TrackPopupMenu 经典配方(Raymond Chen)：前后配 SetForegroundWindow/WM_NULL，
        // 否则菜单一闪而过或点外面不消失
        SetForegroundWindow(hwnd);
        let cmd = TrackPopupMenu(
            menu,
            TPM_RIGHTBUTTON | TPM_RETURNCMD,
            pt.x,
            pt.y,
            0,
            hwnd,
            std::ptr::null(),
        );
        PostMessageW(hwnd, WM_NULL, 0, 0);
        if cmd != 0 {
            SendMessageW(hwnd, WM_SYSCOMMAND, cmd as usize, 0);
        }
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn show_system_menu() {}
