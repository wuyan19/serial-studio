/**
 * 自绘标题栏(VS Code 式):替代系统窗口头。
 * - 拖动:左键按下 startDragging;双击 toggleMaximize(仅事件落在标题栏自身,子元素不劫持)
 * - 右键:Windows 弹原生系统菜单(show_system_menu command,还原/移动/大小/…)
 * - 窗口按钮:Win/Linux 自绘 最小化/最大化(还原)/关闭;macOS 用 Overlay 保留原生红绿灯
 *   (左侧留安全区),仅渲染拖拽区
 * - Web 模式不渲染(App 层按 getMode 控制)
 */
import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform as osPlatform } from "@tauri-apps/plugin-os";
import { tauriInvoke } from "../lib";
import { IconClose, IconWinMax, IconWinMin, IconWinRestore } from "../icons";

export function TitleBar() {
  // 组件内取窗口引用(非模块顶层!):本组件只在 Tauri 桌面渲染,而模块顶层调用
  // getCurrentWindow() 在纯浏览器会因缺 __TAURI_INTERNALS__ 直接抛错——静态 import
  // 链会把 Web 模式整站带崩(白屏)。
  const win = useMemo(() => getCurrentWindow(), []);
  /** 运行平台("windows"/"macos"/"linux");同步查询,初始化器内求值防 mac 首帧闪按钮。 */
  const [os] = useState(() => osPlatform());
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    // 最大化状态:初始查一次 + 尺寸变化时跟随(还原/最大化/贴边分屏都会触发 Resized)
    win.isMaximized().then(setMaximized).catch(() => {});
    const un = win.onResized(async () => setMaximized(await win.isMaximized()));
    return () => {
      un.then((f) => f());
    };
  }, [win]);

  const isMac = os === "macos";

  return (
    <div
      className="titlebar"
      data-mac={isMac ? "true" : undefined}
      onMouseDown={(e) => {
        // 仅左键 + 事件落在标题栏自身(标题文字/安全区)才拖动;按钮等子元素各司其职
        if (e.button !== 0 || e.target !== e.currentTarget) return;
        // 双击最大化/还原;官方 window-customization 模式(detail=2 为第二连击)
        if (e.detail === 2) void win.toggleMaximize();
        else void win.startDragging();
      }}
      onContextMenu={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        // Windows 原生系统菜单(mac/Linux 无此习惯,后端本就 no-op,不浪费 IPC)
        if (os === "windows") void tauriInvoke("show_system_menu");
      }}
      onDoubleClick={(e) => e.preventDefault()}
    >
      {/* macOS 红绿灯安全区(Overlay 模式下原生按钮悬浮于此) */}
      <div className="titlebar__traffic" />
      <div className="titlebar__title">Serial Studio</div>
      {!isMac && (
        <div className="titlebar__controls">
          {/* mousedown 不抢焦点(同侧栏铅笔按钮):点了最小化/最大化后焦点保持在终端,
              否则还原窗口后键盘输入落不到 xterm,必须先点一下终端 */}
          <button
            className="titlebar__btn"
            title="最小化"
            aria-label="最小化"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void win.minimize()}
          >
            <IconWinMin className="titlebar__btn-icon" />
          </button>
          <button
            className="titlebar__btn"
            title={maximized ? "还原" : "最大化"}
            aria-label={maximized ? "还原" : "最大化"}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void win.toggleMaximize()}
          >
            {maximized ? (
              <IconWinRestore className="titlebar__btn-icon" />
            ) : (
              <IconWinMax className="titlebar__btn-icon" />
            )}
          </button>
          <button
            className="titlebar__btn titlebar__btn--close"
            title="关闭"
            aria-label="关闭"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void win.close()}
          >
            <IconClose className="titlebar__btn-icon" />
          </button>
        </div>
      )}
    </div>
  );
}
