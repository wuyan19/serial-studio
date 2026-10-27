/** 设备管理：被测设备卡（通道清单/在线态/占用徽章/每通道开终端/编辑/删除）。
 *  页底折叠「未注册资源」——未归属设备的端口与凭据（资源选择器视角，注册设备时
 *  的候选来源）。占用 = 设备级（leases.grants.device join）。 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  channelPortKey,
  leaseOfDevice,
  subscribeChanged,
  type Device,
  type LeaseView,
  type PortView,
} from "../api";
import { ws } from "../ws";
import { useShell } from "../App";
import { DeviceEditDialog } from "../components/device-edit";
import { ConfirmDialog, DeviceDetailDialog } from "../components/dialogs";
import type { DeviceDetailInfo } from "../components/dialogs";

export default function Devices() {
  const navigate = useNavigate();
  const { sshHosts } = useShell();
  const [devices, setDevices] = useState<Device[]>([]);
  const [leases, setLeases] = useState<LeaseView[]>([]);
  const [ports, setPorts] = useState<PortView[]>([]);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Device | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Device | null>(null);
  const [detail, setDetail] = useState<Device | null>(null);
  const [showResources, setShowResources] = useState(false);

  const refresh = useCallback(() => {
    api
      .devices()
      .then(setDevices)
      .catch((e) => setError(String(e.message ?? e)));
    api.leases().then(setLeases).catch(() => {});
    api.ports().then(setPorts).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const offPorts = ws.on("ports", setPorts);
    return () => {
      offPorts();
    };
  }, [refresh]);
  useEffect(() => subscribeChanged(refresh), [refresh]);

  /** 资源占用表（排除某设备自身后即其它设备已占）。 */
  const ownedSerial = useMemo(() => {
    const s = new Set<string>();
    for (const d of devices)
      for (const c of d.channels)
        if (c.type === "serial" && c.port) s.add(c.port.toLowerCase());
    return s;
  }, [devices]);
  const ownedSsh = useMemo(() => {
    const s = new Set<string>();
    for (const d of devices)
      for (const c of d.channels) if (c.type === "ssh" && c.ref) s.add(c.ref);
    return s;
  }, [devices]);

  const portNames = useMemo(() => ports.map((p) => p.name), [ports]);

  /** SSH 凭据显示名：昵称回退 user@host。 */
  const sshLabel = (id?: string) => {
    const h = sshHosts.find((x) => x.id === id);
    return h ? h.nickname || `${h.username}@${h.host}` : id ?? "?";
  };

  /** 未注册资源：未归属任何设备的端口行 + 未挂设备的 SSH 凭据。 */
  const unregisteredPorts = useMemo(
    () => ports.filter((p) => !ownedSerial.has(p.name.toLowerCase())),
    [ports, ownedSerial],
  );
  const orphanSsh = useMemo(
    () => sshHosts.filter((h) => !ownedSsh.has(h.id)),
    [sshHosts, ownedSsh],
  );

  const save = (input: {
    name: string;
    model: string;
    location: string;
    channels: Device["channels"];
  }) => {
    const target = editing;
    setEditing(null);
    setCreating(false);
    (target ? api.updateDevice(target.id, input) : api.createDevice(input)).catch((e) =>
      setError(String((e as Error).message ?? e)),
    );
  };

  const channelState = (d: Device, i: number) => {
    const c = d.channels[i];
    if (c.type === "serial") {
      const row = ports.find((p) => p.name === c.port);
      return { present: !!row, opened: row?.opened, holders: row?.holders };
    }
    const rows = ports.filter((p) => p.name.split("::")[0] === c.ref);
    return { present: rows.length > 0, opened: rows[0]?.opened, holders: rows[0]?.holders };
  };

  const detailInfo = (d: Device): DeviceDetailInfo => {
    const lease = leaseOfDevice(d.id, leases);
    return {
      icon: "plug",
      label: d.name,
      rows: [
        { label: "ID", value: d.id, copy: true },
        ...(d.model ? [{ label: "型号", value: d.model }] : []),
        ...(d.location ? [{ label: "位置", value: d.location }] : []),
        { label: "通道", value: String(d.channels.length) },
      ],
      statusNode: lease ? (
        <span>
          占用中 · {lease.label}（剩余 {lease.remaining_minutes} 分钟）
        </span>
      ) : (
        <span className="muted">空闲</span>
      ),
      ports: [],
      portsText:
        d.channels
          .map((c) => (c.type === "serial" ? `串口 ${c.port}` : `SSH ${sshLabel(c.ref)}`))
          .join(" · ") || "无通道",
      hint: "占用为设备级（全部通道独占）；终端从通道行打开。",
    };
  };

  return (
    <section className="page">
      <div className="page-head">
        <h1>设备</h1>
        <button className="btn btn--primary" onClick={() => setCreating(true)}>
          注册设备
        </button>
      </div>
      <p className="muted">
        设备 = 被调试的一台机器（如一台交换机）；通道 = 串口控制台 + 多条 SSH 登录。
      </p>
      {error && <p className="error whitespace">{error}</p>}

      {devices.length === 0 ? (
        <p className="muted">暂无被测设备。点「注册设备」，或让 AI 经 MCP 的 device_create 注册。</p>
      ) : (
        devices.map((d) => {
          const lease = leaseOfDevice(d.id, leases);
          return (
            <div key={d.id} className="device-card" onContextMenu={() => setDetail(d)}>
              <div className="device-head">
                <strong>{d.name}</strong>
                {lease && (
                  <span className="badge warn">
                    占用 · {lease.label} · {lease.remaining_minutes} 分钟
                  </span>
                )}
                <span className="muted">
                  {[d.model, d.location].filter(Boolean).join(" · ")}
                </span>
                <span style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
                  <button className="link" onClick={() => setDetail(d)}>
                    详情
                  </button>
                  <button className="link" onClick={() => setEditing(d)}>
                    编辑
                  </button>
                  <button className="link" style={{ color: "var(--danger)" }} onClick={() => setDeleting(d)}>
                    删除
                  </button>
                </span>
              </div>
              <ul>
                {d.channels.map((c, i) => {
                  const st = channelState(d, i);
                  const label =
                    c.type === "serial"
                      ? `串口 ${c.port}`
                      : `SSH ${sshLabel(c.ref)}`;
                  return (
                    <li key={i} className="port-row">
                      <span className="group-badge">{c.type === "serial" ? "串口" : "SSH"}</span>
                      <span className="mono">{label}</span>
                      {!st.present && <span className="muted">不在位</span>}
                      {st.opened && <span className="badge">{st.holders} 人</span>}
                      <button
                        className="link"
                        style={{ marginLeft: "auto" }}
                        onClick={() =>
                          navigate(`/terminal?open=${encodeURIComponent(channelPortKey(c))}`)
                        }
                      >
                        终端
                      </button>
                    </li>
                  );
                })}
                {d.channels.length === 0 && <li className="muted">无通道（编辑添加）</li>}
              </ul>
            </div>
          );
        })
      )}

      <div style={{ marginTop: 20 }}>
        <button className="btn btn--ghost" onClick={() => setShowResources(!showResources)}>
          {showResources ? "收起" : "展开"}未注册资源（{unregisteredPorts.length} 端口 · {orphanSsh.length} 凭据）
        </button>
        {showResources && (
          <div className="device-card" style={{ marginTop: 10 }}>
            <div className="device-head">
              <strong>未注册资源</strong>
              <span className="muted">注册设备时可将其选为通道</span>
            </div>
            <ul>
              {unregisteredPorts.map((p) => (
                <li key={p.name} className="port-row">
                  <span className="group-badge">端口</span>
                  <span className="mono">{p.name}</span>
                  <span className="muted">{p.device?.label ?? p.kind}</span>
                </li>
              ))}
              {orphanSsh.map((h) => (
                <li key={h.id} className="port-row">
                  <span className="group-badge">SSH</span>
                  <span>{h.nickname || `${h.username}@${h.host}`}</span>
                </li>
              ))}
              {unregisteredPorts.length === 0 && orphanSsh.length === 0 && (
                <li className="muted">全部资源已归属设备。</li>
              )}
            </ul>
          </div>
        )}
      </div>

      {(creating || editing) && (
        <DeviceEditDialog
          initial={editing}
          ports={portNames}
          sshHosts={sshHosts.map((h) => ({
            id: h.id,
            label: h.nickname || `${h.username}@${h.host}`,
          }))}
          ownedSerialPorts={ownedSerial}
          ownedSshRefs={ownedSsh}
          onConfirm={save}
          onCancel={() => {
            setEditing(null);
            setCreating(false);
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="删除设备"
          tone="danger"
          confirmText="删除"
          message={`删除「${deleting.name}」？被拓扑引用时会被拒绝。`}
          onConfirm={() => {
            api
              .deleteDevice(deleting.id)
              .then(refresh)
              .catch((e) => setError(String((e as Error).message ?? e)))
              .finally(() => setDeleting(null));
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
      {detail && (
        <DeviceDetailDialog info={detailInfo(detail)} onClose={() => setDetail(null)} />
      )}
    </section>
  );
}
