import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  api,
  leaseOfMember,
  subscribeChanged,
  type LeaseView,
  type TopologyDetail,
} from "../api";
import TopologyGraph from "./TopologyGraph";

export default function TopologyDetail() {
  const { id } = useParams();
  const [detail, setDetail] = useState<TopologyDetail | null>(null);
  const [leases, setLeases] = useState<LeaseView[]>([]);
  const [error, setError] = useState("");
  const [view, setView] = useState<"table" | "graph">("table");

  const refresh = useCallback(() => {
    if (!id) return;
    api
      .topology(id)
      .then(setDetail)
      .catch((e) => setError(String(e.message ?? e)));
    api.leases().then(setLeases).catch(() => {});
  }, [id]);

  useEffect(() => {
    refresh();
    return subscribeChanged(refresh);
  }, [refresh]);

  if (error) return <p className="error">{error}</p>;
  if (!detail) return <p className="muted">加载中…</p>;

  return (
    <section>
      <div className="page-head">
        <h1>{detail.name}</h1>
        <div className="row-actions">
          <button
            className={`btn ${view === "table" ? "" : "secondary"}`}
            onClick={() => setView("table")}
          >
            列表
          </button>
          <button
            className={`btn ${view === "graph" ? "" : "secondary"}`}
            onClick={() => setView("graph")}
          >
            图
          </button>
          <Link className="btn secondary" to={`/topologies/${detail.id}/edit`}>
            编辑
          </Link>
          <span className="muted">id {detail.id}</span>
        </div>
      </div>
      {detail.description && <p className="muted">{detail.description}</p>}
      {view === "graph" ? (
        <TopologyGraph topo={detail} memberViews={detail.member_views} leases={leases} />
      ) : (
        <table>
        <thead>
          <tr>
            <th>类别</th>
            <th>引用</th>
            <th>设备</th>
            <th>状态</th>
            <th>占用</th>
            <th>备注</th>
          </tr>
        </thead>
        <tbody>
          {detail.member_views.map((m) => {
            const lease = leaseOfMember(m, leases);
            return (
              <tr key={`${m.kind}-${m.key}`}>
                <td>{m.kind === "device" ? "设备" : "端点"}</td>
                <td className="mono">{m.key}</td>
                <td>
                  {m.label}
                  {m.detail && <span className="muted"> · {m.detail}</span>}
                </td>
                <td>
                  {m.online === undefined ? "—" : m.online ? "在线" : "离线"}
                </td>
                <td>
                  {lease
                    ? `${lease.label} · ${lease.remaining_minutes} 分钟`
                    : "空闲"}
                </td>
                <td>{m.note ?? ""}</td>
              </tr>
            );
          })}
        </tbody>
        </table>
      )}
      <p className="muted">
        更新于 {detail.updated_at} · AI 引用名 <span className="mono">{detail.name}</span>
      </p>
    </section>
  );
}
