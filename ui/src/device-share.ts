export interface DeviceShareAddress {
  host: string;
  port: number;
  secure?: boolean;
}

export const SHARE_FRAGMENT = "#serial-studio-share=v1";
const MAX_SHARE_LENGTH = 2048;

function validHost(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a !== 0 && a !== 127 && a < 224 && !(a === 169 && b === 254);
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

export function createDeviceShareUrl({ host, port, secure }: DeviceShareAddress): string {
  if (!validHost(host)) throw new Error("请选择其他设备可访问的 IPv4 地址，不能使用本机回环地址");
  if (!validPort(port)) throw new Error("服务端口必须为 1 到 65535 之间的整数");
  return `${secure ? "https" : "http"}://${host}:${port}/${SHARE_FRAGMENT}`;
}

export function parseDeviceShareUrl(text: string | null): DeviceShareAddress | null {
  if (!text || text.length > MAX_SHARE_LENGTH) return null;
  const value = text.trim();
  if (!value.endsWith(SHARE_FRAGMENT)) return null;
  // Check the original authority before URL normalizes legacy numeric IPv4 forms.
  const match = /^(https?):\/\/([\d.]+)(?::(\d+))?\/?#serial-studio-share=v1$/i.exec(value);
  if (!match || !validHost(match[2])) return null;
  const secure = match[1].toLowerCase() === "https";
  const port = match[3] === undefined ? secure ? 443 : 80 : Number(match[3]);
  if (!validPort(port)) return null;
  try {
    const url = new URL(value);
    if (url.hostname !== match[2] || url.pathname !== "/" || url.search || url.username || url.password) return null;
    return { host: url.hostname, port, ...(secure ? { secure: true } : {}) };
  } catch {
    return null;
  }
}

export function createShareClipboardScanner(options: {
  read: () => Promise<string | null>;
  isIgnored: (address: DeviceShareAddress) => Promise<boolean>;
  onShare: (address: DeviceShareAddress) => void;
}): { check: () => Promise<void>; stop: () => void } {
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let lastAddress: string | null = null;

  const scan = async () => {
    try {
      const text = await options.read();
      if (stopped) return;
      const address = parseDeviceShareUrl(text);
      if (!address) return;
      const key = `${address.secure ? "https" : "http"}://${address.host}:${address.port}`;
      if (key === lastAddress) return;
      const ignored = await options.isIgnored(address);
      if (stopped) return;
      lastAddress = key;
      if (!ignored) options.onShare(address);
    } catch {
      // A temporary clipboard or identity lookup failure can retry on the next focus.
    }
  };

  return {
    check: () => {
      if (stopped) return Promise.resolve();
      if (!inFlight) inFlight = scan().finally(() => { inFlight = null; });
      return inFlight;
    },
    stop: () => { stopped = true; },
  };
}
