/** 实时端口表 hook：REST 初始 + WS 全量 ports + 单端口增量事件本地合并。
 *  服务端在开/关/持有数变化时只推增量（opened/closed/holders，见 ws.rs
 *  event_to_msg），不重推全量列表——消费方若只订阅全量 ports，就会
 *  「打开通道后在线人数不显示、切页重拉才刷新」。设备页/拓扑页/终端面板共用。 */
import { useEffect, useState } from "react";
import { api, type PortView } from "./api";
import { ws } from "./ws";

export function useLivePorts(): PortView[] {
  const [ports, setPorts] = useState<PortView[]>([]);
  useEffect(() => {
    api.ports().then(setPorts).catch(() => {});
    const offs = [
      ws.on("ports", setPorts),
      ws.on("opened", (port: string) =>
        setPorts((ps) => ps.map((p) => (p.name === port ? { ...p, opened: true } : p))),
      ),
      ws.on("closed", (port: string) =>
        setPorts((ps) =>
          ps.map((p) => (p.name === port ? { ...p, opened: false, holders: 0 } : p)),
        ),
      ),
      ws.on("holders", (port: string, holders: number) =>
        setPorts((ps) =>
          ps.map((p) =>
            p.name === port ? { ...p, holders, opened: holders > 0 } : p,
          ),
        ),
      ),
    ];
    return () => offs.forEach((off) => off());
  }, []);
  return ports;
}
