import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalTransport, RemoteTransport } from "./transport";
import type { PortGroupsSnapshot } from "./port-groups";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  binaryType = "";
  sent: Array<Record<string, unknown>> = [];
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor(_url: string) { Socket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

const snapshot = (revision: number): PortGroupsSnapshot => ({
  serverId: "server", revision, names: ["Lab"], assignments: {}, sshAssignments: {},
});

describe("shared configuration transports", () => {
  const transports: Array<LocalTransport | RemoteTransport> = [];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", Socket);
    vi.stubGlobal("window", { crypto: globalThis.crypto });
    Socket.instances = [];
  });
  afterEach(() => {
    transports.forEach((transport) => transport.dispose());
    transports.length = 0;
    clearMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function remote() {
    const transport = new RemoteTransport("127.0.0.1", 18700, "remote");
    transports.push(transport);
    const socket = Socket.instances[0];
    socket.open();
    return { transport, socket };
  }

  it("correlates simultaneous responses independently from broadcast snapshots", async () => {
    const { transport, socket } = remote();
    const changed = vi.fn();
    transport.onPortGroups(changed);
    const first = transport.getPortGroups();
    const second = transport.updatePortGroups({ type: "membership", kind: "port", id: "relay::child::COM1", name: "Lab", included: true });
    expect(socket.sent[1].operation).toMatchObject({ id: "relay::child::COM1" });
    socket.receive({ type: "port_groups_changed", snapshot: snapshot(3) });
    expect(changed).toHaveBeenCalledWith(snapshot(3));
    socket.receive({ type: "port_groups_result", request_id: socket.sent[1].request_id, snapshot: snapshot(2), error: null });
    socket.receive({ type: "port_groups_result", request_id: socket.sent[0].request_id, snapshot: snapshot(1), error: null });
    await expect(first).resolves.toEqual(snapshot(1));
    await expect(second).resolves.toEqual(snapshot(2));
  });

  it("reads both libraries from the server and associates reversed replies by request ID", async () => {
    const { transport, socket } = remote();
    const macros = transport.getLibrary("macros");
    const scripts = transport.getLibrary("scripts");
    expect(socket.sent.map((message) => message.kind)).toEqual(["macros", "scripts"]);
    socket.receive({ type: "library_result", request_id: socket.sent[1].request_id, items: { probe: { code: "return 1" } }, server_id: "server", error: null });
    socket.receive({ type: "library_result", request_id: socket.sent[0].request_id, items: { login: { steps: [] } }, server_id: "server", error: null });
    await expect(macros).resolves.toEqual({ items: { login: { steps: [] } }, serverId: "server" });
    await expect(scripts).resolves.toEqual({ items: { probe: { code: "return 1" } }, serverId: "server" });
  });

  it("sends checked library deltas and surfaces server conflicts without reporting success", async () => {
    const { transport, socket } = remote();
    const changes = { login: { before: null, after: { steps: [] } } };
    const saving = transport.patchLibrary("macros", changes);
    expect(socket.sent[0]).toMatchObject({ action: "library_patch", kind: "macros", changes });
    const failed = expect(saving).rejects.toThrow("内容已被修改");
    socket.receive({ type: "library_result", request_id: socket.sent[0].request_id, items: null, server_id: "server", error: "内容已被修改" });
    await failed;
    const reading = transport.getLibrary("scripts");
    const rejected = expect(reading).rejects.toThrow("transport disposed");
    transport.dispose();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the same desktop library commands and receives shared change notifications", async () => {
    const reply = { items: { probe: { code: "return 1" } }, serverId: "desktop" };
    const invoke = vi.fn(async () => reply);
    mockIPC(invoke, { shouldMockEvents: true });
    const transport = new LocalTransport();
    transports.push(transport);
    const changed = vi.fn();
    transport.onScriptsChanged(changed);
    await expect(transport.getLibrary("scripts")).resolves.toEqual(reply);
    const changes = { probe: { before: { code: "return 1" }, after: { code: "return 2" } } };
    await transport.patchLibrary("scripts", changes);
    expect(invoke).toHaveBeenCalledWith("library_get", { kind: "scripts" });
    expect(invoke).toHaveBeenCalledWith("library_patch", { kind: "scripts", changes });
    await emit("scripts-changed");
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("rejects only the failed request and rejects pending work on disposal", async () => {
    const { transport, socket } = remote();
    const failed = transport.updatePortGroups({ type: "create", name: "Lab" });
    const pending = transport.getPortGroups();
    const failureCheck = expect(failed).rejects.toThrow("分组名称已存在");
    socket.receive({ type: "port_groups_result", request_id: socket.sent[0].request_id, snapshot: null, error: "分组名称已存在" });
    await failureCheck;
    const pendingCheck = expect(pending).rejects.toThrow("transport disposed");
    transport.dispose();
    await pendingCheck;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not queue edits while offline and times out unanswered requests", async () => {
    const { transport, socket } = remote();
    const waiting = transport.getPortGroups();
    const check = expect(waiting).rejects.toThrow("分组请求超时");
    await vi.advanceTimersByTimeAsync(10_000);
    await check;
    socket.close();
    await expect(transport.updatePortGroups({ type: "create", name: "offline" })).rejects.toThrow("服务尚未连接");
    expect(socket.sent.filter((message) => message.action === "port_groups_update")).toHaveLength(0);
  });

  it("subscribes to desktop changes before reading and uses the shared IPC commands", async () => {
    const invoke = vi.fn(async (command: string, _args: unknown) => {
      if (command === "get_port_groups") await emit("port-groups-changed", snapshot(2));
      return snapshot(1);
    });
    mockIPC(invoke, { shouldMockEvents: true });
    const transport = new LocalTransport();
    transports.push(transport);
    const changed = vi.fn();
    transport.onPortGroups(changed);
    const reading = transport.getPortGroups();
    await expect(reading).resolves.toEqual(snapshot(1));
    expect(invoke).toHaveBeenCalledWith("get_port_groups", {});
    expect(changed).toHaveBeenCalledWith(snapshot(2));
    await transport.updatePortGroups({ type: "create", name: "Field" });
    expect(invoke).toHaveBeenCalledWith("update_port_groups", { operation: { type: "create", name: "Field" } });
  });
});
