import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, leaseOfDevice, subscribeChanged, type Device, type LeaseView, type Topology } from "../api";
import { ConfirmDialog } from "../components/dialogs";

export default function Topologies() {
  const [list, setList] = useState<Topology[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [leases, setLeases] = useState<LeaseView[]>([]);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<Topology | null>(null);

  const refresh = useCallback(() => {
    api
      .topologies()
      .then(setList)
      .catch((e) => setError(String(e.message ?? e)));
    api.devices().then(setDevices).catch(() => {});
    api.leases().then(setLeases).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    return subscribeChanged(refresh);
  }, [refresh]);

  const remove = (t: Topology) => {
    api
      .deleteTopology(t.id)
      .then(refresh)
      .catch((e) => setError(String((e as Error).message ?? e)))
      .finally(() => setDeleting(null));
  };

  /** 任一成员设备被租约覆盖 → 占用徽章（首个命中）。 */
  const badge = (t: Topology) => {
    const hit = t.members.map((m) => leaseOfDevice(m.device, leases)).find(Boolean);
    return hit ? (
      <span className="dev-badge dev-badge--warn" title={`至 ${hit.label} 剩余 ${hit.remaining_minutes} 分钟`}>
        占用中
      </span>
    ) : (
      <span className="dev-badge">空闲</span>
    );
  };

  /** 成员设备名（id 经注册表翻译；截前 3 个）。 */
  const devName = (id: string) => devices.find((d) => d.id === id)?.name ?? id;
  const memberNames = (t: Topology) => {
    const names = t.members.map((m) => devName(m.device));
    if (names.length <= 3) return names.join(" · ");
    return `${names.slice(0, 3).join(" · ")} 等 ${names.length} 台`;
  };

  return (
    <section>
      <div className="page-head">
        <h1>拓扑</h1>
        <Link className="btn btn--primary" to="/topologies/new">
          新建拓扑
        </Link>
      </div>
      {error && <p className="error whitespace">{error}</p>}
      {list.length === 0 ? (
        <p className="muted">暂无拓扑。点「新建拓扑」创建，或让 AI 经 MCP 的 topo_create 创建。</p>
      ) : (
        <ul className="topo-list">
          {list.map((t) => (
            <li key={t.id} className="topo-card">
              <div className="topo-main">
                <Link to={`/topologies/${t.id}`} className="topo-name">
                  {t.name}
                </Link>
                {badge(t)}
                <div className="topo-actions">
                  <Link to={`/topologies/${t.id}/edit`} className="topo-act" title="编辑">
                    ✎
                  </Link>
                  <button className="topo-act topo-act--danger" title="删除" onClick={() => setDeleting(t)}>
                    ✕
                  </button>
                </div>
              </div>
              {t.description && <p className="topo-desc">{t.description}</p>}
              {t.members.length > 0 && (
                <p className="topo-members mono" title={t.members.map((m) => devName(m.device)).join(" · ")}>
                  {memberNames(t)}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {deleting && (
        <ConfirmDialog
          title="删除拓扑"
          tone="danger"
          confirmText="删除"
          message={`删除拓扑「${deleting.name}」？仅删定义，不动设备。`}
          onConfirm={() => remove(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </section>
  );
}
