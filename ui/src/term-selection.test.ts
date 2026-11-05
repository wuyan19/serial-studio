// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copySelectionText, installSelectionCopy } from "./term-selection";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => {}) }));

describe("terminal automatic selection copy", () => {
  let container: HTMLDivElement;
  let notify: () => void;
  let text: string;
  let clipboard: string;
  let stop: () => void;
  let dispose: ReturnType<typeof vi.fn<() => void>>;
  let copy: ReturnType<typeof vi.fn<(value: string) => boolean>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    text = "terminal selection";
    clipboard = "original clipboard";
    dispose = vi.fn();
    copy = vi.fn((value: string) => { clipboard = value; return true; });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    stop = installSelectionCopy({
      onSelectionChange: listener => { notify = listener; return { dispose }; },
      getSelection: () => text,
    }, container, copy);
  });
  afterEach(() => {
    stop();
    container.remove();
    vi.restoreAllMocks();
  });
  function down(button = 0, detail = 1) {
    container.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button, detail }));
  }
  function up() {
    // xterm publishes its final selection from a document mouseup listener.
    document.addEventListener("mouseup", notify, { once: true });
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }

  it("preserves another application's clipboard after leaving and returning with a selection", () => {
    down(); up();
    expect(clipboard).toBe(text);
    window.dispatchEvent(new Event("blur"));
    clipboard = "copied in another application";
    notify();
    window.dispatchEvent(new Event("focus"));
    notify(); notify();
    expect(clipboard).toBe("copied in another application");
    expect(copy).toHaveBeenCalledOnce();
  });

  it("cancels an interrupted drag on blur and ignores its late mouseup", () => {
    down();
    window.dispatchEvent(new Event("blur"));
    clipboard = "external text";
    window.dispatchEvent(new Event("focus"));
    up();
    expect(copy).not.toHaveBeenCalled();
    expect(clipboard).toBe("external text");
  });

  it.each([1, 2, 3])("copies a fresh drag or %i-click selection, including reselecting the same text", detail => {
    down(0, detail); up();
    clipboard = "external text";
    down(0, detail); up();
    expect(clipboard).toBe(text);
    expect(copy).toHaveBeenCalledTimes(2);
  });

  it("copies right-click word selection during contextmenu and ignores later events", async () => {
    container.addEventListener("contextmenu", notify, { once: true });
    container.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(clipboard).toBe(text);
    await Promise.resolve();
    clipboard = "external text";
    notify();
    expect(clipboard).toBe("external text");
  });

  it.each(["ctrlKey", "metaKey"])("copies keyboard select-all with %s without leaving a pending gesture", async key => {
    container.addEventListener("keydown", notify, { once: true });
    container.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a", [key]: true }));
    expect(clipboard).toBe(text);
    await Promise.resolve();
    clipboard = "external text";
    notify();
    expect(clipboard).toBe("external text");
  });

  it("ignores programmatic selection, search results, deselection and duplicate notifications", () => {
    notify();
    expect(copy).not.toHaveBeenCalled();
    down();
    text = ""; notify();
    expect(copy).not.toHaveBeenCalled();
    text = "selected";
    notify(); notify(); up();
    expect(copy).toHaveBeenCalledOnce();
    text = "search result"; notify();
    expect(clipboard).toBe("selected");
  });

  it("ignores unfocused or hidden windows and cancels gestures when hidden", () => {
    down();
    vi.mocked(document.hasFocus).mockReturnValue(false);
    notify();
    vi.mocked(document.hasFocus).mockReturnValue(true);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    notify(); up();
    expect(copy).not.toHaveBeenCalled();
  });

  it("removes listeners and the terminal subscription on disposal", () => {
    stop();
    down(); notify(); up();
    expect(copy).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    stop = () => {};
  });
});

describe("synchronous automatic clipboard writes", () => {
  beforeEach(() => {
    Object.defineProperty(document, "execCommand", { configurable: true, writable: true, value: vi.fn(() => false) });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, "execCommand");
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("copies a real DOM selection and restores focus without queuing navigator writes", () => {
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();
    const setData = vi.fn();
    const navigatorWrite = vi.spyOn(navigator.clipboard, "writeText");
    vi.spyOn(document, "execCommand").mockImplementation(command => {
      expect(command).toBe("copy");
      const selected = document.activeElement as HTMLTextAreaElement;
      expect(selected).not.toBe(textarea);
      expect(selected.value.slice(selected.selectionStart, selected.selectionEnd)).toBe("terminal text");
      const event = new Event("copy", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { setData } });
      selected.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      return true;
    });
    expect(copySelectionText("terminal text", document)).toBe(true);
    expect(setData).toHaveBeenCalledWith("text/plain", "terminal text");
    expect(navigatorWrite).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(textarea);
    expect(document.querySelectorAll("textarea")).toHaveLength(1);
    setData.mockClear();
    textarea.dispatchEvent(new Event("copy", { bubbles: true }));
    expect(setData).not.toHaveBeenCalled();
    textarea.remove();
  });

  it("fails immediately without a deferred fallback and removes its listener", () => {
    vi.spyOn(document, "execCommand").mockImplementation(() => { throw new Error("copy denied"); });
    const remove = vi.spyOn(document, "removeEventListener");
    expect(copySelectionText("terminal text", document)).toBe(false);
    expect(remove).toHaveBeenCalledWith("copy", expect.any(Function), true);
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });

  it("starts desktop native copying immediately without the browser clipboard or DOM selection", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    const navigatorWrite = vi.spyOn(navigator.clipboard, "writeText");
    const result = copySelectionText("native terminal selection", document);
    expect(writeText).toHaveBeenCalledWith("native terminal selection");
    expect(document.execCommand).not.toHaveBeenCalled();
    expect(navigatorWrite).not.toHaveBeenCalled();
    expect(document.querySelector("textarea")).toBeNull();
    expect(await result).toBe(true);
  });

  it("does not fall back to a browser copy after a late native failure", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    let reject!: (reason: Error) => void;
    vi.mocked(writeText).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const result = copySelectionText("old terminal selection", document);
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
    reject(new Error("clipboard unavailable"));
    expect(await result).toBe(false);
    expect(document.execCommand).not.toHaveBeenCalled();
  });
});
