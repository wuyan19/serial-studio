// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabOverflow } from "./tab-overflow";

describe("tab overflow navigation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let mounted: boolean;
  let scroll: HTMLDivElement;
  let dimensions: { strip: number; viewport: number; content: number };
  let resizeCallback: () => void;
  let mutationCallback: () => void;
  let resizeDisconnect: ReturnType<typeof vi.fn>;
  let mutationDisconnect: ReturnType<typeof vi.fn>;
  let observe: ReturnType<typeof vi.fn>;
  const scrollRef = createRef<HTMLDivElement>();

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    resizeDisconnect = vi.fn(); mutationDisconnect = vi.fn(); observe = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resizeCallback = callback; }
      observe = observe;
      disconnect = resizeDisconnect;
    });
    vi.stubGlobal("MutationObserver", class {
      constructor(callback: () => void) { mutationCallback = callback; }
      observe = vi.fn();
      disconnect = mutationDisconnect;
    });
    dimensions = { strip: 400, viewport: 400, content: 300 };
    container = document.createElement("div"); document.body.appendChild(container);
    root = createRoot(container); mounted = true;
    await act(async () => root.render(<TabOverflow scrollRef={scrollRef}>
      <div ref={scrollRef} className="tab-bar"><div className="tab">First</div><div className="tab">Last</div></div>
    </TabOverflow>));
    scroll = scrollRef.current!;
    Object.defineProperties(scroll, {
      clientWidth: { configurable: true, get: () => dimensions.viewport },
      scrollWidth: { configurable: true, get: () => dimensions.content },
    });
    Object.defineProperty(container.querySelector(".tab-strip")!, "clientWidth", { configurable: true, get: () => dimensions.strip });
    scroll.scrollBy = vi.fn();
    await resize();
  });
  afterEach(async () => {
    if (mounted) await act(async () => root.unmount());
    container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  async function resize() { await act(async () => resizeCallback()); }
  function button(direction: "before" | "after") {
    return container.querySelector<HTMLButtonElement>(`button[aria-label="查看${direction === "before" ? "前面" : "后面"}的标签"]`)!;
  }
  function windowElement() { return container.querySelector<HTMLElement>(".tab-strip__window")!; }
  async function scrollTo(left: number) {
    await act(async () => { scroll.scrollLeft = left; scroll.dispatchEvent(new Event("scroll")); });
  }

  it("shows controls and a trailing fade only when tabs exceed the full strip", async () => {
    expect(container.querySelector(".tab-strip__controls")).toBeNull();
    dimensions.content = 800; dimensions.viewport = 340;
    await resize();
    expect(button("before").disabled).toBe(true);
    expect(button("after").disabled).toBe(false);
    expect(windowElement().dataset.before).toBeUndefined();
    expect(windowElement().dataset.after).toBe("true");
  });

  it("pages in either direction by three quarters of the visible viewport", async () => {
    dimensions.content = 800; dimensions.viewport = 340;
    await resize();
    await act(async () => button("after").click());
    expect(scroll.scrollBy).toHaveBeenLastCalledWith({ left: 255, behavior: "smooth" });
    await scrollTo(200);
    expect(windowElement().dataset.before).toBe("true");
    expect(windowElement().dataset.after).toBe("true");
    await act(async () => button("before").click());
    expect(scroll.scrollBy).toHaveBeenLastCalledWith({ left: -255, behavior: "smooth" });
    await scrollTo(460);
    expect(button("after").disabled).toBe(true);
    expect(button("before").disabled).toBe(false);
    expect(windowElement().dataset.after).toBeUndefined();
  });

  it("rechecks renamed or removed tabs and never mistakes control width for overflow", async () => {
    dimensions.content = 800; dimensions.viewport = 340;
    await resize();
    dimensions.content = 380;
    await act(async () => mutationCallback());
    expect(container.querySelector(".tab-strip__controls")).toBeNull();
    dimensions.content = 450;
    await act(async () => mutationCallback());
    expect(container.querySelector(".tab-strip__controls")).not.toBeNull();
    dimensions.strip = 500;
    await resize();
    expect(container.querySelector(".tab-strip__controls")).toBeNull();
    expect(observe).toHaveBeenCalledWith(scroll.children[0]);
  });

  it("keeps the active tab visible after the available width changes", async () => {
    const active = scroll.children[1] as HTMLElement;
    active.dataset.active = "true";
    vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue({ left: 0, right: 340 } as DOMRect);
    vi.spyOn(active, "getBoundingClientRect").mockReturnValue({ left: 350, right: 450 } as DOMRect);
    dimensions.content = 800; dimensions.viewport = 340;
    await resize();
    expect(scroll.scrollLeft).toBe(110);
    expect(button("before").disabled).toBe(false);
    await scrollTo(0);
    expect(scroll.scrollLeft).toBe(0);
    expect(button("before").disabled).toBe(true);
  });

  it("disconnects observers and its scroll listener on unmount", async () => {
    const remove = vi.spyOn(scroll, "removeEventListener");
    const disconnects = resizeDisconnect.mock.calls.length;
    await act(async () => root.unmount()); mounted = false;
    expect(resizeDisconnect.mock.calls.length).toBe(disconnects + 1);
    expect(mutationDisconnect).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function));
  });
});
