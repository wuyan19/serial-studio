/** 拓扑画布共享件：DeviceNode 节点 + PortEdge 端口标签边 + 圆形布局兜底。
 * 编辑器（可交互）与详情图（只读）共用；节点/边类型与样式集中在此。 */
import { memo, useEffect, useRef, useState } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  Position,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";

export interface DeviceNodeData extends Record<string, unknown> {
  /** 设备 id（节点 id 同值）。 */
  device: string;
  label: string;
  /** 通道摘要小字（如 "串口 COM4 · SSH root@…"）。 */
  subtitle?: string;
  /** 占用中（只读图描边高亮）。 */
  occupied?: boolean;
  /** 成员备注（属性面板编辑，不上节点正文）。 */
  note?: string;
  /** 编辑模式：显示四向连接锚点。 */
  editable?: boolean;
}

export type DeviceFlowNode = Node<DeviceNodeData, "device">;

const HANDLES: { id: string; position: Position }[] = [
  { id: "top", position: Position.Top },
  { id: "right", position: Position.Right },
  { id: "bottom", position: Position.Bottom },
  { id: "left", position: Position.Left },
];

const DeviceNode = memo(function DeviceNode({ data, selected }: NodeProps<DeviceFlowNode>) {
  return (
    <div
      className={[
        "canvas-node",
        data.occupied ? "canvas-node--occupied" : "",
        selected ? "canvas-node--selected" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* 锚点恒渲染（边渲染按 id 匹配锚点，缺失则边不画）；只读容器经 CSS
          visibility 隐藏视觉（保留布局供锚点位置测量），交互由
          nodesConnectable/容器态控制。 */}
      {HANDLES.flatMap((h) => [
        <Handle key={`s-${h.id}`} type="source" position={h.position} id={h.id} isConnectable={!!data.editable} />,
        <Handle key={`t-${h.id}`} type="target" position={h.position} id={h.id} isConnectable={!!data.editable} />,
      ])}
      <div className="canvas-node__name">{data.label}</div>
      {data.subtitle && <div className="canvas-node__sub">{data.subtitle}</div>}
    </div>
  );
});

export interface PortEdgeData extends Record<string, unknown> {
  from_port?: string;
  to_port?: string;
  label?: string;
}

export type PortFlowEdge = Edge<PortEdgeData, "port">;

/** 连线两端端口标签位置：沿真实路径取 14%/86%（贴近各自设备，空间邻近即
 * 归属）。视觉间距（流坐标间距 × 当前 zoom）不足时回退中点合并"p1 ⇄ p2"。 */
const END_FRACTION = 0.14;
const MIN_VISUAL_GAP = 44;

const PortEdge = memo(function PortEdge(props: EdgeProps<PortFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  });
  const { from_port, to_port, label } = props.data ?? {};
  const fromText = from_port?.trim();
  const toText = to_port?.trim();
  const measureRef = useRef<SVGPathElement>(null);
  const [ends, setEnds] = useState<{
    from: { x: number; y: number };
    to: { x: number; y: number };
    gap: number;
  } | null>(null);
  const zoom = useStore((s) => s.transform[2]);

  // 贝塞尔按曲率外凸，直线插值会偏——量真实路径（隐藏 path，getPointAtLength）
  useEffect(() => {
    const el = measureRef.current;
    if (!el || (!fromText && !toText)) {
      return;
    }
    const total = el.getTotalLength();
    const f = el.getPointAtLength(total * END_FRACTION);
    const t = el.getPointAtLength(total * (1 - END_FRACTION));
    setEnds({
      from: { x: f.x, y: f.y },
      to: { x: t.x, y: t.y },
      gap: Math.hypot(t.x - f.x, t.y - f.y),
    });
  }, [path, fromText, toText]);

  const split = ends !== null && ends.gap * zoom >= MIN_VISUAL_GAP;
  const sel = props.selected ? " port-edge__label--sel" : "";
  const chip = (text: string, pos: { x: number; y: number }) => (
    <div
      className={`port-edge__label port-edge__label--end${sel}`}
      style={{ transform: `translate(-50%, -50%) translate(${pos.x}px, ${pos.y}px)` }}
    >
      {text}
    </div>
  );

  return (
    <>
      <BaseEdge
        path={path}
        style={{
          ...props.style,
          ...(props.selected
            ? { stroke: "var(--accent)", strokeWidth: 2.5 }
            : null),
        }}
      />
      {(fromText || toText) && (
        <path ref={measureRef} d={path} fill="none" stroke="none" style={{ pointerEvents: "none" }} />
      )}
      <EdgeLabelRenderer>
        {split && fromText && chip(fromText, ends!.from)}
        {split && toText && chip(toText, ends!.to)}
        {!split && (fromText || toText) && (
          <div
            className={`port-edge__label${sel}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {[fromText, toText].filter(Boolean).join(" ⇄ ")}
          </div>
        )}
        {label && (
          <div
            className={`port-edge__label${sel}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            <span className="port-edge__note">{label}</span>
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
});

export const topoNodeTypes = { device: DeviceNode };
export const topoEdgeTypes = { port: PortEdge };

/** 成员坐标兜底：未摆位（0,0）走圆形布局；编辑保存后持久化真实坐标。 */
export function memberPosition(
  m: { x: number; y: number },
  index: number,
  count: number,
): { x: number; y: number } {
  if (m.x !== 0 || m.y !== 0) return { x: m.x, y: m.y };
  const radius = Math.max(120, 55 * count);
  const angle = (2 * Math.PI * index) / Math.max(count, 1) - Math.PI / 2;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

/** 按两端节点相对位置选 handle 方向。节点是四向带 id 的锚点，而拓扑模型不存
 * 锚点——API 恢复的边按坐标就近选向；用户拖出的连线自带锚点 id 原样保留。 */
export function autoHandle(
  from: { x: number; y: number },
  to: { x: number; y: number },
): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}
