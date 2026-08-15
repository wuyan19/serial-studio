/**
 * 会话状态 reducer（纯函数，无 React、无副作用，可单测）。
 *
 * 收纳所有「会被 transport 事件回调读取/写入」的领域状态——此前这些状态平铺在 App 的
 * useState 里，事件回调（bindTransport，只绑一次）拿不到最新值，只能靠六七个 ref 镜像
 * （groupOfPortRef/groupsRef/openPortsRef/…）绕 stale 闭包。收进 reducer 后：
 *  - 事件回调只 dispatch（dispatch 永不 stale），大多数 ref 镜像自然消失；
 *  - 「焦点 group 被删自愈」「端口唯一归属」等不变量在 reducer 内统一维护。
 *
 * 持有的状态：端口清单（按设备分桶）、设备在线、打开的端口、断开待重连端口、
 * 端口实际配置、editor-group 分栏（groups + layout 树 + 焦点）。
 * 不持有：UI 开关（对话框/侧栏）、宏/脚本库、remotes、运行卡片（那些不经 transport 回调读取）。
 */
import { parsePortId, portIdOf } from "./lib";
import { createRoot, leafGroupIds, removeLeaf, splitLeaf } from "./pane-tree";
import type { Group, PaneHalf, PaneNode, PortId, PortInfo, SerialConfig } from "./types";

export interface SessionState {
  /** 按设备域分桶的端口列表（key=devId："local" 或远程设备 UUID/窗口 "remote"）。 */
  portsByDev: Record<string, PortInfo[]>;
  /** devId → 该设备 WS/IPC 是否就绪。 */
  devOnline: Record<string, boolean>;
  /** 本会话打开的端口复合键，有序。 */
  openPorts: PortId[];
  /** 设备断开(USB 拔出/WS 断连)但 tab 保留的端口——可重连。 */
  disconnectedPorts: Set<PortId>;
  /** 端口实际生效的配置（acquire 结果），key=PortId。 */
  portConfigs: Record<string, SerialConfig>;
  /** editor group 集合：每个 = 标签栏 + 终端区。端口全局唯一归属一个 group。 */
  groups: Record<string, Group>;
  /** 分栏布局树（叶子=group）。 */
  layout: PaneNode;
  /** 焦点 group id。 */
  focusedGroupId: string;
  /** group id 自增序号（reducer 内生成新 group id，保证确定性）。 */
  groupSeq: number;
}

export const initialSession: SessionState = {
  portsByDev: {},
  devOnline: {},
  openPorts: [],
  disconnectedPorts: new Set(),
  portConfigs: {},
  groups: { g1: { id: "g1", ports: [], activePort: "" } },
  layout: createRoot("g1"),
  focusedGroupId: "g1",
  groupSeq: 1,
};

export type SessionAction =
  /** 端口列表到达（list 响应或推送）。 */
  | { type: "ports_listed"; devId: string; ports: PortInfo[] }
  /** 设备连接状态变化。false 时：本设备开着的端口标记断开待重连，端口列表 opened 置 false。 */
  | { type: "dev_online"; devId: string; online: boolean }
  /** transport 销毁（删设备/手动重连/地址变化重建）：清在线标记。 */
  | { type: "teardown_dev"; devId: string }
  /** 端口重新可用（reopen 或别处打开）→ 清该 tab 的断开标记。 */
  | { type: "port_opened_evt"; devId: string; port: string }
  /** 设备物理断开（USB 拔出）→ 保留 tab，仅标记断开待重连。 */
  | { type: "port_disconnected_evt"; devId: string; port: string }
  /** acquire 成功（首开或附加）：记录实际配置、建 tab、进焦点 group；断开标记一并清除。 */
  | { type: "port_acquired"; pid: PortId; config: SerialConfig }
  /** 移除端口（用户主动关 + 远端被关共用）：清 openPorts/portConfigs/groups/layout。 */
  | { type: "prune_port"; pid: PortId }
  /** 聚焦指定 group。 */
  | { type: "set_focused_group"; groupId: string }
  /** 在指定 group 内切活动端口并聚焦它。 */
  | { type: "switch_tab"; groupId: string; port: PortId }
  /** 拖 tab 到某 group 终端区半区：新建 group 并分裂。 */
  | { type: "drop_half"; port: PortId; srcGroupId: string; dstGroupId: string; half: PaneHalf }
  /** 拖 tab 到另一 group 的标签栏：迁移归属。 */
  | { type: "move_port"; port: PortId; srcGroupId: string; dstGroupId: string }
  /** 拖分栏手柄改比例。path = 从根到目标 split 节点的子索引序列（根 split 为 []）。 */
  | { type: "set_split_ratio"; path: number[]; ratio: number };

/** 端口 → 所属 group 反查。 */
function groupOf(groups: Record<string, Group>, pid: PortId): string | undefined {
  for (const g of Object.values(groups)) if (g.ports.includes(pid)) return g.id;
  return undefined;
}

/** move_port 的共享实现（drop_half 落空 group 时也复用）。 */
function movePort(s: SessionState, port: PortId, srcGroupId: string, dstGroupId: string): SessionState {
  if (srcGroupId === dstGroupId) return s;
  const src = s.groups[srcGroupId];
  const dst = s.groups[dstGroupId];
  if (!src || !dst || !src.ports.includes(port) || dst.ports.includes(port)) return s;
  const sp = src.ports.filter((p) => p !== port);
  const srcEmpty = sp.length === 0; // 只有这一个 → 迁出后空
  const groups: Record<string, Group> = {
    ...s.groups,
    [dstGroupId]: { ...dst, ports: [...dst.ports, port], activePort: port },
  };
  if (srcEmpty) delete groups[srcGroupId];
  else groups[srcGroupId] = { ...src, ports: sp, activePort: src.activePort === port ? sp[sp.length - 1] : src.activePort };
  const layout = srcEmpty ? removeLeaf(s.layout, srcGroupId) ?? s.layout : s.layout;
  return { ...s, groups, layout, focusedGroupId: dstGroupId };
}

function reduce(s: SessionState, a: SessionAction): SessionState {
  switch (a.type) {
    case "ports_listed":
      return { ...s, portsByDev: { ...s.portsByDev, [a.devId]: a.ports } };

    case "dev_online": {
      const devOnline = { ...s.devOnline, [a.devId]: a.online };
      if (a.online) return { ...s, devOnline };
      // 断连：本设备开着的端口标记"断开待重连"（重连成功后由端口事件重放）；
      // 端口列表 opened 置 false——WS 断后 portsByDev 不再刷新，会冻在断开前的假绿灯。
      const disconnectedPorts = new Set(s.disconnectedPorts);
      for (const pid of s.openPorts)
        if (parsePortId(pid).devId === a.devId) disconnectedPorts.add(pid);
      const portsByDev = s.portsByDev[a.devId]
        ? { ...s.portsByDev, [a.devId]: s.portsByDev[a.devId].map((p) => ({ ...p, opened: false })) }
        : s.portsByDev;
      return { ...s, devOnline, disconnectedPorts, portsByDev };
    }

    case "teardown_dev": {
      if (!(a.devId in s.devOnline)) return s;
      const devOnline = { ...s.devOnline };
      delete devOnline[a.devId];
      return { ...s, devOnline };
    }

    case "port_opened_evt": {
      const pid = portIdOf(a.devId, a.port);
      if (!s.disconnectedPorts.has(pid)) return s;
      const disconnectedPorts = new Set(s.disconnectedPorts);
      disconnectedPorts.delete(pid);
      return { ...s, disconnectedPorts };
    }

    case "port_disconnected_evt": {
      const pid = portIdOf(a.devId, a.port);
      if (s.disconnectedPorts.has(pid)) return s;
      const disconnectedPorts = new Set(s.disconnectedPorts);
      disconnectedPorts.add(pid);
      return { ...s, disconnectedPorts };
    }

    case "port_acquired": {
      const { pid, config } = a;
      const openPorts = s.openPorts.includes(pid) ? s.openPorts : [...s.openPorts, pid];
      const portConfigs = { ...s.portConfigs, [pid]: config };
      // 成功占有即端口可用：清断开标记（重连路径）。
      const disconnectedPorts = s.disconnectedPorts.has(pid)
        ? new Set([...s.disconnectedPorts].filter((p) => p !== pid))
        : s.disconnectedPorts;
      // 进焦点 group 并设为活动端口。端口唯一归属（INV-1）：已在某 group（重连重放、
      // tab 期间被挪动）则保持原归属不动，只追加新开的端口——否则会同时出现在两个 group。
      const cur = s.groups[s.focusedGroupId];
      const alreadyGrouped = groupOf(s.groups, pid) !== undefined;
      const groups = cur && !alreadyGrouped
        ? {
            ...s.groups,
            [s.focusedGroupId]: {
              ...cur,
              ports: cur.ports.includes(pid) ? cur.ports : [...cur.ports, pid],
              activePort: pid,
            },
          }
        : s.groups;
      return { ...s, openPorts, portConfigs, disconnectedPorts, groups };
    }

    case "prune_port": {
      const pid = a.pid;
      const gid = groupOf(s.groups, pid);
      const openPorts = s.openPorts.filter((p) => p !== pid);
      const portConfigs = { ...s.portConfigs };
      delete portConfigs[pid];
      const disconnectedPorts = s.disconnectedPorts.has(pid)
        ? new Set([...s.disconnectedPorts].filter((p) => p !== pid))
        : s.disconnectedPorts;
      // 顺带清断开标记（有意修正）：原实现不删，用户关掉"断开待重连"的 tab 后，
      // 设备重连时会按重放集合把这个已关的端口重新打开（僵尸复活）。
      if (!gid) return { ...s, openPorts, portConfigs, disconnectedPorts }; // 不在任何 group（异常）
      const cur = s.groups[gid];
      const rest = cur.ports.filter((p) => p !== pid);
      const groups = { ...s.groups };
      let layout = s.layout;
      if (rest.length > 0) {
        groups[gid] = { ...cur, ports: rest, activePort: cur.activePort === pid ? rest[rest.length - 1] : cur.activePort };
      } else if (Object.keys(s.groups).length <= 1) {
        // 唯一根保留为空 group（承接下次打开，否则 layout/focused 仍指向它，重开端口进不去）
        groups[gid] = { ...cur, ports: [], activePort: "" };
      } else {
        delete groups[gid];
        layout = leafGroupIds(s.layout).length <= 1 ? s.layout : removeLeaf(s.layout, gid) ?? s.layout;
      }
      return { ...s, openPorts, portConfigs, disconnectedPorts, groups, layout };
    }

    case "set_focused_group":
      return s.focusedGroupId === a.groupId ? s : { ...s, focusedGroupId: a.groupId };

    case "set_split_ratio": {
      // 沿 path 定位目标 split 节点,只改 ratio(结构不变,clamp 0.15–0.85 防拖没)
      const clamp = Math.min(0.85, Math.max(0.15, a.ratio));
      const walk = (node: PaneNode, idx: number): PaneNode => {
        if (node.type !== "split") return node;
        if (idx === a.path.length) return node.ratio === clamp ? node : { ...node, ratio: clamp };
        const children: [PaneNode, PaneNode] = [node.children[0], node.children[1]];
        children[a.path[idx]] = walk(children[a.path[idx]], idx + 1);
        return { ...node, children };
      };
      const layout = walk(s.layout, 0);
      return layout === s.layout ? s : { ...s, layout };
    }

    case "switch_tab": {
      const cur = s.groups[a.groupId];
      if (!cur || !cur.ports.includes(a.port)) return s;
      // activePort 未变也仍要聚焦该 group：侧栏/串口面板触发"已开端口"时靠这里跳转焦点
      //（点 group 自身标签则已由容器 mousedown 聚焦，此处 no-op 无感）。
      const groups = cur.activePort === a.port ? s.groups : { ...s.groups, [a.groupId]: { ...cur, activePort: a.port } };
      return { ...s, groups, focusedGroupId: a.groupId };
    }

    case "drop_half": {
      const { port, srcGroupId, dstGroupId, half } = a;
      const src = s.groups[srcGroupId];
      if (!src || !src.ports.includes(port)) return s;
      // 落到空 group：直接搬进去，不分裂（否则空格子累积、永不坍缩）
      if ((s.groups[dstGroupId]?.ports.length ?? 0) === 0) {
        return movePort(s, port, srcGroupId, dstGroupId);
      }
      // 拖自己唯一 tab 到自己半区：结果只是空 group + 单 tab group，无分栏意义
      if (srcGroupId === dstGroupId && src.ports.length === 1) return s;
      const newId = "g" + (s.groupSeq + 1);
      const srcPorts = src.ports.filter((p) => p !== port);
      const srcEmpty = srcPorts.length === 0;
      const groups: Record<string, Group> = {
        ...s.groups,
        [newId]: { id: newId, ports: [port], activePort: port },
      };
      if (srcEmpty && srcGroupId !== dstGroupId) delete groups[srcGroupId];
      else
        groups[srcGroupId] = {
          ...src,
          ports: srcPorts,
          activePort: src.activePort === port ? srcPorts[srcPorts.length - 1] : src.activePort,
        };
      const dir = half === "left" || half === "right" ? "row" : "col";
      const side = half === "right" || half === "down" ? "end" : "start";
      let layout: PaneNode = splitLeaf(s.layout, dstGroupId, { type: "leaf", groupId: newId }, dir, side);
      if (srcEmpty && srcGroupId !== dstGroupId) layout = removeLeaf(layout, srcGroupId) ?? layout;
      return { ...s, groups, layout, focusedGroupId: newId, groupSeq: s.groupSeq + 1 };
    }

    case "move_port":
      return movePort(s, a.port, a.srcGroupId, a.dstGroupId);
    default: {
      // 联合已穷尽；default 仅满足返回类型检查
      const _exhaustive: never = a;
      return s;
    }
  }
}

/** 对外 reducer：内层 reduce + 焦点自愈（焦点 group 被删 → 回退到首个 leaf，
 *  保 channel-strip/macro 上下文不指向死 group）。 */
export function sessionReducer(s: SessionState, a: SessionAction): SessionState {
  const next = reduce(s, a);
  const leaves = leafGroupIds(next.layout);
  if (leaves.length && !leaves.includes(next.focusedGroupId)) {
    return { ...next, focusedGroupId: leaves[0] };
  }
  return next;
}
