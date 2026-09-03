/**
 * 次侧栏三个活动面板：端口列表 / 宏库 / 脚本库。
 * 纯展示 + 回调上行——数据与操作全部由 App 注入，面板自身无状态（折叠态也由 App 持有持久化）。
 */
import type { RefObject } from "react";
import type { PortId, PortInfo, RemoteDevice } from "../types";
import { bucketPidOf, displayPortName, getMode, groupBy } from "../lib";
import {
  IconEdit,
  IconExport,
  IconImport,
  IconPlus,
  IconPower,
  IconRefresh,
  IconTrash,
} from "../icons";
import { GroupHead, InlineAliasInput, PortLabel } from "./primitives";

/** 端口分组卡（App 派生：本地卡 + 远程设备卡）。 */
export interface PortGroupView {
  devId: string;
  label: string;
  online?: boolean;
  ports: PortInfo[];
}

/** 端口面板：设备分组卡 + 端口行（点开/附加/重连、别名 inline 编辑、强制关闭）。 */
export function PortsPanel({
  portGroups,
  remotes,
  portCollapsed,
  onTogglePortGroup,
  activePort,
  aliasEditPort,
  onSetAliasEdit,
  onTriggerPort,
  onCommitAlias,
  onCancelAlias,
  onForceClose,
  onReconnectRemote,
  onDisconnectRemote,
  onRemoveRemote,
  onRenameRemote,
  onShowRemoteDetail,
  onRefresh,
}: {
  portGroups: PortGroupView[];
  remotes: RemoteDevice[];
  portCollapsed: Set<string>;
  onTogglePortGroup: (devId: string) => void;
  activePort: PortId;
  /** 正在编辑别名的端口复合键（list 处触发），null = 未编辑。 */
  aliasEditPort: PortId | null;
  onSetAliasEdit: (pid: PortId) => void;
  onTriggerPort: (pid: PortId) => void;
  onCommitAlias: (pid: PortId, alias: string) => void;
  onCancelAlias: () => void;
  onForceClose: (pid: PortId) => void;
  onReconnectRemote: (dev: RemoteDevice) => void;
  onDisconnectRemote: (dev: RemoteDevice) => void;
  onRemoveRemote: (dev: RemoteDevice) => void;
  /** 设备卡改名(空串=清除昵称,标题回退 host:port)。仅本地桌面形态传入。 */
  onRenameRemote: (dev: RemoteDevice, nickname: string) => void;
  /** 右键菜单「设备详情」:打开该设备的只读详情弹窗。 */
  onShowRemoteDetail: (dev: RemoteDevice) => void;
  onRefresh: () => void;
}) {
  return (
    <>
      <div className="section-head">
        <h4 className="section-head__title">PORTS</h4>
        <button className="icon-btn" onClick={onRefresh} title="刷新" aria-label="刷新端口列表">
          <IconRefresh />
        </button>
      </div>
      {portGroups.map((grp) => {
        const dev = grp.devId === "local" ? null : remotes.find((r) => r.id === grp.devId);
        // 设备卡重命名仅本地桌面形态(remotes.json 持久化;web/远程窗口 connConfig 派生不落盘)
        const canRename = dev !== null && getMode() === "local";
        return (
          <div key={grp.devId} className="macro-group port-group">
            <GroupHead
              name={grp.label}
              count={grp.ports.length}
              collapsed={portCollapsed.has(grp.devId)}
              onToggle={() => onTogglePortGroup(grp.devId)}
              // 设了昵称后组标签只剩昵称,地址无处可看——悬停兜底显示 host:port
              title={dev ? `${dev.host}:${dev.port}` : undefined}
              // 三态:在线=绿 / 离线=红 / 连接中(unknown)=无修饰类,落 .dot 默认灰
              leading={<span className={`dot ${grp.online === true ? "on" : grp.online === false ? "off" : ""}`} />}
              onRename={canRename ? (n) => { if (dev) onRenameRemote(dev, n); } : undefined}
              renameLabel="重命名设备"
              renameInitial={dev?.nickname ?? ""}
              renamePlaceholder="设备昵称(留空显示地址)"
              menuHidden={!dev}
              extraMenuItems={
                dev
                  ? [
                      // 附加项首位(整菜单序:重命名设备→详情→断开/重连→删除)
                      { label: "设备详情", onSelect: () => { if (dev) onShowRemoteDetail(dev); } },
                      // 在线可断开;离线/连接中可重连(状态相关项)
                      grp.online === true
                        ? { label: "断开设备", onSelect: () => { if (dev) onDisconnectRemote(dev); } }
                        : { label: "重连设备", onSelect: () => { if (dev) onReconnectRemote(dev); } },
                      { label: "删除设备", danger: true, onSelect: () => { if (dev) onRemoveRemote(dev); } },
                    ]
                  : undefined
              }
            />
            {!portCollapsed.has(grp.devId) &&
              (grp.ports.length === 0 ? (
                <p className="sidebar__empty">
                  {grp.online === false
                    ? "未连接"
                    : grp.online === undefined && grp.devId !== "local"
                      ? "连接中…"
                      : "无可用端口"}
                </p>
              ) : (
                grp.ports.map((p) => {
                  // 条目键首段已是桶 devId(本地合并视图的完整 pid)则直通;
                  // 远程 transport 的远端侧键则加桶前缀。幂等。
                  const pid = bucketPidOf(grp.devId, p.name);
                  const shown = displayPortName(p.name); // 展示剥设备前缀,只留串口名
                  const isActive = pid === activePort;
                  const editingThis = aliasEditPort === pid;
                  // 强制关闭仅桌面形态:踢本机服务器的其它本地会话(远程设备上别的主机
                  // 的会话归远端管理)。web/远窗连的是远端 ss,无此本地特权——隐藏按钮。
                  const canForce = getMode() === "local" && p.opened;
                  return (
                    <div key={p.name} className="port-item-row" data-active={isActive} data-opened={p.opened ? "true" : undefined} data-force={canForce ? "true" : undefined} data-editing={editingThis ? "true" : undefined}>
                      <div
                        className="port-item"
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          if (!editingThis) onTriggerPort(pid);
                        }}
                        onKeyDown={(e) => {
                          if (editingThis) return;
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onTriggerPort(pid);
                          }
                        }}
                      >
                        <span className={`port-item__dot${p.opened ? " open" : ""}`} />
                        <span className="port-item__name">
                          {editingThis ? (
                            <InlineAliasInput
                              initial={p.alias ?? ""}
                              placeholder={`为 ${shown} 设置别名`}
                              onCommit={(alias) => onCommitAlias(pid, alias)}
                              onCancel={onCancelAlias}
                            />
                          ) : (
                            <PortLabel name={shown} alias={p.alias} />
                          )}
                        </span>
                        {p.opened && p.holders > 0 && <span className="port-item__holders">{p.holders}</span>}
                      </div>
                      <button
                        className="port-item__edit"
                        title={`设置 ${shown} 别名`}
                        aria-label={`设置 ${shown} 别名`}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => onSetAliasEdit(pid)}
                      >
                        <IconEdit />
                      </button>
                      {canForce && (
                        <button
                          className="port-item__force"
                          title={`强制关闭 ${shown}（断开远程）`}
                          aria-label={`强制关闭 ${shown}`}
                          onClick={() => onForceClose(pid)}
                        >
                          <IconPower />
                        </button>
                      )}
                    </div>
                  );
                })
              ))}
          </div>
        );
      })}
    </>
  );
}

/** 宏/脚本面板共用的库面板骨架：段头（导入/导出/新增/可选扩展按钮）+ 分组列表 + 运行卡片。 */
export function NamedLibraryPanel<T extends { group?: string }>({
  title,
  items,
  hasItems,
  collapsed,
  onToggleGroup,
  onRenameGroup,
  onDissolveGroup,
  importRef,
  onImportFile,
  onExport,
  exportTitle,
  onNew,
  newItemLabel,
  emptyHint,
  renderRow,
  children,
  extraActions,
  storageHint,
}: {
  /** 段标题（MACROS / SCRIPTS，含 → activePort 后缀由调用方拼好）。 */
  title: React.ReactNode;
  items: Record<string, T>;
  hasItems: boolean;
  collapsed: Set<string>;
  onToggleGroup: (g: string) => void;
  onRenameGroup: (oldName: string, newName: string) => void;
  onDissolveGroup: (name: string) => void;
  importRef: RefObject<HTMLInputElement>;
  onImportFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onExport: () => void;
  exportTitle: string;
  onNew: () => void;
  newItemLabel: string;
  emptyHint: string;
  /** 分组内单行（运行/编辑/删除按钮组）。 */
  renderRow: (name: string) => React.ReactNode;
  /** 运行卡片等尾随内容。 */
  children?: React.ReactNode;
  /** 段头额外按钮（脚本面板的「指南」等），排在末尾（新增按钮之后）。 */
  extraActions?: React.ReactNode;
  /** 存储位置说明（Web 模式:localStorage,与桌面端落盘不同——防止误以为存服务器）。 */
  storageHint?: string;
}) {
  return (
    <>
      <div className="section-head">
        <h4 className="section-head__title">{title}</h4>
        <div className="section-head__actions">
          <button className="icon-btn" onClick={() => importRef.current?.click()} title={`导入${newItemLabel}`}>
            <IconImport />
          </button>
          <button
            className="icon-btn"
            onClick={onExport}
            disabled={!hasItems}
            title={exportTitle}
          >
            <IconExport />
          </button>
          <button className="icon-btn" onClick={onNew} title={`新增${newItemLabel}`}>
            <IconPlus />
          </button>
          {extraActions}
        </div>
        <input
          ref={importRef}
          type="file"
          accept=".json,application/json"
          style={{ display: "none" }}
          onChange={onImportFile}
        />
      </div>
      {storageHint && <p className="sidebar__storage-hint">{storageHint}</p>}
      {!hasItems && <p className="sidebar__empty">{emptyHint}</p>}
      {groupBy(Object.entries(items), (m) => m.group).map((g) => (
        <div key={g.name} className="macro-group">
          <GroupHead
            name={g.name}
            count={g.items.length}
            collapsed={collapsed.has(g.name)}
            onToggle={() => onToggleGroup(g.name)}
            onRename={(n) => onRenameGroup(g.name, n)}
            onDissolve={() => onDissolveGroup(g.name)}
            menuHidden={g.name === "未分组"}
          />
          {!collapsed.has(g.name) && g.items.map(([name]) => renderRow(name))}
        </div>
      ))}
      {children}
    </>
  );
}

/** 宏面板行：运行 + 编辑 + 删除。 */
export function MacroRow({ name, disabled, onRun, onEdit, onDelete }: {
  name: string;
  disabled: boolean;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="macro-row">
      <button className="macro-run" onClick={onRun} disabled={disabled} title={disabled ? "先打开一个端口再运行宏" : undefined}>
        <span className="macro-run__label">{name}</span>
      </button>
      <button className="macro-action macro-action--edit" onClick={onEdit} title="编辑" aria-label={`编辑宏 ${name}`}>
        <IconEdit />
      </button>
      <button className="macro-action macro-action--danger" onClick={onDelete} title="删除" aria-label={`删除宏 ${name}`}>
        <IconTrash />
      </button>
    </div>
  );
}

/** 脚本面板行：与宏行同构（无 disabled 态——脚本无主端口也能跑）。 */
export function ScriptRow({ name, onRun, onEdit, onDelete }: {
  name: string;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="macro-row">
      <button className="macro-run" onClick={onRun}>
        <span className="macro-run__label">{name}</span>
      </button>
      <button className="macro-action macro-action--edit" onClick={onEdit} title="编辑" aria-label={`编辑脚本 ${name}`}>
        <IconEdit />
      </button>
      <button className="macro-action macro-action--danger" onClick={onDelete} title="删除" aria-label={`删除脚本 ${name}`}>
        <IconTrash />
      </button>
    </div>
  );
}
