import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, subscribeChanged, type TopologyDetail } from "../api";

export default function TopologyDetail() {
  const { id } = useParams();
  const [detail, setDetail] = useState<TopologyDetail | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    if (!id) return;
    api
      .topology(id)
      .then(setDetail)
      .catch((e) => setError(String(e.message ?? e)));
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
          <Link className="btn" to={`/topologies/${detail.id}/edit`}>
            编辑
          </Link>
          <span className="muted">id {detail.id}</span>
        </div>
      </div>
      {detail.description && <p className="muted">{detail.description}</p>}
      <table>
        <thead>
          <tr>
            <th>类别</th>
            <th>引用</th>
            <th>设备</th>
            <th>状态</th>
            <th>备注</th>
          </tr>
        </thead>
        <tbody>
          {detail.member_views.map((m) => (
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
              <td>{m.note ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        更新于 {detail.updated_at} · AI 引用名 <span className="mono">{detail.name}</span>
      </p>
    </section>
  );
}
