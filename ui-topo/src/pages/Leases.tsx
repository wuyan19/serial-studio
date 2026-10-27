import { useCallback, useEffect, useState } from "react";
import { api, fmtTime, subscribeChanged, type LeaseView } from "../api";

export default function Leases() {
  const [list, setList] = useState<LeaseView[]>([]);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    api
      .leases()
      .then(setList)
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(() => {
    refresh();
    const off = subscribeChanged(refresh);
    const timer = setInterval(refresh, 30_000); // 剩余时间是倒计时，轮询刷新
    return () => {
      off();
      clearInterval(timer);
    };
  }, [refresh]);

  const forceRelease = async (l: LeaseView) => {
    if (!confirm(`强制释放「${l.label}」的租约？其会话的写操作将被立即闸拒。`)) return;
    try {
      await api.forceReleaseLease(l.id);
      refresh();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  return (
    <section>
      <h1>占用</h1>
      <p className="muted">
        AI 会话经 lease_acquire 申请的排他写权；到期自动释放，人可强制收回。
      </p>
      {error && <p className="error">{error}</p>}
      {list.length === 0 ? (
        <p className="muted">当前无活跃租约。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>持有者</th>
              <th>范围</th>
              <th>获得于</th>
              <th>到期</th>
              <th>剩余</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((l) => (
              <tr key={l.id}>
                <td>{l.label}</td>
                <td className="mono">
                  {l.grants
                    .map((g) => `${g.kind === "device" ? "设备" : "端点"} ${g.key}`)
                    .join("、")}
                </td>
                <td>{fmtTime(l.acquired_at)}</td>
                <td>{fmtTime(l.expires_at)}</td>
                <td>{l.remaining_minutes} 分钟</td>
                <td>
                  <button className="link" onClick={() => forceRelease(l)}>
                    强制释放
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
