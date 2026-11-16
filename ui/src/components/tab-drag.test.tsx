// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupView } from "./term";

describe("tab drag insertion", () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: ComponentProps<typeof GroupView>;
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    props = {
      group: { id: "g1", ports: ["COM1", "COM2", "COM3"], activePort: "COM1" }, focused: true,
      aliasEditTab: null, aliasOf: () => undefined, onSwitchTab: vi.fn(), onCloseTab: vi.fn(),
      onRenameTab: vi.fn(), onTabContextMenu: vi.fn(), onCommitAlias: vi.fn(), onCancelAlias: vi.fn(),
      onFocusGroup: vi.fn(), onWrite: vi.fn(), onReady: vi.fn(), searchOpen: false, activeTerm: undefined,
      onCloseSearch: vi.fn(), onDragOverHalf: vi.fn(), onDragLeave: vi.fn(), onDropHalf: vi.fn(),
      onDropOnTabs: vi.fn(), dropHint: null, termContainerRef: vi.fn(),
    };
    await act(async () => root.render(<GroupView {...props} />));
    container.querySelectorAll<HTMLElement>(".tab").forEach((tab, index) => {
      vi.spyOn(tab, "getBoundingClientRect").mockReturnValue({ left: index * 100, width: 100 } as DOMRect);
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  async function drag(type: string, x: number, target = container.querySelector(".tab-bar")!, raw = JSON.stringify({ port: "COM1", src: "g1" })) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      clientX: { value: x }, clientY: { value: 200 },
      dataTransfer: { value: { types: ["text/x-port"], getData: () => raw, dropEffect: "" } },
    });
    await act(async () => target.dispatchEvent(event));
    return event;
  }
  it("shows an insertion hint and drops before a tab midpoint", async () => {
    await drag("dragover", 110);
    expect(container.querySelectorAll(".tab")[1].getAttribute("data-drop-before")).toBe("true");
    await drag("drop", 110);
    expect(props.onDropOnTabs).toHaveBeenCalledWith("COM1", "g1", "g1", 1);
    expect(container.querySelector("[data-drop-before]")).toBeNull();
  });
  it("routes an end-of-bar drop from another pane with the final insertion index", async () => {
    await drag("drop", 310, undefined, JSON.stringify({ port: "COM4", src: "g2" }));
    expect(props.onDropOnTabs).toHaveBeenCalledWith("COM4", "g2", "g1", 3);
  });
  it("retains native terminal splitting and ignores malformed tab payloads", async () => {
    const term = container.querySelector(".group__term")!;
    vi.spyOn(term, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 400, height: 400 } as DOMRect);
    await drag("drop", 395, term);
    expect(props.onDropHalf).toHaveBeenCalledWith("COM1", "g1", "g1", "right");
    await drag("drop", 10, undefined, "not json");
    await drag("drop", 10, undefined, JSON.stringify({ port: 123, src: null }));
    expect(props.onDropOnTabs).not.toHaveBeenCalled();
  });
});
