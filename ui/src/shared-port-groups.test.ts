import { describe, expect, it, vi } from "vitest";
import {
  PORT_GROUPS_KEY, canonicalGrouping, clientGrouping, emptyPortGrouping,
  type PortGroupsOperation, type PortGroupsSnapshot,
} from "./port-groups";
import { SharedPortGroups, type PortGroupsConnection } from "./shared-port-groups";

function snapshot(serverId = "server-a", revision = 0, names: string[] = []): PortGroupsSnapshot {
  return { serverId, revision, names, assignments: {}, sshAssignments: {} };
}

function preferences(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class Connection implements PortGroupsConnection {
  devId = "remote";
  listeners = new Set<(value: PortGroupsSnapshot) => void>();
  getPortGroups = vi.fn(async () => this.current);
  updatePortGroups = vi.fn(async (_operation: PortGroupsOperation) => this.current);

  constructor(public current = snapshot()) {}

  onPortGroups(cb: (value: PortGroupsSnapshot) => void) {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  emit(value: PortGroupsSnapshot) {
    this.current = value;
    this.listeners.forEach((listener) => listener(value));
  }
}

const legacy = {
  names: ["Lab", "Field"],
  assignments: { "remote::COM1": ["Lab"], "remote::relay::COM1": ["Field"] },
  sshAssignments: { "ssh-host": ["Lab"] }, collapsed: ["Field"],
};

describe("shared grouping identities", () => {
  it("uses the same server keys for desktop and browser without stripping cascaded routes", () => {
    const browser = canonicalGrouping(legacy, "remote");
    const desktop = canonicalGrouping({ ...legacy, assignments: { COM1: ["Lab"], "relay::COM1": ["Field"] } }, "local");
    expect(browser).toEqual(desktop);
    expect(browser).not.toHaveProperty("collapsed");
    const wire = { ...snapshot(), ...browser };
    expect(clientGrouping(wire, "remote", ["Lab"]).assignments).toEqual(legacy.assignments);
    expect(clientGrouping(wire, "local", []).assignments).toEqual(desktop.assignments);
    expect(clientGrouping(wire, "another-client", []).sshAssignments).toEqual({ "ssh-host": ["Lab"] });
  });

  it("merges duplicate migrated aliases and retains prototype-looking identity keys safely", () => {
    const input = {
      ...emptyPortGrouping(), names: ["Lab", "Field"],
      assignments: Object.fromEntries([
        ["remote::COM1", ["Lab"]], ["COM1", ["Field", "Lab"]],
        ["remote::__proto__", ["Lab"]], ["constructor", ["Field"]],
      ]),
      sshAssignments: Object.fromEntries([["__proto__", ["Field"]]]),
    };
    const canonical = canonicalGrouping(input, "remote");
    expect(canonical.assignments.COM1).toEqual(["Lab", "Field"]);
    expect(Object.keys(canonical.assignments)).toEqual(["COM1", "__proto__", "constructor"]);
    expect(Object.getPrototypeOf(canonical.assignments)).toBe(Object.prototype);
    const output = clientGrouping({ ...snapshot(), ...canonical }, "remote", []);
    expect(output.assignments["remote::__proto__"]).toEqual(["Lab"]);
    expect(output.sshAssignments["__proto__"]).toEqual(["Field"]);
  });
});

describe("shared grouping synchronization", () => {
  it("imports old groups once per bound source and preserves the original local backup", async () => {
    const raw = JSON.stringify(legacy);
    const storage = preferences({ [PORT_GROUPS_KEY]: raw });
    const connection = new Connection(snapshot("server-a", 3, ["Existing"]));
    connection.updatePortGroups.mockResolvedValue({
      ...snapshot("server-a", 4, ["Existing", "Lab", "Field"]),
      ...canonicalGrouping(legacy, "remote"), names: ["Existing", "Lab", "Field"],
    });
    const makeSource = vi.fn(() => "source-1");
    const first = new SharedPortGroups(connection, storage, vi.fn(), makeSource);
    await first.start();
    expect(first.state.ready).toBe(true);
    expect(first.state.snapshot?.names).toEqual(["Existing", "Lab", "Field"]);
    expect(first.state.collapsed).toEqual(["Field"]);
    expect(storage.getItem(PORT_GROUPS_KEY)).toBe(raw);
    expect(connection.updatePortGroups).toHaveBeenCalledWith({
      type: "migrate", sourceId: "source-1", data: canonicalGrouping(legacy, "remote"),
    });
    expect(JSON.parse(storage.getItem(`${PORT_GROUPS_KEY}:migration`)!)).toEqual({ serverId: "server-a", sourceId: "source-1" });
    first.stop();

    connection.current = snapshot("server-a", 5, ["Existing"]);
    connection.updatePortGroups.mockResolvedValue(connection.current);
    const reconnected = new SharedPortGroups(connection, storage, vi.fn(), makeSource);
    await reconnected.start();
    expect(makeSource).toHaveBeenCalledTimes(1);
    expect(connection.updatePortGroups.mock.calls[1][0]).toEqual(connection.updatePortGroups.mock.calls[0][0]);
    expect(reconnected.state.snapshot?.names).toEqual(["Existing"]);
    reconnected.stop();
  });

  it("does not copy one server's legacy groups when the client switches to another server", async () => {
    const storage = preferences({ [PORT_GROUPS_KEY]: JSON.stringify(legacy) });
    const first = new SharedPortGroups(new Connection(), storage, vi.fn(), () => "source-1");
    await first.start();
    first.stop();
    const other = new Connection(snapshot("server-b", 7, ["Other server"]));
    const second = new SharedPortGroups(other, storage, vi.fn(), () => "source-2");
    await second.start();
    expect(second.state.snapshot?.names).toEqual(["Other server"]);
    expect(other.updatePortGroups).not.toHaveBeenCalled();
    expect(second.state.collapsed).toEqual([]);
    second.stop();
  });

  it("does not roll back a newer broadcast when the initial response or a save response arrives late", async () => {
    const get = deferred<PortGroupsSnapshot>();
    const connection = new Connection();
    connection.getPortGroups.mockReturnValue(get.promise);
    const sync = new SharedPortGroups(connection, preferences(), vi.fn(), () => "source");
    const starting = sync.start();
    connection.emit(snapshot("server-a", 5, ["Newest"]));
    get.resolve(snapshot("server-a", 2, ["Old"]));
    await starting;
    expect(sync.state.snapshot?.names).toEqual(["Newest"]);

    const save = deferred<PortGroupsSnapshot>();
    connection.updatePortGroups.mockReturnValue(save.promise);
    const updating = sync.update({ type: "create", name: "Mine" });
    await Promise.resolve();
    connection.emit(snapshot("server-a", 8, ["Newest", "Mine", "Other client"]));
    save.resolve(snapshot("server-a", 7, ["Newest", "Mine"]));
    await updating;
    expect(sync.state.snapshot?.names).toEqual(["Newest", "Mine", "Other client"]);
    sync.stop();
  });

  it("serializes dependent edits without changing the visible snapshot before confirmation", async () => {
    const connection = new Connection(snapshot("server-a", 1, ["Lab"]));
    const sync = new SharedPortGroups(connection, preferences(), vi.fn(), () => "source");
    await sync.start();
    const save = deferred<PortGroupsSnapshot>();
    connection.updatePortGroups.mockReturnValueOnce(save.promise).mockResolvedValueOnce(snapshot("server-a", 3, ["Renamed", "Field"]));
    const rename = sync.update({ type: "rename", name: "Lab", newName: "Renamed" });
    const create = sync.update({ type: "create", name: "Field" });
    await Promise.resolve();
    expect(connection.updatePortGroups).toHaveBeenCalledTimes(1);
    expect(sync.state.snapshot?.names).toEqual(["Lab"]);
    save.resolve(snapshot("server-a", 2, ["Renamed"]));
    await Promise.all([rename, create]);
    expect(connection.updatePortGroups.mock.calls.map(([operation]) => operation.type)).toEqual(["rename", "create"]);
    expect(sync.state.snapshot?.names).toEqual(["Renamed", "Field"]);
    sync.stop();
  });

  it("keeps the confirmed state on save failure and allows a subsequent edit", async () => {
    const connection = new Connection(snapshot("server-a", 1, ["Lab"]));
    const sync = new SharedPortGroups(connection, preferences(), vi.fn(), () => "source");
    await sync.start();
    connection.updatePortGroups.mockRejectedValueOnce(new Error("disk full"));
    await expect(sync.update({ type: "dissolve", name: "Lab" })).rejects.toThrow("disk full");
    expect(sync.state.snapshot?.names).toEqual(["Lab"]);
    expect(sync.state.error).toContain("disk full");
    connection.updatePortGroups.mockResolvedValueOnce(snapshot("server-a", 2, ["Lab", "Field"]));
    await sync.update({ type: "create", name: "Field" });
    expect(sync.state.snapshot?.names).toEqual(["Lab", "Field"]);
    expect(sync.state.error).toBe("");
    sync.stop();
  });

  it("leaves a failed legacy migration retryable with the same source identity", async () => {
    const connection = new Connection();
    const storage = preferences({ [PORT_GROUPS_KEY]: JSON.stringify(legacy) });
    connection.updatePortGroups.mockRejectedValueOnce(new Error("write denied"));
    const sync = new SharedPortGroups(connection, storage, vi.fn(), () => "fixed-source");
    await sync.start();
    expect(sync.state.ready).toBe(false);
    expect(sync.state.error).toContain("write denied");
    connection.updatePortGroups.mockResolvedValueOnce(snapshot("server-a", 1, ["Lab", "Field"]));
    await sync.reload();
    expect(sync.state.ready).toBe(true);
    expect(connection.updatePortGroups.mock.calls.map(([operation]) => operation.type === "migrate" ? operation.sourceId : null)).toEqual(["fixed-source", "fixed-source"]);
    expect(storage.getItem(PORT_GROUPS_KEY)).toBe(JSON.stringify(legacy));
    sync.stop();
  });

  it("ignores a late initial response after stopping without migrating or writing preferences", async () => {
    const connection = new Connection();
    const get = deferred<PortGroupsSnapshot>();
    connection.getPortGroups.mockReturnValue(get.promise);
    const storage = preferences({ [PORT_GROUPS_KEY]: JSON.stringify(legacy) });
    const changed = vi.fn();
    const sync = new SharedPortGroups(connection, storage, changed, () => "source");
    const starting = sync.start();
    sync.stop();
    get.resolve(snapshot());
    await starting;
    expect(connection.listeners.size).toBe(0);
    expect(changed).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(connection.updatePortGroups).not.toHaveBeenCalled();
  });

  it("does not persist a late rename or send queued edits after the client has stopped", async () => {
    const connection = new Connection(snapshot("server-a", 1, ["Lab"]));
    const storage = preferences();
    const sync = new SharedPortGroups(connection, storage, vi.fn(), () => "source");
    await sync.start();
    sync.toggleCollapsed("Lab");
    storage.setItem.mockClear();
    const save = deferred<PortGroupsSnapshot>();
    connection.updatePortGroups.mockReturnValue(save.promise);
    const renaming = sync.update({ type: "rename", name: "Lab", newName: "Renamed" });
    const creating = sync.update({ type: "create", name: "Field" });
    const rejected = expect(creating).rejects.toThrow();
    await Promise.resolve();
    sync.stop();
    save.resolve(snapshot("server-a", 2, ["Renamed"]));
    await renaming;
    await rejected;
    expect(connection.updatePortGroups).toHaveBeenCalledTimes(1);
    expect(sync.state.snapshot?.names).toEqual(["Lab"]);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("shares group updates while retaining each client's independent collapsed state", async () => {
    const wire = snapshot("server-a", 1, ["Lab"]);
    const desktopConnection = new Connection(wire);
    desktopConnection.devId = "local";
    const browserConnection = new Connection(wire);
    const desktopStorage = preferences();
    const browserStorage = preferences();
    const desktop = new SharedPortGroups(desktopConnection, desktopStorage, vi.fn(), () => "desktop");
    const browser = new SharedPortGroups(browserConnection, browserStorage, vi.fn(), () => "browser");
    await Promise.all([desktop.start(), browser.start()]);
    desktop.toggleCollapsed("Lab");
    const updated = { ...snapshot("server-a", 2, ["Lab", "Field"]), assignments: { "relay::COM3": ["Field"] }, sshAssignments: { host: ["Lab"] } };
    desktopConnection.emit(updated);
    browserConnection.emit(updated);
    expect(desktop.state.snapshot).toEqual(browser.state.snapshot);
    expect(desktop.state.collapsed).toEqual(["Lab"]);
    expect(browser.state.collapsed).toEqual([]);
    expect(desktopConnection.updatePortGroups).not.toHaveBeenCalled();
    expect(browserConnection.updatePortGroups).not.toHaveBeenCalled();
    expect(clientGrouping(browser.state.snapshot, "remote", []).assignments["remote::relay::COM3"]).toEqual(["Field"]);
    desktop.stop();
    browser.stop();

    const restored = new SharedPortGroups(desktopConnection, desktopStorage, vi.fn(), () => "desktop");
    await restored.start();
    expect(restored.state.collapsed).toEqual(["Lab"]);
    restored.stop();
  });
});
