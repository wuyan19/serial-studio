/** 拓扑编辑（画布）：左栏拖/双击设备入画布，锚点拖拽连线，选中节点/连线
 * 在属性面板编辑端口标签与备注，Delete 键删除选中（删节点连带其连线）。
 * 位置即数据——节点坐标保存进成员，下次进入原样恢复。 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Background,
  Controls,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import { api, sshChannelLabel, type Device } from "../api";
import {
  autoHandle,
  memberPosition,
  topoEdgeTypes,
  topoNodeTypes,
  type DeviceFlowNode,
  type PortEdgeData,
  type PortFlowEdge,
} from "../components/topo-canvas";

/** 通道摘要（palette 与节点小字共用）：串口取端口键，SSH 取昵称/user@host。 */
function deviceSubtitle(d: Device): string | undefined {
  const parts = d.channels.map((c) =>
    c.type === "serial" ? `串口 ${c.port}` : `SSH ${sshChannelLabel(c)}`,
  );
  return parts.length ? parts.join(" · ") : undefined;
}

export default function TopologyEdit() {
  return (
    <ReactFlowProvider>
      <TopologyEditInner />
    </ReactFlowProvider>
  );
}

function TopologyEditInner() {
  const { id } = useParams();
  const editing = id !== undefined;
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nodes, setNodes] = useState<DeviceFlowNode[]>([]);
  const [edges, setEdges] = useState<PortFlowEdge[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [selNodeId, setSelNodeId] = useState<string | null>(null);
  const [selEdgeId, setSelEdgeId] = useState<string | null>(null);

  useEffect(() => {
    api
      .devices()
      .then(setDevices)
      .catch(() => setError("设备列表加载失败——检查服务器连接（无法从设备库添加成员）"));
  }, []);

  useEffect(() => {
    if (!editing) return;
    // id 变化即重置（含清空）：跨拓扑切换或加载失败时，避免上一个拓扑的数据
    // 被保存进当前拓扑；加载失败时名称为空，保存按钮天然禁用。
    setName("");
    setDescription("");
    setNodes([]);
    setEdges([]);
    api
      .topology(id!)
      .then((t) => {
        setName(t.name);
        setDescription(t.description);
        const count = t.members.length;
        const positions = t.members.map((m, i) => memberPosition(m, i, count));
        const posOf = (deviceId: string) => {
          const i = t.members.findIndex((m) => m.device === deviceId);
          return i >= 0 ? positions[i] : { x: 0, y: 0 };
        };
        setNodes(
          t.members.map((m, i) => {
            const v = t.member_views.find((x) => x.device === m.device);
            return {
              id: m.device,
              type: "device" as const,
              position: positions[i],
              data: {
                device: m.device,
                label: v?.name ?? m.device,
                subtitle:
                  v && v.channels.length > 0
                    ? v.channels.map((c) => c.label).join(" · ")
                    : undefined,
                note: m.note,
                editable: true,
              },
            };
          }),
        );
        setEdges(
          t.links.map((l) => ({
            id: `link-${l.from}__${l.to}`,
            type: "port" as const,
            source: l.from,
            target: l.to,
            sourceHandle: autoHandle(posOf(l.from), posOf(l.to)),
            targetHandle: autoHandle(posOf(l.to), posOf(l.from)),
            data: { from_port: l.from_port, to_port: l.to_port, label: l.label },
          })),
        );
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, [id, editing]);

  const devOf = useMemo(() => new Map(devices.map((d) => [d.id, d])), [devices]);
  /** palette 候选：未入图的设备（同一设备可同时属于多个拓扑，这里是本图视角）。 */
  const available = devices.filter((d) => !nodes.some((n) => n.id === d.id));

  /** 拖拽/双击添加设备节点。pos 为画布坐标（双击给网格错开位）。 */
  const addDevice = useCallback(
    (deviceId: string, pos: { x: number; y: number }) => {
      const d = devOf.get(deviceId);
      if (!d || nodes.some((n) => n.id === deviceId)) return;
      setNodes((ns) => [
        ...ns,
        {
          id: d.id,
          type: "device",
          position: pos,
          data: {
            device: d.id,
            label: d.name,
            subtitle: deviceSubtitle(d),
            editable: true,
          },
        },
      ]);
    },
    [devOf, nodes, setNodes],
  );

  /** palette 双击：网格错开摆位（函数式更新内计算——快速连续添加也不重叠）。 */
  const addByClick = useCallback(
    (deviceId: string) => {
      setNodes((ns) => {
        if (ns.some((n) => n.id === deviceId)) return ns;
        const d = devOf.get(deviceId);
        if (!d) return ns;
        const n = ns.length;
        return [
          ...ns,
          {
            id: d.id,
            type: "device",
            position: { x: 80 + (n % 3) * 260, y: 60 + Math.floor(n / 3) * 150 },
            data: {
              device: d.id,
              label: d.name,
              subtitle: deviceSubtitle(d),
              editable: true,
            },
          },
        ];
      });
    },
    [devOf, setNodes],
  );

  const removeNode = useCallback(
    (nodeId: string) => {
      setNodes((ns) => ns.filter((n) => n.id !== nodeId));
      setEdges((es) => es.filter((e) => e.source !== nodeId && e.target !== nodeId));
      setSelNodeId(null);
    },
    [setNodes, setEdges],
  );

  const removeEdge = useCallback(
    (edgeId: string) => {
      setEdges((es) => es.filter((e) => e.id !== edgeId));
      setSelEdgeId(null);
    },
    [setEdges],
  );

  const patchNodeData = useCallback(
    (nodeId: string, patch: Partial<DeviceFlowNode["data"]>) => {
      setNodes((ns) =>
        ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n)),
      );
    },
    [setNodes],
  );

  const patchEdgeData = useCallback(
    (edgeId: string, patch: Partial<PortEdgeData>) => {
      setEdges((es) =>
        es.map((e) => (e.id === edgeId ? { ...e, data: { ...e.data, ...patch } } : e)),
      );
    },
    [setEdges],
  );

  const save = async () => {
    setSaving(true);
    setError("");
    // 悬空边兜底过滤（键盘删除节点的级联遗漏防御）
    const ids = new Set(nodes.map((n) => n.id));
    const body = {
      name: name.trim(),
      description,
      members: nodes.map((n) => ({
        device: n.id,
        x: Math.round(n.position.x * 10) / 10,
        y: Math.round(n.position.y * 10) / 10,
        note: n.data.note?.trim() || undefined,
      })),
      links: edges
        .filter((e) => ids.has(e.source) && ids.has(e.target))
        .map((e) => ({
          from: e.source,
          to: e.target,
          from_port: e.data?.from_port?.trim() || undefined,
          to_port: e.data?.to_port?.trim() || undefined,
          label: e.data?.label?.trim() || undefined,
        })),
    };
    try {
      const t = editing
        ? await api.updateTopology(id!, body)
        : await api.createTopology(body);
      navigate(`/topologies/${t.id}`);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setSaving(false);
    }
  };

  const selNode = nodes.find((n) => n.id === selNodeId) ?? null;
  const selEdge = edges.find((e) => e.id === selEdgeId) ?? null;
  const nodeName = (nodeId: string) =>
    nodes.find((n) => n.id === nodeId)?.data.label ?? nodeId;

  return (
    <section className="page page--fill topo-editor">
      <div className="page-head">
        <h1>{editing ? "编辑拓扑" : "新建拓扑"}</h1>
        <div className="row-actions">
          <button className="btn btn--primary" disabled={saving || !name.trim()} onClick={save}>
            {saving ? "保存中…" : "保存"}
          </button>
          <button className="btn btn--ghost" onClick={() => navigate(-1)}>
            返回
          </button>
        </div>
      </div>
      <div className="topo-editor__bar">
        <label className="topo-editor__field">
          名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="同表唯一；AI 经 MCP 按名称或 id 引用"
          />
        </label>
        <label className="topo-editor__field topo-editor__field--grow">
          描述
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="用途说明（可选）"
          />
        </label>
      </div>
      {error && <p className="error whitespace">{error}</p>}
      <div className="topo-editor__body">
        <aside className="topo-palette">
          <div className="topo-palette__head">设备库</div>
          <p className="topo-palette__tip">拖入画布（或双击）添加为本拓扑成员</p>
          {available.length === 0 ? (
            <p className="muted">
              {devices.length === 0
                ? "暂无被测设备——先到「设备」页注册。"
                : "本图已包含全部设备。"}
            </p>
          ) : (
            available.map((d) => (
              <div
                key={d.id}
                className="topo-palette__item"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/topo-device", d.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDoubleClick={() => addByClick(d.id)}
                title="拖入画布或双击添加"
              >
                <div className="topo-palette__name">{d.name}</div>
                {deviceSubtitle(d) && (
                  <div className="topo-palette__sub">{deviceSubtitle(d)}</div>
                )}
              </div>
            ))
          )}
        </aside>
        <CanvasFlow
          nodes={nodes}
          edges={edges}
          setNodes={setNodes}
          setEdges={setEdges}
          onDropDevice={addDevice}
          onSelectionChange={({ nodes: ns, edges: es }: OnSelectionChangeParams) => {
            setSelNodeId(ns.length ? ns[0].id : null);
            setSelEdgeId(es.length ? es[0].id : null);
          }}
        >
          {selNode ? (
            <NodePropsPanel
              key={`n-${selNode.id}`}
              node={selNode}
              onNote={(v) => patchNodeData(selNode.id, { note: v || undefined })}
              onRemove={() => removeNode(selNode.id)}
            />
          ) : selEdge ? (
            <EdgePropsPanel
              key={`e-${selEdge.id}`}
              edge={selEdge}
              fromName={nodeName(selEdge.source)}
              toName={nodeName(selEdge.target)}
              onPatch={(p) => patchEdgeData(selEdge.id, p)}
              onRemove={() => removeEdge(selEdge.id)}
            />
          ) : (
            <Panel position="top-right">
              <div className="topo-props topo-props--hint">
                点选节点或连线编辑属性；Delete 键删除选中
              </div>
            </Panel>
          )}
        </CanvasFlow>
      </div>
    </section>
  );
}

/** 画布主体：受控 nodes/edges + 连线校验 + 拖放落点转换。 */
function CanvasFlow({
  nodes,
  edges,
  setNodes,
  setEdges,
  onDropDevice,
  onSelectionChange,
  children,
}: {
  nodes: DeviceFlowNode[];
  edges: PortFlowEdge[];
  setNodes: React.Dispatch<React.SetStateAction<DeviceFlowNode[]>>;
  setEdges: React.Dispatch<React.SetStateAction<PortFlowEdge[]>>;
  onDropDevice: (deviceId: string, pos: { x: number; y: number }) => void;
  onSelectionChange: (p: OnSelectionChangeParams) => void;
  children: React.ReactNode;
}) {
  const { screenToFlowPosition } = useReactFlow();

  const onNodesChange = useCallback(
    (cs: NodeChange<DeviceFlowNode>[]) =>
      setNodes((ns) => applyNodeChanges(cs, ns)),
    [setNodes],
  );
  const onEdgesChange = useCallback(
    (cs: EdgeChange<PortFlowEdge>[]) =>
      setEdges((es) => applyEdgeChanges(cs, es)),
    [setEdges],
  );

  /** 连线约束：禁自环、同对设备（含反向）只允许一条。 */
  const isValidConnection = useCallback(
    (c: Connection | PortFlowEdge) => {
      if (!c.source || !c.target || c.source === c.target) return false;
      return !edges.some(
        (e) =>
          (e.source === c.source && e.target === c.target) ||
          (e.source === c.target && e.target === c.source),
      );
    },
    [edges],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!isValidConnection(c)) return;
      setEdges((es) => [
        ...es,
        {
          id: `link-${c.source}__${c.target}`,
          type: "port",
          source: c.source!,
          target: c.target!,
          // 用户拖出的连线自带锚点 id（四向 handle 均有 id，缺失时右向兜底）
          sourceHandle: c.sourceHandle ?? "right",
          targetHandle: c.targetHandle ?? "left",
          data: {},
        },
      ]);
    },
    [isValidConnection, setEdges],
  );

  /** 键盘删节点时级联清边（受控模式下保险，applyEdgeChanges 的移除幂等）。 */
  const onNodesDelete = useCallback(
    (deleted: DeviceFlowNode[]) => {
      const ids = new Set(deleted.map((n) => n.id));
      setEdges((es) => es.filter((e) => !ids.has(e.source) && !ids.has(e.target)));
    },
    [setEdges],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      const deviceId = e.dataTransfer.getData("application/topo-device");
      if (!deviceId) return;
      e.preventDefault();
      onDropDevice(deviceId, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
    },
    [onDropDevice, screenToFlowPosition],
  );

  return (
    <div className="topo-editor__canvas" onDrop={handleDrop} onDragOver={onDragOver}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={topoNodeTypes}
        edgeTypes={topoEdgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onSelectionChange={onSelectionChange}
        onNodesDelete={onNodesDelete}
        deleteKeyCode={["Backspace", "Delete"]}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={2.5}
        proOptions={{ hideAttribution: false }}
      >
        <Background color="var(--hairline)" gap={20} />
        <Controls showInteractive={false} />
        {nodes.length === 0 && (
          <Panel position="top-center">
            <div className="topo-canvas-hint">从左侧拖入设备，节点边缘拖出连线</div>
          </Panel>
        )}
        {children}
      </ReactFlow>
    </div>
  );
}

/** 属性面板键盘隔离：输入中的按键不冒泡到画布（防 Delete 误删元素）。 */
function stopKeys(e: React.KeyboardEvent) {
  e.stopPropagation();
}

function NodePropsPanel({
  node,
  onNote,
  onRemove,
}: {
  node: DeviceFlowNode;
  onNote: (v: string) => void;
  onRemove: () => void;
}) {
  return (
    <Panel position="top-right">
      <div className="topo-props" onKeyDown={stopKeys}>
        <div className="topo-props__title">{node.data.label}</div>
        {node.data.subtitle && <div className="topo-props__sub">{node.data.subtitle}</div>}
        <label className="topo-props__field">
          备注
          <input
            placeholder="如「被测主板」（可选）"
            value={node.data.note ?? ""}
            onChange={(e) => onNote(e.target.value)}
          />
        </label>
        <button className="btn btn--ghost topo-props__danger" onClick={onRemove}>
          移出拓扑
        </button>
      </div>
    </Panel>
  );
}

function EdgePropsPanel({
  edge,
  fromName,
  toName,
  onPatch,
  onRemove,
}: {
  edge: PortFlowEdge;
  fromName: string;
  toName: string;
  onPatch: (p: Partial<PortEdgeData>) => void;
  onRemove: () => void;
}) {
  const d = edge.data ?? {};
  return (
    <Panel position="top-right">
      <div className="topo-props" onKeyDown={stopKeys}>
        <div className="topo-props__title">
          {fromName} ↔ {toName}
        </div>
        <label className="topo-props__field">
          {fromName} 端口
          <input
            placeholder="如 GE1/1/1"
            value={d.from_port ?? ""}
            onChange={(e) => onPatch({ from_port: e.target.value })}
          />
        </label>
        <label className="topo-props__field">
          {toName} 端口
          <input
            placeholder="如 eth0"
            value={d.to_port ?? ""}
            onChange={(e) => onPatch({ to_port: e.target.value })}
          />
        </label>
        <label className="topo-props__field">
          说明
          <input
            placeholder="连线备注（可选）"
            value={d.label ?? ""}
            onChange={(e) => onPatch({ label: e.target.value })}
          />
        </label>
        <button className="btn btn--ghost topo-props__danger" onClick={onRemove}>
          删除连线
        </button>
      </div>
    </Panel>
  );
}
