/** 远程访问验证的类型与纯函数（自 serial-studio ui 移植；网络函数走 api.ts 的 REST 封装）。
 *  目标键形如 serial:COM4 / ssh:<凭据id>——设备平台的通道属主信息由 PortView 携带。 */
import type { PortView } from "./api";

export type AccessTarget = { kind: "ssh" | "serial"; id: string };

export interface AccessConfig {
  enabled: boolean;
  allow_http: boolean;
  scope: "all" | "selected";
  targets: AccessTarget[];
  refresh_minutes: number;
  tls_port: number;
  tls_cert: string;
  tls_key: string;
}

export interface AccessStatus {
  config: AccessConfig;
  code?: string | null;
  expires_in: number;
  session_count: number;
}

export const DEFAULT_ACCESS_PORT = 18702;
export const HTTP_ACCESS_WARNING =
  "HTTP 会明文传输验证码、会话和终端数据，仅适用于可信局域网。";

export function validAccessPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

export function accessTargetKey(target: AccessTarget): string {
  if (target.kind === "ssh") return `ssh:${target.id}`;
  const route = target.id.replace(/^local::/, "");
  const separator = route.lastIndexOf("::");
  const owner = separator < 0 ? "" : route.slice(0, separator + 2);
  const name = route.slice(separator < 0 ? 0 : separator + 2);
  const device = name.replace(/^\/dev\/(?:cu|tty)\.|^\\\\\.\\/, "");
  return `serial:${owner}${device.replace(/[A-Z]/g, (character) => character.toLowerCase())}`;
}

export function accessTargetOptions(ports: PortView[]): { target: AccessTarget; label: string }[] {
  const options = new Map<string, { target: AccessTarget; label: string; priority: number }>();
  for (const port of ports) {
    const ssh = port.kind === "ssh" || port.device?.via === "ssh";
    const separator = port.name.lastIndexOf("::");
    if (ssh && separator <= 0) continue;
    const target: AccessTarget = ssh
      ? { kind: "ssh", id: port.name.slice(0, separator) }
      : { kind: "serial", id: port.name };
    const name = separator < 0 ? port.name : port.name.slice(separator + 2);
    const label = ssh
      ? port.device?.label ?? target.id
      : [port.device?.label, port.alias ? `${port.alias} (${name})` : name]
          .filter(Boolean)
          .join(" · ");
    const key = accessTargetKey(target);
    const priority = ssh ? 0 : port.alias ? 2 : name.startsWith("/dev/cu.") ? 1 : 0;
    if (priority > (options.get(key)?.priority ?? -1))
      options.set(key, { target, label, priority });
  }
  return [...options.values()]
    .map(({ target, label }) => ({ target, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
