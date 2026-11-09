// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortsPanel, type PortGroupView } from "./sidebar";
import type { PortRow } from "../types";

const row = (pid: string, alias = pid): PortRow => ({ pid, name: pid, alias, opened: false, holders: 0 });
const groups: PortGroupView[] = [
  { devId: "a", label: "Device A", ports: [row("a::COM1", "match 1"), row("a::COM2", "hidden"), row("a::COM3", "match 3")] },
  { devId: "ssh", label: "Lab SSH", kind: "ssh", ports: [row("ssh::shell")] },
  { devId: "b", label: "Device B", ports: [row("b::COM1")] },
];
const deviceScope = (id: string) => JSON.stringify(["device", id]);
const groupScope = (name: string) => JSON.stringify(["group", name]);
const serialId = (pid: string) => JSON.stringify(["serial", pid]);
const sshId = JSON.stringify(["ssh", "ssh"]);

function transfer(types: string[] = []) {
  const values = new Map<string, string>();
  return {
    types: [...types], files: { length: types.includes("Files") ? 1 : 0 }, effectAllowed: "all", dropEffect: "none",
    setData(type: string, value: string) { values.set(type, value); if (!this.types.includes(type)) this.types.push(type); },
    getData(type: string) { return values.get(type) ?? ""; },
  };
}

describe("connection list drag ordering", () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: ComponentProps<typeof PortsPanel>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      clear: () => storage.clear(),
    });
    container = document.createElement("div"); document.body.appendChild(container);
    root = createRoot(container);
    props = {
      portGroups: groups, remotes: [], portCollapsed: new Set(), activePort: "", openPorts: [], aliasEditPort: null,
      grouping: { names: ["Work", "Other"], collapsed: [], assignments: { "a::COM1": ["Work"], "a::COM2": ["Work"], "a::COM3": ["Work"], "b::COM1": ["Other"] }, sshAssignments: { ssh: ["Work"] } },
      groupsReady: true, groupsError: "", onUpdateGroups: vi.fn(async () => {}), onToggleCustomGroup: vi.fn(),
      listView: "default", orderScope: "fixture", onTogglePortGroup: vi.fn(), onSetAliasEdit: vi.fn(), onTriggerPort: vi.fn(),
      onCommitAlias: vi.fn(), onCancelAlias: vi.fn(), onForceClose: vi.fn(), onReconnectRemote: vi.fn(), onDisconnectRemote: vi.fn(),
      onRemoveRemote: vi.fn(), onRenameRemote: vi.fn(), onShowDeviceDetail: vi.fn(), onSshAction: vi.fn(), onNewSshTerminal: vi.fn(),
      onClosePort: vi.fn(), onCopyPortKey: vi.fn(), onShowPortDetail: vi.fn(), onRefresh: vi.fn(),
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); localStorage.clear(); vi.unstubAllGlobals();
  });
  async function render(changes: Partial<typeof props> = {}) {
    props = { ...props, ...changes }; await act(async () => root.render(<PortsPanel {...props} />));
  }
  function items(scope: string) { return [...container.querySelectorAll<HTMLElement>("[data-sort-scope]")].filter(el => el.dataset.sortScope === scope); }
  function ids(scope: string) { return items(scope).map(el => el.dataset.sortId); }
  function item(scope: string, id: string) {
    const found = items(scope).find(el => el.dataset.sortId === id);
    if (!found) throw new Error(`Missing ${scope} / ${id}`);
    return found;
  }
  async function dispatch(el: HTMLElement, type: string, data: ReturnType<typeof transfer>, after = false) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { dataTransfer: { value: data }, clientY: { value: after ? 90 : 10 } });
    await act(async () => el.dispatchEvent(event));
    return event;
  }
  async function drag(source: HTMLElement, target: HTMLElement, after = false) {
    const data = transfer();
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top: 0, height: 100 } as DOMRect);
    await dispatch(source, "dragstart", data);
    await dispatch(target, "dragover", data, after);
    const drop = await dispatch(target, "drop", data, after);
    await dispatch(source, "dragend", data);
    return drop;
  }

  it("moves SSH and serial device headers together, saves order and restores it after remount", async () => {
    await render();
    await drag(item("devices", "ssh"), item("devices", "a"));
    expect(ids("devices")).toEqual(["ssh", "a", "b"]);
    await drag(item("devices", "ssh"), item("devices", "b"), true);
    expect(ids("devices")).toEqual(["a", "b", "ssh"]);
    await act(async () => root.unmount()); root = createRoot(container); await render();
    expect(ids("devices")).toEqual(["a", "b", "ssh"]);
    expect(props.onTriggerPort).not.toHaveBeenCalled(); expect(props.onSshAction).not.toHaveBeenCalled();
  });

  it("orders serial children only inside their device and rejects child-to-header drops", async () => {
    await render();
    await drag(item(deviceScope("a"), serialId("a::COM3")), item(deviceScope("a"), serialId("a::COM1")));
    expect(ids(deviceScope("a"))).toEqual(["a::COM3", "a::COM1", "a::COM2"].map(serialId));
    const snapshot = localStorage.getItem("serial-studio-connection-order-v1:fixture");
    expect((await drag(item(deviceScope("a"), serialId("a::COM1")), item(deviceScope("b"), serialId("b::COM1")))).defaultPrevented).toBe(false);
    expect((await drag(item(deviceScope("a"), serialId("a::COM1")), item("devices", "b"))).defaultPrevented).toBe(false);
    expect(localStorage.getItem("serial-studio-connection-order-v1:fixture")).toBe(snapshot);
  });

  it("moves group headers and mixed group members without changing membership", async () => {
    await render({ listView: "groups" });
    await drag(item("groups", "Other"), item("groups", "Work"));
    expect(ids("groups")).toEqual(["Other", "Work"]);
    await drag(item(groupScope("Work"), sshId), item(groupScope("Work"), serialId("a::COM1")));
    expect(ids(groupScope("Work"))[0]).toBe(sshId);
    expect((await drag(item(groupScope("Work"), sshId), item(groupScope("Other"), serialId("b::COM1")))).defaultPrevented).toBe(false);
    expect(ids(groupScope("Other"))).toEqual([serialId("b::COM1")]);
    expect(props.onUpdateGroups).not.toHaveBeenCalled();
  });

  it("keeps hidden siblings when ordering filtered children and isolates server preferences", async () => {
    await render({ query: "match" });
    await drag(item(deviceScope("a"), serialId("a::COM3")), item(deviceScope("a"), serialId("a::COM1")));
    await render({ query: "" });
    expect(ids(deviceScope("a"))).toEqual(["a::COM3", "a::COM1", "a::COM2"].map(serialId));
    await render({ orderScope: "another-server" });
    expect(ids(deviceScope("a"))).toEqual(groups[0].ports.map(port => serialId(port.pid)));
    await render({ orderScope: "fixture" });
    expect(ids(deviceScope("a"))[0]).toBe(serialId("a::COM3"));
  });

  it("does not reorder from editing text or an external file drop", async () => {
    await render({ aliasEditPort: "a::COM1" });
    const editing = item(deviceScope("a"), serialId("a::COM1"));
    expect(editing.getAttribute("draggable")).toBe("false");
    const input = editing.querySelector<HTMLInputElement>("input")!;
    expect((await dispatch(input, "dragstart", transfer())).defaultPrevented).toBe(true);
    const files = transfer(["Files"]);
    const target = item("devices", "ssh");
    expect((await dispatch(target, "dragover", files)).defaultPrevented).toBe(false);
    expect((await dispatch(target, "drop", files)).defaultPrevented).toBe(false);
    expect(ids("devices")).toEqual(["a", "ssh", "b"]);
    expect(localStorage.getItem("serial-studio-connection-order-v1:fixture")).toBeNull();
    expect(props.onTriggerPort).not.toHaveBeenCalled();
    expect(props.onUpdateGroups).not.toHaveBeenCalled();
  });
});
