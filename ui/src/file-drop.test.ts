import { describe, expect, it, vi } from "vitest";
import { installFileDropGuard, isFileDrop } from "./file-drop";

function drag(type: "dragover" | "drop", types: string[], count = 0) {
  const transfer = { types, files: { length: count }, dropEffect: "copy" };
  const event = new Event(type, { cancelable: true, bubbles: true });
  Object.defineProperty(event, "dataTransfer", { value: transfer });
  return { event, transfer };
}

describe("external file drop protection", () => {
  it("recognizes protected drag metadata before files are available and files on drop", () => {
    expect(isFileDrop({ types: ["Files", "text/uri-list"], files: { length: 0 } })).toBe(true);
    expect(isFileDrop({ types: [], files: { length: 1 } })).toBe(true);
    expect(isFileDrop(null)).toBe(false);
    expect(isFileDrop(undefined)).toBe(false);
    expect(isFileDrop({ types: ["text/x-port", "text/plain"] })).toBe(false);
    expect(isFileDrop({ types: ["text/uri-list"] })).toBe(false);
  });

  it.each(["dragover", "drop"] as const)("prevents local HTML navigation on %s without suppressing panel handling", type => {
    const target = new EventTarget();
    const uninstall = installFileDropGuard(target);
    const { event, transfer } = drag(type, ["Files", "text/html", "text/uri-list"], type === "drop" ? 1 : 0);
    const stop = vi.spyOn(event, "stopPropagation");
    const stopImmediate = vi.spyOn(event, "stopImmediatePropagation");
    const receiver = vi.fn((received: Event) => {
      expect(received.defaultPrevented).toBe(true);
      expect(transfer.dropEffect).toBe(type === "dragover" ? "none" : "copy");
      transfer.dropEffect = "copy";
    });
    target.addEventListener(type, receiver);
    target.dispatchEvent(event);
    expect(receiver).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    expect(stopImmediate).not.toHaveBeenCalled();
    expect(transfer.dropEffect).toBe("copy");
    uninstall();
  });

  it("preserves internal terminal tab drags and ordinary text drops", () => {
    const target = new EventTarget();
    const uninstall = installFileDropGuard(target);
    for (const types of [["text/x-port", "text/plain"], ["text/plain"], ["text/uri-list"]]) {
      const { event, transfer } = drag("drop", types);
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(transfer.dropEffect).toBe("copy");
    }
    uninstall();
  });

  it("removes both listeners on cleanup", () => {
    const target = new EventTarget();
    const add = vi.spyOn(target, "addEventListener");
    const remove = vi.spyOn(target, "removeEventListener");
    const uninstall = installFileDropGuard(target);
    expect(add.mock.calls.map(([type, , options]) => [type, options])).toEqual([
      ["dragover", { capture: true, passive: false }], ["drop", { capture: true, passive: false }],
    ]);
    uninstall();
    expect(remove.mock.calls.map(([type]) => type)).toEqual(["dragover", "drop"]);
    for (const type of ["dragover", "drop"] as const) {
      const { event } = drag(type, ["Files"], 1);
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  });
});
