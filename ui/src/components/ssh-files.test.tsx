// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SshFilesPanel } from "./ssh-files";
import type { SshFileClient, SshFileProgress } from "../ssh-files";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const listing = { path: "/tmp/local_config", entries: [{ name: "remote.txt", path: "/tmp/local_config/remote.txt", kind: "file" as const, size: 10 }], protocol: "ssh" };
function fixture(): SshFileClient {
  return {
    list: vi.fn(async () => listing),
    preview: vi.fn(async () => ({ text: "remote file", truncated: false, size: 10 })),
    upload: vi.fn(async () => true),
    uploadFiles: vi.fn(async () => true),
    download: vi.fn(async () => true),
    dispose: vi.fn(),
  };
}
function FocusParent({ client }: { client: SshFileClient }) {
  const [focuses, setFocuses] = useState(0);
  return <div data-focuses={focuses} onMouseDownCapture={() => setFocuses(value => value + 1)}>
    <SshFilesPanel client={client} label="fixture" onClose={() => {}} />
  </div>;
}

describe("SSH file drop confirmation", () => {
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
  async function mount(client: SshFileClient) {
    await act(async () => root.render(<FocusParent client={client} />));
  }
  function button(name: string) {
    const result = Array.from(container.querySelectorAll("button")).find(item => item.textContent === name);
    if (!result) throw new Error(`Missing button: ${name}`);
    return result;
  }
  async function click(target: HTMLButtonElement) {
    await act(async () => {
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    expect(target.isConnected).toBe(true);
    await act(async () => {
      target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      target.click();
    });
  }
  async function drop(file = new File(["<p>local HTML</p>"], "ap.html", { type: "text/html" })) {
    let active = true;
    const transfer = {
      types: ["Files", "text/uri-list"],
      items: [{ webkitGetAsEntry: () => ({ isDirectory: false }) }],
      get files() { return active ? [file] : []; },
      dropEffect: "none",
    };
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    await act(async () => { container.querySelector(".ssh-files__list")!.dispatchEvent(event); });
    active = false;
    expect(event.defaultPrevented).toBe(true);
    return file;
  }
  it("retains dropped files past the drag event and uploads after a parent focus update", async () => {
    const client = fixture();
    const completion = deferred<boolean>();
    let update!: (progress: SshFileProgress) => void;
    vi.mocked(client.uploadFiles).mockImplementation(async (files, target, progress) => {
      expect(await files[0].text()).toBe("<p>local HTML</p>");
      expect(target).toBe("/tmp/local_config");
      update = progress;
      return completion.promise;
    });
    await mount(client);
    const file = await drop();
    expect(client.uploadFiles).not.toHaveBeenCalled();
    const confirm = button("确认上传");
    expect(confirm.disabled).toBe(false);
    await click(confirm);
    expect(client.uploadFiles).toHaveBeenCalledWith([file], "/tmp/local_config", expect.any(Function), expect.any(AbortSignal));
    expect(container.querySelector(".ssh-files__confirm")).toBeNull();
    await act(async () => update({ name: "ap.html", bytes: 5, total: 17, files: 0 }));
    expect(container.querySelector("progress")).not.toBeNull();
    await act(async () => completion.resolve(true));
    expect(container.querySelector(".ssh-files__footer")?.textContent).toBe("上传完成");
    expect(client.list).toHaveBeenCalledTimes(2);
  });
  it("cancels the pending drop without uploading", async () => {
    const client = fixture();
    await mount(client);
    await drop();
    await click(button("取消"));
    expect(container.querySelector(".ssh-files__confirm")).toBeNull();
    expect(client.uploadFiles).not.toHaveBeenCalled();
  });
  it("does not disable a captured upload while an unrelated preview is loading", async () => {
    const client = fixture();
    const preview = deferred<{ text: string; truncated: boolean; size: number }>();
    let previewSignal: AbortSignal | undefined;
    vi.mocked(client.preview).mockImplementation((_path, signal) => { previewSignal = signal; return preview.promise; });
    await mount(client);
    await drop();
    const previewButton = Array.from(container.querySelectorAll("button")).find(item => item.textContent?.includes("remote.txt"))!;
    await click(previewButton);
    expect(container.textContent).toContain("正在读取文件");
    expect(button("确认上传").disabled).toBe(false);
    await click(button("确认上传"));
    expect(client.uploadFiles).toHaveBeenCalledTimes(1);
    expect(previewSignal?.aborted).toBe(true);
    await act(async () => preview.resolve({ text: "late preview must be ignored", truncated: false, size: 10 }));
    expect(container.textContent).not.toContain("late preview must be ignored");
    expect(container.querySelector(".ssh-files__footer")?.textContent).toBe("上传完成");
  });
  it("ignores additional drops during a running transfer", async () => {
    const client = fixture();
    const completion = deferred<boolean>();
    vi.mocked(client.uploadFiles).mockReturnValue(completion.promise);
    await mount(client);
    await drop();
    await click(button("确认上传"));
    await drop(new File(["second"], "second.txt"));
    expect(container.querySelector(".ssh-files__confirm")).toBeNull();
    expect(client.uploadFiles).toHaveBeenCalledTimes(1);
    await act(async () => completion.resolve(true));
  });
  it("surfaces an upload failure and leaves the controls usable", async () => {
    const client = fixture();
    vi.mocked(client.uploadFiles).mockRejectedValue(new Error("Remote permission denied"));
    await mount(client);
    await drop();
    await click(button("确认上传"));
    expect(container.querySelector(".ssh-files__error")?.textContent).toContain("Remote permission denied");
    expect(container.querySelector(".ssh-files__confirm")).toBeNull();
    expect(container.querySelector("progress")).toBeNull();
    expect(button("文件").disabled).toBe(false);
  });
  it("rejects drops until the initial directory has loaded", async () => {
    const client = fixture();
    const pending = deferred<typeof listing>();
    vi.mocked(client.list).mockReturnValue(pending.promise);
    await mount(client);
    await drop();
    expect(container.querySelector(".ssh-files__confirm")).toBeNull();
    expect(client.uploadFiles).not.toHaveBeenCalled();
    await act(async () => pending.resolve(listing));
    await drop();
    expect(button("确认上传").disabled).toBe(false);
  });
});
