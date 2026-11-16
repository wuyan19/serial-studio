import { describe, expect, it, vi } from "vitest";
import { createSshFileClient, createStoredZip, joinRemotePath, safeRelativePath, SSH_FILE_CHUNK, type SshFileOperation, type SshFileResult } from "./ssh-files";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./lib", () => ({ isTauri: () => false, tauriInvoke: invoke }));
const source = (size: number): File => ({ name: "a", size, webkitRelativePath: "root/a", slice: (start: number, end: number) => ({ arrayBuffer: async () => new Uint8Array(Math.min(size, end) - start).buffer }) } as File);
const opened: SshFileResult = { kind: "opened", session: "token", path: "/home" };
describe("SSH file transfers", () => {
  it("rejects path traversal and nonportable destinations", () => {
    for (const path of ["../secret", "a/../../b", "/etc/passwd", "C:/file", "a\\b", "a//b", "a/./b", "a\0b"]) expect(() => safeRelativePath(path)).toThrow();
    expect(joinRemotePath("/", "a.txt")).toBe("/a.txt");
  });
  it("uploads bounded chunks to temporary files then renames", async () => {
    const operations: SshFileOperation[] = [];
    const client = createSshFileClient(async op => { operations.push(op); return op.op === "open" ? opened : { kind: "ok" }; }, false);
    const progress = vi.fn(); await client.uploadFiles([source(SSH_FILE_CHUNK + 3)], "/tmp", progress);
    const writes = operations.filter(o => o.op === "write");
    expect(writes.map(o => [o.offset, o.data.length / 2, o.truncate])).toEqual([[0, SSH_FILE_CHUNK, true], [SSH_FILE_CHUNK, 3, false]]);
    expect(writes.every(o => o.path.endsWith(".part"))).toBe(true);
    expect(operations.filter(o => o.op === "rename").map(o => o.to)).toEqual(["/tmp/root/a"]);
    expect(progress.mock.lastCall?.[0]).toMatchObject({ bytes: SSH_FILE_CHUNK + 3, files: 1 });
  });
  it("cancellation stops chunks and removes partial uploads", async () => {
    const controller = new AbortController(); const operations: SshFileOperation[] = [];
    const client = createSshFileClient(async op => { operations.push(op); if (op.op === "write") controller.abort(); return op.op === "open" ? opened : { kind: "ok" }; }, false);
    await expect(client.uploadFiles([source(SSH_FILE_CHUNK * 2)], "/tmp", vi.fn(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(operations.filter(o => o.op === "write")).toHaveLength(1);
    expect(operations[operations.length - 1].op).toBe("remove");
    expect(operations.some(o => o.op === "rename")).toBe(false);
  });
  it("closes sessions opened after disposal and ignores late list", async () => {
    let resolve!: (v: SshFileResult) => void;
    const request = vi.fn((op: SshFileOperation): Promise<SshFileResult> => op.op === "open" ? new Promise(r => { resolve = r; }) : Promise.resolve({ kind: "ok" }));
    const client = createSshFileClient(request, false); const pending = client.list("."); client.dispose(); resolve(opened);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(request.mock.calls.map(([op]) => op.op)).toEqual(["open", "close"]);
  });
  it("previews plain UTF-8, blocks binary data and rejects malformed chunks", async () => {
    const make = (data: string) => createSshFileClient(async op => op.op === "open" ? opened : op.op === "stat" ? { kind: "stat", entry: { name: "a", kind: "file", size: 100 } } : { kind: "data", data, eof: false }, false);
    expect(await make("3c68313e").preview("/a")).toEqual({ text: "<h1>", size: 100, truncated: true });
    expect((await make("010002").preview("/a")).text).toBeNull();
    await expect(make("zz").preview("/a")).rejects.toThrow("数据无效");
  });
  it("creates portable stored ZIP with correct CRC", async () => {
    const blob = createStoredZip([{ path: "目录", data: new Uint8Array(), directory: true }, { path: "目录/a.txt", data: new TextEncoder().encode("123456789") }]);
    const bytes = new Uint8Array(await blob.arrayBuffer()); const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint32(30 + new TextEncoder().encode("目录/").length + 14, true)).toBe(0xcbf43926);
    expect(view.getUint16(bytes.length - 12, true)).toBe(2);
    expect(() => createStoredZip([{ path: "../escape", data: bytes }])).toThrow();
  });
  it("downloads nested folders through bounded native writes and releases the selection", async () => {
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      calls.push({ command, args });
      return command === "ssh_local_pick_download" ? "local-token" : undefined;
    });
    const client = createSshFileClient(async op => {
      if (op.op === "open") return opened;
      if (op.op === "list") return { kind: "listed", path: "/root", entries: [{ name: "a.txt", kind: "file", size: 3 }, { name: "link", kind: "symlink", size: 100 }] };
      if (op.op === "read") return { kind: "data", data: "616263", eof: true };
      return { kind: "ok" };
    }, true);
    const progress = vi.fn();
    await client.download({ name: "root", path: "/root", kind: "directory", size: 4096 }, progress);
    expect(calls.map(c => c.command)).toEqual(["ssh_local_pick_download", "ssh_local_mkdir", "ssh_local_write", "ssh_local_release"]);
    expect(calls[2].args).toEqual({ id: "local-token", path: "root/a.txt", offset: 0, data: [97, 98, 99], final: true });
    expect(progress.mock.lastCall?.[0]).toEqual({ name: "root/a.txt", bytes: 3, total: 3, files: 1 });
  });
  it("releases native download tokens without committing an incomplete file", async () => {
    const controller = new AbortController(); const calls: string[] = [];
    invoke.mockImplementation(async (command: string) => { calls.push(command); return command === "ssh_local_pick_download" ? "local-token" : undefined; });
    const client = createSshFileClient(async op => {
      if (op.op === "open") return opened;
      controller.abort(); return { kind: "data", data: "61", eof: true };
    }, true);
    await expect(client.download({ name: "a", path: "/a", kind: "file", size: 1 }, vi.fn(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toEqual(["ssh_local_pick_download", "ssh_local_release"]);
  });

  it("commits empty and multi-chunk native downloads only at their last chunk", async () => {
    const writes: Record<string, unknown>[] = []; const releases: unknown[] = [];
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "ssh_local_pick_download") return "local-token";
      if (command === "ssh_local_write") writes.push(args);
      if (command === "ssh_local_release") releases.push(args);
    });
    let size = 0;
    const client = createSshFileClient(async op => op.op === "open" ? opened : op.op === "read" ? { kind: "data", data: "61".repeat(Math.min(op.length, size - op.offset)), eof: op.offset + op.length >= size } : { kind: "ok" }, true);
    await client.download({ name: "empty", path: "/empty", kind: "file", size }, vi.fn());
    expect(writes).toEqual([{ id: "local-token", path: "", offset: 0, data: [], final: true }]);
    writes.length = 0; size = SSH_FILE_CHUNK + 2;
    await client.download({ name: "large", path: "/large", kind: "file", size }, vi.fn());
    expect(writes.map(w => [w.offset, (w.data as number[]).length, w.final])).toEqual([[0, SSH_FILE_CHUNK, false], [SSH_FILE_CHUNK, 2, true]]);
    expect(releases).toHaveLength(2);
  });
  it("preserves empty folders and skips symlinks without traversing them", async () => {
    const directories: string[] = []; const readPaths: string[] = [];
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "ssh_local_pick_download") return "local-token";
      if (command === "ssh_local_mkdir") directories.push(args.path as string);
    });
    const client = createSshFileClient(async op => {
      if (op.op === "open") return opened;
      if (op.op === "list") {
        readPaths.push(op.path);
        return { kind: "listed", path: op.path, entries: op.path === "/root" ? [{ name: "empty", kind: "directory", size: 4096 }, { name: "loop", kind: "symlink", size: 0 }] : [] };
      }
      return { kind: "ok" };
    }, true);
    await client.download({ name: "root", path: "/root", kind: "directory", size: 0 }, vi.fn());
    expect(directories).toEqual(["root", "root/empty"]);
    expect(readPaths).toEqual(["/root", "/root/empty"]);
  });
  it("does not open remote files when native destination selection is cancelled", async () => {
    invoke.mockResolvedValue(null); const request = vi.fn();
    const client = createSshFileClient(request, true);
    await expect(client.download({ name: "a", path: "/a", kind: "file", size: 1 }, vi.fn())).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
  it("stops reading on native write failure and releases partial output", async () => {
    const calls: string[] = []; let reads = 0;
    invoke.mockImplementation(async (command: string) => {
      calls.push(command);
      if (command === "ssh_local_pick_download") return "local-token";
      if (command === "ssh_local_write") throw new Error("磁盘已满");
    });
    const client = createSshFileClient(async op => {
      if (op.op === "open") return opened;
      if (op.op === "read") { reads++; return { kind: "data", data: "61".repeat(op.length), eof: false }; }
      return { kind: "ok" };
    }, true);
    await expect(client.download({ name: "a", path: "/a", kind: "file", size: SSH_FILE_CHUNK * 2 }, vi.fn())).rejects.toThrow("磁盘已满");
    expect(reads).toBe(1); expect(calls[calls.length - 1]).toBe("ssh_local_release");
  });
  it("rejects oversized browser fallbacks before reading data or saving a ZIP", async () => {
    vi.stubGlobal("window", {});
    const request = vi.fn(async (op: SshFileOperation): Promise<SshFileResult> => op.op === "open" ? opened : { kind: "listed", path: "/root", entries: [{ name: "big", kind: "file", size: 101 * 1024 * 1024 }] });
    const client = createSshFileClient(request, false);
    try {
      await expect(client.download({ name: "root", path: "/root", kind: "directory", size: 0 }, vi.fn())).rejects.toThrow("100 MiB");
      expect(request.mock.calls.map(([op]) => op.op)).toEqual(["open", "list"]);
    } finally { vi.unstubAllGlobals(); }
  });

  it("cleans partial uploads before closing a disposed session", async () => {
    const operations: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let writing!: () => void;
    const started = new Promise<void>(resolve => { writing = resolve; });
    const client = createSshFileClient(async op => {
      operations.push(op.op);
      if (op.op === "open") return opened;
      if (op.op === "write") { writing(); await blocked; }
      return { kind: "ok" };
    }, false);
    const pending = client.uploadFiles([source(1)], "/tmp", vi.fn());
    await started; client.dispose();
    expect(operations).not.toContain("close");
    release(); await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(operations.slice(-2)).toEqual(["remove", "close"]);
  });

});
