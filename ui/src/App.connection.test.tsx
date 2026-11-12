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
  readyState = Socket.CONNECTING;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  sent: { action: string; port?: string; config?: unknown }[] = [];
  constructor() { Socket.current = this; }
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
