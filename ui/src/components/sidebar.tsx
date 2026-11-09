/** Sidebar panels keep display preferences separate from application operations. */
import { useEffect, useRef, useState, type RefObject } from "react";
import type { DeviceView, PortId, PortInfo, PortRow, RemoteDevice } from "../types";
import { displayPortName, getMode, groupBy } from "../lib";
import { connectionRows, selectSshPort, type ConnectionListRow } from "../connection-list";
import { useListOrder } from "../use-list-order";
import {
  getGroupMemberships, type PortGrouping, type PortGroupsOperation,
} from "../port-groups";
import {
  IconClose,
  IconEdit,
  IconExport,
  IconImport,
  IconPower,
  IconTrash,
} from "../icons";
import { ContextMenu, type ContextMenuItem } from "./context-menu";
import { GroupHead, InlineAliasInput, PortLabel } from "./primitives";

/** 列表视图状态上提到 App(面板 ··· 菜单切换),持久化键与加载器由此导出。 */
export const PORT_LIST_VIEW_KEY = "serial-studio-port-list-view";
export type PortListView = "default" | "groups";

export function loadPortListView(): PortListView {
  try { return localStorage.getItem(PORT_LIST_VIEW_KEY) === "groups" ? "groups" : "default"; }
  catch { return "default"; }
}

/** 端口分组卡（App 派生：本地卡 + 远程设备卡 + SSH 设备卡 + 补充卡）。 */
export interface PortGroupView {
  devId: string;
  label: string;
  online?: boolean;
  /** 桶内行带 ingest 定型的 pid（与事件回流键同源）。 */
  ports: PortRow[];
  /** SSH devices are presented as one row while retaining their endpoint identities. */
  kind?: "ssh";
  /** 组头悬停提示（SSH 卡兜底显示 user@host:port——设了昵称后地址无处可看）。 */
  detail?: string;
  /** 级联补充卡：属主注册在远程 server 上（本机 remotes/sshHosts 查无），
   *  动作类菜单（新建终端/编辑/删除/断开）对它无处派发——只给「设备详情」。 */
  external?: boolean;
  /** 补充卡的设备元数据（行上 device，详情弹窗数据源）。 */
  meta?: DeviceView;
}

/** 设备详情入口目标（通用详情弹窗的卡类）。meta = 级联补充卡（无本地注册表
 *  条目，详情直接用行上 device 元数据）。 */
export type DeviceDetailTarget =
  | { kind: "local" }
  | { kind: "remote"; dev: RemoteDevice }
  | { kind: "ssh"; devId: string }
  | { kind: "meta"; device: DeviceView };

/** 端口面板：设备分组卡 + 端口行（点开/附加/重连、别名 inline 编辑、强制关闭）。 */
export function PortsPanel({
  portGroups,
  remotes,
  portCollapsed,
  onTogglePortGroup,
  activePort,
  openPorts,
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
  onShowDeviceDetail,
  onSshAction,
  onNewSshTerminal,
  onClosePort,
  onCopyPortKey,
  onShowPortDetail,
  onRefresh,
  listView,
  query = "",
  visible = true,
  grouping,
  groupsReady,
  groupsError,
  onUpdateGroups,
  onToggleCustomGroup,
  orderScope = "local",
}: {
  orderScope?: string;
  grouping: PortGrouping;
  groupsReady: boolean;
  groupsError: string;
  onUpdateGroups: (operation: PortGroupsOperation) => Promise<void>;
  onToggleCustomGroup: (name: string) => void;
  query?: string;
  visible?: boolean;
  portGroups: PortGroupView[];
  remotes: RemoteDevice[];
  portCollapsed: Set<string>;
  onTogglePortGroup: (devId: string) => void;
  activePort: PortId;
  openPorts: PortId[];
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
  /** 右键菜单「设备详情」:打开该设备的只读详情弹窗(远程/SSH/本机三类卡)。 */
  onShowDeviceDetail: (target: DeviceDetailTarget) => void;
  /** SSH 设备卡菜单动作（connect=新建终端 / edit=打开管理弹窗编辑 / delete=删除）。 */
  onSshAction: (devId: string, action: "connect" | "edit" | "delete") => void;
  onNewSshTerminal: (pid: PortId) => void;
  /** SSH 实例行 ✕:关闭该终端(本地 release;多人共享时他人不受影响)。 */
  onClosePort: (pid: PortId) => void;
  /** 右键「复制端口键」:复制服务端侧键(row.name——脚本/MCP 的寻址值,web 形态
   *  不带连接桶前缀)。App 侧负责写剪贴板 + toast 反馈。 */
  onCopyPortKey: (row: PortRow) => void;
  /** 右键「端口详情」:打开该端点的只读详情弹窗(端口键/属主设备/状态等)。 */
  onShowPortDetail: (pid: PortId) => void;
  onRefresh: () => void;
  /** 列表视图(default/groups)已上提到 App(··· 菜单切换),此处只消费。 */
  listView: PortListView;
}) {
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupError, setGroupError] = useState("");
  const [groupSaving, setGroupSaving] = useState(false);
  const order = useListOrder(orderScope);
  const devices = order.sort("devices", portGroups, group => group.devId);
  const customNames = order.sort("groups", grouping.names, name => name);
  const memberScope = (name: string) => JSON.stringify(["group", name]);
  const deviceScope = (id: string) => JSON.stringify(["device", id]);
  const rowKey = (row: ConnectionListRow) => JSON.stringify(row.kind === "ssh" ? ["ssh", row.group.devId] : ["serial", row.port.pid]);
  const search = query.trim().toLocaleLowerCase();
  const buckets = (listView === "default" ? [null] : customNames).map((name) => {
    const matches = connectionRows(devices, grouping, name, query);
    if (name === null) return { name, rows: matches };
    const visibleIds = new Set(matches.map(rowKey));
    return { name, rows: order.sort(memberScope(name), connectionRows(devices, grouping, name, ""), rowKey)
      .filter(row => visibleIds.has(rowKey(row))) };
  });
  const updateGroups = async (operation: PortGroupsOperation): Promise<boolean> => {
    setGroupError("");
    try { await onUpdateGroups(operation); return true; }
    catch (error) { setGroupError(String(error instanceof Error ? error.message : error)); return false; }
  };
  const createGroup = async () => {
    if (groupSaving) return;
    const name = groupName.trim();
    if (!name) { setGroupError("请输入分组名称"); return; }
    if (grouping.names.includes(name)) { setGroupError("分组名称已存在"); return; }
    setGroupSaving(true);
    if (await updateGroups({ type: "create", name })) {
      setCreatingGroup(false);
      setGroupName("");
    }
    setGroupSaving(false);
  };
  type SshRow = Extract<ConnectionListRow, { kind: "ssh" }>;
  const [keyMenu, setKeyMenu] = useState<({ x: number; y: number } & (
    { kind: "serial"; port: PortRow } | { kind: "ssh"; row: SshRow }
  )) | null>(null);
  useEffect(() => {
    if (!visible) {
      setKeyMenu(null);
    }
  }, [visible]);

  const portMembershipItems = (port: PortRow): ContextMenuItem[] => [
    ...grouping.names.map((name) => ({
      label: `添加到分组：${name}`,
      disabled: !groupsReady || getGroupMemberships(grouping.assignments, port.pid).includes(name),
      onSelect: () => { void updateGroups({ type: "membership", kind: "port", id: port.name, name, included: true }); },
    })),
    ...getGroupMemberships(grouping.assignments, port.pid).map((name) => ({
      label: `从分组移出：${name}`,
      disabled: !groupsReady,
      onSelect: () => { void updateGroups({ type: "membership", kind: "port", id: port.name, name, included: false }); },
    })),
  ];
  const sshMembershipItems = (group: PortGroupView): ContextMenuItem[] => grouping.names.map((name) => {
    const included = getGroupMemberships(grouping.sshAssignments, group.devId).includes(name) ||
      group.ports.some((port) => getGroupMemberships(grouping.assignments, port.pid).includes(name));
    return {
      label: `${included ? "从分组移出" : "添加到分组"}：${name}`,
      disabled: !groupsReady,
      onSelect: () => {
        void (async () => {
          if (!await updateGroups({ type: "membership", kind: "ssh", id: group.devId, name, included: !included })) return;
          if (included) {
            for (const port of group.ports) {
              if (getGroupMemberships(grouping.assignments, port.pid).includes(name) &&
                !await updateGroups({ type: "membership", kind: "port", id: port.name, name, included: false })) break;
            }
          }
        })();
      },
    };
  });
  const portMenuItems = (port: PortRow): ContextMenuItem[] => [
    { label: "端口详情", onSelect: () => onShowPortDetail(port.pid) },
    { label: "复制端口键", onSelect: () => onCopyPortKey(port) },
  ];
  const sshMenuItems = ({ group, ports }: SshRow): ContextMenuItem[] => {
    const selected = selectSshPort(ports, activePort);
    const ownSessions = ports.filter((port) => openPorts.includes(port.pid));
    const labelOf = (port: PortRow) => port.alias?.trim() || displayPortName(port.name);
    return [
      {
        label: "新建终端",
        disabled: !selected && group.external,
        onSelect: () => selected ? onNewSshTerminal(selected.pid) : onSshAction(group.devId, "connect"),
      },
      ...ownSessions.map((port) => ({ label: `切换终端：${labelOf(port)}`, onSelect: () => onTriggerPort(port.pid) })),
      ...ownSessions.map((port) => ({ label: `关闭终端：${labelOf(port)}`, onSelect: () => onClosePort(port.pid) })),
      { sep: true },
      { label: "设备详情", onSelect: () => onShowDeviceDetail(group.external && group.meta ? { kind: "meta", device: group.meta } : { kind: "ssh", devId: group.devId }) },
      ...(!group.external ? [
        { label: "编辑设备", onSelect: () => onSshAction(group.devId, "edit") },
        { label: "删除设备", onSelect: () => onSshAction(group.devId, "delete") },
      ] : []),
      ...(selected ? portMenuItems(selected) : []),
      ...(grouping.names.length ? [{ sep: true }, ...sshMembershipItems(group)] : []),
    ];
  };
  const keyMenuItems: ContextMenuItem[] = !keyMenu ? [] : keyMenu.kind === "ssh" ? sshMenuItems(keyMenu.row) : [
    ...portMenuItems(keyMenu.port),
    ...(grouping.names.length ? [{ sep: true }, ...portMembershipItems(keyMenu.port)] : []),
  ];

  const renderSerial = (group: PortGroupView, port: PortRow, showSource: boolean, scope: string, ids: string[]) => {
    const pid = port.pid;
    const shown = displayPortName(port.name);
    const editing = aliasEditPort === pid;
    const canForce = getMode() === "local" && port.opened;
    return <div
      {...order.bind(scope, rowKey({ kind: "serial", group, port }), ids)}
      draggable={!editing}
      key={`serial:${pid}`} className="port-item-row port-item-row--single"
      data-active={pid === activePort} data-opened={port.opened || undefined}
      data-force={canForce || undefined} data-editing={editing || undefined}
      title={`${port.alias?.trim() ? `${port.alias} · ` : ""}${port.name} · ${group.detail ?? group.label}`}
      onContextMenu={(event) => {
        if (editing) return;
        event.preventDefault();
        setKeyMenu({ x: event.clientX, y: event.clientY, kind: "serial", port });
      }}
    >
      <div className="port-item" role="button" tabIndex={0}
        onClick={() => { if (!editing) onTriggerPort(pid); }}
        onKeyDown={(event) => {
          if (!editing && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            onTriggerPort(pid);
          }
        }}
      >
        <span className={`port-item__dot${port.opened ? " open" : ""}`} />
        <span className="port-item__name">
          {editing ? <InlineAliasInput initial={port.alias ?? ""} placeholder={`为 ${shown} 设置别名`} onCommit={(alias) => onCommitAlias(pid, alias)} onCancel={onCancelAlias} /> : <>
            <PortLabel name={shown} alias={port.alias} />
            {showSource && <span className="port-item__source"> · {group.label}</span>}
          </>}
        </span>
        {port.opened && port.holders > 0 && <span className="port-item__holders">{port.holders}</span>}
      </div>
      <button className="port-item__edit" title={`设置 ${shown} 别名`} aria-label={`设置 ${shown} 别名`} onMouseDown={(event) => event.preventDefault()} onClick={() => onSetAliasEdit(pid)}><IconEdit /></button>
      {canForce && <button className="port-item__force" title={`强制关闭 ${shown}（断开远程）`} aria-label={`强制关闭 ${shown}`} onClick={() => onForceClose(pid)}><IconPower /></button>}
    </div>;
  };
  const renderSsh = (row: SshRow, scope: string, ids: string[], deviceLevel = false) => {
    const { group, ports } = row;
    const selected = selectSshPort(ports, activePort);
    const opened = ports.filter((port) => port.opened);
    const activate = () => {
      if (selected) onTriggerPort(selected.pid);
      else if (!group.external) onSshAction(group.devId, "connect");
    };
    return <div
      {...order.bind(scope, deviceLevel ? group.devId : rowKey(row), ids)}
      key={`ssh:${group.devId}`} className={`port-item-row port-item-row--single port-item-row--ssh${deviceLevel ? " port-item-row--device" : ""}`}
      data-active={ports.some((port) => port.pid === activePort)} data-opened={opened.length > 0 || undefined}
      title={`${group.label} · ${group.detail ?? group.meta?.detail ?? "SSH"}`}
      onContextMenu={(event) => {
        event.preventDefault();
        setKeyMenu({ x: event.clientX, y: event.clientY, kind: "ssh", row });
      }}
    >
      <button className="port-item" onClick={activate}>
        <span className={`port-item__dot${opened.length ? " open" : ""}`} />
        {deviceLevel && <span aria-hidden="true" />}
        <span className="port-item__name">{group.label}</span>
        <span className="port-item__meta">
          <span className="port-item__kind">SSH</span>
          {opened.length > 1 && <span className="port-item__holders" title={`${opened.length} 个终端`}>{opened.length}</span>}
        </span>
      </button>
    </div>;
  };
  const renderDefaultDevice = (group: PortGroupView, rows: ConnectionListRow[]) => {
    const scope = deviceScope(group.devId);
    const allRows = order.sort(scope, connectionRows([group], grouping, null, ""), rowKey);
    const rowIds = allRows.map(rowKey);
    const visibleIds = new Set(rows.map(rowKey));
    const serialRows = allRows.filter((row): row is Extract<ConnectionListRow, { kind: "serial" }> => row.kind === "serial" && visibleIds.has(rowKey(row)));
    if (!serialRows.length && (group.ports.length > 0 || (search && !`${group.label} ${group.detail ?? ""}`.toLocaleLowerCase().includes(search)))) return null;
    const dev = remotes.find((remote) => remote.id === group.devId);
    const canRename = Boolean(dev && getMode() === "local");
    const details = () => onShowDeviceDetail(group.external && group.meta ? { kind: "meta", device: group.meta } : dev ? { kind: "remote", dev } : { kind: "local" });
    const collapsed = !search && portCollapsed.has(group.devId);
    return <div key={`device:${group.devId}`} className="macro-group port-group">
      <GroupHead
        dragProps={order.bind("devices", group.devId, devices.map(device => device.devId))}
        name={group.label} count={serialRows.length} collapsed={collapsed}
        onToggle={() => onTogglePortGroup(group.devId)}
        leading={<span className={`dot ${group.online === true ? "on" : group.online === false ? "off" : ""}`} />}
        title={dev ? `${dev.host}:${dev.port}` : group.detail}
        onRename={canRename && dev ? (name) => onRenameRemote(dev, name) : undefined}
        renameLabel="重命名设备" renameInitial={dev?.nickname ?? ""} renamePlaceholder="设备昵称(留空显示地址)"
        menuHidden={!dev && group.devId !== "local" && !group.external}
        extraMenuItems={[
          { label: "设备详情", onSelect: details },
          ...(dev ? [
            { label: group.online === true ? "断开设备" : "重连设备", onSelect: () => group.online === true ? onDisconnectRemote(dev) : onReconnectRemote(dev) },
            { label: "删除设备", danger: true, onSelect: () => onRemoveRemote(dev) },
          ] : []),
        ]}
      />
      {!collapsed && <div className="connection-tree__children">{serialRows.length ? serialRows.map((row) => renderSerial(group, row.port, false, scope, rowIds)) : <p className="sidebar__empty">{group.online === false ? "未连接" : group.online === undefined && group.devId !== "local" ? "连接中…" : "无可用端口"}</p>}</div>}
    </div>;
  };

  return <>
    {/* 分组视图的「+ 新建分组」内联行(原 section-head 上的按钮迁此;标题/刷新/切视图收进面板 ··· 菜单) */}
    {listView === "groups" && !creatingGroup && (
      <button className="group-create-row" disabled={!groupsReady} onClick={() => setCreatingGroup(true)}>
        + 新建分组
      </button>
    )}
    {listView === "groups" && creatingGroup && <form className="port-group-create" onSubmit={(event) => { event.preventDefault(); void createGroup(); }}>
      <input className="field" aria-label="新分组名称" placeholder="分组名称" autoFocus maxLength={64} value={groupName} onChange={(event) => setGroupName(event.target.value)} />
      <button className="mini-btn" type="submit" disabled={!groupsReady || groupSaving}>{groupSaving ? "保存中…" : "创建"}</button>
      <button className="icon-btn" type="button" aria-label="取消新建分组" onClick={() => { setCreatingGroup(false); setGroupError(""); }}><IconClose /></button>
    </form>}
    {(groupsError || groupError) && <p className="sidebar__group-error" role="alert">{groupsError || groupError}</p>}
    {listView === "groups" && !groupsReady && !groupsError && <p className="sidebar__empty">正在同步分组，请确认服务已连接。</p>}
    {listView === "groups" && groupsReady && !grouping.names.length && <p className="sidebar__empty">暂无分组，点击“新建分组”，再右键串口或 SSH 设备添加。</p>}
    {search && buckets.length > 0 && buckets.every((bucket) => !bucket.rows.length && !bucket.name?.toLocaleLowerCase().includes(search)) && <p className="sidebar__empty">没有匹配的连接</p>}
    <div className="connection-tree" data-view={listView}>{buckets.map((bucket) => {
      const customName = bucket.name;
      if (customName === null) return <div key="default" className="connection-tree__default">{devices.map((group) => {
        if (group.kind !== "ssh") return renderDefaultDevice(group, bucket.rows);
        const row = bucket.rows.find((entry): entry is SshRow => entry.kind === "ssh" && entry.group.devId === group.devId);
        return row ? renderSsh(row, "devices", devices.map(device => device.devId), true) : null;
      })}</div>;
      if (search && !bucket.rows.length && !customName.toLocaleLowerCase().includes(search)) return null;
      const collapsed = !search && grouping.collapsed.includes(customName);
      const scope = memberScope(customName);
      const ids = order.sort(scope, connectionRows(devices, grouping, customName, ""), rowKey).map(rowKey);
      return <div key={`custom:${customName}`} className="port-custom-group">
        <GroupHead name={customName} count={bucket.rows.length} collapsed={collapsed}
          dragProps={order.bind("groups", customName, customNames)}
          onToggle={() => onToggleCustomGroup(customName)}
          onRename={(value) => {
            if (value.trim() === customName) { setGroupError(""); return; }
            const newName = value.trim();
            if (!newName || grouping.names.includes(newName)) setGroupError("分组名称不能为空或与现有分组重复");
            else { void updateGroups({ type: "rename", name: customName, newName }); }
          }}
          onDissolve={() => { void updateGroups({ type: "dissolve", name: customName }); }}
        />
        {!collapsed && <div className="connection-tree__children">{bucket.rows.length ? bucket.rows.map((row) => row.kind === "ssh" ? renderSsh(row, scope, ids) : renderSerial(row.group, row.port, true, scope, ids)) : <p className="sidebar__empty">{search ? "没有匹配的连接" : "在默认视图右键串口或 SSH 设备可添加到此分组"}</p>}</div>}
      </div>;
    })}</div>
    {keyMenu && <ContextMenu x={keyMenu.x} y={keyMenu.y} items={keyMenuItems} onClose={() => setKeyMenu(null)} />}
  </>;
}

/** Shared library content; creation lives in the workspace sidebar.
 *  段标题/导入/导出等面板级动作已上收至面板标题栏的 ··· 菜单(App 组装),
 *  此处只留隐藏的导入 file input(菜单触发 importRef.click())与列表本体。 */
export function NamedLibraryPanel<T extends { group?: string }>({
  items,
  hasItems,
  collapsed,
  onToggleGroup,
  onRenameGroup,
  onDissolveGroup,
  importRef,
  onImportFile,
  emptyHint,
  renderRow,
  children,
  storageHint,
  query = "",
}: {
  query?: string;
  items: Record<string, T>;
  hasItems: boolean;
  collapsed: Set<string>;
  onToggleGroup: (g: string) => void;
  onRenameGroup: (oldName: string, newName: string) => void;
  onDissolveGroup: (name: string) => void;
  importRef: RefObject<HTMLInputElement>;
  onImportFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  emptyHint: string;
  /** 分组内单行（运行/编辑/删除按钮组）。 */
  renderRow: (name: string) => React.ReactNode;
  /** 运行卡片等尾随内容。 */
  children?: React.ReactNode;
  /** 存储位置说明（Web 模式:localStorage,与桌面端落盘不同——防止误以为存服务器）。 */
  storageHint?: string;
}) {
  const filteredItems = Object.entries(items).filter(([name, item]) => `${name} ${item.group ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return (
    <>
      <input
        ref={importRef}
        type="file"
        accept=".json,application/json"
        style={{ display: "none" }}
        onChange={onImportFile}
      />
      {storageHint && <p className="sidebar__storage-hint">{storageHint}</p>}
      {!hasItems && <p className="sidebar__empty">{emptyHint}</p>}
      {hasItems && !filteredItems.length && <p className="sidebar__empty">没有匹配的条目</p>}
      {groupBy(filteredItems, (m) => m.group).map((g) => (
        <div key={g.name} className="macro-group">
          <GroupHead
            name={g.name}
            count={g.items.length}
            collapsed={!query.trim() && collapsed.has(g.name)}
            onToggle={() => onToggleGroup(g.name)}
            onRename={(n) => onRenameGroup(g.name, n)}
            onDissolve={() => onDissolveGroup(g.name)}
            menuHidden={g.name === "未分组"}
          />
          {(!!query.trim() || !collapsed.has(g.name)) && g.items.map(([name]) => renderRow(name))}
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
