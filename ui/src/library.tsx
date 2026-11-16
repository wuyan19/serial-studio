/**
 * 命名库泛型（宏/脚本共用）：名字是 Record key、group 是字段、可分组折叠、可导入导出的
 * 命名条目集合。此前宏与脚本是两套逐行复制的 state + handler（编辑/保存/删除/重命名组/
 * 解散组/导入/折叠持久化），第三种命名库出现时复制成本会再翻倍——此处收敛为一份实现，
 * 差异（判别、校验、新建默认、加载/持久化通道）全部由 LibrarySpec 注入。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  dissolveGroup,
  isTauri,
  loadMacrosLocal,
  loadScriptsLocal,
  renameGroup,
  tauriInvoke,
  upsertNamed,
} from "./lib";
import { IconAlert, IconTrash } from "./icons";
import type { Macro, Script } from "./types";
import { editorLibraryBefore, type NamedLibrarySource } from "./shared-library";

/** 宿主 UI 能力（App 注入：确认弹窗 / 提示横幅 / 错误横幅）。 */
export interface LibraryUI {
  confirm: (s: {
    title: string;
    icon?: React.ReactNode;
    message: string;
    /** 必填动词式按钮文案（如「删除」「解散」），避免泛化「确定」。 */
    confirmText: string;
    tone?: "primary" | "danger";
    onConfirm: () => void | Promise<void>;
  }) => void;
  /** 轻提示（几秒后自动消失）。 */
  notify: (msg: string, ms?: number) => void;
  /** 错误横幅（几秒后自动消失）。 */
  error: (msg: string, ms?: number) => void;
}

/** 每个命名库的差异面。 */
export interface LibrarySpec<T> {
  /** 中文名（「宏」/「脚本」），用于确认弹窗与提示文案。 */
  label: string;
  /** 导入 JSON 值判别（如「有 steps 数组即宏」）。 */
  isItemLike: (v: unknown) => v is T;
  /** 保存/导入校验：null = 通过，否则为错误文案（名字校验在外层，另行处理）。 */
  validateItem: (v: T) => string | null;
  /** 新建条目默认值（编辑器新建分支用）。 */
  newItem: () => T;
  /** 导入重名时的兜底名前缀（「导入的宏」）。 */
  importBase: string;
  /** 导入解析失败的提示文案。 */
  importHint: string;
  /** 分组折叠态的 localStorage key。 */
  collapsedKey: string;
  /** 加载：Tauri → invoke；Web → localStorage。返回 Promise 或同步值均可。 */
  load: () => Promise<Record<string, T>> | Record<string, T>;
  /** 持久化（内部已按 Tauri/Web 分流）。 */
  persist: (items: Record<string, T>) => Promise<void>;
}

/** 重名兜底：「基名 2」「基名 3」… */
export function uniqueName(base: string, taken: Record<string, unknown>): string {
  if (!taken[base]) return base;
  let i = 2;
  while (taken[`${base} ${i}`]) i++;
  return `${base} ${i}`;
}

/** 导入 JSON → [名称, 条目]：兼容 {"名称": 条目} 记录 与 单个条目对象。无效项丢弃。 */
export function parseImportedItems<T>(
  data: unknown,
  isItemLike: (v: unknown) => v is T,
  existing: Record<string, T>,
  importBase: string
): [string, T][] {
  if (isItemLike(data)) return [[uniqueName(importBase, existing), data]];
  if (data && typeof data === "object") {
    const out: [string, T][] = [];
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (isItemLike(v)) out.push([k, v]);
    }
    return out;
  }
  return [];
}

/** 宏/脚本共用的 useNamedLibrary 返回面。 */
export function useNamedLibrary<T extends { group?: string }>(spec: LibrarySpec<T>, ui: LibraryUI, source?: NamedLibrarySource<T>) {
  const [items, setItems] = useState<Record<string, T>>({});
  const [editing, setEditing] = useState<{ name: string; isNew: boolean } | null>(null);
  const [editorName, setEditorName] = useState("");
  const [editorItem, setEditorItem] = useState<T>(spec.newItem);
  const [editorError, setEditorError] = useState("");
  /** 打开时的快照（名字+条目），供 closeEditor 判 dirty。 */
  const [editorInitial, setEditorInitial] = useState<{ name: string; item: T }>({ name: "", item: spec.newItem() });
  /** 侧栏分组折叠状态（收起的组名集合，localStorage 持久化，单一数据源集中写盘）。 */
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(JSON.parse(localStorage.getItem(spec.collapsedKey) ?? "[]") as string[])
  );

  useEffect(() => {
    localStorage.setItem(spec.collapsedKey, JSON.stringify([...collapsed]));
  }, [collapsed, spec.collapsedKey]);

  const sourceRef = useRef(source);
  const specRef = useRef(spec);
  const uiRef = useRef(ui);
  const scopeRef = useRef(source?.scope);
  const request = useRef(0);
  const loaded = useRef(false);
  const active = useRef(true);
  const serverId = useRef<string | null>(null);
  sourceRef.current = source;
  specRef.current = spec;
  uiRef.current = ui;
  if (scopeRef.current !== source?.scope) {
    scopeRef.current = source?.scope;
    request.current++;
    loaded.current = false;
    serverId.current = null;
  }

  const reload = useCallback(async () => {
    const number = ++request.current;
    loaded.current = false;
    const adapter = sourceRef.current;
    try {
      const result = adapter ? await adapter.load() : { items: await specRef.current.load(), serverId: "legacy" };
      if (!active.current || number !== request.current || adapter !== sourceRef.current) return;
      if (serverId.current && serverId.current !== result.serverId) setEditing(null);
      serverId.current = result.serverId;
      loaded.current = true;
      setItems(result.items);
    } catch (error) {
      if (!active.current || number !== request.current || adapter !== sourceRef.current) return;
      loaded.current = false;
      uiRef.current.error(`加载${specRef.current.label}失败：${String(error instanceof Error ? error.message : error)}`);
    }
  }, []);
  useEffect(() => {
    active.current = true;
    loaded.current = false;
    serverId.current = null;
    setItems({});
    setEditing(null);
    setEditorError("");
    if (!sourceRef.current) void reload();
    return () => { active.current = false; request.current++; loaded.current = false; };
  }, [source?.scope, reload]);

  const commit = async (next: Record<string, T>, before = items): Promise<boolean> => {
    const adapter = sourceRef.current;
    if (!active.current || !loaded.current || adapter?.scope !== source?.scope) {
      ui.error("库尚未加载或连接已切换，请连接服务并重新打开编辑器");
      return false;
    }
    const scope = request.current;
    const owner = serverId.current;
    try {
      const saved = adapter ? await adapter.persist(next, before) : (await spec.persist(next), { items: next, serverId: "legacy" });
      if (!active.current || adapter !== sourceRef.current || scopeRef.current !== source?.scope) return false;
      if (owner !== saved.serverId) {
        loaded.current = false;
        setEditing(null);
        ui.error("服务身份已变化，请重新加载后重试");
        void reload();
        return false;
      }
      request.current++;
      setItems(saved.items);
      void reload();
      return true;
    } catch (error) {
      if (!active.current || adapter !== sourceRef.current || scopeRef.current !== source?.scope) return false;
      const message = `保存${spec.label}失败：${String(error instanceof Error ? error.message : error)}`;
      setEditorError(message);
      ui.error(message);
      if (scope === request.current) void reload();
      return false;
    }
  };

  const openEditor = (name: string | null) => {
    if (name && items[name]) {
      setEditing({ name, isNew: false });
      setEditorName(name);
      setEditorItem(JSON.parse(JSON.stringify(items[name])));
      setEditorInitial({ name, item: items[name] });
    } else {
      setEditing({ name: "", isNew: true });
      setEditorName("");
      setEditorItem(spec.newItem());
      setEditorInitial({ name: "", item: spec.newItem() });
    }
    setEditorError("");
  };

  /** 关闭编辑器;有未保存改动先确认(保存/删除路径不经此处,直接 setEditing(null))。 */
  const closeEditor = () => {
    if (!editing) return;
    const dirty =
      editorName !== editorInitial.name ||
      JSON.stringify(editorItem) !== JSON.stringify(editorInitial.item);
    if (!dirty) {
      setEditing(null);
      return;
    }
    ui.confirm({
      title: "放弃未保存的修改",
      icon: <IconAlert />,
      message: `修改尚未保存，关闭后将丢失。`,
      confirmText: "放弃修改",
      tone: "danger",
      onConfirm: () => setEditing(null),
    });
  };

  const saveDef = async () => {
    const trimmedName = editorName.trim();
    if (!trimmedName) {
      setEditorError(`${spec.label}名不能为空`);
      return;
    }
    const err = spec.validateItem(editorItem);
    if (err) {
      setEditorError(err);
      return;
    }
    const oldKey = editing && !editing.isNew ? editing.name : null;
    const next = upsertNamed(items, oldKey, trimmedName, editorItem);
    if (!next) {
      setEditorError(`已存在同名${spec.label}`);
      return;
    }
    const before = editorLibraryBefore(items, oldKey, editorInitial.item);
    if (await commit(next, before)) setEditing(null);
  };

  const askDelete = (name: string) => {
    ui.confirm({
      title: `删除${spec.label}`,
      icon: <IconTrash />,
      message: `删除${spec.label}「${name}」？此操作不可恢复。`,
      confirmText: "删除",
      tone: "danger",
      onConfirm: async () => {
        const next = { ...items };
        delete next[name];
        if (await commit(next)) setEditing(null);
      },
    });
  };

  const renameItemGroup = async (oldName: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return; // 空名忽略（防误解散；解散走 askDissolve）
    const merged = trimmed !== oldName && Object.values(items).some((m) => m.group === trimmed);
    const next = renameGroup(items, oldName, trimmed);
    if (!await commit(next)) return;
    setCollapsed((prev) => {
      if (!prev.has(oldName)) return prev;
      const n = new Set(prev);
      n.delete(oldName);
      n.add(trimmed);
      return n;
    });
    if (merged) ui.notify(`已合并到组「${trimmed}」`, 4000);
  };

  const askDissolve = (name: string) => {
    const count = Object.values(items).filter((m) => m.group === name).length;
    ui.confirm({
      title: "解散分组",
      icon: <IconAlert />,
      message: `解散分组「${name}」？其中 ${count} 个${spec.label}将移至「未分组」，不会被删除。`,
      confirmText: "解散",
      tone: "danger",
      onConfirm: async () => {
        const { next } = dissolveGroup(items, name);
        if (!await commit(next)) return;
        setCollapsed((prev) => {
          if (!prev.has(name)) return prev;
          const n = new Set(prev);
          n.delete(name);
          return n;
        });
      },
    });
  };

  /** 导入：读 JSON 文件，合并入库（重名/无效跳过）。 */
  const importFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const entries = parseImportedItems(data, spec.isItemLike, items, spec.importBase);
      if (entries.length === 0) {
        ui.error(spec.importHint, 6000);
        return;
      }
      const next = { ...items };
      let added = 0;
      let skipped = 0;
      for (const [n, m] of entries) {
        if (next[n] || spec.validateItem(m)) {
          skipped++;
          continue;
        }
        next[n] = m;
        added++;
      }
      if (added > 0) {
        if (!await commit(next)) return;
      }
      ui.notify(`导入完成：新增 ${added} 个${skipped ? `，跳过 ${skipped} 个（重名或无效）` : ""}。`, 5000);
    } catch (err) {
      ui.error(`导入失败：${String(err)}，请确认文件为有效的 JSON`, 6000);
    }
  };

  const toggleGroup = (g: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  /** 现存组名列表（编辑器 datalist 用）。 */
  const groupNames = Array.from(new Set(Object.values(items).map((m) => m.group).filter((g): g is string => !!g)));

  return {
    items,
    setItems,
    editing,
    setEditing,
    closeEditor,
    editorName,
    setEditorName,
    editorItem,
    setEditorItem,
    editorError,
    setEditorError,
    openEditor,
    saveDef,
    askDelete,
    renameItemGroup,
    askDissolve,
    importFile,
    reload,
    collapsed,
    toggleGroup,
    groupNames,
  };
}

// ===== 宏/脚本的判别与加载通道（与 useNamedLibrary 的 spec 搭配使用） =====

/** 对象是否像一个 Macro（有 steps 数组）。 */
export function isMacroLike(v: unknown): v is Macro {
  return !!v && typeof v === "object" && Array.isArray((v as { steps?: unknown }).steps);
}

/** 对象是否像一个 Script（有 code 字符串）。 */
export function isScriptLike(v: unknown): v is Script {
  return !!v && typeof v === "object" && typeof (v as { code?: unknown }).code === "string";
}

/** 宏加载：Tauri → invoke load_macros；Web → localStorage 回退。 */
export function loadMacros(): Promise<Record<string, Macro>> | Record<string, Macro> {
  return isTauri() ? tauriInvoke<Record<string, Macro>>("load_macros") : loadMacrosLocal();
}

/** 脚本加载：Tauri → invoke load_scripts；Web → localStorage 回退。 */
export function loadScripts(): Promise<Record<string, Script>> | Record<string, Script> {
  return isTauri() ? tauriInvoke<Record<string, Script>>("load_scripts") : loadScriptsLocal();
}
