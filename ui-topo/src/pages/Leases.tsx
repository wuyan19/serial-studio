import { useCallback, useEffect, useState } from "react";
import { api, fmtTime, subscribeChanged, type Device, type LeaseView } from "../api";
import { IconBolt } from "../icons";

export default function Leases() {
  const [list, setList] = useState<LeaseView[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    api
      .leases()
      .then(setList)
      .catch((e) => setError(String(e.message ?? e)));
    api.devices().then(setDevices).catch(() => {});
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
      <div className="page-head">
        <h1>占用</h1>
      </div>
      <p className="muted">
        AI 会话经 lease_acquire 申请的排他写权；到期自动释放，人可强制收回。
      </p>
      {error && <p className="error">{error}</p>}
      {list.length === 0 ? (
        <div className="empty-note">
          <IconBolt className="empty-note__icon" />
          <p>
            当前无活跃租约。AI 申请占用设备后，租约会出现在这里。
          </p>
        </div>
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
                    .map(
                      (g) =>
                        devices.find((d) => d.id === g.device)?.name ?? g.device,
                    )
                    .join("、")}
                </td>
                <td>{fmtTime(l.acquired_at)}</td>
                <td>{fmtTime(l.expires_at)}</td>
                <td>
                  <span className="dev-badge dev-badge--warn">剩 {l.remaining_minutes} 分</span>
                </td>
                <td>
                  <button className="btn btn--danger btn--sm" onClick={() => forceRelease(l)}>
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
