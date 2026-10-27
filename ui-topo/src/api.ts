/** REST + SSE 封装。后端契约见 crates/topo-hub/src/api.rs。 */

/** 被测设备（device.rs 注册表）：设备=身份，通道=接入方式。 */
export interface DeviceChannel {
  type: "serial" | "ssh";
  /** serial: 端口键（本机裸名或级联键）；ssh: 凭据 id。 */
  port?: string;
  ref?: string;
}

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
  note?: string;
}

export interface TopologyLink {
  /** 设备 id（拓扑成员维度）。 */
  from: string;
  to: string;
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
  note?: string;
}

export interface LinkInput {
  from: string;
  to: string;
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

/** 通道的终端端口键：serial 直用；ssh 取凭据的 shell 端点。 */
export function channelPortKey(ch: DeviceChannel): string {
  if (ch.type === "serial") return ch.port ?? "";
  return `${ch.ref}::shell`;
}

/** 时间戳显示（iso → 本地短格式）。 */
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(
    d.getHours(),
  ).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
