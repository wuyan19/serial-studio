import { useId, useRef, type ReactNode } from "react";
import {
  IconBolt, IconCode, IconGear, IconGlobe,
  IconPlug, IconPlus, IconShare, IconSsh,
} from "../icons";
import type { SettingsCategoryId } from "./settings-registry";
import { useDialogA11y, useEscClose } from "./primitives";

export type WorkspacePanel = "ports" | "macros" | "scripts";

export function WorkspaceSidebar({
  panel, onPanel, showScripts, counts, running, failed, query,
  onQuery, onNew, onRemote, onShare, width, collapsed, tools, children,
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
  children: ReactNode;
}) {
  const panelId = useId();
  const label = panel === "ports" ? "连接" : panel === "macros" ? "宏" : "脚本";
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
        <button className="workspace-new" onClick={onNew}><IconPlus /><span>新建{label}</span></button>
        <label className="workspace-search">
          <span aria-hidden="true">⌕</span>
          <input
            type="search" value={query} onChange={(event) => onQuery(event.target.value)}
            placeholder={`搜索${label}…`} aria-label={`搜索${label}`} autoCapitalize="off" spellCheck={false}
          />
        </label>
        <div className="sidebar__content">{children}</div>
      </div>
    </aside>
  );
}

/** 齿轮按钮：直接打开设置页（外观分类）。原「设置/快捷键/关于」二级菜单已撤——
 *  快捷键与关于在设置页内自有分类，入口合一后无需菜单中转。 */
export function WorkspaceSettingsMenu({ onOpen }: { onOpen: (category: SettingsCategoryId) => void }) {
  return (
    <button className="workspace-footer-action" title="设置" aria-label="设置" onClick={() => onOpen("appearance")}>
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
