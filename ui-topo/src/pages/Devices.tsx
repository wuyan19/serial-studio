/** 设备库：本机/SSH/远端统一清单（WS 实时端口表），右键详情、内联别名、双击进终端。
 * 交互抄 serial-studio 侧栏设备卡（在线状态点/别名铅笔/详情弹窗），列表形态更适合管理台。 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type PortView } from "../api";
import { subscribeChanged } from "../api";
import { ws } from "../ws";
import { InlineAliasInput, PortLabel } from "../primitives";
import {
  DeviceDetailDialog,
  PortDetailDialog,
  type DeviceDetailInfo,
  type PortDetailInfo,
} from "../components/dialogs";

interface DeviceGroup {
  id: string;
  label: string;
  detail?: string;
  via: string;
  online?: boolean;
  ports: PortView[];
}

function groupByDevice(ports: PortView[]): DeviceGroup[] {
  const map = new Map<string, DeviceGroup>();
  const local: DeviceGroup = { id: "local", label: "本机", via: "local", ports: [] };
  for (const p of ports) {
    const dev = p.device;
    if (!dev || dev.id === "local") {
      local.ports.push(p);
      continue;
    }
    const g =
      map.get(dev.id) ??
      { id: dev.id, label: dev.label, detail: dev.detail, via: dev.via, online: dev.online, ports: [] };
    g.ports.push(p);
    map.set(dev.id, g);
  }
  return [local, ...map.values()];
}

export default function Devices() {
  const navigate = useNavigate();
  const [ports, setPorts] = useState<PortView[]>([]);
  const [error, setError] = useState("");
  const [editingAlias, setEditingAlias] = useState<string | null>(null);
  const [deviceDetail, setDeviceDetail] = useState<DeviceGroup | null>(null);
  const [portDetail, setPortDetail] = useState<PortView | null>(null);

  const refresh = useCallback(() => {
    api
      .ports()
      .then(setPorts)
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(() => {
    // WS 实时端口表（服务端在连接/变更时推送）为主，REST 兜底
    const offPorts = ws.on("ports", (list) => setPorts(list));
    const offMeta = ws.on("metaChanged", () => ws.sshList());
    refresh();
    return () => {
      offPorts();
      offMeta();
    };
  }, [refresh]);

  // 占用/租约变化不涉及端口表；SSE 订阅保留给未来徽章
  useEffect(() => subscribeChanged(refresh), [refresh]);

  const groups = useMemo(() => groupByDevice(ports), [ports]);

  const deviceDetailInfo = (g: DeviceGroup): DeviceDetailInfo => ({
    icon: g.via === "ssh" ? "ssh" : g.via === "remote" ? "globe" : "plug",
    label: g.label,
    online: g.via === "remote" ? g.online : undefined,
    statusNode:
      g.via === "ssh" ? (
        <span className="muted">按需连接</span>
      ) : g.via === "local" ? (
        <span className="muted">本机</span>
      ) : undefined,
    rows: [
      { label: "ID", value: g.id, copy: true },
      ...(g.detail ? [{ label: "地址", value: g.detail, copy: true }] : []),
      ...(g.via !== "local" ? [{ label: "接入", value: g.via === "ssh" ? "SSH" : "远程级联" }] : []),
    ],
    ports: g.ports,
    hint: g.via === "remote" ? "端口随远端 Serial Studio 上报，离线时不可用。" : undefined,
  });

  const portDetailInfo = (p: PortView): PortDetailInfo => ({
    icon: p.kind === "ssh" ? "ssh" : "plug",
    label: p.alias ? `${p.alias}（${p.name}）` : p.name,
    rows: [
      { label: "端口键", value: p.name, copy: true },
      ...(p.device ? [{ label: "属主设备", value: `${p.device.label} (${p.device.id})` }] : []),
      ...(p.kind ? [{ label: "类别", value: p.kind }] : []),
      { label: "状态", value: p.opened ? `已开 · ${p.holders} 人持有` : "未开" },
    ],
    hint: "端口键可直接用于拓扑成员与 MCP 工具寻址。",
  });

  return (
    <section className="page">
      <div className="page-head">
        <h1>设备库</h1>
        <span className="muted">{ports.length} 个端口 · {groups.length} 台设备</span>
      </div>
      <p className="muted">本机串口、SSH、远程设备的统一清单；双击端口进终端，右键看详情。</p>
      {error && <p className="error">{error}</p>}
      {groups.map((g) => (
        <div
          key={g.id}
          className="device-card"
          onContextMenu={(e) => {
            e.preventDefault();
            setDeviceDetail(g);
          }}
        >
          <div className="device-head">
            <strong>{g.label}</strong>
            {g.via === "remote" && (
              <span className={`dot ${g.online ? "on" : "off"}`} title={g.online ? "在线" : "离线"} />
            )}
            {g.via === "ssh" && <span className="group-badge">SSH</span>}
            <span className="muted">
              {g.detail ? `${g.detail} · ` : ""}
              <span className="mono">{g.id}</span>
            </span>
          </div>
          <ul>
            {g.ports.map((p) => (
              <li
                key={p.name}
                className="port-row"
                onDoubleClick={() => navigate(`/terminal?open=${encodeURIComponent(p.name)}`)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setPortDetail(p);
                }}
                title="双击打开终端 · 右键详情"
              >
                {editingAlias === p.name ? (
                  <InlineAliasInput
                    initial={p.alias ?? ""}
                    placeholder="别名"
                    onCommit={(alias) => {
                      ws.setAlias(p.name, alias || null);
                      setEditingAlias(null);
                    }}
                    onCancel={() => setEditingAlias(null)}
                  />
                ) : (
                  <>
                    <PortLabel name={p.name} alias={p.alias} />
                    {p.instance != null && <span className="group-badge">实例 {p.instance}</span>}
                    {p.opened ? (
                      <span className="badge" title="当前持有者数">
                        {p.holders} 人
                      </span>
                    ) : p.disconnected ? (
                      <span className="muted">已断开</span>
                    ) : null}
                    <button
                      className="link mini-btn"
                      title="编辑别名"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingAlias(p.name);
                      }}
                    >
                      ✎
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {deviceDetail && (
        <DeviceDetailDialog
          info={deviceDetailInfo(deviceDetail)}
          onClose={() => setDeviceDetail(null)}
        />
      )}
      {portDetail && (
        <PortDetailDialog info={portDetailInfo(portDetail)} onClose={() => setPortDetail(null)} />
      )}
    </section>
  );
}
