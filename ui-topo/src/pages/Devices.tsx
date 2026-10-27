import { useCallback, useEffect, useState } from "react";
import { api, subscribeChanged, type DeviceView, type PortView } from "../api";

interface DeviceGroup {
  device: DeviceView;
  ports: PortView[];
}

/** 端口行按属主设备分组（device.id；无 device 字段归「本机」）。 */
function groupByDevice(ports: PortView[]): DeviceGroup[] {
  const map = new Map<string, DeviceGroup>();
  const local: DeviceView = { id: "local", label: "本机", via: "local" };
  for (const p of ports) {
    const dev = p.device ?? local;
    if (!map.has(dev.id)) map.set(dev.id, { device: dev, ports: [] });
    map.get(dev.id)!.ports.push(p);
  }
  return [...map.values()];
}

export default function Devices() {
  const [groups, setGroups] = useState<DeviceGroup[]>([]);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    api
      .ports()
      .then((p) => setGroups(groupByDevice(p)))
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(() => {
    refresh();
    const off = subscribeChanged(refresh);
    const metaTimer = setInterval(refresh, 10_000); // 端口插拔无广播，轮询兜底
    return () => {
      off();
      clearInterval(metaTimer);
    };
  }, [refresh]);

  if (error) return <p className="error">{error}</p>;

  return (
    <section>
      <h1>设备库</h1>
      <p className="muted">
        本机串口、SSH、远程设备的统一清单；拓扑成员从这里引用。
      </p>
      {groups.map((g) => (
        <div key={g.device.id} className="device-card">
          <div className="device-head">
            <strong>{g.device.label}</strong>
            <span className="muted">
              {g.device.detail ? `${g.device.detail} · ` : ""}
              {g.device.id}
              {g.device.online !== undefined
                ? g.device.online
                  ? " · 在线"
                  : " · 离线"
                : ""}
            </span>
          </div>
          <ul>
            {g.ports.map((p) => (
              <li key={p.name} className="port-row">
                <span className="mono">{p.name}</span>
                {p.alias && <span className="muted"> · {p.alias}</span>}
                {p.opened && <span className="badge">已开 · {p.holders}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
