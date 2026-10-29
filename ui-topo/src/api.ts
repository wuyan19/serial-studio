/** REST + SSE 封装。后端契约见 crates/topo-hub/src/api.rs。 */
import type { SerialConfig as SerialConfigT } from "./types";

/** 被测设备（device.rs 注册表）：设备=身份，通道=接入方式（内联完整配置）。 */
export interface SshChannel {
  type: "ssh";
  /** 稳定 id（=端口键首段，服务端生成）。 */
  id: string;
  host: string;
  port: number;
  username: string;
  nickname?: string;
  auth: { type: "key"; keyPath: string } | { type: "agent" } | { type: "password"; password: string };
}

export interface SerialChannel {
  type: "serial";
  /** 端口键（本机裸名或级联键）。 */
  port: string;
  config?: Partial<SerialConfigT>;
}

export type DeviceChannel = SerialChannel | SshChannel;

export interface Device {
  id: string;
  name: string;
  model: string;
  location: string;
  channels: DeviceChannel[];
}

export interface DeviceInput {
  name: string;
  model?: string;
  location?: string;
  channels: DeviceChannel[];
}

/** 通道展示视图（member_views 内嵌；设备管理页本地构造同形）。 */
export interface ChannelView {
  type: "serial" | "ssh";
  key: string;
  label: string;
  present: boolean;
  opened?: boolean;
  holders?: number;
}

export interface TopologyMember {
  device: string;
  /** 画布坐标（编辑器拖拽位置；0/0 视为未摆位，前端圆形布局兜底）。 */
  x: number;
  y: number;
  note?: string;
}

export interface TopologyLink {
  /** 设备 id（拓扑成员维度）。 */
  from: string;
  to: string;
  /** from 端设备上的物理端口标签（如 "GE1/1/1"，自由文本）。 */
  from_port?: string;
  /** to 端设备上的物理端口标签（如 "eth0"）。 */
  to_port?: string;
  label?: string;
}

export interface Topology {
  id: string;
  name: string;
  description: string;
  members: TopologyMember[];
  links: TopologyLink[];
  created_at: string;
  updated_at: string;
}

export interface MemberView {
  device: string;
  name: string;
  model: string;
  location: string;
  note?: string;
  channels: ChannelView[];
}

export interface TopologyDetail extends Topology {
  member_views: MemberView[];
}

export interface MemberInput {
  device: string;
  x?: number;
  y?: number;
  note?: string;
}

export interface LinkInput {
  from: string;
  to: string;
  from_port?: string;
  to_port?: string;
  label?: string;
}

export interface PortView {
  name: string;
  opened: boolean;
  holders: number;
  alias?: string;
  /** 设备断开（USB 拔出等）但占有权保留、可重连。 */
  disconnected?: boolean;
  kind?: string;
  instance?: number;
  device?: DeviceView;
}

export interface DeviceView {
  id: string;
  label: string;
  detail?: string;
  via: string;
  online?: boolean;
}

export interface RemoteDeviceT {
  id: string;
  host: string;
  port: number;
  nickname?: string;
}

/** 设置视图（后端 SettingsView：settings.json 展开 + lease 对象）。 */
export interface ServerSettings {
  ws_host: string;
  ws_port: number;
  telnet_port: number;
  enable_scripting: boolean;
  script_log_to_disk: boolean;
  lease: { ttl_minutes: number; max_ttl_minutes: number; enable_gate: boolean };
}

export interface Grant {
  device: string;
}

export interface LeaseView {
  id: string;
  label: string;
  grants: Grant[];
  acquired_at: string;
  expires_at: string;
  remaining_minutes: number;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  topologies: () => req<Topology[]>("/api/topologies"),
  topology: (id: string) => req<TopologyDetail>(`/api/topologies/${id}`),
  createTopology: (body: {
    name: string;
    description?: string;
    members?: MemberInput[];
    links?: LinkInput[];
  }) => req<Topology>("/api/topologies", { method: "POST", body: JSON.stringify(body) }),
  updateTopology: (
    id: string,
    body: {
      name?: string;
      description?: string;
      members?: MemberInput[];
      links?: LinkInput[];
    },
  ) => req<Topology>(`/api/topologies/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteTopology: (id: string) => req<void>(`/api/topologies/${id}`, { method: "DELETE" }),
  devices: () => req<Device[]>("/api/devices"),
  createDevice: (body: DeviceInput) =>
    req<Device>("/api/devices", { method: "POST", body: JSON.stringify(body) }),
  updateDevice: (id: string, body: DeviceInput) =>
    req<Device>(`/api/devices/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteDevice: (id: string) => req<void>(`/api/devices/${id}`, { method: "DELETE" }),
  leases: () => req<LeaseView[]>("/api/leases"),
  forceReleaseLease: (id: string) =>
    req<void>(`/api/leases/${id}`, { method: "DELETE" }),
  ports: () => req<PortView[]>("/api/ports"),
  remotes: () => req<RemoteDeviceT[]>("/api/remotes"),
  saveRemotes: (devices: RemoteDeviceT[]) =>
    req<RemoteDeviceT[]>("/api/remotes", { method: "PUT", body: JSON.stringify({ devices }) }),
  settings: () => req<ServerSettings>("/api/settings"),
  saveSettings: (s: ServerSettings) =>
    req<ServerSettings>("/api/settings", { method: "PUT", body: JSON.stringify(s) }),
};

/** 订阅变更通知（拓扑/设备/租约），收到即回调（调用方重拉数据）。 */
export function subscribeChanged(cb: () => void): () => void {
  const es = new EventSource("/api/events");
  es.addEventListener("topo_changed", cb);
  es.addEventListener("lease_changed", cb);
  return () => es.close();
}

/** 设备的占用租约（设备级独占：grant.device 即设备 id）。 */
export function leaseOfDevice(deviceId: string, leases: LeaseView[]): LeaseView | undefined {
  return leases.find((l) => l.grants.some((g) => g.device === deviceId));
}

/** 通道的终端端口键：serial 直用；ssh 取 shell 端点。 */
export function channelPortKey(ch: DeviceChannel): string {
  if (ch.type === "serial") return ch.port;
  return `${ch.id}::shell`;
}

/** 串口通道的完整打开配置（缺省补默认——与设备编辑对话框同源）。 */
export function channelSerialConfig(ch: SerialChannel): SerialConfigT {
  return {
    baud_rate: 115200,
    data_bits: "eight",
    stop_bits: "one",
    parity: "none",
    flow_control: "none",
    line_ending: "lf",
    ...ch.config,
  };
}

/** SSH 通道显示名：昵称回退 user@host。 */
export function sshChannelLabel(ch: SshChannel): string {
  return ch.nickname?.trim() || `${ch.username}@${ch.host}`;
}

/** 通道在端口表中的可见状态（镜像服务端 Channel::covers 两粒度语义）：
 * 串口精确匹配端口键，SSH 按复合键首段（凭据 id）匹配。 */
export function channelStatus(
  ch: DeviceChannel,
  ports: PortView[],
): { present: boolean; opened?: boolean; holders?: number } {
  if (ch.type === "serial") {
    const row = ports.find((p) => p.name === ch.port);
    return { present: !!row, opened: row?.opened, holders: row?.holders };
  }
  const rows = ports.filter((p) => p.name.split("::")[0] === ch.id);
  return { present: rows.length > 0, opened: rows[0]?.opened, holders: rows[0]?.holders };
}

/** 通道展示文案（卡片/图节点小字共用）：串口取端口键，SSH 取昵称/user@host。 */
export function channelLabel(ch: DeviceChannel): string {
  return ch.type === "serial" ? `串口 ${ch.port}` : `SSH ${sshChannelLabel(ch)}`;
}

/** 时间戳显示（iso → 本地短格式）。 */
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(
    d.getHours(),
  ).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
