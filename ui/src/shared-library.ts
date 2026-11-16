import type { LibraryChanges, LibraryItem, LibraryKind, LibrarySnapshot } from "./library-protocol";

export interface NamedLibrarySource<T> {
  scope: string;
  load(): Promise<{ items: Record<string, T>; serverId: string }>;
  persist(next: Record<string, T>, before: Record<string, T>): Promise<{ items: Record<string, T>; serverId: string }>;
}

interface LibraryConnection {
  getLibrary(kind: LibraryKind): Promise<LibrarySnapshot>;
  patchLibrary(kind: LibraryKind, changes: LibraryChanges): Promise<LibrarySnapshot>;
}

export function libraryChanges<T extends LibraryItem>(before: Record<string, T>, next: Record<string, T>): LibraryChanges {
  return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(next)])].flatMap((name) => {
    const old = Object.prototype.hasOwnProperty.call(before, name) ? before[name] : null;
    const value = Object.prototype.hasOwnProperty.call(next, name) ? next[name] : null;
    return JSON.stringify(old) === JSON.stringify(value) ? [] : [[name, { before: old, after: value }]];
  }));
}

export function editorLibraryBefore<T>(items: Record<string, T>, name: string | null, initial: T): Record<string, T> {
  const before = { ...items };
  if (name) Object.defineProperty(before, name, { value: initial, enumerable: true, writable: true, configurable: true });
  return before;
}

export function sharedLibrarySource<T extends LibraryItem>(kind: LibraryKind, scope: string, connection: () => LibraryConnection | undefined): NamedLibrarySource<T> {
  const current = () => {
    const value = connection();
    if (!value) throw new Error("请先连接服务后重试");
    return value;
  };
  return {
    scope,
    async load() {
      const result = await current().getLibrary(kind);
      return { ...result, items: result.items as Record<string, T> };
    },
    async persist(next, before) {
      const result = await current().patchLibrary(kind, libraryChanges(before, next));
      return { ...result, items: result.items as Record<string, T> };
    },
  };
}
