/**
 * 自绘标题栏（VS Code 式，自 main 移植；仅 Tauri 桌面渲染，Web 不挂载）。
 * - 拖动：左键按下 startDragging；双击 toggleMaximize（仅事件落在标题栏自身）
 * - 右键：Windows 弹原生系统菜单（show_system_menu command）
 * - 窗口按钮：Win/Linux 自绘 最小化/最大化(还原)/关闭；macOS 壳保留原生红绿灯
 *   （此处仅渲染左侧安全区），平台用 navigator 判定（不引 plugin-os，零额外 IPC）
 */
import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri, tauriInvoke } from "../lib";
import { IconClose, IconWinMax, IconWinMin, IconWinRestore } from "../icons";

/** mac 判定：desktop 壳内 navigator.platform 足够（无需 plugin-os 精确平台）。 */
function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
}

export function TitleBar() {
  if (!isTauri()) return null;
  return <TitleBarInner />;
}

function TitleBarInner() {
  // 组件内取窗口引用（非模块顶层！）：getCurrentWindow() 在纯浏览器会因缺
  // __TAURI_INTERNALS__ 直接抛错——静态 import 链会把 Web 模式整站带崩。
  const win = useMemo(() => getCurrentWindow(), []);
  const [mac] = useState(isMacPlatform);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    // 最大化状态：初始查一次 + 尺寸变化时跟随（还原/最大化/贴边分屏都触发 Resized）
    win.isMaximized().then(setMaximized).catch(() => {});
    const un = win.onResized(async () => setMaximized(await win.isMaximized()));
    return () => {
      un.then((f) => f());
    };
  }, [win]);

  return (
    <div
      className="titlebar"
      data-mac={mac ? "true" : undefined}
      onMouseDown={(e) => {
        // 仅左键 + 事件落在标题栏自身（按钮等子元素各司其职）
        if (e.button !== 0 || e.target !== e.currentTarget) return;
        e.preventDefault();
        // 双击最大化/还原；官方 window-customization 模式（detail=2 为第二连击）
        if (e.detail === 2) void win.toggleMaximize();
        else void win.startDragging();
      }}
      onContextMenu={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        // Windows 原生系统菜单（mac/Linux 无此习惯，后端本就 no-op，不浪费 IPC）
        if (!mac) void tauriInvoke("show_system_menu");
      }}
      onDoubleClick={(e) => e.preventDefault()}
    >
      {/* macOS 红绿灯安全区（Overlay 模式下原生按钮悬浮于此） */}
      <div className="titlebar__traffic" />
      {/* 占位撑开，把窗口控制钮推到右缘（拖动区=标题栏本体） */}
      <div className="titlebar__title" />
      {!mac && (
        <div className="titlebar__controls">
          {/* mousedown 不抢焦点：点了最小化/最大化后焦点保持原地 */}
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
