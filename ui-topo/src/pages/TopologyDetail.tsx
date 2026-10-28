import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  api,
  leaseOfDevice,
  subscribeChanged,
  type Device,
  type LeaseView,
  type TopologyDetail,
} from "../api";
import TopologyGraph from "./TopologyGraph";

export default function TopologyDetail() {
  const { id } = useParams();
  const [detail, setDetail] = useState<TopologyDetail | null>(null);
  const [leases, setLeases] = useState<LeaseView[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState("");
  const [view, setView] = useState<"table" | "graph">("table");
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(() => {
    if (!id) return;
    api
      .topology(id)
      .then(setDetail)
      .catch((e) => setError(String(e.message ?? e)));
    api.leases().then(setLeases).catch(() => {});
    api.devices().then(setDevices).catch(() => {});
  }, [id]);

  useEffect(() => {
    refresh();
    return subscribeChanged(refresh);
  }, [refresh]);

  if (error) return <p className="error">{error}</p>;
  if (!detail) return <p className="muted">加载中…</p>;

  /** 图/连线显示用的设备名（详情快照优先，注册表兜底）。 */
  const nameOf = (deviceId: string) =>
    detail.member_views.find((m) => m.device === deviceId)?.name ??
    devices.find((d) => d.id === deviceId)?.name ??
    deviceId;
  /** 节点小字：通道摘要。 */
  const subtitleOf = (deviceId: string) => {
    const m = detail.member_views.find((x) => x.device === deviceId);
    return m && m.channels.length > 0
      ? m.channels.map((c) => c.label).join(" · ")
      : undefined;
  };

  const copyId = () => {
    navigator.clipboard?.writeText(detail.id).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };

  return (
    <section className="page page--wide">
      <div className="page-head">
        <h1>{detail.name}</h1>
        <div className="row-actions">
          <button
            className={`btn ${view === "table" ? "btn--primary" : "btn--ghost"}`}
            onClick={() => setView("table")}
          >
            列表
          </button>
          <button
            className={`btn ${view === "graph" ? "btn--primary" : "btn--ghost"}`}
            onClick={() => setView("graph")}
          >
            图
          </button>
          <Link className="btn btn--ghost" to={`/topologies/${detail.id}/edit`}>
            编辑
          </Link>
        </div>
      </div>
      {detail.description && <p className="muted">{detail.description}</p>}
      <p className="meta-line">
        AI 引用名 <span className="mono">{detail.name}</span>
        {" · "}更新于 {detail.updated_at}
        {" · "}
        <button className="copy-id mono" onClick={copyId} title="点击复制完整 id">
          {copied ? "已复制 id" : `id ${detail.id.slice(0, 8)}…`}
        </button>
      </p>
      {view === "graph" ? (
        <TopologyGraph topo={detail} nameOf={nameOf} subtitleOf={subtitleOf} leases={leases} />
      ) : (
        <div className="table-wrap">
          <table>
          <thead>
            <tr>
              <th>设备</th>
              <th>通道</th>
              <th>状态</th>
              <th>占用</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            {detail.member_views.map((m) => {
              const lease = leaseOfDevice(m.device, leases);
              return (
                <tr key={m.device}>
                  <td>
                    {m.name}
                    {(m.model || m.location) && (
                      <span className="muted"> · {[m.model, m.location].filter(Boolean).join(" · ")}</span>
                    )}
                  </td>
                  <td>
                    {m.channels.length === 0 ? (
                      "—"
                    ) : (
                      <span className="chan-list">
                        {m.channels.map((c, i) => (
                          <span key={i} className="chan-item">
                            <span className={`dev-badge ${c.type === "serial" ? "dev-badge--serial" : "dev-badge--ssh"}`}>
                              {c.type === "serial" ? "串口" : "SSH"}
                            </span>
                            {c.type === "serial" ? c.label.replace(/^串口\s*/, "") : c.label}
                            {c.present ? "" : "（不在位）"}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td>
                    {m.channels.length === 0 ? (
                      "—"
                    ) : m.channels.some((c) => c.opened) ? (
                      <span className="dev-badge dev-badge--ok">使用中</span>
                    ) : (
                      <span className="dev-badge">空闲</span>
                    )}
                  </td>
                  <td>
                    {lease ? (
                      <span className="dev-badge dev-badge--warn" title={`至 ${lease.expires_at}`}>
                        {lease.label} · 剩 {lease.remaining_minutes} 分
                      </span>
                    ) : (
                      <span className="dev-badge">空闲</span>
                    )}
                  </td>
                  <td>{m.note ?? ""}</td>
                </tr>
              );
            })}
          </tbody>
          </table>
        </div>
      )}
      {view === "table" && detail.links.length > 0 && (
        <p className="meta-line">
          连线：
          {detail.links
            .map((l) => `${nameOf(l.from)} ↔ ${nameOf(l.to)}${l.label ? `（${l.label}）` : ""}`)
            .join("；")}
        </p>
      )}
    </section>
  );
}
