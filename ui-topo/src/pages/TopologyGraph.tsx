import { useMemo } from "react";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { leaseOfDevice, type LeaseView, type Topology } from "../api";
import { autoHandle, memberPosition, topoEdgeTypes, topoNodeTypes } from "../components/topo-canvas";

/** 拓扑图（只读）：节点 = 成员设备（通道列为小字），边 = links（两端端口标签
 * + 说明）。节点位置取成员坐标（编辑器摆位持久化），未摆位的旧数据圆形布局兜底；
 * 占用中的设备描边高亮。card=true 为大卡片内嵌形态（矮容器）。 */
export default function TopologyGraph({
  topo,
  nameOf,
  subtitleOf,
  leases,
  card,
}: {
  topo: Topology;
  /** 设备 id → 显示名（注册表翻译，由调用方注入）。 */
  nameOf: (deviceId: string) => string;
  /** 设备 id → 节点小字（通道摘要）。 */
  subtitleOf: (deviceId: string) => string | undefined;
  leases: LeaseView[];
  /** 大卡片内嵌形态（矮容器，隐藏缩放控件）。 */
  card?: boolean;
}) {
  const { nodes, edges } = useMemo(() => {
    const memberIds = topo.members.map((m) => m.device);
    const positions = topo.members.map((m, i) => memberPosition(m, i, memberIds.length));
    const posOf = (deviceId: string) => {
      const i = topo.members.findIndex((m) => m.device === deviceId);
      return i >= 0 ? positions[i] : { x: 0, y: 0 };
    };
    const nodeList = topo.members.map((m, i) => ({
      id: m.device,
      type: "device" as const,
      position: positions[i],
      data: {
        device: m.device,
        label: nameOf(m.device),
        subtitle: subtitleOf(m.device),
        occupied: Boolean(leaseOfDevice(m.device, leases)),
      },
    }));
    const edgeList = topo.links.map((l, i) => ({
      id: `e${i}-${l.from}-${l.to}`,
      type: "port" as const,
      source: l.from,
      target: l.to,
      sourceHandle: autoHandle(posOf(l.from), posOf(l.to)),
      targetHandle: autoHandle(posOf(l.to), posOf(l.from)),
      data: {
        from_port: l.from_port,
        to_port: l.to_port,
        label: l.label,
      },
    }));
    return { nodes: nodeList, edges: edgeList };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topo, leases, nameOf, subtitleOf]);

  return (
    <div className={card ? "graph graph--card" : "graph"}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={topoNodeTypes}
        edgeTypes={topoEdgeTypes}
        fitView
        nodesConnectable={false}
        nodesDraggable={!card}
        proOptions={{ hideAttribution: false }}
      >
        <Background color="var(--hairline)" gap={20} />
        {!card && <Controls showInteractive={false} />}
      </ReactFlow>
    </div>
  );
}
