import { useMemo } from "react";
import { Background, Controls, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { leaseOfDevice, type LeaseView, type Topology } from "../api";

/** 拓扑图：节点 = 成员设备（通道列为小字），边 = links（设备维度）。
 * 圆形自动布局，节点可拖；占用中的设备描边高亮。V2 不持久化布局。 */
export default function TopologyGraph({
  topo,
  nameOf,
  subtitleOf,
  leases,
}: {
  topo: Topology;
  /** 设备 id → 显示名（详情快照优先、注册表兜底，由调用方注入）。 */
  nameOf: (deviceId: string) => string;
  /** 设备 id → 节点小字（通道摘要）。 */
  subtitleOf: (deviceId: string) => string | undefined;
  leases: LeaseView[];
}) {
  const { nodes, edges } = useMemo(() => {
    const memberIds = topo.members.map((m) => m.device);
    const radius = Math.max(120, 55 * memberIds.length);
    const nodeList: Node[] = memberIds.map((id, i) => {
      const occupied = leaseOfDevice(id, leases);
      const angle = (2 * Math.PI * i) / Math.max(memberIds.length, 1) - Math.PI / 2;
      const chans = subtitleOf(id);
      return {
        id,
        position: { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius },
        data: {
          label: `${nameOf(id)}${chans ? `\n${chans}` : ""}${occupied ? "\n● 占用中" : ""}`,
        },
        style: {
          background: "var(--surface)",
          color: "var(--ink)",
          border: `1px solid ${occupied ? "var(--warn)" : "var(--hairline)"}`,
          borderRadius: 12,
          padding: "10px 16px",
          fontSize: 13,
          lineHeight: 1.55,
          maxWidth: 240,
          whiteSpace: "pre-line",
          textAlign: "center",
          boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.05)",
        },
      };
    });
    const edgeList: Edge[] = topo.links.map((l, i) => ({
      id: `e${i}`,
      source: l.from,
      target: l.to,
      label: l.label,
      style: { stroke: "var(--ink-faint)", strokeWidth: 1.5 },
      labelStyle: { fill: "var(--ink-dim)", fontSize: 11 },
      labelBgStyle: { fill: "var(--surface-2)" },
      labelBgPadding: [6, 3],
      labelBgBorderRadius: 4,
    }));
    return { nodes: nodeList, edges: edgeList };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topo, leases, nameOf, subtitleOf]);

  return (
    <div className="graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        nodesConnectable={false}
        proOptions={{ hideAttribution: false }}
      >
        <Background color="var(--hairline)" gap={20} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
