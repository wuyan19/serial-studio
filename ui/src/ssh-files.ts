import { isTauri, tauriInvoke } from "./lib";

export const SSH_FILE_CHUNK = 64 * 1024;
export const BROWSER_DOWNLOAD_LIMIT = 100 * 1024 * 1024;
export interface SshFileEntry { name: string; path: string; kind: "directory" | "file" | "symlink" | "other"; size: number }
export interface SshFileProgress { name: string; bytes: number; total: number; files: number }
export interface SshFileClient {
  list(path: string, signal?: AbortSignal): Promise<{ path: string; entries: SshFileEntry[]; protocol?: string }>;
  preview(path: string, signal?: AbortSignal): Promise<{ text: string | null; truncated: boolean; size: number }>;
  upload(directory: boolean, target: string, progress: (p: SshFileProgress) => void, signal?: AbortSignal): Promise<boolean>;
  uploadFiles(files: File[], target: string, progress: (p: SshFileProgress) => void, signal?: AbortSignal): Promise<boolean>;
  download(entry: SshFileEntry, progress: (p: SshFileProgress) => void, signal?: AbortSignal): Promise<boolean>;
  dispose(): void;
}

export function safeRelativePath(path: string): string {
  const parts = path.split("/");
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || parts.some(p => !p || p === "." || p === "..") || /^[a-z]:/i.test(path)) throw new Error("文件路径无效");
  return parts.join("/");
}
export function joinRemotePath(parent: string, name: string): string { return `${parent.replace(/\/$/, "")}/${safeRelativePath(name)}`; }

interface UploadEntry { path: string; size: number; isDir: boolean; read(offset: number, length: number): Promise<Uint8Array> }
interface DiskHandle { kind: string; getFileHandle(name: string, options?: { create: boolean }): Promise<DiskHandle>; getDirectoryHandle(name: string, options?: { create: boolean }): Promise<DiskHandle>; createWritable(): Promise<DiskWriter> }
interface DiskWriter { write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
interface PickerWindow extends Window { showDirectoryPicker?: (options: unknown) => Promise<DiskHandle>; showSaveFilePicker?: (options: unknown) => Promise<DiskHandle> }

function temporarySuffix(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function aborted(): never { throw new DOMException("已取消传输", "AbortError"); }
function isCancel(error: unknown): boolean { return error instanceof DOMException && error.name === "AbortError"; }

async function pickBrowserFiles(directory: boolean): Promise<File[]> {
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file"; input.multiple = true; input.hidden = true;
    if (directory) input.setAttribute("webkitdirectory", "");
    const done = (files: File[]) => { input.remove(); resolve(files); };
    input.onchange = () => done(Array.from(input.files ?? []));
    input.addEventListener("cancel", () => done([]), { once: true });
    document.body.appendChild(input); input.click();
  });
}

// Stored ZIP entries keep names portable without executing or interpreting remote content.
export function createStoredZip(entries: { path: string; data: Uint8Array; directory?: boolean }[]): Blob {
  const parts: BlobPart[] = []; const central: BlobPart[] = []; let offset = 0; let centralSize = 0;
  if (entries.length > 10000) throw new Error("文件夹条目过多（上限 10000）");
  const header = (size: number) => { const bytes = new Uint8Array(size); return { bytes, view: new DataView(bytes.buffer) }; };
  for (const entry of entries) {
    const name = new TextEncoder().encode(safeRelativePath(entry.path) + (entry.directory ? "/" : ""));
    if (name.length > 65535) throw new Error("文件名过长");
    const data = entry.data; let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const h = header(30); h.view.setUint32(0, 0x04034b50, true); h.view.setUint16(4, 20, true); h.view.setUint16(6, 0x800, true);
    h.view.setUint32(14, crc, true); h.view.setUint32(18, data.length, true); h.view.setUint32(22, data.length, true); h.view.setUint16(26, name.length, true);
    parts.push(h.bytes as BlobPart, name as BlobPart, data as BlobPart);
    const c = header(46); c.view.setUint32(0, 0x02014b50, true); c.view.setUint16(4, 20, true); c.view.setUint16(6, 20, true); c.view.setUint16(8, 0x800, true);
    c.view.setUint32(16, crc, true); c.view.setUint32(20, data.length, true); c.view.setUint32(24, data.length, true); c.view.setUint16(28, name.length, true); c.view.setUint32(38, entry.directory ? 0x10 : 0, true); c.view.setUint32(42, offset, true);
    central.push(c.bytes as BlobPart, name as BlobPart); centralSize += 46 + name.length; offset += 30 + name.length + data.length;
  }
  const end = header(22); end.view.setUint32(0, 0x06054b50, true); end.view.setUint16(8, entries.length, true); end.view.setUint16(10, entries.length, true); end.view.setUint32(12, centralSize, true); end.view.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.bytes], { type: "application/zip" });
}

function saveBlob(blob: Blob, name: string) { const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); }

export type SshFileOperation =
  | { op: "open" }
  | { op: "close"; session: string }
  | { op: "list" | "stat" | "mkdir" | "remove"; session: string; path: string }
  | { op: "read"; session: string; path: string; offset: number; length: number }
  | { op: "write"; session: string; path: string; offset: number; data: string; truncate: boolean }
  | { op: "rename"; session: string; from: string; to: string };
export type SshFileResult =
  | { kind: "opened"; session: string; path: string }
  | { kind: "listed"; path: string; entries: Omit<SshFileEntry, "path">[]; protocol?: string }
  | { kind: "stat"; entry: Omit<SshFileEntry, "path"> }
  | { kind: "data"; data: string; eof: boolean }
  | { kind: "ok" };
type SessionOperation = SshFileOperation extends infer O ? O extends { session: string } ? Omit<O, "session"> : never : never;
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
const unhex = (value: string) => {
  if (value.length > SSH_FILE_CHUNK * 2 || value.length % 2 || !/^[0-9a-f]*$/i.test(value)) throw new Error("远程文件数据无效");
  return Uint8Array.from(value.match(/../g) ?? [], byte => parseInt(byte, 16));
};

export function createSshFileClient(request: (operation: SshFileOperation) => Promise<SshFileResult>, native = isTauri()): SshFileClient {
  let disposed = false;
  let session: Promise<string> | undefined;
  let activeOperations = 0;
  let closeIssued = false;
  const closeIfIdle = () => {
    if (disposed && activeOperations === 0 && session && !closeIssued) {
      closeIssued = true;
      void session.then(id => request({ op: "close", session: id })).catch(() => {});
    }
  };
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    activeOperations++;
    try { return await operation(); }
    finally { activeOperations--; closeIfIdle(); }
  };
  const check = (signal?: AbortSignal) => { if (disposed || signal?.aborted) aborted(); };
  const open = () => {
    if (!session) session = request({ op: "open" }).then(async result => {
      if (result.kind !== "opened") throw new Error("文件服务未返回会话");
      if (disposed) { closeIssued = true; await request({ op: "close", session: result.session }); aborted(); }
      return result.session;
    }).catch(error => { session = undefined; throw error; });
    return session;
  };
  const call = async (operation: SessionOperation, signal?: AbortSignal) => { check(signal); const id = await open(); check(signal); const result = await request({ ...operation, session: id } as SshFileOperation); check(signal); return result; };
  const list = async (path: string, signal?: AbortSignal) => {
    const result = await call({ op: "list", path }, signal);
    if (result.kind !== "listed") throw new Error("文件服务目录响应无效");
    return { path: result.path, protocol: result.protocol, entries: result.entries.map(entry => ({ ...entry, path: joinRemotePath(result.path, entry.name) })) };
  };
  const directories = new Set<string>();
  const mkdir = async (path: string, signal?: AbortSignal) => { if (!directories.has(path)) { await call({ op: "mkdir", path }, signal); directories.add(path); } };
  const send = async (entries: UploadEntry[], target: string, progress: (p: SshFileProgress) => void, signal?: AbortSignal) => {
    directories.clear();
    if (entries.length > 10000) throw new Error("文件夹条目过多（上限 10000）");
    const total = entries.reduce((sum, e) => sum + (e.isDir ? 0 : e.size), 0); let bytes = 0; let files = 0;
    for (const entry of entries) {
      check(signal); safeRelativePath(entry.path);
      const parts = entry.path.split("/");
      if (parts.length > 64) throw new Error("文件夹层级超过 64 层");
      for (let i = 1; i < parts.length; i++) await mkdir(joinRemotePath(target, parts.slice(0, i).join("/")), signal);
      const path = joinRemotePath(target, entry.path);
      if (entry.isDir) { await mkdir(path, signal); continue; }
      const temporary = `${path}.serial-studio-${temporarySuffix()}.part`;
      let offset = 0;
      try {
        do {
          check(signal);
          const data = entry.size === 0 ? new Uint8Array() : await entry.read(offset, Math.min(SSH_FILE_CHUNK, entry.size - offset));
          check(signal);
          if ((!data.length && offset < entry.size) || data.length > Math.min(SSH_FILE_CHUNK, entry.size - offset)) throw new Error("本地文件在上传期间发生变化");
          await call({ op: "write", path: temporary, offset, data: hex(data), truncate: offset === 0 }, signal);
          offset += data.length;
          bytes += data.length;
          progress({ name: entry.path, bytes, total, files });
        } while (offset < entry.size);
        await call({ op: "rename", from: temporary, to: path }, signal);
      } catch (error) {
        if (session) { try { const id = await session; await request({ op: "remove", session: id, path: temporary }); } catch { /* Cleanup must not hide the transfer error. */ } }
        throw error;
      }
      files++; progress({ name: entry.path, bytes, total, files });
    }
    return true;
  };
  const uploadFiles = async (files: File[], target: string, progress: (p: SshFileProgress) => void, signal?: AbortSignal) => {
    if (!files.length) return false;
    return send(files.map(file => ({ path: safeRelativePath(file.webkitRelativePath || file.name), size: file.size, isDir: false, read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()) })), target, progress, signal);
  };
  const upload = async (directory: boolean, target: string, progress: (p: SshFileProgress) => void, signal?: AbortSignal) => {
    if (!native) return uploadFiles(await pickBrowserFiles(directory), target, progress, signal);
    const pick = await tauriInvoke<{ id: string; entries: { path: string; size: number; isDir: boolean }[] } | null>("ssh_local_pick_upload", { directory });
    if (!pick) return false;
    try {
      return await send(pick.entries.map(entry => ({ ...entry, read: async (offset, length) => new Uint8Array(await tauriInvoke<number[]>("ssh_local_read", { id: pick.id, path: entry.path, offset, length })) })), target, progress, signal);
    } finally { await tauriInvoke("ssh_local_release", { id: pick.id }); }
  };
  const collect = async (entry: SshFileEntry, signal?: AbortSignal): Promise<{ entry: SshFileEntry; relative: string }[]> => {
    const result: { entry: SshFileEntry; relative: string }[] = [];
    const walk = async (item: SshFileEntry, relative: string, depth: number) => {
      check(signal); safeRelativePath(relative);
      if (depth > 64 || result.length >= 10000) throw new Error("文件夹层级或条目数超出限制");
      if (item.kind !== "file" && item.kind !== "directory") return;
      result.push({ entry: item, relative });
      if (item.kind === "directory") {
        const children = await list(item.path, signal);
        for (const child of children.entries) await walk(child, `${relative}/${safeRelativePath(child.name)}`, depth + 1);
      }
    };
    await walk(entry, safeRelativePath(entry.name), 0); return result;
  };
  const download = async (entry: SshFileEntry, progress: (p: SshFileProgress) => void, signal?: AbortSignal) => {
    if (entry.kind !== "file" && entry.kind !== "directory") throw new Error("仅支持下载普通文件或文件夹，不跟随符号链接");
    let token: string | undefined; let directory: DiskHandle | undefined; let fileHandle: DiskHandle | undefined;
    const folder = entry.kind === "directory";
    try {
      check(signal);
      if (native) {
        token = await tauriInvoke<string | null>("ssh_local_pick_download", { name: entry.name, directory: folder }) ?? undefined;
        if (!token) return false;
      } else {
        const win = window as PickerWindow;
        if (folder && win.showDirectoryPicker) directory = await win.showDirectoryPicker({ mode: "readwrite" });
        else if (!folder && win.showSaveFilePicker) fileHandle = await win.showSaveFilePicker({ suggestedName: entry.name });
      }
      const entries = await collect(entry, signal); const total = entries.reduce((sum, e) => sum + (e.entry.kind === "file" ? e.entry.size : 0), 0);
      if (!token && !directory && !fileHandle && total > BROWSER_DOWNLOAD_LIMIT) throw new Error("当前浏览器下载上限为 100 MiB，请使用桌面版或支持文件保存的浏览器");
      let bytes = 0; let files = 0; const archive: { path: string; data: Uint8Array; directory?: boolean }[] = [];
      const handles = new Map<string, DiskHandle>();
      if (directory) handles.set("", directory);
      const ensureDirectory = async (relative: string) => {
        let parent = directory!; let key = "";
        for (const part of relative.split("/")) {
          key = key ? `${key}/${part}` : part;
          if (!handles.has(key)) {
            try { await parent.getDirectoryHandle(part); throw new Error(`本地已存在同名目录：${key}`); }
            catch (error) { if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error; }
            handles.set(key, await parent.getDirectoryHandle(part, { create: true }));
          }
          parent = handles.get(key)!;
        }
        return parent;
      };
      for (const item of entries) {
        check(signal); const relative = folder ? item.relative : "";
        if (item.entry.kind === "directory") {
          if (token) await tauriInvoke("ssh_local_mkdir", { id: token, path: relative });
          else if (directory) await ensureDirectory(relative);
          else archive.push({ path: item.relative, data: new Uint8Array(), directory: true });
          continue;
        }
        let writer: DiskWriter | undefined;
        if (fileHandle) writer = await fileHandle.createWritable();
        if (directory) { const parts = relative.split("/"); const name = parts.pop()!; const parent = handles.get(parts.join("/"))!; writer = await (await parent.getFileHandle(name, { create: true })).createWritable(); }
        const chunks: Uint8Array[] = []; let offset = 0;
        try {
          do {
            const result = await call({ op: "read", path: item.entry.path, offset, length: Math.max(1, Math.min(SSH_FILE_CHUNK, item.entry.size - offset)) }, signal);
            if (result.kind !== "data") throw new Error("文件服务读取响应无效");
            const data = unhex(result.data);
            if (data.length > Math.min(SSH_FILE_CHUNK, item.entry.size - offset) || (!data.length && offset < item.entry.size)) throw new Error("远程文件读取不完整，请刷新后重试");
            if (token) await tauriInvoke("ssh_local_write", { id: token, path: relative, offset, data: Array.from(data), final: offset + data.length >= item.entry.size });
            else if (writer) await writer.write(data);
            else {
              if (bytes + data.length > BROWSER_DOWNLOAD_LIMIT) throw new Error("当前浏览器下载超出 100 MiB 上限");
              chunks.push(data);
            }
            offset += data.length; bytes += data.length; progress({ name: item.relative, bytes, total, files });
          } while (offset < item.entry.size);
          check(signal); await writer?.close();
        } catch (error) { await writer?.abort(); throw error; }
        if (!token && !writer) { const data = new Uint8Array(offset); let position = 0; for (const chunk of chunks) { data.set(chunk, position); position += chunk.length; } archive.push({ path: item.relative, data }); }
        files++; progress({ name: item.relative, bytes, total, files });
      }
      check(signal);
      if (!token && !directory && !fileHandle) saveBlob(folder ? createStoredZip(archive) : new Blob([archive[0]?.data as BlobPart]), folder ? `${entry.name}.zip` : entry.name);
      return true;
    } catch (error) { if (isCancel(error) && !signal?.aborted && !disposed) return false; throw error; }
    finally { if (token) await tauriInvoke("ssh_local_release", { id: token }); }
  };
  return {
    list: (path, signal) => run(() => list(path, signal)),
    upload: (directory, target, progress, signal) => run(() => upload(directory, target, progress, signal)),
    uploadFiles: (files, target, progress, signal) => run(() => uploadFiles(files, target, progress, signal)),
    download: (entry, progress, signal) => run(() => download(entry, progress, signal)),
    preview: (path, signal) => run(async () => {
      const metadata = await call({ op: "stat", path }, signal); if (metadata.kind !== "stat") throw new Error("文件服务元数据响应无效"); const size = metadata.entry.size;
      const result = await call({ op: "read", path, offset: 0, length: SSH_FILE_CHUNK }, signal); if (result.kind !== "data") throw new Error("文件服务读取响应无效");
      const data = unhex(result.data);
      let text: string | null = null;
      try { if (!data.includes(0)) text = new TextDecoder("utf-8", { fatal: true }).decode(data, { stream: size > data.length }); } catch { /* Binary data is never interpreted as markup. */ }
      return { text, size, truncated: size > data.length };
    }),
    dispose: () => { disposed = true; closeIfIdle(); },
  };
}
