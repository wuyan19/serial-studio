import type { PortInfo } from "./types";
import { sshTabTarget } from "./lib";

export interface ConnectionColors {
  tab?: string;
  cursor?: string;
}

export const CONNECTION_COLORS_KEY = "serial-studio-connection-colors-v1";

export function connectionColorKey(pid: string, row?: Pick<PortInfo, "kind" | "name" | "device">, sshOwner?: string): string {
  const owner = row?.device?.via === "ssh" ? row.device.id : sshOwner;
  const host = owner ?? sshTabTarget(row)?.hostId;
  if (host) return `ssh:${host}`;
  return `serial:${pid}`;
}

function readColor(value: unknown): string | undefined {
  return typeof value === "string" && /^#[\da-f]{6}$/i.test(value) ? value : undefined;
}

export function loadConnectionColors(): Map<string, ConnectionColors> {
  const colors = new Map<string, ConnectionColors>();
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(CONNECTION_COLORS_KEY) ?? "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return colors;
    for (const [key, value] of Object.entries(stored)) {
      if (!value || typeof value !== "object") continue;
      const tab = readColor("tab" in value ? value.tab : undefined);
      const cursor = readColor("cursor" in value ? value.cursor : undefined);
      if (tab || cursor) colors.set(key, { tab, cursor });
    }
  } catch {
    return colors;
  }
  return colors;
}

export function saveConnectionColors(colors: ReadonlyMap<string, ConnectionColors>) {
  localStorage.setItem(CONNECTION_COLORS_KEY, JSON.stringify(Object.fromEntries(colors)));
}
