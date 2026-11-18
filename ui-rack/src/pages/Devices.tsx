/** 设备管理：被测设备卡（通道清单/在线态/占用徽章/每通道开终端/编辑/删除）。
 *  「打开」按钮直达右侧终端面板（不跳页）；裸端口入口在面板的「打开端口」。
 *  占用 = 设备级（leases.grants.device join）。 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  channelLabel,
  channelPortKey,
  channelStatus,
  fmtTime,
  leaseOfDevice,
  sshChannelLabel,
  subscribeChanged,
  type Device,
  type LeaseView,
  type Topology,
} from "../api";
import { useLivePorts } from "../use-ports";
import { useShell } from "../App";
import { DeviceEditDialog } from "../components/device-edit";
import { ConfirmDialog, DeviceDetailDialog } from "../components/dialogs";
import type { DeviceDetailInfo } from "../components/dialogs";

export default function Devices() {
  const { openTerminal } = useShell();
  const [devices, setDevices] = useState<Device[]>([]);
  const [leases, setLeases] = useState<LeaseView[]>([]);
  const [topos, setTopos] = useState<Topology[]>([]);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Device | null>(null);
  const [creating, setCreating] = useState(false);
  const ports = useLivePorts();
  const [deleting, setDeleting] = useState<Device | null>(null);
  const [detail, setDetail] = useState<Device | null>(null);

  const refresh = useCallback(() => {
    api
      .devices()
      .then(setDevices)
      .catch((e) => setError(String(e.message ?? e)));
    api.leases().then(setLeases).catch(() => {});
    api.topologies().then(setTopos).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    return subscribeChanged(refresh);
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
  const portNames = useMemo(
    () => [
      ...new Set([
        // 候选=未归属其它设备的端口（ownedSerial 含本设备现役会被排除，
        // 但本设备现役端口在编辑对话框里作为"不在位"选项保留）
        ...ports.map((p) => p.name).filter((n) => !ownedSerial.has(n.toLowerCase())),
      ]),
    ],
    [ports, ownedSerial],
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

  /** 设备所属拓扑（可多属——引用不独占，卡片与详情均展示）。 */
  const toposOf = useCallback(
    (deviceId: string) => topos.filter((t) => t.members.some((m) => m.device === deviceId)),
    [topos],
  );

  const channelState = (c: Device["channels"][number]) => channelStatus(c, ports);

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
        {
          label: "所属拓扑",
          value: toposOf(d.id).map((t) => t.name).join("、") || "—",
        },
      ],
      statusNode: lease ? (
        <span>
          占用中 · {lease.label}（剩余 {lease.remaining_minutes} 分钟）
        </span>
      ) : (
        <span className="muted">空闲</span>
      ),
      ports: [],
      portsText: d.channels.map((c) => channelLabel(c)).join(" · ") || "无通道",
      hint: "占用为设备级（全部通道独占）；通道行「打开」进终端。",
    };
  };

  return (
    <section className="page page--wide">
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
                {toposOf(d.id).length > 0 && (
                  <div className="dev-card__topos" title="所属拓扑（点击进入）">
                    {toposOf(d.id).map((t) => (
                      <Link key={t.id} to={`/#topo-${t.id}`} className="dev-topo-chip">
                        {t.name}
                      </Link>
                    ))}
                  </div>
                )}
                <ul className="dev-card__channels">
                  {d.channels.map((c, i) => {
                    const st = channelState(c);
                    const key = channelPortKey(c);
                    const label = c.type === "serial" ? (c.port ?? "") : sshChannelLabel(c);
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
                          onClick={() => openTerminal(key)}
                        >
                          打开
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
