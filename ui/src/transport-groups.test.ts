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

  it("preserves SSH test classifications and fingerprints over WebSocket", async () => {
    const { transport, socket } = remote();
    const testing = transport.sshTest("new-host");
    const ssh = { kind: "host_key_unknown", fingerprint: "SHA256:fixture", keyType: "ssh-ed25519" };
    socket.receive({ type: "ssh_test_result", host_id: "new-host", ok: false, message: "Confirm fingerprint", ssh });
    await expect(testing).resolves.toEqual({ ok: false, message: "Confirm fingerprint", ssh });
    expect(socket.sent).toEqual([{ action: "ssh_test", host_id: "new-host" }]);
  });

  it("supports legacy test replies without structured SSH errors", async () => {
    const { transport, socket } = remote();
    const testing = transport.sshTest("legacy-host");
    socket.receive({ type: "ssh_test_result", host_id: "legacy-host", ok: true, message: "" });
    await expect(testing).resolves.toEqual({ ok: true, message: "" });
  });

  it("keeps structured desktop test errors and accepts older two-field replies", async () => {
    const ssh = { kind: "auth_failed", method: "password" };
    const invoke = vi.fn(async (command: string) => command === "ssh_test" ? [false, "Authentication failed", ssh] : undefined);
    mockIPC(invoke, { shouldMockEvents: true });
    const transport = new LocalTransport();
    transports.push(transport);
    await expect(transport.sshTest("new-host")).resolves.toEqual({ ok: false, message: "Authentication failed", ssh });
    invoke.mockResolvedValueOnce([true, ""]);
    await expect(transport.sshTest("legacy-host")).resolves.toEqual({ ok: true, message: "" });
    expect(invoke).toHaveBeenCalledWith("ssh_test", { hostId: "new-host" });
  });

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

describe("SSH file transports", () => {
  let transport: RemoteTransport | LocalTransport | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", Socket);
    vi.stubGlobal("window", { crypto: globalThis.crypto });
    Socket.instances = [];
  });
  afterEach(() => {
    transport?.dispose();
    transport = undefined;
    clearMocks(); vi.useRealTimers(); vi.unstubAllGlobals();
  });
  it("correlates file replies and keeps cascaded host routes intact", async () => {
    transport = new RemoteTransport("127.0.0.1", 18700, "web-owner");
    const socket = Socket.instances[0]; socket.open();
    const first = transport.sshFiles("relay::child::ssh", { op: "open" });
    const second = transport.sshFiles("other", { op: "open" });
    expect(socket.sent[0]).toMatchObject({ action: "ssh_files", host_id: "relay::child::ssh" });
    socket.receive({ type: "ssh_files_result", request_id: socket.sent[1].request_id, result: { kind: "opened", session: "two", path: "/home" } });
    socket.receive({ type: "ssh_files_result", request_id: socket.sent[0].request_id, result: { kind: "opened", session: "one", path: "/root" } });
    await expect(first).resolves.toMatchObject({ session: "one" });
    await expect(second).resolves.toMatchObject({ session: "two" });
  });
  it("fails offline requests, times out and rejects pending work on disconnect", async () => {
    transport = new RemoteTransport("127.0.0.1", 18700, "owner");
    await expect(transport.sshFiles("h", { op: "open" })).rejects.toThrow("服务尚未连接");
    const socket = Socket.instances[0]; socket.open();
    const first = transport.sshFiles("h", { op: "open" });
    const timeout = expect(first).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(45_000); await timeout;
    const next = transport.sshFiles("h", { op: "open" });
    const failure = expect(next).rejects.toThrow(); socket.close(); await failure;
    socket.receive({ type: "ssh_files_result", request_id: socket.sent[0].request_id, result: { kind: "ok" } });
  });
  it("uses window-scoped desktop IPC for file operations", async () => {
    const invoke = vi.fn(async () => ({ kind: "ok" }));
    mockIPC(invoke, { shouldMockEvents: true });
    transport = new LocalTransport();
    const operation = { op: "close", session: "test" } as const;
    await expect(transport.sshFiles("relay::ssh", operation)).resolves.toEqual({ kind: "ok" });
    expect(invoke).toHaveBeenCalledWith("ssh_files", { hostId: "relay::ssh", operation });
    await vi.advanceTimersByTimeAsync(0);
    transport.dispose();
    await expect(transport.sshFiles("h", operation)).rejects.toThrow("transport disposed");
  });
});
