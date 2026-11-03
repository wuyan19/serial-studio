import { describe, expect, it } from "vitest";
import { connectionRows, selectSshPort } from "./connection-list";
import { addPortToGroup, addSshToGroup, emptyPortGrouping } from "./port-groups";
import type { PortGroupView } from "./components/sidebar";
import type { PortRow } from "./types";

function port(pid: string, extras: Partial<PortRow> = {}): PortRow {
  return { pid, name: pid, opened: false, holders: 0, ...extras };
}

const serialA: PortGroupView = { devId: "a", label: "Device A", ports: [port("a::COM1")] };
const serialB: PortGroupView = { devId: "b", label: "Device B", ports: [port("b::COM1")] };
const ssh: PortGroupView = {
  devId: "ssh", label: "Lab SSH", detail: "root@192.0.2.1:22", kind: "ssh",
  ports: [port("ssh::shell"), port("ssh::shell@2", { instance: 2, opened: true }), port("ssh::shell@3", { instance: 3, alias: "Monitoring" })],
};

function preferences() {
  return { ...emptyPortGrouping(), names: ["Work", "Other"] };
}

describe("flat connection rows", () => {
  it("keeps every default serial identity and collapses all SSH endpoints into one row", () => {
    const grouping = addPortToGroup(addSshToGroup(preferences(), "ssh", "Work"), "a::COM1", "Work");
    const rows = connectionRows([serialA, ssh, serialB], grouping, null, "");
    expect(rows.map((row) => row.kind)).toEqual(["serial", "ssh", "serial"]);
    expect(rows.filter((row) => row.kind === "serial").map((row) => row.port.pid)).toEqual(["a::COM1", "b::COM1"]);
    expect(rows[1]).toEqual({ kind: "ssh", group: ssh, ports: ssh.ports });
  });

  it("flattens group members without repeating the SSH device for endpoint memberships", () => {
    let grouping = addSshToGroup(preferences(), "ssh", "Work");
    grouping = addPortToGroup(grouping, "ssh::shell@2", "Work");
    grouping = addPortToGroup(grouping, "b::COM1", "Work");
    const rows = connectionRows([serialA, serialB, ssh], grouping, "Work", "");
    expect(rows).toEqual([{ kind: "serial", group: serialB, port: serialB.ports[0] }, { kind: "ssh", group: ssh, ports: ssh.ports }]);
    expect(connectionRows([serialA, serialB, ssh], grouping, "Other", "")).toEqual([]);
  });

  it("keeps only explicitly grouped SSH endpoints when the whole device is not grouped", () => {
    const grouping = addPortToGroup(addPortToGroup(preferences(), "ssh::shell@2", "Work"), "ssh::shell@3", "Work");
    expect(connectionRows([ssh], grouping, "Work", "")).toEqual([{ kind: "ssh", group: ssh, ports: ssh.ports.slice(1) }]);
  });

  it("retains zero-endpoint SSH devices only in the default or whole-device membership", () => {
    const empty: PortGroupView = { ...ssh, ports: [] };
    expect(connectionRows([empty], preferences(), null, "")).toEqual([{ kind: "ssh", group: empty, ports: [] }]);
    expect(connectionRows([empty], preferences(), "Work", "")).toEqual([]);
    const grouping = addSshToGroup(preferences(), "ssh", "Work");
    expect(connectionRows([empty], grouping, "Work", "work")).toEqual([{ kind: "ssh", group: empty, ports: [] }]);
    expect(connectionRows([empty], grouping, "Work", "missing")).toEqual([]);
  });

  it("searches device addresses and aliases without losing sibling SSH sessions", () => {
    expect(connectionRows([serialA, ssh], preferences(), null, " ROOT@192.0.2.1 ")).toEqual([{ kind: "ssh", group: ssh, ports: ssh.ports }]);
    expect(connectionRows([ssh], preferences(), null, "monitoring")).toEqual([{ kind: "ssh", group: ssh, ports: ssh.ports }]);
    const grouping = addSshToGroup(preferences(), "ssh", "Work");
    expect(connectionRows([ssh], grouping, "Work", "work")[0]).toEqual({ kind: "ssh", group: ssh, ports: ssh.ports });
  });

  it("searches serial aliases and origin labels within only the selected membership", () => {
    const group: PortGroupView = { ...serialA, ports: [port("a::COM1", { alias: "Sensor", device: { id: "origin", label: "Origin", via: "remote" } }), port("a::COM2")] };
    const grouping = addPortToGroup(preferences(), "a::COM1", "Work");
    for (const query of ["sensor", "origin", "a::com1", "device a", "work"]) {
      expect(connectionRows([group], grouping, "Work", query)).toEqual([{ kind: "serial", group, port: group.ports[0] }]);
    }
    expect(connectionRows([group], grouping, "Work", "com2")).toEqual([]);
  });
});

describe("SSH row target selection", () => {
  it("prefers the active session, then an opened base endpoint, then any opened instance", () => {
    const base = port("ssh::shell", { opened: true });
    const instance = port("ssh::shell@2", { opened: true, instance: 2 });
    expect(selectSshPort([instance, base], instance.pid)).toBe(instance);
    expect(selectSshPort([instance, base], "other")).toBe(base);
    expect(selectSshPort([{ ...base, opened: false }, instance], "other")).toBe(instance);
  });

  it("uses metadata and the legacy endpoint suffix without inspecting a host's @ sign", () => {
    const instance = port("legacy::shell@2");
    const base = port("user@host::shell");
    expect(selectSshPort([instance, base], "other")).toBe(base);
    const structuredInstance = port("ssh::opaque-name", { instance: 8 });
    expect(selectSshPort([structuredInstance, base], "other")).toBe(base);
    expect(selectSshPort([instance], "other")).toBe(instance);
    expect(selectSshPort([], "other")).toBeUndefined();
  });
});
