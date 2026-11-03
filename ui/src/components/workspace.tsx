import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  IconBolt, IconCheck, IconCode, IconGear, IconGlobe, IconInfo,
  IconKeyboard, IconPlug, IconPlus, IconShirt, IconSsh,
} from "../icons";
import { getFontSize, setFontSize, subscribeFont } from "../term-font";
import { THEMES, type Theme } from "../theme";
import { useDialogA11y, useEscClose } from "./primitives";

export type WorkspacePanel = "ports" | "macros" | "scripts";

function SidebarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9 4v16" />
    </svg>
  );
}

export function WorkspaceSidebar({
  panel, onPanel, showScripts, counts, running, failed, query,
  onQuery, onNew, onRemote, connected, width, collapsed, onToggle, tools, children,
}: {
  panel: WorkspacePanel;
  onPanel: (panel: WorkspacePanel) => void;
  showScripts: boolean;
  counts: Record<WorkspacePanel, number>;
  running: { macros: boolean; scripts: boolean };
  failed: { macros: boolean; scripts: boolean };
  query: string;
  onQuery: (query: string) => void;
  onNew: () => void;
  onRemote?: () => void;
  connected: boolean;
  width: number;
  collapsed: boolean;
  onToggle: () => void;
  tools: ReactNode;
  children: ReactNode;
}) {
  const label = panel === "ports" ? "连接" : panel === "macros" ? "宏" : "脚本";
  const entries = [
    { id: "ports" as const, label: "连接", icon: <IconPlug /> },
    { id: "macros" as const, label: "宏", icon: <IconBolt /> },
    ...(showScripts ? [{ id: "scripts" as const, label: "脚本", icon: <IconCode /> }] : []),
  ];
  return (
    <aside className={`sidebar${collapsed ? " sidebar--collapsed" : ""}`} style={{ width: collapsed ? 64 : width + 64 }} aria-label="工作空间导航">
      <div className="sidebar__rail">
        <div className="sidebar__toggle-row">
          <button className="icon-btn" onClick={onToggle} title={collapsed ? "展开侧栏" : "收起侧栏"} aria-label="切换侧栏" aria-expanded={!collapsed}><SidebarIcon /></button>
        </div>
        <nav className="workspace-nav" aria-label="功能导航">
          {entries.map((entry) => {
            const status = entry.id === "ports" ? "" : failed[entry.id] ? "，有未查看的失败结果" : running[entry.id] ? "，正在运行" : "";
            return (
            <button
              key={entry.id}
              className={`workspace-nav__item${panel === entry.id ? " active" : ""}`}
              aria-current={panel === entry.id ? "page" : undefined}
              aria-label={`${entry.label}${status}`}
              title={`${entry.label} · ${counts[entry.id]}${status}`}
              onClick={() => onPanel(entry.id)}
            >
              {entry.icon}<span className="workspace-nav__label">{entry.label}</span>
              {entry.id !== "ports" && (running[entry.id] || failed[entry.id]) && (
                <span
                  className={`workspace-nav__badge${failed[entry.id] ? " failed" : ""}`}
                  aria-label={failed[entry.id] ? "有未查看的失败结果" : "正在运行"}
                >{failed[entry.id] ? "!" : "●"}</span>
              )}
              <span className="workspace-nav__count">{counts[entry.id]}</span>
            </button>
            );
          })}
        </nav>
        <div className="sidebar__rail-footer">
          {onRemote && <button className="workspace-footer-action" onClick={onRemote} title="添加远程设备" aria-label="添加远程设备"><IconGlobe /></button>}
          {tools}
        </div>
      </div>
      <div className="sidebar__panel" hidden={collapsed}>
        <button className="workspace-new" onClick={onNew}><IconPlus /><span>新建{label}</span></button>
        <label className="workspace-search">
          <span aria-hidden="true">⌕</span>
          <input
            type="search" value={query} onChange={(event) => onQuery(event.target.value)}
            placeholder={`搜索${label}…`} aria-label={`搜索${label}`} autoCapitalize="off" spellCheck={false}
          />
        </label>
        <div className="sidebar__content">{children}</div>
        <div className="sidebar__footer">
          <div className="workspace-footer-row">
              <span className="workspace-service" title={connected ? "已连接" : "未连接"} aria-label={connected ? "已连接" : "未连接"}><span className={`dot${connected ? " on" : ""}`} />{connected ? "已连接" : "未连接"}</span>
          </div>
        </div>
      </div>
    </aside>
  );
}

function FooterPopover({ anchor, onClose, label, children }: {
  anchor: RefObject<HTMLButtonElement>;
  onClose: () => void;
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const button = anchor.current;
    const menu = ref.current;
    if (!button || !menu) return;
    const rect = button.getBoundingClientRect();
    menu.style.maxHeight = `${Math.max(80, rect.top - 16)}px`;
    menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    menu.style.visibility = "visible";
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [anchor, label]);
  useEffect(() => {
    window.addEventListener("resize", onClose);
    return () => window.removeEventListener("resize", onClose);
  }, [onClose]);
  return createPortal(<>
    <div className="manage-backdrop" onClick={onClose} />
    <div ref={ref} className="manage-menu workspace-menu workspace-popover" role="menu" aria-label={label} style={{ visibility: "hidden" }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          anchor.current?.focus();
          return;
        }
        if (event.key === "Tab") { onClose(); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        if (!buttons.length) return;
        event.preventDefault();
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next].focus();
      }}
    >{children}</div>
  </>, document.body);
}

export function WorkspaceSettingsMenu({
  theme, themeMenu, onThemeMenu, onTheme, manageMenu, onManageMenu, onSettings, onShortcuts, onAbout,
}: {
  theme: Theme;
  themeMenu: boolean;
  onThemeMenu: (open: boolean) => void;
  onTheme: (theme: Theme) => void;
  manageMenu: boolean;
  onManageMenu: (open: boolean) => void;
  onSettings: () => void;
  onShortcuts: () => void;
  onAbout: () => void;
}) {
  const [fontSize, setCurrentFontSize] = useState(getFontSize);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const close = () => { onThemeMenu(false); onManageMenu(false); };
  const back = () => onThemeMenu(false);
  useEffect(() => subscribeFont(setCurrentFontSize), []);
  return <div className="workspace-settings">
    <button ref={settingsButton} className="workspace-footer-action" title="设置" aria-label="设置" aria-haspopup="menu" aria-expanded={manageMenu}
      onClick={() => { back(); onManageMenu(!manageMenu); }}><IconGear /></button>
    {manageMenu && <FooterPopover anchor={settingsButton} onClose={close} label={themeMenu ? "皮肤" : "设置菜单"}>
      {themeMenu ? <>
            <button className="manage-menu__item workspace-menu-back" role="menuitem" onClick={back}>‹ 返回</button>
            <div className="workspace-font-size">
              <span>界面与终端字号</span>
              <div>{[14, 15, 16].map((size) => (
                <button key={size} className="mini-btn" aria-pressed={fontSize === size} onClick={() => setFontSize(size)}>{size}</button>
              ))}</div>
            </div>
            {THEMES.map((definition) => (
              <button
                key={definition.id} className="manage-menu__item"
                role="menuitemradio" aria-checked={definition.id === theme}
                data-current={definition.id === theme || undefined}
                onClick={() => { onTheme(definition.id); close(); settingsButton.current?.focus(); }}
              >
                <span style={{ visibility: definition.id === theme ? "visible" : "hidden" }}><IconCheck /></span>
                {definition.label}
              </button>
            ))}
      </> : <>
        <button className="manage-menu__item" role="menuitem" onClick={() => { close(); onSettings(); }}><IconGear />设置</button>
        <button className="manage-menu__item" role="menuitem" aria-haspopup="menu" onClick={() => onThemeMenu(true)}><IconShirt />皮肤<span className="workspace-menu-chevron" aria-hidden="true">›</span></button>
        <button className="manage-menu__item" role="menuitem" onClick={() => { close(); onShortcuts(); }}><IconKeyboard />快捷键</button>
        <button className="manage-menu__item" role="menuitem" onClick={() => { close(); onAbout(); }}><IconInfo />关于</button>
      </>}
    </FooterPopover>}
  </div>;
}

export function ConnectionLauncher({ onSerial, onSsh, onClose }: { onSerial: () => void; onSsh: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEscClose(onClose);
  useDialogA11y(ref);
  return <div className="dialog-overlay" onClick={onClose}>
    <div className="dialog dialog--narrow" ref={ref} role="dialog" aria-modal="true" aria-label="新建连接" onClick={(event) => event.stopPropagation()}>
      <h3 className="dialog__title">新建连接</h3><p className="dialog__hint">选择连接类型</p>
      <div className="workspace-connection-options">
        <button onClick={onSerial}><IconPlug /><span><strong>串口</strong><small>选择本地或远程设备的可用端口</small></span></button>
        <button onClick={onSsh}><IconSsh /><span><strong>SSH</strong><small>添加、管理 SSH 主机或打开终端</small></span></button>
      </div>
      <div className="btn-row"><button className="btn btn--ghost" onClick={onClose}>取消</button></div>
    </div>
  </div>;
}
