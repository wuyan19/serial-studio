import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, subscribeChanged, type Topology } from "../api";

export default function Topologies() {
  const [list, setList] = useState<Topology[]>([]);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    api
      .topologies()
      .then(setList)
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(() => {
    refresh();
    return subscribeChanged(refresh);
  }, [refresh]);

  const remove = async (t: Topology) => {
    if (!confirm(`删除拓扑「${t.name}」？仅删定义，不动设备。`)) return;
    try {
      await api.deleteTopology(t.id);
      refresh();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  return (
    <section>
      <div className="page-head">
        <h1>拓扑</h1>
        <Link className="btn" to="/topologies/new">
          新建
        </Link>
      </div>
      {error && <p className="error">{error}</p>}
      {list.length === 0 ? (
        <p className="muted">暂无拓扑。点「新建」创建，或让 AI 经 MCP 的 topo_create 创建。</p>
      ) : (
        <ul className="topo-list">
          {list.map((t) => (
            <li key={t.id} className="topo-card">
              <div className="topo-main">
                <Link to={`/topologies/${t.id}`} className="topo-name">
                  {t.name}
                </Link>
                <span className="muted">成员 {t.members.length}</span>
              </div>
              {t.description && <p className="topo-desc">{t.description}</p>}
              <div className="topo-actions">
                <Link to={`/topologies/${t.id}/edit`}>编辑</Link>
                <button className="link" onClick={() => remove(t)}>
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
