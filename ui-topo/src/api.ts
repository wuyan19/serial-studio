/** REST + SSE 封装。后端契约见 crates/topo-hub/src/api.rs。 */

export interface TopologyMember {
  kind: "device" | "endpoint";
  key: string;
  note?: string;
}

export interface TopologyLink {
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
  kind: "device" | "endpoint";
  key: string;
  note?: string;
  label: string;
  detail?: string;
  online?: boolean;
}

export interface TopologyDetail extends Topology {
  member_views: MemberView[];
}

export interface MemberInput {
  key: string;
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
  kind: "device" | "endpoint";
  key: string;
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

/** 订阅变更通知（拓扑/租约），收到即回调（调用方重拉数据）。 */
export function subscribeChanged(cb: () => void): () => void {
  const es = new EventSource("/api/events");
  es.addEventListener("topo_changed", cb);
  es.addEventListener("lease_changed", cb);
  return () => es.close();
}

const devSeg = (k: string) => (k.includes("::") ? k.split("::")[0] : "local");

/** grant 覆盖集合与拓扑成员是否相交（服务端 grants_intersect 的展示侧子集）。 */
export function grantCoversMember(
  grant: Grant,
  member: { kind: "device" | "endpoint"; key: string },
): boolean {
  if (grant.kind === "device" && member.kind === "device") return grant.key === member.key;
  if (grant.kind === "device") return devSeg(member.key) === grant.key;
  if (member.kind === "device") return devSeg(grant.key) === member.key;
  return grant.key === member.key;
}

/** 找到覆盖该成员的租约（占用徽章/占用列共用）。 */
export function leaseOfMember(
  member: { kind: "device" | "endpoint"; key: string },
  leases: LeaseView[],
): LeaseView | undefined {
  return leases.find((l) => l.grants.some((g) => grantCoversMember(g, member)));
}

/** 时间戳显示（iso → 本地短格式）。 */
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(
    d.getHours(),
  ).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
