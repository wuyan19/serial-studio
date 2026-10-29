/** 拓扑总览（唯一入口，详情页已撤）：大卡片承载全部信息——图、成员设备
 * （通道/在位/占用）、连线（端口标签）、元信息。设备页的拓扑 chip 经
 * /#topo-<id> 锚点跳入并高亮对应卡片。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  api,
  channelLabel,
  channelStatus,
  fmtTime,
  leaseOfDevice,
  subscribeChanged,
  type Device,
  type LeaseView,
  type PortView,
  type Topology,
} from "../api";
import { ConfirmDialog } from "../components/dialogs";
import TopologyGraph from "./TopologyGraph";

export default function Topologies() {
  const [list, setList] = useState<Topology[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [leases, setLeases] = useState<LeaseView[]>([]);
  const [ports, setPorts] = useState<PortView[]>([]);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<Topology | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const location = useLocation();

  const refresh = useCallback(() => {
    api
      .topologies()
      .then(setList)
      .catch((e) => setError(String(e.message ?? e)));
    api.devices().then(setDevices).catch(() => {});
    api.leases().then(setLeases).catch(() => {});
    api.ports().then(setPorts).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    return subscribeChanged(refresh);
  }, [refresh]);

  /** 锚点聚焦（设备页拓扑 chip / 编辑保存后跳入）：滚动到卡并短暂高亮。
   * 已消费的 hash 记账跳过——否则 SSE 每次刷新（list 新引用）都会把用户
   * 拽回锚点卡；数据未到时不记账，靠 list 依赖在数据到达后补跑。 */
  const focusedHash = useRef<string | null>(null);
  useEffect(() => {
    if (!location.hash.startsWith("#topo-")) return;
    if (focusedHash.current === location.hash) return;
    const el = document.getElementById(location.hash.slice(1));
    if (!el) return;
    focusedHash.current = location.hash;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("topo-big-card--flash");
    const timer = setTimeout(() => el.classList.remove("topo-big-card--flash"), 1600);
    return () => {
      clearTimeout(timer);
      el.classList.remove("topo-big-card--flash");
    };
  }, [location.hash, list]);

  const devOf = useMemo(() => new Map(devices.map((d) => [d.id, d])), [devices]);

  const remove = (t: Topology) => {
    api
      .deleteTopology(t.id)
      .then(refresh)
      .catch((e) => setError(String((e as Error).message ?? e)))
      .finally(() => setDeleting(null));
  };

  const copyId = (t: Topology) => {
    navigator.clipboard?.writeText(t.id).then(
      () => {
        setCopied(t.id);
        setTimeout(() => setCopied(null), 1200);
      },
      () => {},
    );
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

  const nameOf = useCallback(
    (id: string) => devOf.get(id)?.name ?? id,
    [devOf],
  );
  const subtitleOf = useCallback(
    (id: string) => {
      const d = devOf.get(id);
      if (!d || d.channels.length === 0) return undefined;
      return d.channels.map((c) => channelLabel(c)).join(" · ");
    },
    [devOf],
  );

  return (
    <section className="page page--wide">
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
        <div className="topo-big-grid">
          {list.map((t) => (
            <article className="topo-big-card" id={`topo-${t.id}`} key={t.id}>
              <div className="topo-big-card__head">
                <span className="topo-big-card__name" title={t.name}>
                  {t.name}
                </span>
                {badge(t)}
                <div className="topo-big-card__actions">
                  <Link to={`/topologies/${t.id}/edit`} className="topo-act" title="编辑">
                    ✎
                  </Link>
                  <button className="topo-act topo-act--danger" title="删除" onClick={() => setDeleting(t)}>
                    ✕
                  </button>
                </div>
              </div>
              {t.description && <p className="topo-big-card__desc">{t.description}</p>}
              <TopologyGraph topo={t} nameOf={nameOf} subtitleOf={subtitleOf} leases={leases} card />
              <ul className="topo-big-card__members">
                {t.members.map((m) => {
                  const d = devOf.get(m.device);
                  const lease = leaseOfDevice(m.device, leases);
                  return (
                    <li key={m.device} className="topo-member" title={m.note ?? undefined}>
                      <span className="topo-member__name">
                        {nameOf(m.device)}
                        {d && (d.model || d.location) && (
                          <span className="muted">
                            {" "}
                            · {[d.model, d.location].filter(Boolean).join(" · ")}
                          </span>
                        )}
                      </span>
                      <span className="chan-list">
                        {d?.channels.map((c, i) => {
                          const st = channelStatus(c, ports);
                          return (
                            <span key={i} className="chan-item">
                              <span className={`dev-badge ${c.type === "serial" ? "dev-badge--serial" : "dev-badge--ssh"}`}>
                                {channelLabel(c)}
                              </span>
                              {!st.present ? "（不在位）" : st.opened ? `使用中${st.holders ? ` · ${st.holders} 人` : ""}` : ""}
                            </span>
                          );
                        })}
                        {!d && <span className="muted">设备不存在</span>}
                        {d && d.channels.length === 0 && <span className="muted">无通道</span>}
                      </span>
                      {lease ? (
                        <span className="dev-badge dev-badge--warn" title={`至 ${lease.expires_at}`}>
                          占用 · 剩 {lease.remaining_minutes} 分
                        </span>
                      ) : (
                        <span className="dev-badge">空闲</span>
                      )}
                    </li>
                  );
                })}
                {t.members.length === 0 && <li className="muted">无成员设备</li>}
              </ul>
              <div className="topo-big-card__foot">
                <span>更新于 {fmtTime(t.updated_at)}</span>
                <button
                  className="copy-id mono"
                  onClick={() => copyId(t)}
                  title="点击复制完整 id（AI 经 MCP 按名称或 id 引用）"
                >
                  {copied === t.id ? "已复制 id" : `id ${t.id.slice(0, 8)}…`}
                </button>
              </div>
            </article>
          ))}
        </div>
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
