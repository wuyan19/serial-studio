/** REST + SSE 封装。后端契约见 crates/topo-hub/src/api.rs。 */

export interface TopologyMember {
  kind: "device" | "endpoint";
  key: string;
  note?: string;
}

export interface Topology {
  id: string;
  name: string;
  description: string;
  members: TopologyMember[];
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

export interface PortView {
  name: string;
  opened: boolean;
  holders: number;
  alias?: string;
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
  createTopology: (body: { name: string; description?: string; members?: MemberInput[] }) =>
    req<Topology>("/api/topologies", { method: "POST", body: JSON.stringify(body) }),
  updateTopology: (
    id: string,
    body: { name?: string; description?: string; members?: MemberInput[] },
  ) => req<Topology>(`/api/topologies/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteTopology: (id: string) => req<void>(`/api/topologies/${id}`, { method: "DELETE" }),
  ports: () => req<PortView[]>("/api/ports"),
};

/** 订阅变更通知（拓扑/未来租约），收到即回调（调用方重拉数据）。 */
export function subscribeChanged(cb: () => void): () => void {
  const es = new EventSource("/api/events");
  es.addEventListener("topo_changed", cb);
  return () => es.close();
}
