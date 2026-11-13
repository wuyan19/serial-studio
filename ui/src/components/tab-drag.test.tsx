// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupView, TermView } from "./term";
import { getTheme, setTheme, themeDefOf } from "../theme";
import type { TermInstance } from "../types";

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
  it("sets the same tab accent for matching sessions", async () => {
    await act(async () => root.render(<GroupView {...props}
      group={{ id: "g1", ports: ["host::shell", "host::shell@2", "COM3"], activePort: "host::shell" }}
      tabColorOf={(port) => port.startsWith("host::") ? "#aa1133" : undefined}
    />));
    const accents = [...container.querySelectorAll<HTMLElement>(".tab")].map((tab) => tab.style.getPropertyValue("--tab-accent"));
    expect(accents).toEqual(["#aa1133", "#aa1133", ""]);
  });

  it("updates cursor color and preserves it through theme changes without recreating the terminal", async () => {
    const originalTheme = getTheme();
    const onReady = vi.fn<(instance: TermInstance | null) => void>();
    const renderTerm = async (cursorColor?: string) => {
      await act(async () => root.render(<TermView port="host::shell" visible={false} focused={false}
        targetContainer={null} cursorColor={cursorColor} onWrite={vi.fn()} onReady={onReady} />));
    };
    try {
      await renderTerm("#aa1133");
      const term = onReady.mock.calls[0][0]!.term;
      expect(term.options.theme?.cursor).toBe("#aa1133");
      await renderTerm("#55cc99");
      await act(async () => setTheme(originalTheme === "codex" ? "codex-light" : "codex"));
      expect(term.options.theme?.cursor).toBe("#55cc99");
      expect(term.options.theme?.background).toBe(themeDefOf(getTheme()).term.background);
      await renderTerm();
      expect(term.options.theme?.cursor).toBe(themeDefOf(getTheme()).term.cursor);
      expect(onReady).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => setTheme(originalTheme));
    }
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
