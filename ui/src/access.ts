import type { PortInfo } from "./types";

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

export interface PublicAccessStatus {
  enabled: boolean;
  allow_http?: boolean;
  https_available?: boolean;
  scope: AccessConfig["scope"];
  tls_port: number;
  authenticated: boolean;
}

export const DEFAULT_ACCESS_PORT = 18702;
export const HTTP_ACCESS_WARNING = "HTTP 会明文传输验证码、会话和终端数据，仅适用于可信局域网。";
export type DesktopAccessMode = "legacy" | "https" | "http";

export function validAccessPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

export function accessOrigin(host: string, port: number, secure: boolean): string {
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const url = new URL(`${secure ? "https" : "http"}://${authority}:${port}`);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("服务地址无效");
  return url.origin;
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

export function accessTargetOptions(ports: PortInfo[]): { target: AccessTarget; label: string }[] {
  const options = new Map<string, { target: AccessTarget; label: string; priority: number }>();
  for (const port of ports) {
    const ssh = port.kind === "ssh" || port.device?.via === "ssh";
    const separator = port.name.lastIndexOf("::");
    if (ssh && separator <= 0) continue;
    // The full route prefix preserves the device identity when SSH is behind a relay.
    const target: AccessTarget = ssh ? { kind: "ssh", id: port.name.slice(0, separator) } : { kind: "serial", id: port.name };
    const name = separator < 0 ? port.name : port.name.slice(separator + 2);
    const label = ssh ? port.device?.label ?? target.id : [port.device?.label, port.alias ? `${port.alias} (${name})` : name].filter(Boolean).join(" · ");
    const key = accessTargetKey(target);
    const priority = ssh ? 0 : port.alias ? 2 : name.startsWith("/dev/cu.") ? 1 : 0;
    if (priority > (options.get(key)?.priority ?? -1)) options.set(key, { target, label, priority });
  }
  return [...options.values()].map(({ target, label }) => ({ target, label })).sort((a, b) => a.label.localeCompare(b.label));
}

export async function fetchAccessStatus(origin: string, signal?: AbortSignal): Promise<PublicAccessStatus | null> {
  const response = await fetch(`${origin}/api/access/status`, { credentials: "same-origin", cache: "no-store", redirect: "error", signal });
  // Old servers serve the SPA fallback for unknown paths.
  if (response.status === 404 || (response.ok && !response.headers.get("content-type")?.includes("application/json"))) return null;
  if (!response.ok) throw new Error("无法读取远程访问状态");
  const status: PublicAccessStatus = await response.json();
  if (typeof status.enabled !== "boolean" || typeof status.authenticated !== "boolean" ||
      !["all", "selected"].includes(status.scope) || !validAccessPort(status.tls_port)) {
    throw new Error("远程访问状态无效");
  }
  return status;
}

export async function verifyWebAccess(code: string, allowHttp = false): Promise<void> {
  if (location.protocol !== "https:" && !(allowHttp && location.protocol === "http:")) {
    throw new Error("请在目标设备的 HTTPS 页面验证");
  }
  const response = await fetch("/api/access/verify", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (response.status === 429) throw new Error("尝试次数过多，请稍后重试");
  if (response.status === 401) throw new Error("验证码错误、已使用或已过期，请获取新码");
  if (response.status === 403) throw new Error("目标设备未启用当前连接方式的访问验证");
  if (!response.ok) throw new Error("验证失败，请稍后重试");
}

export async function logoutWebAccess(allowHttp = false): Promise<void> {
  if (location.protocol !== "https:" && !(allowHttp && location.protocol === "http:")) {
    throw new Error("请在目标设备的 HTTPS 页面退出验证");
  }
  const response = await fetch("/api/access/logout", {
    method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
  });
  if (!response.ok) throw new Error("无法退出验证，请稍后重试");
}
