// @vitest-environment happy-dom
import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSettingsMenu, WorkspaceSidebar } from "./workspace";

describe("workspace sidebar layout interactions", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  function props(): ComponentProps<typeof WorkspaceSidebar> {
    return {
      panel: "ports", collapsed: false, width: 280, showScripts: true,
      counts: { ports: 4, macros: 2, scripts: 1 }, running: { macros: false, scripts: false }, failed: { macros: false, scripts: false },
      query: "", onPanel: vi.fn(), onQuery: vi.fn(), onNew: vi.fn(), onRemote: vi.fn(), onShare: vi.fn(), tools: <span />,
      children: <button>existing connection</button>, onRefresh: vi.fn(),
      view: { label: "默认", items: [{ label: "默认", checked: true }, { label: "分组", checked: false, onSelect: vi.fn() }] },
    };
  }
  function button(name: string) {
    const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => (b.getAttribute("aria-label") || b.textContent) === name);
    if (!result) throw new Error(`Missing button: ${name}`);
    return result;
  }
  async function click(name: string) { await act(async () => button(name).click()); }

  it("keeps creation, refresh and extra operations bound to existing callbacks", async () => {
    const value = props();
    await act(async () => root.render(<WorkspaceSidebar {...value} />));
    await click("新建连接"); await click("刷新列表"); await click("分享当前设备"); await click("添加远程设备");
    expect(value.onNew).toHaveBeenCalledOnce(); expect(value.onRefresh).toHaveBeenCalledOnce();
    expect(value.onShare).toHaveBeenCalledOnce(); expect(value.onRemote).toHaveBeenCalledOnce();
    expect(container.querySelector(".sidebar__rail")?.parentElement).toBe(container.querySelector(".sidebar__panel")?.parentElement);
    expect(container.querySelectorAll(".workspace-create")).toHaveLength(1);
  });
  it("opens the badge view menu and changes the view without triggering creation", async () => {
    const value = props();
    await act(async () => root.render(<WorkspaceSidebar {...value} />));
    await click("列表视图：默认，点击切换");
    expect(document.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent).toBe("默认");
    await click("分组");
    expect(value.view!.items[1].onSelect).toHaveBeenCalledOnce();
    expect(value.onNew).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
  it("retains mounted list content while toggling the current navigation icon", async () => {
    const value = props();
    function Harness() {
      const [collapsed, setCollapsed] = useState(false);
      return <WorkspaceSidebar {...value} collapsed={collapsed} onPanel={() => setCollapsed(v => !v)} />;
    }
    await act(async () => root.render(<Harness />));
    const content = button("existing connection");
    await click("连接");
    expect(container.querySelector<HTMLElement>(".sidebar__panel")?.hidden).toBe(true);
    expect(content.isConnected).toBe(true);
    expect(button("连接").getAttribute("aria-expanded")).toBe("false");
    await click("连接");
    expect(button("existing connection")).toBe(content);
    expect(button("连接").getAttribute("aria-expanded")).toBe("true");
  });
  it("closes view menus when navigating away and preserves library import operations", async () => {
    const value = props(); const onImport = vi.fn();
    await act(async () => root.render(<WorkspaceSidebar {...value} />));
    await click("列表视图：默认，点击切换");
    await act(async () => root.render(<WorkspaceSidebar {...value} panel="macros" view={undefined} onRefresh={undefined} moreItems={[{ label: "导入宏", onSelect: onImport }]} />));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await click("更多操作"); await click("导入宏");
    expect(onImport).toHaveBeenCalledOnce();
    expect(container.querySelector(".panel-head__view")).toBeNull();
  });
  it("opens settings directly in the settings category", async () => {
    const open = vi.fn();
    await act(async () => root.render(<WorkspaceSettingsMenu onOpen={open} />));
    await click("设置");
    expect(open).toHaveBeenCalledWith("connection");
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
