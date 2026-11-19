/**
 * 自绘标题栏（VS Code 式，自 main 移植；Web 与桌面同渲染——界面一致）。
 * - 桌面专属：拖动（左键 startDragging；双击 toggleMaximize）、右键系统菜单、
 *   右上三窗口钮（Win/Linux 自绘；macOS 保留原生红绿灯，仅渲染安全区）
 * - 两形态共有：左侧菜单（拓扑/设备/占用 导航 + 远程/设置 入口——侧栏被
 *   布局预设隐藏时仍是完整导航面）与自定义布局菜单
 * - Web 无窗口概念：不取窗口引用（getCurrentWindow 在纯浏览器会抛错）、
 *   无拖动/窗口钮，其余一致
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri, tauriInvoke } from "../lib";
import type { LayoutMode } from "../layout";
import { useShell } from "../App";
import { LayoutMenuButton } from "./layout-menu";
import { IconClose, IconWinMax, IconWinMin, IconWinRestore } from "../icons";

/** mac 判定：desktop 壳内 navigator.platform 足够（无需 plugin-os 精确平台）。 */
function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
}

export function TitleBar(props: {
  layoutMode: LayoutMode;
  onLayoutChange: (m: LayoutMode) => void;
}) {
  return <TitleBarInner {...props} />;
}

/** 标题栏导航（路由项激活态按当前路径）。 */
const NAV_ITEMS = [
  { to: "/", label: "拓扑", exact: true },
  { to: "/devices", label: "设备" },
  { to: "/leases", label: "占用" },
];

function TitleBarInner({
  layoutMode,
  onLayoutChange,
}: {
  layoutMode: LayoutMode;
  onLayoutChange: (m: LayoutMode) => void;
}) {
  const desktop = isTauri();
  // 组件内取窗口引用（非模块顶层！）：getCurrentWindow() 在纯浏览器会因缺
  // __TAURI_INTERNALS__ 直接抛错——Web 形态不取、不触发拖动/窗口钮。
  const win = useMemo(
    () => (desktop ? getCurrentWindow() : undefined),
    [desktop],
  );
  const [mac] = useState(isMacPlatform);
  const [maximized, setMaximized] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { openDialog } = useShell();

  useEffect(() => {
    if (!win) return;
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
      data-mac={desktop && mac ? "true" : undefined}
      onMouseDown={
        win
          ? (e) => {
              // 仅左键 + 事件落在标题栏自身（按钮等子元素各司其职）
              if (e.button !== 0 || e.target !== e.currentTarget) return;
              e.preventDefault();
              // 双击最大化/还原；官方 window-customization 模式（detail=2 为第二连击）
              if (e.detail === 2) void win.toggleMaximize();
              else void win.startDragging();
            }
          : undefined
      }
      onContextMenu={
        win
          ? (e) => {
              if (e.target !== e.currentTarget) return;
              e.preventDefault();
              // Windows 原生系统菜单（mac/Linux 无此习惯，后端本就 no-op，不浪费 IPC）
              if (!mac) void tauriInvoke("show_system_menu");
            }
          : undefined
      }
      onDoubleClick={(e) => e.preventDefault()}
    >
      {/* macOS 红绿灯安全区（Overlay 模式下原生按钮悬浮于此；仅桌面 mac） */}
      {desktop && mac && <div className="titlebar__traffic" />}
      {/* 左侧菜单：导航三项 + 动作两项（远程/设置）。侧栏被布局预设隐藏
          （rows/columns）时这里是完整导航面 */}
      <nav className="titlebar__menu" aria-label="主导航">
        {NAV_ITEMS.map((n) => {
          const active = n.exact
            ? location.pathname === n.to
            : location.pathname.startsWith(n.to);
          return (
            <button
              key={n.to}
              className={`titlebar__menu-item${active ? " titlebar__menu-item--on" : ""}`}
              aria-current={active ? "page" : undefined}
              onClick={() => navigate(n.to)}
            >
              {n.label}
            </button>
          );
        })}
        <span className="titlebar__menu-sep" aria-hidden="true" />
        <button className="titlebar__menu-item" onClick={() => openDialog("remote")}>
          远程
        </button>
        <button className="titlebar__menu-item" onClick={() => openDialog("settings")}>
          设置
        </button>
      </nav>
      {/* 占位撑开，把控制钮推到右缘（桌面拖动区=标题栏本体） */}
      <div className="titlebar__title" />
      <div className="titlebar__controls">
        {/* 自定义布局：四预设菜单（两形态同款入口） */}
        <LayoutMenuButton layoutMode={layoutMode} onLayoutChange={onLayoutChange} />
        {/* 窗口钮仅桌面 Win/Linux；mac 用原生红绿灯 */}
        {desktop && !mac && (
          <>
            {/* mousedown 不抢焦点：点了最小化/最大化后焦点保持原地 */}
            <button
              className="titlebar__btn"
              title="最小化"
              aria-label="最小化"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void win?.minimize()}
            >
              <IconWinMin className="titlebar__btn-icon" />
            </button>
            <button
              className="titlebar__btn"
              title={maximized ? "还原" : "最大化"}
              aria-label={maximized ? "还原" : "最大化"}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void win?.toggleMaximize()}
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
              onClick={() => void win?.close()}
            >
              <IconClose className="titlebar__btn-icon" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
