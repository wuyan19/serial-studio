// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import { DEFAULT_CONFIG } from "./lib";
import type { PortInfo } from "./types";

class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  static current: Socket;
  static urls: string[] = [];
  readyState = Socket.CONNECTING;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  sent: { action: string; port?: string; config?: unknown }[] = [];
  constructor(url: string) { Socket.current = this; Socket.urls.push(url); }
  close() { this.readyState = 3; }
  open() { this.readyState = Socket.OPEN; this.onopen?.(); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

const ssh: PortInfo = {
  name: "ssh-device::shell", opened: false, holders: 0, kind: "ssh",
  device: { id: "ssh-device", label: "Lab SSH", via: "ssh" },
};
const serial: PortInfo = {
  name: "hub::COM5", opened: false, holders: 0, kind: "serial",
  device: { id: "hub", label: "Lab Hub", via: "remote", online: true },
};

let root: Root;
let container: HTMLDivElement;
let socket: Socket;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
  vi.useFakeTimers();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<App />));
  socket = Socket.current;
  await act(async () => {
    socket.open();
    socket.receive({ type: "ports", ports: [ssh, serial] });
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function pressEnter(target: EventTarget, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
}

it("shows an SSH timeout on its own tab, retries in place, and releases a dismissed open", async () => {
  const row = container.querySelector<HTMLElement>(".port-item-row--ssh .port-item")!;
  await act(async () => { row.click(); row.click(); });
  const tab = container.querySelector(".tab")!;
  expect(tab.getAttribute("data-connection")).toBe("opening");
  expect(container.querySelector(".term-connection")?.textContent).toContain("正在连接");
  expect(socket.sent.filter((msg) => msg.action === "open")).toHaveLength(1);

  await act(async () => socket.receive({ type: "error", port: ssh.name, message: `串口 ${ssh.name} 打开失败: 连接超时` }));
  expect(tab.getAttribute("data-connection")).toBe("failed");
  expect(container.querySelector(".term-connection")?.textContent).toContain("连接超时");
  expect(container.querySelector(".statusbar__msg--err")).toBeNull();

  await act(async () => {
    const search = container.querySelector<HTMLInputElement>(".sidebar input")!;
    expect(pressEnter(search!).defaultPrevented).toBe(false);
    expect(pressEnter(row, { repeat: true }).defaultPrevented).toBe(true);
    expect(socket.sent.filter((msg) => msg.action === "open")).toHaveLength(1);
    expect(pressEnter(row).defaultPrevented).toBe(true);
    pressEnter(row);
  });
  expect(container.querySelector(".tab")).toBe(tab);
  expect(tab.getAttribute("data-connection")).toBe("opening");
  expect(socket.sent.filter((msg) => msg.action === "open")).toHaveLength(2);
  await act(async () => tab.querySelector<HTMLElement>(".tab__btn--close")!.click());
  expect(container.querySelector(".tab")).toBeNull();

  await act(async () => socket.receive({ type: "acquired", port: ssh.name, config: DEFAULT_CONFIG, opened: true, holders: 1 }));
  expect(container.querySelector(".tab")).toBeNull();
  expect(socket.sent.filter((msg) => msg.action === "close")).toEqual([{ action: "close", port: ssh.name }]);
});

it("keeps a background serial error off the active SSH tab", async () => {
  const portRow = [...container.querySelectorAll<HTMLElement>(".port-item")]
    .find((row) => row.textContent?.includes("COM5"))!;
  await act(async () => portRow.click());
  const confirm = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === "打开")!;
  expect(socket.sent.filter((msg) => msg.action === "open")).toHaveLength(0);
  await act(async () => confirm.click());
  const tab = container.querySelector(".tab")!;
  expect(tab.getAttribute("data-connection")).toBe("opening");
  await act(async () => container.querySelector<HTMLElement>(".port-item-row--ssh .port-item")!.click());

  await act(async () => socket.receive({ type: "error", port: serial.name, message: `串口 ${serial.name} 打开失败: 远程设备离线` }));
  expect(tab.getAttribute("data-connection")).toBe("failed");
  expect(container.querySelector(".tab[data-active=true]")).not.toBe(tab);
  expect(container.querySelector(".term-connection")?.textContent).not.toContain("远程设备离线");
  await act(async () => (tab as HTMLElement).click());
  expect(container.querySelector(".term-connection")?.textContent).toContain("远程设备离线");
});

it("shows disconnect and reconnect feedback over the same SSH terminal", async () => {
  await act(async () => container.querySelector<HTMLElement>(".port-item-row--ssh .port-item")!.click());
  const tab = container.querySelector(".tab");
  const acquired = { type: "acquired", port: ssh.name, config: DEFAULT_CONFIG, opened: true, holders: 1 };
  await act(async () => socket.receive(acquired));
  const terminal = container.querySelector<HTMLElement>(".termview-root")!;
  expect(terminal.style.display).toBe("flex");
  expect(container.querySelector(".term-connection")).toBeNull();

  await act(async () => socket.receive({ type: "disconnected", port: ssh.name }));
  expect(tab?.getAttribute("data-disconnected")).toBe("true");
  expect(container.querySelector(".term-connection [role=alert]")?.textContent).toContain("连接已断开");
  expect(container.querySelector(".termview-root")).toBe(terminal);
  expect(terminal.style.display).toBe("flex");

  await act(async () => { expect(pressEnter(document.body).defaultPrevented).toBe(true); });
  expect(container.querySelector(".term-connection [role=status]")?.textContent).toContain("正在连接");
  await act(async () => socket.receive(acquired));
  expect(container.querySelector(".term-connection")).toBeNull();
  expect(container.querySelector(".termview-root")).toBe(terminal);
  expect(container.querySelector(".tab")).toBe(tab);
  expect(tab?.hasAttribute("data-disconnected")).toBe(false);
  expect(pressEnter(document.body).defaultPrevented).toBe(false);
});

it("waits for a protected HTTPS session before opening a secure WebSocket", async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  Socket.urls = [];
  vi.stubGlobal("location", new URL("https://lab.example:18702/"));
  let authenticated = false;
  const fetcher = vi.fn(async (input: string, options?: RequestInit) => {
    if (input === "/api/access/verify") {
      expect(options).toMatchObject({ method: "POST", credentials: "same-origin", redirect: "error" });
      expect(JSON.parse(String(options?.body))).toEqual({ code: "01234567" });
      authenticated = true;
      return new Response("{}", { status: 200 });
    }
    expect(input).toBe("https://lab.example:18702/api/access/status");
    return new Response(JSON.stringify({ enabled: true, scope: "selected", tls_port: 18702, authenticated }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(<App />));
  expect(Socket.urls).toEqual([]);
  const form = container.querySelector<HTMLFormElement>('[aria-label="远程访问验证"] form')!;
  const input = form.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "01234567");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(Socket.urls).toEqual(["wss://lab.example:18702/ws?access_ui=1"]);
  expect(container.querySelector('[aria-label="远程访问验证"]')).toBeNull();
});

it("redirects only locked connections to the advertised HTTPS port", async () => {
  const assign = vi.fn();
  vi.stubGlobal("location", Object.assign(new URL("http://localhost:3000/"), { assign }));
  await act(async () => socket.receive({ type: "ports", ports: [{ ...ssh, locked: true, access_tls_port: 24443 }, serial] }));
  const locked = container.querySelector<HTMLButtonElement>(".port-item-row--ssh .port-item")!;
  expect(locked.textContent).toContain("需验证");
  await act(async () => locked.click());
  expect(assign).toHaveBeenCalledWith("https://localhost:24443");
  expect(socket.sent.filter((msg) => msg.action === "open")).toHaveLength(0);

  const available = [...container.querySelectorAll<HTMLElement>(".port-item")].find((item) => item.textContent?.includes("COM5"))!;
  await act(async () => available.click());
  expect(container.querySelector(".dialog")?.textContent).toContain("波特率");
  expect(assign).toHaveBeenCalledTimes(1);
});

it("keeps unprotected HTTP connections available and verifies a locked connection in place", async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  Socket.urls = [];
  const assign = vi.fn();
  vi.stubGlobal("location", Object.assign(new URL("http://lab.example:18700/"), { assign }));
  let authenticated = false;
  const fetcher = vi.fn(async (input: string, options?: RequestInit) => {
    if (input === "/api/access/verify") {
      expect(options).toMatchObject({ method: "POST", credentials: "same-origin", redirect: "error" });
      expect(JSON.parse(String(options?.body))).toEqual({ code: "01234567" });
      authenticated = true;
      return new Response("{}", { status: 200 });
    }
    if (input === "/api/access/logout") {
      authenticated = false;
      return new Response(null, { status: 204 });
    }
    expect(input).toBe("http://lab.example:18700/api/access/status");
    return new Response(JSON.stringify({ enabled: true, scope: "selected", tls_port: 18702, allow_http: true, https_available: false, authenticated }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(<App />));
  expect(Socket.urls).toEqual(["ws://lab.example:18700/ws?access_ui=1"]);
  expect(container.querySelector('[aria-label="远程访问验证"]')).toBeNull();
  expect(container.querySelector(".access-banner")?.textContent).not.toContain("打开 HTTPS");
  socket = Socket.current;
  await act(async () => {
    socket.open();
    socket.receive({ type: "ports", ports: [{ ...ssh, locked: true }, serial] });
  });
  const available = [...container.querySelectorAll<HTMLElement>(".port-item")].find((item) => item.textContent?.includes("COM5"))!;
  await act(async () => available.click());
  expect(container.querySelector(".dialog")?.textContent).toContain("波特率");
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".dialog button")].find((button) => button.textContent?.trim() === "取消")!.click());

  const locked = container.querySelector<HTMLButtonElement>(".port-item-row--ssh .port-item")!;
  await act(async () => locked.click());
  const form = container.querySelector<HTMLFormElement>('[aria-label="远程访问验证"] form')!;
  expect(form.querySelector('[role="note"]')?.textContent).toContain("明文传输");
  const input = form.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "01234567");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(container.querySelector('[aria-label="远程访问验证"]')).toBeNull();
  expect(container.querySelector(".access-banner")?.textContent).toContain("已通过 HTTP 验证");
  expect(Socket.urls).toEqual(["ws://lab.example:18700/ws?access_ui=1", "ws://lab.example:18700/ws?access_ui=1"]);
  expect(assign).not.toHaveBeenCalled();

  await act(async () => container.querySelector<HTMLButtonElement>(".access-banner button")!.click());
  expect(container.querySelector(".access-banner")?.textContent).toContain("通过 HTTP 验证");
  expect(Socket.urls).toHaveLength(3);
});
