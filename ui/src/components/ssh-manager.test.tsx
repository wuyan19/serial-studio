// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SshManagerDialog } from "./dialogs";
import type { SshHost, SshTestState } from "../types";

const hosts: SshHost[] = Array.from({ length: 11 }, (_, i) => ({
  id: `host-${i + 1}`, nickname: `Device ${i + 1}`, host: `192.0.2.${i + 1}`, port: 22,
  username: "test", auth: { type: "agent" }, endpoints: [{ name: "shell", type: "shell" }],
}));

describe("SSH manager pagination", () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: ComponentProps<typeof SshManagerDialog>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    props = { hosts, testOf: () => undefined, onCommit: vi.fn(), onDelete: vi.fn(), onTest: vi.fn(), onClose: vi.fn() };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  async function render(changes: Partial<typeof props> = {}) {
    props = { ...props, ...changes };
    await act(async () => root.render(<SshManagerDialog {...props} />));
  }
  function button(name: string, scope: ParentNode = container) {
    const result = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(b => (b.getAttribute("aria-label") || b.textContent?.trim()) === name);
    if (!result) throw new Error(`Missing button: ${name}`);
    return result;
  }
  async function click(name: string, scope: ParentNode = container) { await act(async () => button(name, scope).click()); }
  function rows() { return [...container.querySelectorAll(".ssh-table__row:not(.ssh-table__head)")]; }
  function names() { return rows().map(row => row.querySelector(".ssh-table__name")?.textContent); }
  function page() { return container.querySelector(".ssh-pagination__position")?.textContent; }

  it("shows five hosts per page and navigates through the final partial page", async () => {
    await render();
    expect(names()).toEqual(hosts.slice(0, 5).map(h => h.nickname));
    expect(button("上一页").disabled).toBe(true);
    expect(page()).toBe("第 1 / 3 页");
    await click("下一页");
    expect(names()).toEqual(hosts.slice(5, 10).map(h => h.nickname));
    await click("下一页");
    expect(names()).toEqual(["Device 11"]);
    expect(button("下一页").disabled).toBe(true);
    await click("上一页");
    expect(page()).toBe("第 2 / 3 页");
  });

  it("resets to the first page when changing the page size", async () => {
    await render(); await click("下一页");
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="每页设备数"]')!;
    await act(async () => { select.value = "10"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(rows()).toHaveLength(10);
    expect(page()).toBe("第 1 / 2 页");
    await act(async () => { select.value = "20"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(rows()).toHaveLength(11);
    expect(page()).toBe("第 1 / 1 页");
    expect(button("下一页").disabled).toBe(true);
  });

  it("keeps a valid page after deleting the last host on the final page or clearing the list", async () => {
    await render(); await click("下一页"); await click("下一页");
    await click("删除", rows()[0]);
    expect(props.onDelete).toHaveBeenCalledWith(hosts[10]);
    await render({ hosts: hosts.slice(0, 10) });
    expect(page()).toBe("第 2 / 2 页");
    expect(rows()).toHaveLength(5);
    await render({ hosts: [] });
    expect(container.querySelector(".ssh-pagination")).toBeNull();
    expect(container.textContent).toContain("暂无 SSH 设备");
    await render({ hosts: hosts.slice(0, 1) });
    expect(page()).toBe("第 1 / 1 页");
    expect(names()).toEqual(["Device 1"]);
  });

  it("tests the correct visible host and retains its status after paging away", async () => {
    const states = new Map<string, SshTestState>();
    await render({ testOf: id => states.get(id) });
    await click("下一页"); await click("测试", rows()[0]);
    expect(props.onTest).toHaveBeenCalledWith(hosts[5]);
    states.set(hosts[5].id, { status: "testing" });
    await render();
    expect(button("测试", rows()[0]).disabled).toBe(true);
    await click("上一页");
    states.set(hosts[5].id, { status: "fail", message: "fixture connection refused" });
    await render(); await click("下一页");
    expect(rows()[0].querySelector(".ssh-table__status")?.textContent).toBe("✗");
    expect(rows()[0].textContent).toContain("fixture connection refused");
    expect(button("测试", rows()[0]).disabled).toBe(false);
  });

  it("opens the correct host editor and retains its page when returning", async () => {
    await render(); await click("下一页");
    await click("编辑", rows()[0]);
    const values = [...container.querySelectorAll<HTMLInputElement>("input")].map(input => input.value);
    expect(values).toContain(hosts[5].host);
    await click("返回");
    expect(page()).toBe("第 2 / 3 页");
    expect(names()[0]).toBe("Device 6");
    expect(props.onCommit).not.toHaveBeenCalled();
    await click("关闭");
    expect(props.onClose).toHaveBeenCalledOnce();
  });
});
