import { useMemo } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { LeaseView, MemberView, Topology } from "../api";
import { leaseOfMember } from "../api";

const devSeg = (k: string) => (k.includes("::") ? k.split("::")[0] : "local");

interface GraphProps {
  topo: Topology;
  memberViews: MemberView[];
  leases: LeaseView[];
}

/** 拓扑图：节点 = 成员按设备分组（端点列为节点小字），边 = links（归到设备）。
 * 圆形自动布局，节点可拖；占用中的设备节点描边高亮。V2 不持久化布局。 */
export default function TopologyGraph({ topo, memberViews, leases }: GraphProps) {
  const { nodes, edges } = useMemo(() => {
    // 设备分组：device 成员自带标签；endpoint 成员的 label 形如 "设备 · 端点"
    const devices = new Map<
      string,
      { label: string; endpoints: string[]; occupied: boolean }
    >();
    for (const m of memberViews) {
      const dev = devSeg(m.key);
      const entry = devices.get(dev) ?? { label: dev, endpoints: [], occupied: false };
      if (m.kind === "device") {
        entry.label = m.label;
      } else {
        entry.label = m.label.split(" · ")[0] || entry.label;
        entry.endpoints.push(m.key.split("::").pop() ?? m.key);
      }
      if (leaseOfMember(m, leases)) entry.occupied = true;
      devices.set(dev, entry);
    }

    const ids = [...devices.keys()];
    const radius = Math.max(120, 55 * ids.length);
    const nodeList: Node[] = ids.map((id, i) => {
      const d = devices.get(id)!;
      const angle = (2 * Math.PI * i) / Math.max(ids.length, 1) - Math.PI / 2;
      return {
        id,
        position: {
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
        },
        data: {
          label: `${d.label}${d.endpoints.length ? `\n${d.endpoints.join(" · ")}` : ""}`,
        },
        style: {
          background: "var(--panel)",
          color: "var(--text)",
          border: `1px solid ${d.occupied ? "var(--warn)" : "var(--border)"}`,
          borderRadius: 8,
          padding: "8px 14px",
          fontSize: 13,
          whiteSpace: "pre-line",
          textAlign: "center",
        },
      };
    });

    const edgeList: Edge[] = topo.links.map((l, i) => ({
      id: `e${i}`,
      source: devSeg(l.from),
      target: devSeg(l.to),
      label: l.label,
      style: { stroke: "var(--border)", strokeWidth: 1.5 },
      labelStyle: { fill: "var(--muted)", fontSize: 11 },
      labelBgStyle: { fill: "var(--bg)" },
    }));
    return { nodes: nodeList, edges: edgeList };
  }, [topo, memberViews, leases]);

  return (
    <div className="graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        nodesConnectable={false}
        proOptions={{ hideAttribution: false }}
      >
        <Background color="#2c303a" gap={20} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
