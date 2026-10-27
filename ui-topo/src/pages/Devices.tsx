/** 设备管理：被测设备卡（通道清单/在线态/占用徽章/每通道开终端/编辑/删除）。
 *  临时端口的直达入口在终端页的「任意端口键」输入，不再在本页维护未注册资源清单。
 *  占用 = 设备级（leases.grants.device join）。 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  channelPortKey,
  fmtTime,
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
        <div className="dev-grid">
          {devices.map((d) => {
            const lease = leaseOfDevice(d.id, leases);
            return (
              <div key={d.id} className="dev-card" onContextMenu={() => setDetail(d)}>
                <div className="dev-card__head">
                  <span className="dev-card__name" title={d.name}>
                    {d.name}
                  </span>
                  {lease ? (
                    <span className="dev-badge dev-badge--warn" title={`至 ${fmtTime(lease.expires_at)}`}>
                      占用 · {lease.label} · {lease.remaining_minutes} 分
                    </span>
                  ) : (
                    <span className="dev-badge">空闲</span>
                  )}
                </div>
                {(d.model || d.location) && (
                  <div className="dev-card__sub" title={[d.model, d.location].filter(Boolean).join(" · ")}>
                    {[d.model, d.location].filter(Boolean).join(" · ")}
                  </div>
                )}
                <ul className="dev-card__channels">
                  {d.channels.map((c, i) => {
                    const st = channelState(d, i);
                    const key = channelPortKey(c);
                    const label =
                      c.type === "serial" ? (c.port ?? "") : sshLabel(c.ref);
                    return (
                      <li key={i} className="dev-channel" title={key}>
                        <span className={`dev-badge ${c.type === "serial" ? "dev-badge--serial" : "dev-badge--ssh"}`}>
                          {c.type === "serial" ? "串口" : "SSH"}
                        </span>
                        <span className="dev-channel__key mono">{label}</span>
                        {st.present ? (
                          st.opened ? (
                            <span className="dev-channel__st">使用中 · {st.holders} 人</span>
                          ) : null
                        ) : (
                          <span className="dev-channel__st">不在位</span>
                        )}
                        <button
                          className="dev-channel__term"
                          onClick={() => navigate(`/terminal?open=${encodeURIComponent(key)}`)}
                        >
                          终端
                        </button>
                      </li>
                    );
                  })}
                  {d.channels.length === 0 && (
                    <li className="dev-channel__empty">无通道（编辑添加）</li>
                  )}
                </ul>
                <div className="dev-card__foot">
                  <span className="dev-card__id mono" title={d.id}>
                    {d.id.slice(0, 8)}…
                  </span>
                  <div className="dev-card__actions">
                    <button className="dev-icon-btn" title="详情" onClick={() => setDetail(d)}>
                      ⓘ
                    </button>
                    <button className="dev-icon-btn" title="编辑" onClick={() => setEditing(d)}>
                      ✎
                    </button>
                    <button
                      className="dev-icon-btn dev-icon-btn--danger"
                      title="删除"
                      onClick={() => setDeleting(d)}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

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
