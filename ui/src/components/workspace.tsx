import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  IconBolt, IconCode, IconGear, IconGlobe,
  IconMore, IconPlug, IconPlus, IconRefresh, IconShare, IconSsh,
} from "../icons";
import type { SettingsCategoryId } from "./settings-registry";
import { ContextMenu, type ContextMenuItem } from "./context-menu";
import { useDialogA11y, useEscClose } from "./primitives";

export type WorkspacePanel = "ports" | "macros" | "scripts";

export function WorkspaceSidebar({
  panel, onPanel, showScripts, counts, running, failed, query,
  onQuery, onNew, onRemote, onShare, width, collapsed, tools, moreItems, view, onRefresh, children,
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
  onShare: () => void;
  width: number;
  collapsed: boolean;
  tools: ReactNode;
  /** 面板标题栏 ··· 菜单项(App 按当前面板组好:连接=刷新/视图切换,宏/脚本=导入导出/指南)。 */
  moreItems?: ContextMenuItem[];
  view?: { label: string; items: ContextMenuItem[] };
  onRefresh?: () => void;
  children: ReactNode;
}) {
  const panelId = useId();
  const label = panel === "ports" ? "连接" : panel === "macros" ? "宏" : "脚本";
  const moreButton = useRef<HTMLButtonElement>(null);
  const viewButton = useRef<HTMLButtonElement>(null);
  const [viewMenu, setViewMenu] = useState<{ x: number; y: number } | null>(null);
  /** ··· 菜单锚点(按钮下方);null=关。 */
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => { setViewMenu(null); setMoreMenu(null); }, [panel, collapsed]);
  const entries = [
    { id: "ports" as const, label: "连接", icon: <IconPlug /> },
    { id: "macros" as const, label: "宏", icon: <IconBolt /> },
    ...(showScripts ? [{ id: "scripts" as const, label: "脚本", icon: <IconCode /> }] : []),
  ];
  return (
    <aside className={`sidebar${collapsed ? " sidebar--collapsed" : ""}`} style={{ width: collapsed ? 56 : width + 56 }} aria-label="工作空间导航">
      <div className="sidebar__rail">
        <nav className="workspace-nav" aria-label="功能导航">
          {entries.map((entry) => {
            const status = entry.id === "ports" ? "" : failed[entry.id] ? "，有未查看的失败结果" : running[entry.id] ? "，正在运行" : "";
            const expanded = !collapsed && panel === entry.id;
            return (
            <button
              key={entry.id}
              className={`workspace-nav__item${expanded ? " active" : ""}`}
              aria-current={expanded ? "page" : undefined}
              aria-expanded={expanded}
              aria-controls={panelId}
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
          <button className="workspace-footer-action" onClick={onShare} title="分享当前设备" aria-label="分享当前设备"><IconShare /></button>
          {onRemote && <button className="workspace-footer-action" onClick={onRemote} title="添加远程设备" aria-label="添加远程设备"><IconGlobe /></button>}
          {tools}
        </div>
      </div>
      <div id={panelId} className="sidebar__panel" hidden={collapsed}>
        <div className="workspace-sidebar-actions">
          <label className="workspace-search">
            <span aria-hidden="true">⌕</span>
            <input type="search" value={query} onChange={(event) => onQuery(event.target.value)}
              placeholder={`搜索${label}…`} aria-label={`搜索${label}`} autoCapitalize="off" spellCheck={false} />
          </label>
          <button className="workspace-create" onClick={onNew} aria-label={`新建${label}`} title={`新建${label}`}><IconPlus /></button>
        </div>
        <div className="panel-head">
          <span className="panel-head__title">{panel === "ports" ? "连接列表" : label}</span>
          {view && <button className="workspace-view-badge" ref={viewButton} aria-label={`列表视图：${view.label}`}
            aria-haspopup="menu" aria-expanded={viewMenu !== null} onClick={() => {
              const rect = viewButton.current?.getBoundingClientRect();
              if (rect) { setMoreMenu(null); setViewMenu(viewMenu ? null : { x: rect.left, y: rect.bottom + 6 }); }
            }}>{view.label}</button>}
          {onRefresh && <button className="icon-btn panel-head__refresh" onClick={onRefresh} title="刷新列表" aria-label="刷新列表"><IconRefresh /></button>}
          {moreItems && moreItems.length > 0 && (
            <button
              ref={moreButton}
              className="icon-btn panel-head__more"
              aria-label="更多操作" aria-haspopup="menu" aria-expanded={moreMenu !== null}
              onClick={() => {
                const rect = moreButton.current?.getBoundingClientRect();
                if (rect) { setViewMenu(null); setMoreMenu(moreMenu ? null : { x: Math.max(8, rect.right - 170), y: rect.bottom + 6 }); }
              }}
            >
              <IconMore />
            </button>
          )}
          {moreMenu && moreItems && (
            <ContextMenu
              x={moreMenu.x} y={moreMenu.y} items={moreItems}
              onClose={(reason) => {
                setMoreMenu(null);
                if (reason === "item" || reason === "escape") moreButton.current?.focus();
              }}
            />
          )}
          {viewMenu && view && <ContextMenu x={viewMenu.x} y={viewMenu.y} items={view.items}
            onClose={(reason) => { setViewMenu(null); if (reason === "item" || reason === "escape") viewButton.current?.focus(); }} />}
        </div>
        <div className="sidebar__content">{children}</div>
      </div>
    </aside>
  );
}

/** Open settings directly; categories remain inside the dialog. */
export function WorkspaceSettingsMenu({ onOpen }: { onOpen: (category: SettingsCategoryId) => void }) {
  return (
    <button className="workspace-footer-action" title="设置" aria-label="设置" aria-haspopup="dialog" onClick={() => onOpen("connection")}>
      <IconGear />
    </button>
  );
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
