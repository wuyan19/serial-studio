import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActionId,
  ConnConfig,
  Group,
  Macro,
  MacroResult,
  PaneHalf,
  PaneNode,
  PortId,
  PortInfo,
  RemoteDevice,
  Script,
  ScriptResult,
  ScriptRunCard,
  MacroRunCard,
  SerialConfig,
  SrvSettings,
  TermInstance,
} from "./types";
import { createRoot, leafGroupIds, removeLeaf, splitLeaf } from "./pane-tree";
import {
  downloadJson,
  getRemoteFromUrl,
  initConn,
  dissolveGroup,
  groupBy,
  isTauri,
  renameGroup,
  upsertNamed,
  loadConfig,
  loadMacrosLocal,
  loadScriptsLocal,
  parsePortId,
  persistMacros,
  persistRemotes,
  persistScripts,
  portIdOf,
  saveConfig,
  saveConn,
  tauriInvoke,
} from "./lib";
import { LocalTransport, RemoteTransport, type Transport } from "./transport";
import {
  AboutDialog,
  ActivityIcon,
  ConfirmDialog,
  ExportMacrosDialog,
  ExportScriptsDialog,
  GroupHead,
  GroupView,
  InlineAliasInput,
  MacroEditor,
  MacroPalette,
  ScriptPalette,
  PortPalette,
  newStep,
  PortLabel,
  RemoteDialog,
  ScriptEditor,
  ScriptRunParamsDialog,
  ScriptSkillDialog,
  SearchBar,
  SerialConfigDialog,
  SettingsPanel,
  ShortcutsDialog,
  TermView,
  validateMacro,
} from "./components";
import {
  IconAlert,
  IconBolt,
  IconClose,
  IconCode,
  IconEdit,
  IconExport,
  IconGear,
  IconGlobe,
  IconInfo,
  IconImport,
  IconPlay,
  IconPlug,
  IconPlus,
  IconPower,
  IconRefresh,
  IconSliders,
  IconTrash,
  IconMoon,
  IconSun,
} from "./icons";
import { getTheme, subscribe, toggleTheme, type Theme } from "./theme";
import { eventToCombo, findAction } from "./shortcuts";

type Activity = { rx: number; tx: number };

/** 把 SerialConfig 渲染成仪器读数字符串：115200 8N1 · LF */
function formatConfig(c: SerialConfig): string {
  const db = ({ eight: "8", seven: "7", six: "6", five: "5" } as Record<string, string>)[c.data_bits] ?? c.data_bits;
  const sb = ({ one: "1", two: "2" } as Record<string, string>)[c.stop_bits] ?? c.stop_bits;
  const pa = ({ none: "N", odd: "O", even: "E" } as Record<string, string>)[c.parity] ?? c.parity;
  const le = ({ lf: "LF", crlf: "CRLF", cr: "CR" } as Record<string, string>)[c.line_ending] ?? c.line_ending.toUpperCase();
  return `${c.baud_rate} ${db}${pa}${sb} · ${le}`;
}

/**
 * 双通道 TX/RX 活动指示——签名元素。
 * rAF 轮询读取活动时间戳（来自真实数据面：onData=RX，onWrite=TX），
 * 命令式刷新 LED 的 data-active，避免每帧 React 重渲染。
 * prefers-reduced-motion 下 CSS 关闭过渡，LED 仍如实反映流量（只是不脉动）。
 */
function Leds({ port, activityRef }: { port: string; activityRef: React.MutableRefObject<Map<string, Activity>> }) {
  const rxRef = useRef<HTMLSpanElement>(null);
  const txRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const THRESHOLD = 280;
    const loop = () => {
      const e = activityRef.current.get(port);
      const now = performance.now();
      const rxOn = !!e && now - e.rx < THRESHOLD;
      const txOn = !!e && now - e.tx < THRESHOLD;
      if (rxRef.current) rxRef.current.setAttribute("data-active", String(rxOn));
      if (txRef.current) txRef.current.setAttribute("data-active", String(txOn));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [port, activityRef]);
  return (
    <div className="txrx">
      <div className="txrx__group">
        <span className="led" data-dir="rx" ref={rxRef} />
        <span className="txrx__label rx">RX</span>
      </div>
      <div className="txrx__group">
        <span className="led" data-dir="tx" ref={txRef} />
        <span className="txrx__label tx">TX</span>
      </div>
    </div>
  );
}

/** 对象是否像一个 Macro（有 steps 数组）。 */
function isMacroLike(v: unknown): v is Macro {
  return !!v && typeof v === "object" && Array.isArray((v as { steps?: unknown }).steps);
}
function uniqueMacroName(base: string, taken: Record<string, unknown>): string {
  if (!taken[base]) return base;
  let i = 2;
  while (taken[`${base} ${i}`]) i++;
  return `${base} ${i}`;
}
/** 导入 JSON → [名称, 宏]：兼容 {"名称": 宏} 记录 与 单个宏对象。 */
function parseImportedMacros(data: unknown, existing: Record<string, Macro>): [string, Macro][] {
  if (isMacroLike(data)) return [[uniqueMacroName("导入的宏", existing), data]];
  if (data && typeof data === "object") {
    const out: [string, Macro][] = [];
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (isMacroLike(v)) out.push([k, v]);
    }
    return out;
  }
  return [];
}

/** 对象是否像一个 Script（有 code 字符串）。 */
function isScriptLike(v: unknown): v is Script {
  return !!v && typeof v === "object" && typeof (v as { code?: unknown }).code === "string";
}
function uniqueScriptName(base: string, taken: Record<string, unknown>): string {
  if (!taken[base]) return base;
  let i = 2;
  while (taken[`${base} ${i}`]) i++;
  return `${base} ${i}`;
}
/** 导入 JSON → [名称, 脚本]：兼容 {"名称": 脚本} 记录 与 单个脚本对象。 */
function parseImportedScripts(data: unknown, existing: Record<string, Script>): [string, Script][] {
  if (isScriptLike(data)) return [[uniqueScriptName("导入的脚本", existing), data]];
  if (data && typeof data === "object") {
    const out: [string, Script][] = [];
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (isScriptLike(v)) out.push([k, v]);
    }
    return out;
  }
  return [];
}

/** Web/远程窗口：把单连接配置派生为单设备列表（id 固定 "remote"，无 localStorage 持久化）。 */
function initRemoteFromConn(c: ConnConfig): RemoteDevice[] {
  return [{ id: "remote", host: c.host, port: c.port }];
}

/**
 * Serial Studio 前端主组件（Tauri 与浏览器共用）。
 * 数据面走 Transport（本地 IPC / 远程 WS），控制面走 Tauri invoke。
 * 仪器风布局：活动栏 + 可收起次侧栏 + 通道条 + 主终端区。
 */
export default function App() {
  const isRemote = !!getRemoteFromUrl();
  const isLocal = isTauri() && !isRemote;
  // portsByDev：按设备域分桶的端口列表（key=devId）。本地 devId="local"，远程=设备 UUID/窗口 "remote"。
  // devId 由桶 key 隐含（不进 PortInfo），保后端契约零侵入。多 Transport 共存的核心数据结构。
  const [portsByDev, setPortsByDev] = useState<Record<string, PortInfo[]>>({});
  const [macros, setMacros] = useState<Record<string, Macro>>({});
  /** 宏运行卡片:runId → MacroRunCard(贯穿 running→done,并发各自,就地切换)。 */
  const [macroRuns, setMacroRuns] = useState<Map<string, MacroRunCard>>(new Map());
  // devOnline[devId]：该设备 WS/IPC 是否就绪，驱动折叠卡状态点。
  const [devOnline, setDevOnline] = useState<Record<string, boolean>>({});
  /** 全局连接标志（兼容旧消费方：通道条/Web 远程提示）。本地看 devOnline["local"]，远程看任一就绪。 */
  const connected = isLocal ? !!devOnline["local"] : Object.values(devOnline).some(Boolean);
  const [openPorts, setOpenPorts] = useState<PortId[]>([]);
  /** 设备断开(USB 拔出)但 tab 保留的端口——可手动重连。区别于主动关(从 openPorts 移除)。 */
  const [disconnectedPorts, setDisconnectedPorts] = useState<Set<PortId>>(new Set());
  const [portConfigs, setPortConfigs] = useState<Record<string, SerialConfig>>({});
  /** editor-group 分栏：每个 group = 标签栏 + 终端区。端口唯一归属一个 group（不扇出）。
   *  单 group（layout 单叶）时 openPorts == groups[g1].ports，行为同单视图。多 group 见后续 Phase。 */
  const groupIdSeq = useRef(1);
  const [groups, setGroups] = useState<Record<string, Group>>(() => ({ g1: { id: "g1", ports: [], activePort: "" } }));
  const [layout, setLayout] = useState<PaneNode>(() => createRoot("g1"));
  const [focusedGroupId, setFocusedGroupId] = useState("g1");
  /** 拖拽分栏时的落点高亮（{overGroupId, overHalf} | null；onDragEnd/Leave 清）。 */
  const [dropHint, setDropHint] = useState<{ overGroupId: string; overHalf: PaneHalf } | null>(null);
  /** group 终端容器 DOM 集合（GroupView 上报）。TermView 经 DOM reparent 挪入对应容器，
   *  跨 group 搬 tab 只换容器、组件不重建 → 保 scrollback。 */
  const [groupContainers, setGroupContainers] = useState<Map<string, HTMLDivElement>>(new Map());
  const setGroupContainer = useCallback((groupId: string, el: HTMLDivElement | null) => {
    setGroupContainers((prev) => {
      const m = new Map(prev);
      if (el) m.set(groupId, el);
      else m.delete(groupId);
      return m;
    });
  }, []);
  const [errorMsg, setErrorMsg] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingPort, setPendingPort] = useState<string | null>(null);
  const [serialConfig, setSerialConfig] = useState<SerialConfig>(loadConfig);
  const [connConfig, setConnConfig] = useState<ConnConfig>(initConn);
  // 已知远程设备列表：桌面端先空（mount effect 异步 invoke load_remotes 填充，见下）；
  // Web/远程窗口由 connConfig 派生单设备（不持久化）。
  const [remotes, setRemotes] = useState<RemoteDevice[]>(() =>
    isLocal ? [] : initRemoteFromConn(connConfig),
  );
  // 展开的远程设备卡（= 需要连接）。桌面端先空（mount effect 加载 remotes 后全展开 → 自动重连）；
  // Web/远程窗口默认展开其唯一设备。
  const [expandedRemotes, setExpandedRemotes] = useState<Set<string>>(() =>
    isLocal ? new Set() : new Set(["remote"]),
  );
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [remoteInput, setRemoteInput] = useState({ host: "", port: 18700, nickname: "" });
  const [srvSettings, setSrvSettings] = useState<SrvSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editing, setEditing] = useState<{ name: string; isNew: boolean } | null>(null);
  const [editorName, setEditorName] = useState("");
  const [editorMacro, setEditorMacro] = useState<Macro>({ steps: [] });
  const [editorError, setEditorError] = useState("");
  const [scripts, setScripts] = useState<Record<string, Script>>({});
  /** 脚本运行卡片:runId → ScriptRunCard(贯穿 running→done,并发各自,就地切换)。logs 为 log() 实时累积。 */
  const [scriptRuns, setScriptRuns] = useState<Map<string, ScriptRunCard>>(new Map());
  /** 当前展开日志的卡片 runId(null = 收起);一次展开一个卡片。 */
  const [expandedLog, setExpandedLog] = useState<string | null>(null);
  const [editingScript, setEditingScript] = useState<{ name: string; isNew: boolean } | null>(null);
  const [editorScriptName, setEditorScriptName] = useState("");
  const [editorScript, setEditorScript] = useState<Script>({ code: "" });
  const [editorScriptError, setEditorScriptError] = useState("");
  type ActivityView = "ports" | "macros" | "scripts" | null;
  const [activity, setActivity] = useState<ActivityView>(null);
  /** 侧栏宽度(可拖动调整,localStorage 持久化,clamp 180–480)。 */
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem("sidebar-width"));
    return saved >= 180 && saved <= 480 ? saved : 240;
  });
  const sidebarDrag = useRef<{ x: number; w: number } | null>(null);
  /** 侧栏分组折叠状态(收起的组名集合,localStorage 持久化)。 */
  const [macroCollapsed, setMacroCollapsed] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem("macro-groups-collapsed") ?? "[]") as string[]));
  const [scriptCollapsed, setScriptCollapsed] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem("script-groups-collapsed") ?? "[]") as string[]));
  const toggleMacroGroup = (g: string) =>
    setMacroCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g); else next.add(g);
      return next;
    });
  const toggleScriptGroup = (g: string) =>
    setScriptCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g); else next.add(g);
      return next;
    });
  // 折叠态写盘集中于此(单一数据源):各 handler 只 setState,不再就地 setItem。
  useEffect(() => {
    localStorage.setItem("macro-groups-collapsed", JSON.stringify([...macroCollapsed]));
  }, [macroCollapsed]);
  useEffect(() => {
    localStorage.setItem("script-groups-collapsed", JSON.stringify([...scriptCollapsed]));
  }, [scriptCollapsed]);
  /** 串口分组折叠（本地卡 / 远程设备卡），key=devId，localStorage 持久化。 */
  const [portCollapsed, setPortCollapsed] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem("port-groups-collapsed") ?? "[]") as string[]));
  const togglePortGroup = (devId: string) =>
    setPortCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(devId)) next.delete(devId); else next.add(devId);
      localStorage.setItem("port-groups-collapsed", JSON.stringify([...next]));
      return next;
    });
  const [manageMenu, setManageMenu] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  /** 脚本指南对话框;skillText 首次打开时拉取并缓存(null=未拉)。 */
  const [skillOpen, setSkillOpen] = useState(false);
  const [skillText, setSkillText] = useState<string | null>(null);
  /** 待收集参数的脚本名(非 null=弹参数收集框);null=关闭。 */
  const [pendingRun, setPendingRun] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [macroPaletteOpen, setMacroPaletteOpen] = useState(false);
  const [scriptPaletteOpen, setScriptPaletteOpen] = useState(false);
  const [portPaletteOpen, setPortPaletteOpen] = useState(false);
  /** 通用确认弹窗状态（替代原生 confirm）。null = 关闭。 */
  const [confirmState, setConfirmState] = useState<{
    title: string;
    icon?: React.ReactNode;
    message: string;
    confirmText?: string;
    tone?: "primary" | "danger";
    onConfirm: () => void;
  } | null>(null);
  /** 正在编辑别名的端口 + 触发位置（null = 未编辑）。
   *  where 必要：打开端口同时在「端口列表」和「tab 栏」两处出现，若都只按 port 判定，
   *  两处会各挂一个 InlineAliasInput 互抢焦点、随即互触 blur 全部关闭（表现为进不去编辑态）。
   *  where 把编辑态钉在触发处，杜绝两个 input 并存。 */
  const [aliasEdit, setAliasEdit] = useState<{ port: string; where: "list" | "tab" } | null>(null);
  /** 宏批量导出对话框是否打开。 */
  const [exportMacrosOpen, setExportMacrosOpen] = useState(false);
  const [exportScriptsOpen, setExportScriptsOpen] = useState(false);
  const [version, setVersion] = useState("");
  const [scriptEnabled, setScriptEnabled] = useState(false);
  const [serviceError, setServiceError] = useState("");
  const [theme, setThemeState] = useState<Theme>(() => getTheme());

  // 多 Transport 实例：key=devId。本地 "local" 常驻，远程按引用计数懒建/销（见 transport effect）。
  const transportsRef = useRef<Map<string, Transport>>(new Map());
  /** 每设备 Transport 的回调取消函数（dispose 时清理）。 */
  const unsubsByDev = useRef<Map<string, (() => void)[]>>(new Map());
  /** 每远程设备上次连接地址（host:port）；变化时强制销毁重建（Web 改连接 / 编辑设备 host）。 */
  const remoteAddrRef = useRef<Map<string, string>>(new Map());
  const terminalsRef = useRef<Map<string, TermInstance>>(new Map());
  const importInputRef = useRef<HTMLInputElement>(null);
  const scriptImportInputRef = useRef<HTMLInputElement>(null);
  const focusedGroupIdRef = useRef("g1");
  focusedGroupIdRef.current = focusedGroupId;
  /** 端口 → 所属 group 反查（每 render 重建；端口唯一归属一个 group）。 */
  const groupOfPort: Map<string, string> = new Map();
  for (const g of Object.values(groups)) for (const p of g.ports) groupOfPort.set(p, g.id);
  // 镜像到 ref：prunePort 经 onPortClosed 调用是 stale 闭包（transport effect 只绑一次），
  // 必须读 ref.current 拿最新值，否则用挂载时的空 Map → gid 永远 undefined → 远端关端口留僵尸 tab
  const groupOfPortRef = useRef(groupOfPort);
  groupOfPortRef.current = groupOfPort;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  /** 全局活动端口 = 聚焦 group 的活动端口（派生）。channel-strip / macro / 搜索等消费者零改动。 */
  const activePort = groups[focusedGroupId]?.activePort ?? "";
  const activeRef = useRef("");
  activeRef.current = activePort;
  // 镜像 openPorts / disconnectedPorts 到 ref：bindTransport 是空依赖 useCallback（只绑一次），
  // 其 onConnectedChange 闭包读的是挂载时快照 → 走 ref.current 拿最新值（断开标记 / 重放都依赖）。
  const openPortsRef = useRef(openPorts);
  openPortsRef.current = openPorts;
  const disconnectedPortsRef = useRef(disconnectedPorts);
  disconnectedPortsRef.current = disconnectedPorts;
  // reconnectPort 在下方定义，这里先建 ref 占位，定义后同步 current，供 bindTransport 重连后重放调用。
  const reconnectPortRef = useRef<(pid: PortId) => Promise<void>>(async () => {});

  // 焦点 group 被删（坍缩）→ 自愈回退到首个 leaf，保 channel-strip/macro 上下文不指向死 group
  useEffect(() => {
    const leaves = leafGroupIds(layout);
    if (leaves.length && !leaves.includes(focusedGroupId)) setFocusedGroupId(leaves[0]);
  }, [layout, focusedGroupId]);
  // dev 不变量校验：INV-1 端口唯一归属、INV-3 layout 叶子集 == groups 键集
  useEffect(() => {
    if (!(import.meta as any).env?.DEV) return;
    const seen = new Set<string>();
    for (const g of Object.values(groups)) for (const p of g.ports) {
      if (seen.has(p)) console.error("[INV-1] 端口同时在多个 group:", p);
      seen.add(p);
    }
    const leaves = leafGroupIds(layout);
    const gkeys = Object.keys(groups);
    if (leaves.length !== gkeys.length || leaves.some((k) => !groups[k])) {
      console.error("[INV-3] layout 叶子 != groups:", leaves, gkeys);
    }
  }, [groups, layout]);
  /** 快捷键处理器表：每 render 用最新闭包刷新；dispatch 经 ref 读，菜单/action 闭包不陈旧。
   *  Partial：terminal 作用域（zoom）不经此 dispatch（在 xterm handler 内自处理）。 */
  const handlersRef = useRef<Partial<Record<ActionId, (arg?: string) => void>>>({});
  /** 任一模态打开 → 抑制全局快捷键（不抢对话框裸 Enter/Esc、不抢输入）。 */
  const modalOpenRef = useRef(false);
  const dispatch = useCallback((action: ActionId, arg?: string) => {
    handlersRef.current[action]?.(arg);
  }, []);
  /** per-port 字节流活动时间戳——驱动 TX/RX LED。 */
  const activityRef = useRef<Map<string, Activity>>(new Map());
  const touch = (port: string, dir: "rx" | "tx") => {
    const e = activityRef.current.get(port) ?? { rx: 0, tx: 0 };
    e[dir] = performance.now();
    activityRef.current.set(port, e);
  };

  // 脚本入口显隐：本地主权恒显；远程/Web 取决于服务端 enable_scripting
  const showScripts = isLocal || scriptEnabled;

  // activeTabCount：每设备的活跃 Tab 数（端口在任一 group.ports 中）。驱动远程按需连接。
  const activeTabCount = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const g of Object.values(groups))
      for (const pid of g.ports) {
        const { devId } = parsePortId(pid);
        counts[devId] = (counts[devId] ?? 0) + 1;
      }
    return counts;
  }, [groups]);

  /** 把 Transport 的所有事件绑到指定 devId：onData/onPortClosed 用 portIdOf 还原复合键，
   *  onPorts 写入 portsByDev[devId] 桶，onConnectedChange 写 devOnline[devId]。返回取消函数。 */
  const bindTransport = useCallback((devId: string, t: Transport): (() => void)[] => {
    return [
      t.onPorts((list) => setPortsByDev((prev) => ({ ...prev, [devId]: list }))),
      t.onConnectedChange((conn) => {
        setDevOnline((prev) => ({ ...prev, [devId]: conn }));
        if (conn) {
          t.list();
          // 重连成功：重放本设备开着的端口（首次连上时 disconnectedPorts 为空 → 空操作，天然区分首次/重连）。
          // 复用 reconnectPort——用原配置 openPort + 成功才清断开标记；失败则 tab 保持断开态待手动重试。
          const mine = [...disconnectedPortsRef.current].filter(
            (pid) => parsePortId(pid).devId === devId
          );
          for (const pid of mine) reconnectPortRef.current?.(pid);
        } else {
          // 断连:清本设备运行卡片幽灵(脚本/宏后端经 owner 清理 abort,但 result 发不回前端 → 卡片会永远卡在 running)
          setScriptRuns((prev) => {
            const n = new Map(prev);
            for (const [rid, card] of n) if (card.devId === devId) n.delete(rid);
            return n;
          });
          setMacroRuns((prev) => {
            const n = new Map(prev);
            for (const [rid, card] of n) if (card.devId === devId) n.delete(rid);
            return n;
          });
          // 标本设备开着的端口为"断开待重连"（重连成功后由上面分支重放）。
          setDisconnectedPorts((prev) => {
            const n = new Set(prev);
            for (const pid of openPortsRef.current)
              if (parsePortId(pid).devId === devId) n.add(pid);
            return n;
          });
          // 整设备端口 opened 置 false，灭掉端口行假绿灯：WS 断后 portsByDev 不再刷新，会冻在断开前
          // 的旧状态（p.opened 仍 true → 小灯假绿）。端口行直接读 p.opened，无需改渲染。重连后 t.list() 覆盖。
          setPortsByDev((prev) =>
            prev[devId]
              ? { ...prev, [devId]: prev[devId].map((p) => ({ ...p, opened: false })) }
              : prev
          );
        }
      }),
      t.onData((port, data) => {
        const pid = portIdOf(devId, port);
        touch(pid, "rx"); // 签名：收到字节 → RX 亮
        terminalsRef.current.get(pid)?.term.write(data);
      }),
      t.onPortOpened((port) => {
        t.list();
        // 端口重新可用(本会话 reopen 或别处)→ 清该 tab 断开标记。保留占有权方案下
        // holder 真在、物理层已重建,清红是正确的(非上一版的"假绿")。
        const pid = portIdOf(devId, port);
        setDisconnectedPorts((prev) => {
          if (!prev.has(pid)) return prev;
          const n = new Set(prev);
          n.delete(pid);
          return n;
        });
      }),
      t.onPortClosed((port) => {
        // 端口全局关闭（末位释放/被强制关闭）：清掉本会话的标签、终端与分栏归属
        prunePort(portIdOf(devId, port));
        t.list();
      }),
      t.onPortDisconnected((port) => {
        // 设备物理断开:保留 tab(scrollback 可继续看),仅标"已断开"待手动重连。
        // 不动 openPorts/terminalsRef/groups——重连后 onData 自动接回同一 term。
        const pid = portIdOf(devId, port);
        setDisconnectedPorts((prev) => new Set(prev).add(pid));
        t.list();
      }),
      t.onHolders(() => t.list()),
      t.onMetaChanged(() => {
        // 别名等元数据变更（本机或别的客户端改的）→ 及时刷新，不必等串口事件
        t.list();
      }),
      t.onScriptsChanged(() => {
        // 脚本库变更(MCP/Tauri 写入)→ 重新 load_scripts,不必重启
        reloadScripts();
      }),
      t.onError((msg) => {
        setErrorMsg(msg);
        setTimeout(() => setErrorMsg(""), 5000);
      }),
      t.onMacroResult((runId, name, success, message) => {
        // 更新对应卡片 running→done(card 不在则忽略,理论上 runMacro 已 set)。
        if (!runId) return;
        setMacroRuns((prev) => {
          const card = prev.get(runId);
          if (!card) return prev;
          return new Map(prev).set(runId, { ...card, status: "done", success, message });
        });
      }),
      t.onScriptResult((runId, name, success, message) => {
        if (!runId) return;
        setScriptRuns((prev) => {
          const card = prev.get(runId);
          if (!card) return prev;
          return new Map(prev).set(runId, { ...card, status: "done", success, message });
        });
      }),
      t.onScriptLog((runId, message) => {
        // 未知 runId 忽略(防 MCP run_id="" 污染);每卡片 logs cap 1000(滚动)。
        if (!runId) return;
        setScriptRuns((prev) => {
          const card = prev.get(runId);
          if (!card) return prev;
          const logs = card.logs.length >= 1000 ? [...card.logs.slice(1), message] : [...card.logs, message];
          return new Map(prev).set(runId, { ...card, logs });
        });
      }),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 本地 Transport 常驻（devId="local"）：IPC 不随 connConfig 重连——重建会丢 per-port RX Channel，
  // 导致改服务监听设置后串口"变哑"（发得出收不到，重开才好）。
  useEffect(() => {
    if (!isLocal) return;
    const devId = "local";
    const t = new LocalTransport();
    transportsRef.current.set(devId, t);
    unsubsByDev.current.set(devId, bindTransport(devId, t));
    return () => {
      unsubsByDev.current.get(devId)?.forEach((fn) => fn());
      unsubsByDev.current.delete(devId);
      t.dispose();
      transportsRef.current.delete(devId);
    };
  }, [isLocal, bindTransport]);

  // 远程 Transport 引用计数（按需）：需求 = 卡展开 OR 该 devId 有活跃 Tab。
  // false→true 建连（RemoteTransport + 绑回调 + list），true→false 断开（dispose + 清状态）。
  // 地址变化（Web 改连接 / 编辑设备 host）→ 销毁旧实例按新地址重建。Web 单设备默认在 expandedRemotes，自动建连。
  useEffect(() => {
    const wanted = new Set<string>();
    for (const d of remotes) {
      if (expandedRemotes.has(d.id) || (activeTabCount[d.id] ?? 0) > 0) wanted.add(d.id);
    }
    const map = transportsRef.current;
    const addrMap = remoteAddrRef.current;
    const teardown = (id: string) => {
      unsubsByDev.current.get(id)?.forEach((fn) => fn());
      unsubsByDev.current.delete(id);
      map.get(id)?.dispose();
      map.delete(id);
      addrMap.delete(id);
      setDevOnline((prev) => {
        const n = { ...prev };
        delete n[id];
        return n;
      });
    };
    const create = (d: RemoteDevice) => {
      const t = new RemoteTransport(d.host, d.port);
      map.set(d.id, t);
      addrMap.set(d.id, `${d.host}:${d.port}`);
      unsubsByDev.current.set(d.id, bindTransport(d.id, t));
    };
    for (const d of remotes) {
      const existing = map.get(d.id);
      const addrChanged = addrMap.get(d.id) !== `${d.host}:${d.port}`;
      if (wanted.has(d.id)) {
        if (!existing) create(d);
        else if (addrChanged) {
          teardown(d.id);
          create(d);
        }
      } else if (existing) {
        teardown(d.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remotes, expandedRemotes, activeTabCount, bindTransport]);

  // Web/远程窗口：connConfig 变 → 同步单设备 remotes[0] 的 host/port（驱动上面的引用计数 effect 重连）。
  useEffect(() => {
    if (isLocal) return;
    setRemotes((prev) => {
      const r = prev[0];
      if (r && r.host === connConfig.host && r.port === connConfig.port) return prev;
      return [{ id: r?.id ?? "remote", host: connConfig.host, port: connConfig.port }];
    });
  }, [isLocal, connConfig.host, connConfig.port]);

  // 服务器配置：Tauri 控制面 invoke 读本地 settings.json
  useEffect(() => {
    if (!isTauri()) return;
    tauriInvoke<SrvSettings>("get_settings")
      .then((s) => {
        setSrvSettings(s);
        if (!isRemote) {
          setConnConfig((c) => (c.port === s.ws_port ? c : { host: "127.0.0.1", port: s.ws_port }));
        }
      })
      .catch(() => {});
  }, []);

  // 宏加载：Tauri → invoke load_macros；Web → localStorage 回退
  useEffect(() => {
    if (isTauri()) {
      tauriInvoke<Record<string, Macro>>("load_macros").then(setMacros).catch((e) => console.error("加载宏失败", e));
    } else {
      setMacros(loadMacrosLocal());
    }
  }, []);

  // 脚本加载/重载：Tauri → invoke load_scripts；Web → localStorage 回退。
  // 抽成函数供 mount + scriptsChanged 广播复用(MCP/Tauri 写入后即时刷新,不必重启)。
  const reloadScripts = () => {
    if (isTauri()) {
      tauriInvoke<Record<string, Script>>("load_scripts").then(setScripts).catch((e) => console.error("加载脚本失败", e));
    } else {
      setScripts(loadScriptsLocal());
    }
  };
  useEffect(() => {
    reloadScripts();
  }, []);

  // 远程设备加载：桌面端 → invoke load_remotes（remotes.json 落盘）；Web/远程窗口不加载
  // （由 connConfig 派生单设备）。加载后全展开 → 引用计数 effect 自动重连之前的设备。
  useEffect(() => {
    if (!isLocal) return;
    tauriInvoke<RemoteDevice[]>("load_remotes")
      .then((loaded) => {
        setRemotes(loaded);
        setExpandedRemotes(new Set(loaded.map((r) => r.id)));
      })
      .catch((e) => console.error("加载远程设备失败", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 版本号：经 transport 统一取——本地取 Tauri app 版本，远程/Web 取服务端版本。
  // 远程窗口虽 isTauri() 为真，但连的是远程服务，版本应反映服务端而非本机 app。
  // 连接时序由 RemoteTransport.send() 内部 await open 兜底，挂载即取也不会踩 CONNECTING 异常。
  useEffect(() => {
    const t = transportsRef.current.get(isLocal ? "local" : remotes[0]?.id ?? "");
    t?.getVersion().then(({ version, enableScripting }) => {
      setVersion(version);
      setScriptEnabled(enableScripting);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 侧栏宽度持久化(随用户走,localStorage)
  useEffect(() => {
    localStorage.setItem("sidebar-width", String(sidebarWidth));
  }, [sidebarWidth]);

  // 服务状态：本地服务启动失败（端口被占用等）时显示持久横幅。远程/Web 无本地服务。
  // start 是异步的：监听 service-status 事件 + 2s 后兜底查一次（避免“还在启动中”误报）。
  useEffect(() => {
    if (!isTauri() || isRemote) return;
    let unlisten: (() => void) | undefined;
    const check = () =>
      tauriInvoke<{ running: boolean }>("service_status")
        .then((s) =>
          setServiceError(
            s.running
              ? ""
              : "本地服务未启动（WS/Telnet 端口可能被占用）。本地串口仍可用，但无法被远程访问。"
          )
        )
        .catch(() => {});
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{ running: boolean; error?: string }>("service-status", (e) => {
        if (e.payload.running) {
          setServiceError("");
        } else {
          setServiceError(
            `${e.payload.error ? e.payload.error + " " : ""}本地串口仍可用，但无法被远程访问。`
          );
        }
      });
    })();
    const timer = setTimeout(check, 2000);
    return () => {
      unlisten?.();
      clearTimeout(timer);
    };
  }, [isRemote]);

  // 主题：订阅 theme 模块，切换时刷新按钮图标
  useEffect(() => subscribe(setThemeState), []);

  // 全局快捷键：单一 capture listener——combo 查 global 表 → dispatch。
  // 焦点在输入控件或任一模态打开时抑制（不抢对话框裸 Enter/Esc、不抢输入）。
  // 桌面若该 combo 已是菜单 accelerator，OS 先于 webview 拦截，listener 本就不会收到。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // 焦点在表单控件时跳过（不抢输入）；但 xterm 聚焦时 e.target 是隐藏的
      // .xterm-helper-textarea（终端的输入/IME 代理），那属于“终端聚焦”而非“填表”，
      // 必须放行——否则终端一聚焦，所有全局快捷键失效。
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable) &&
        !t.closest(".xterm")
      ) {
        return;
      }
      if (modalOpenRef.current) return;
      const combo = eventToCombo(e);
      if (!combo) return;
      const hit = findAction(combo, "global");
      if (hit) {
        e.preventDefault();
        e.stopPropagation();
        dispatch(hit.id, hit.arg);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dispatch]);

  // 原生菜单（B 层）暂不启用：Windows 上建菜单会占一条菜单栏，而所有全局快捷键已由
  // 上面的 listener 覆盖（菜单只是同一批动作的第二入口，属冗余）。要恢复原生菜单 /
  // accelerator，调 menu.ts 的 setupAppMenu(dispatch) 即可（web/远程模式自动 no-op）。
  // menu.ts 保留待用。

  // 切端口 / 关端口时收起搜索框（addon 已随实例销毁）
  useEffect(() => {
    setSearchOpen(false);
  }, [activePort]);

  /** 真正发起占有：建终端标签、记实际配置；附加时提示沿用既有配置。返回 acquire 结果（供调用方按 opened 决策）。 */
  const openPort = async (pid: PortId, config: SerialConfig) => {
    const { devId, name } = parsePortId(pid);
    try {
      const res = await transportsRef.current.get(devId)?.open(name, config);
      if (!res) return undefined;
      // 成功占有（首开或附加）：创建本会话的终端标签，并记录端口实际配置供通道条展示
      setOpenPorts((prev) => (prev.includes(pid) ? prev : [...prev, pid]));
      // 进聚焦 group 并设为活动端口（端口唯一归属：openPort 是新开，此前不在任何 group）
      const fg = focusedGroupIdRef.current;
      setGroups((g) => {
        const cur = g[fg];
        if (!cur) return g;
        const ports = cur.ports.includes(pid) ? cur.ports : [...cur.ports, pid];
        return { ...g, [fg]: { ...cur, ports, activePort: pid } };
      });
      setPortConfigs((prev) => ({ ...prev, [pid]: res.config }));
      if (!res.opened) {
        // 附加到已开端口：请求的 config 被忽略，告知实际配置
        const c = res.config;
        setNotice(`已加入 ${res.port}（当前 ${res.holders} 人在线）；端口沿用既有配置 ${c.baud_rate} 波特、换行 ${c.line_ending.toUpperCase()}。`);
        setTimeout(() => setNotice(""), 6000);
      }
      return res;
    } catch (e) {
      setErrorMsg(String(e));
      setTimeout(() => setErrorMsg(""), 5000);
      return undefined;
    }
  };

  /** 打开对话框确认：先 open，仅首开（opened=true）才落别名——与串口参数同逻辑（附加时别名忽略）。 */
  const confirmOpen = async (config: SerialConfig, alias: string) => {
    const pid = pendingPort;
    if (!pid) return;
    saveConfig(config);
    setPendingPort(null);
    const res = await openPort(pid, config);
    const trimmed = alias.trim();
    if (!trimmed) return;
    if (res?.opened) {
      // 首开：别名生效
      const { devId, name } = parsePortId(pid);
      try {
        await transportsRef.current.get(devId)?.setAlias(name, trimmed);
        refreshPorts(devId);
      } catch (e) {
        setErrorMsg("设置别名失败: " + String(e));
        setTimeout(() => setErrorMsg(""), 5000);
      }
    } else if (res && !res.opened) {
      // 附加：别名未生效（端口已被其它会话先开）
      setNotice("端口已被其它会话打开，本次别名未生效。");
      setTimeout(() => setNotice(""), 5000);
    }
  };

  /** 从分栏与端口清单移除端口（关端口共用：用户主动关 closePort + 远端被关 onPortClosed）。
   *  所属 group 的 ports 移除 + activePort 回退；group 空（且非唯一根）→ 删 group + removeLeaf 坍缩，
   *  focused 回退交给 effect 自愈。全用函数式 setState，transport effect 的 stale 闭包调用也安全。 */
  const prunePort = (pid: PortId) => {
    const gid = groupOfPortRef.current.get(pid);
    setOpenPorts((prev) => prev.filter((p) => p !== pid));
    setPortConfigs((prev) => {
      if (!prev[pid]) return prev;
      const next = { ...prev };
      delete next[pid];
      return next;
    });
    terminalsRef.current.delete(pid);
    activityRef.current.delete(pid);
    if (!gid) return; // 不在任何 group（异常）——上面已清端口清单/实例
    setGroups((g) => {
      const cur = g[gid];
      if (!cur) return g;
      const ports = cur.ports.filter((p) => p !== pid);
      if (ports.length > 0) return { ...g, [gid]: { ...cur, ports, activePort: cur.activePort === pid ? ports[ports.length - 1] : cur.activePort } };
      // group 空：唯一根保留为空 group（承接下次 openPort，否则 layout 仍指向它、focused 也指向它，
      // 重开端口进不去 → 端口在线却不显示）；多 group 才删（layout 坍缩见下）
      if (Object.keys(g).length <= 1) return { ...g, [gid]: { ...cur, ports: [], activePort: "" } };
      const next = { ...g };
      delete next[gid];
      return next;
    });
    // group 空（关的是该 group 唯一/末个端口）且非唯一根 → layout 坍缩。读 groupsRef（最新，避 stale）
    if ((groupsRef.current[gid]?.ports.length ?? 0) <= 1) {
      setLayout((tree) => (leafGroupIds(tree).length <= 1 ? tree : removeLeaf(tree, gid) ?? tree));
    }
  };
  const closePort = (pid: PortId) => {
    // 关闭正在编辑别名的端口时退出编辑态：组件直接卸载会跳过 blur，否则 state 残留到端口列表
    if (aliasEdit?.port === pid) setAliasEdit(null);
    const { devId, name } = parsePortId(pid);
    transportsRef.current.get(devId)?.close(name);
    prunePort(pid);
  };

  const forceClosePort = (pid: PortId) => {
    const { name } = parsePortId(pid);
    setConfirmState({
      title: "强制关闭端口",
      icon: <IconPower />,
      message: `强制关闭 ${name}？将断开所有远程客户端并关闭该端口。`,
      confirmText: "强制关闭",
      tone: "danger",
      onConfirm: async () => {
        const t = transportsRef.current.get("local");
        if (t) {
          try {
            await t.forceClose(name); // 踢远程持有者（force_close_others）
            await t.close(name);      // 本地释放（远程已踢 → 末位 → 拆毁端口）
          } catch {
            /* 端口可能已被 force_close 拆毁，忽略 */
          }
        }
        prunePort(pid); // 显式清本地 tab（不依赖 onPortClosed 事件）
        setConfirmState(null);
      },
    });
  };

  const switchPort = (port: string) => {
    // 在聚焦 group 内切活动端口（activePort 由 groups[focused].activePort 派生）
    const fg = focusedGroupIdRef.current;
    setGroups((g) => {
      const cur = g[fg];
      if (!cur || !cur.ports.includes(port)) return g;
      return { ...g, [fg]: { ...cur, activePort: port } };
    });
  };

  // 标签页切换快捷键：Ctrl+Alt+1..9 直达、Ctrl+Alt+←/→ 循环。复用 switchPort +
  // 聚焦新终端（TermView display 切换不销毁，term 实例常驻 terminalsRef，可立即 focus）。
  const focusTab = (name: string) => terminalsRef.current.get(name)?.term.focus();
  const cycleTab = (dir: 1 | -1) => {
    const tabs = groups[focusedGroupId]?.ports ?? [];
    if (tabs.length < 2) return;
    const i = tabs.indexOf(activePort);
    const next = tabs[((i < 0 ? 0 : i) + dir + tabs.length) % tabs.length]; // 循环 wrap
    switchPort(next);
    focusTab(next);
  };
  const selectTab = (n: number) => {
    const tabs = groups[focusedGroupId]?.ports ?? [];
    if (!tabs.length) return;
    const idx = n === 0 ? tabs.length - 1 : n - 1; // 1..9→第 n 个，0→末个（浏览器惯例）
    const t = tabs[idx]; // 越界 → undefined → no-op
    if (t) {
      switchPort(t);
      focusTab(t);
    }
  };

  /** 在指定 group 内切活动端口 + 聚焦该 group（点 group 内 tab 触发）。
   *  与 switchPort（快捷键用，作用于聚焦 group）的区别：本函数接受 groupId 并聚焦它。 */
  const switchTabInGroup = (groupId: string, port: string) => {
    setGroups((g) => {
      const cur = g[groupId];
      if (!cur || !cur.ports.includes(port)) return g;
      return { ...g, [groupId]: { ...cur, activePort: port } };
    });
    setFocusedGroupId(groupId);
  };

  /** 拖 tab 到某 group 终端区半区：新建 group（装该 port）并在目标 group 处分裂。
   *  half=left/right→row，up/down→col；right/down→新 group 在后（side=end）。
   *  port 从源 group 迁出；源 group 空（且非自分裂）→ removeLeaf 坍缩移除。
   *  newId 在 updater 外生成（单次 ++，避 strict mode double-invoke updater 重复 ++）。 */
  const dropHalf = (port: string, srcGroupId: string, dstGroupId: string, half: PaneHalf) => {
    const src = groups[srcGroupId];
    if (!src || !src.ports.includes(port)) return;
    // 落到空 group：直接搬进去，不分裂（否则空格子累积、永不坍缩）
    if ((groups[dstGroupId]?.ports.length ?? 0) === 0) {
      movePort(port, srcGroupId, dstGroupId);
      return;
    }
    // 拖自己唯一 tab 到自己半区：结果只是空 group + 单 tab group，无分栏意义，跳过（也避免产生空格子）
    if (srcGroupId === dstGroupId && src.ports.length === 1) return;
    const newId = "g" + ++groupIdSeq.current;
    const srcPorts = src.ports.filter((p) => p !== port);
    const srcEmpty = srcPorts.length === 0;
    setGroups((g) => {
      const cur = g[srcGroupId];
      if (!cur) return g;
      const next: Record<string, Group> = { ...g, [newId]: { id: newId, ports: [port], activePort: port } };
      if (srcEmpty && srcGroupId !== dstGroupId) delete next[srcGroupId];
      else next[srcGroupId] = { ...cur, ports: srcPorts, activePort: cur.activePort === port ? srcPorts[srcPorts.length - 1] : cur.activePort };
      return next;
    });
    setLayout((tree) => {
      const dir = half === "left" || half === "right" ? "row" : "col";
      const side = half === "right" || half === "down" ? "end" : "start";
      let t: PaneNode = splitLeaf(tree, dstGroupId, { type: "leaf", groupId: newId }, dir, side);
      if (srcEmpty && srcGroupId !== dstGroupId) t = removeLeaf(t, srcGroupId) ?? t;
      return t;
    });
    setFocusedGroupId(newId);
  };
  const onDragOverHalf = (groupId: string, half: PaneHalf) => setDropHint({ overGroupId: groupId, overHalf: half });
  const onPaneDragLeave = () => setDropHint(null);

  /** 拖 tab 到另一 group 的标签栏：迁移 port 归属（源移除、目标追加 + 设其 activePort）。
   *  源 group 空 → removeLeaf 坍缩。TermView 经 portal 不 remount → scrollback 保留。 */
  const movePort = (port: string, srcGroupId: string, dstGroupId: string) => {
    if (srcGroupId === dstGroupId) return;
    const src = groups[srcGroupId];
    const dst = groups[dstGroupId];
    if (!src || !dst || !src.ports.includes(port) || dst.ports.includes(port)) return;
    const srcEmpty = src.ports.length === 1; // 只有这一个 → 迁出后空
    setGroups((g) => {
      const s = g[srcGroupId];
      const d = g[dstGroupId];
      if (!s || !d || d.ports.includes(port)) return g;
      const sp = s.ports.filter((p) => p !== port);
      const next: Record<string, Group> = { ...g, [dstGroupId]: { ...d, ports: [...d.ports, port], activePort: port } };
      if (sp.length === 0) delete next[srcGroupId];
      else next[srcGroupId] = { ...s, ports: sp, activePort: s.activePort === port ? sp[sp.length - 1] : s.activePort };
      return next;
    });
    if (srcEmpty) setLayout((tree) => removeLeaf(tree, srcGroupId) ?? tree);
    setFocusedGroupId(dstGroupId);
  };

  /** 递归渲染分栏布局树：split→flex 容器(row/col + 比例)，leaf→GroupView(标签栏+终端区)。 */
  const renderPane = (node: PaneNode) => {
    if (node.type === "split") {
      return (
        <div className={`pane-split pane-split--${node.dir}`}>
          <div className="pane-split__child" style={{ flex: node.ratio }}>
            {renderPane(node.children[0])}
          </div>
          <div className="pane-split__child" style={{ flex: 1 - node.ratio }}>
            {renderPane(node.children[1])}
          </div>
        </div>
      );
    }
    const g = groups[node.groupId];
    if (!g) return null;
    const isFocused = node.groupId === focusedGroupId;
    return (
      <GroupView
        key={g.id}
        group={g}
        focused={isFocused}
        aliasEditTab={aliasEdit?.where === "tab" ? { port: aliasEdit.port } : null}
        aliasOf={aliasOf}
        sourceLabelOf={(pid) => {
          if (remotes.length === 0) return undefined;
          const { devId } = parsePortId(pid);
          if (devId === "local") return undefined;
          const d = remotes.find((r) => r.id === devId);
          return d ? (d.nickname?.trim() || `${d.host}:${d.port}`) : undefined;
        }}
        disconnectedOf={(pid) => disconnectedPorts.has(pid)}
        onReconnectTab={reconnectPort}
        onSwitchTab={(port) => switchTabInGroup(node.groupId, port)}
        onCloseTab={closePort}
        onRenameTab={(port) => setAliasEdit({ port, where: "tab" })}
        onCommitAlias={commitAlias}
        onCancelAlias={() => setAliasEdit(null)}
        onFocusGroup={() => setFocusedGroupId(node.groupId)}
        onWrite={(p, data) => {
          touch(p, "tx");
          const { devId, name } = parsePortId(p);
          transportsRef.current.get(devId)?.write(name, data);
        }}
        onReady={(p, inst) => {
          if (inst) terminalsRef.current.set(p, inst);
          else terminalsRef.current.delete(p);
        }}
        searchOpen={searchOpen}
        activeTerm={isFocused ? activeTerm : undefined}
        onCloseSearch={() => {
          setSearchOpen(false);
          activeTerm?.term.focus();
        }}
        onDragOverHalf={onDragOverHalf}
        onDragLeave={onPaneDragLeave}
        onDropHalf={dropHalf}
        dropHint={dropHint}
        onDropOnTabs={movePort}
        termContainerRef={(el) => setGroupContainer(node.groupId, el)}
      />
    );
  };

  /** 重连断开的 tab:复用 openPort(自带 dedup + onData 路由接回同一 term),成功后清断开标记。 */
  const reconnectPort = async (pid: PortId) => {
    const res = await openPort(pid, portConfigs[pid] ?? serialConfig);
    if (res) setDisconnectedPorts((prev) => { const n = new Set(prev); n.delete(pid); return n; });
  };
  reconnectPortRef.current = reconnectPort;

  /** 触发某端口：已开则切过去；被他会话占着则附加；否则弹配置框。与点端口行同一流程，
   *  串口选择面板(Ctrl+I)的回车也走这里，避免两处复制三分支逻辑。 */
  const triggerPort = (pid: PortId) => {
    if (disconnectedPorts.has(pid)) {
      void reconnectPort(pid); // 断开 tab:重连(区别于"已开仅切 tab"的第一分支)
      return;
    }
    if (openPorts.includes(pid)) {
      // 已开：聚焦到端口所属 group 并切其 tab（端口可能不在当前聚焦 group，纯 switchPort 会 no-op）
      const gid = groupOfPort.get(pid);
      if (gid) switchTabInGroup(gid, pid);
      else switchPort(pid);
    } else {
      const { devId, name } = parsePortId(pid);
      const info = portsByDev[devId]?.find((p) => p.name === name);
      if (info?.opened) void openPort(pid, serialConfig); // 被他会话占着：附加
      else setPendingPort(pid); // 未开：弹配置框
    }
  };

  const runMacro = (name: string) => {
    if (!activePort) {
      setErrorMsg("请先选择并打开一个串口");
      return;
    }
    const runId = crypto.randomUUID();
    const { devId, name: portName } = parsePortId(activePort);
    setMacroRuns((prev) => new Map(prev).set(runId, { name, devId, status: "running" }));
    transportsRef.current.get(devId)?.runMacro(name, portName, macros[name], runId);
  };

  const openMacroEditor = (name: string | null) => {
    if (name && macros[name]) {
      setEditing({ name, isNew: false });
      setEditorName(name);
      setEditorMacro(JSON.parse(JSON.stringify(macros[name])));
    } else {
      setEditing({ name: "", isNew: true });
      setEditorName("");
      setEditorMacro({ description: "", steps: [newStep("send")] });
    }
    setEditorError("");
  };

  const saveMacroDef = async () => {
    const trimmedName = editorName.trim();
    if (!trimmedName) {
      setEditorError("宏名不能为空");
      return;
    }
    const err = validateMacro(editorMacro);
    if (err) {
      setEditorError(err);
      return;
    }
    const oldKey = editing && !editing.isNew ? editing.name : null;
    const next = upsertNamed(macros, oldKey, trimmedName, editorMacro);
    if (!next) {
      setEditorError("已存在同名宏");
      return;
    }
    setMacros(next);
    await persistMacros(next);
    setEditing(null);
  };

  const deleteMacro = (name: string) => {
    setConfirmState({
      title: "删除宏",
      icon: <IconTrash />,
      message: `删除宏 "${name}"？此操作不可恢复。`,
      confirmText: "删除",
      tone: "danger",
      onConfirm: async () => {
        const next = { ...macros };
        delete next[name];
        setMacros(next);
        await persistMacros(next);
        setEditing(null);
        setConfirmState(null);
      },
    });
  };

  const renameMacroGroup = async (oldName: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return; // 空名忽略（防误解散；解散走 askDissolveMacroGroup）
    const merged = trimmed !== oldName && Object.values(macros).some((m) => m.group === trimmed);
    const next = renameGroup(macros, oldName, trimmed);
    setMacros(next);
    // 折叠态同步:旧组名 → 新组名(保留折叠)。须在 await 前——React 18 在 await 处断批,
    // 否则折叠的组会先按新名展开、再折回,闪一帧。
    setMacroCollapsed((prev) => {
      if (!prev.has(oldName)) return prev;
      const n = new Set(prev);
      n.delete(oldName);
      n.add(trimmed);
      return n;
    });
    await persistMacros(next);
    if (merged) {
      setNotice(`已合并到组「${trimmed}」`);
      setTimeout(() => setNotice(""), 4000);
    }
  };

  const askDissolveMacroGroup = (name: string) => {
    const count = Object.values(macros).filter((m) => m.group === name).length;
    setConfirmState({
      title: "解散分组",
      icon: <IconAlert />,
      message: `解散分组「${name}」?其中 ${count} 个宏将移至「未分组」,不会被删除。`,
      confirmText: "解散",
      tone: "danger",
      onConfirm: async () => {
        const { next } = dissolveGroup(macros, name);
        setMacros(next);
        setMacroCollapsed((prev) => {
          if (!prev.has(name)) return prev;
          const n = new Set(prev);
          n.delete(name);
          return n;
        });
        await persistMacros(next);
        setConfirmState(null);
      },
    });
  };

  const doRun = (name: string, args: Record<string, string>) => {
    // 有 tab 用其端口作主端口;无 tab → 主端口空(纯 sleep/log 脚本照跑便于调试流程;
    // 有缺省 send 的脚本则 send 抛"未指定端口")。脚本天生跨多端口,不绑 tab(区别于宏)。
    // devId(transport):有 tab 用其设备;无 tab → 本地 "local" / 远程第一个 remote。
    const { devId, name: portName } = activePort
      ? parsePortId(activePort)
      : { devId: isLocal ? "local" : (remotes[0]?.id ?? ""), name: "" };
    const transport = transportsRef.current.get(devId);
    if (!transport) {
      setErrorMsg(isLocal ? "本地服务未就绪" : "请先连接一台远程设备");
      return;
    }
    const runId = crypto.randomUUID();
    setScriptRuns((prev) => new Map(prev).set(runId, { name, devId, status: "running", logs: [] }));
    setExpandedLog(runId); // 新运行自动展开:实时看进度;结束后同卡片继续展开看完整历史
    transport.runScript(name, portName, scripts[name], args, runId);
  };
  const runScript = (name: string) => {
    // 脚本声明了参数 → 弹收集框;否则直接跑。
    if (scripts[name]?.params?.length) {
      setPendingRun(name);
      return;
    }
    doRun(name, {});
  };

  const openScriptEditor = (name: string | null) => {
    if (name && scripts[name]) {
      setEditingScript({ name, isNew: false });
      setEditorScriptName(name);
      setEditorScript(JSON.parse(JSON.stringify(scripts[name])));
    } else {
      setEditingScript({ name: "", isNew: true });
      setEditorScriptName("");
      setEditorScript({ code: "// 在此写 JS 脚本\n" });
    }
    setEditorScriptError("");
  };

  const saveScriptDef = async () => {
    const trimmedName = editorScriptName.trim();
    if (!trimmedName) {
      setEditorScriptError("脚本名不能为空");
      return;
    }
    if (!editorScript.code.trim()) {
      setEditorScriptError("脚本代码不能为空");
      return;
    }
    const oldKey = editingScript && !editingScript.isNew ? editingScript.name : null;
    const next = upsertNamed(scripts, oldKey, trimmedName, editorScript);
    if (!next) {
      setEditorScriptError("已存在同名脚本");
      return;
    }
    setScripts(next);
    await persistScripts(next);
    setEditingScript(null);
  };

  const deleteScript = (name: string) => {
    setConfirmState({
      title: "删除脚本",
      icon: <IconTrash />,
      message: `删除脚本 "${name}"？此操作不可恢复。`,
      confirmText: "删除",
      tone: "danger",
      onConfirm: async () => {
        const next = { ...scripts };
        delete next[name];
        setScripts(next);
        await persistScripts(next);
        setEditingScript(null);
        setConfirmState(null);
      },
    });
  };

  const renameScriptGroup = async (oldName: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const merged = trimmed !== oldName && Object.values(scripts).some((s) => s.group === trimmed);
    const next = renameGroup(scripts, oldName, trimmed);
    setScripts(next);
    setScriptCollapsed((prev) => {
      if (!prev.has(oldName)) return prev;
      const n = new Set(prev);
      n.delete(oldName);
      n.add(trimmed);
      return n;
    });
    await persistScripts(next);
    if (merged) {
      setNotice(`已合并到组「${trimmed}」`);
      setTimeout(() => setNotice(""), 4000);
    }
  };

  const askDissolveScriptGroup = (name: string) => {
    const count = Object.values(scripts).filter((s) => s.group === name).length;
    setConfirmState({
      title: "解散分组",
      icon: <IconAlert />,
      message: `解散分组「${name}」?其中 ${count} 个脚本将移至「未分组」,不会被删除。`,
      confirmText: "解散",
      tone: "danger",
      onConfirm: async () => {
        const { next } = dissolveGroup(scripts, name);
        setScripts(next);
        setScriptCollapsed((prev) => {
          if (!prev.has(name)) return prev;
          const n = new Set(prev);
          n.delete(name);
          return n;
        });
        await persistScripts(next);
        setConfirmState(null);
      },
    });
  };

  /** 导入宏：读 JSON 文件，合并入库（重名/无效跳过），Tauri/Web 均落 persistMacros。 */
  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const entries = parseImportedMacros(data, macros);
      if (entries.length === 0) {
        setErrorMsg('导入失败：未找到有效宏（需 {"名称": {steps:[...]}} 或单个宏）');
        setTimeout(() => setErrorMsg(""), 6000);
        return;
      }
      const next = { ...macros };
      let added = 0;
      let skipped = 0;
      for (const [n, m] of entries) {
        if (next[n] || validateMacro(m)) {
          skipped++;
          continue;
        }
        next[n] = m;
        added++;
      }
      if (added > 0) {
        setMacros(next);
        await persistMacros(next);
      }
      setNotice(`导入完成：新增 ${added} 个${skipped ? `，跳过 ${skipped} 个（重名或无效）` : ""}。`);
      setTimeout(() => setNotice(""), 5000);
    } catch (err) {
      setErrorMsg("导入失败：" + String(err));
      setTimeout(() => setErrorMsg(""), 6000);
    }
  };

  /** 导入脚本：读 JSON 文件，合并入库（重名/空 code 跳过），Tauri/Web 均落 persistScripts。 */
  const onImportScripts = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const entries = parseImportedScripts(data, scripts);
      if (entries.length === 0) {
        setErrorMsg('导入失败：未找到有效脚本（需 {"名称": {code:"..."}} 或单个脚本）');
        setTimeout(() => setErrorMsg(""), 6000);
        return;
      }
      const next = { ...scripts };
      let added = 0;
      let skipped = 0;
      for (const [n, s] of entries) {
        if (next[n] || !s.code.trim()) {
          skipped++;
          continue;
        }
        next[n] = s;
        added++;
      }
      if (added > 0) {
        setScripts(next);
        await persistScripts(next);
      }
      setNotice(`导入完成：新增 ${added} 个${skipped ? `，跳过 ${skipped} 个（重名或空代码）` : ""}。`);
      setTimeout(() => setNotice(""), 5000);
    } catch (err) {
      setErrorMsg("导入失败：" + String(err));
      setTimeout(() => setErrorMsg(""), 6000);
    }
  };

  /** 添加远程设备：生成稳定 UUID + 持久化（桌面）+ 默认展开（触发按需连接）。同地址已存在则轻提示。 */
  const addRemote = () => {
    const host = remoteInput.host.trim();
    if (!host) return;
    const id = crypto.randomUUID();
    const dev: RemoteDevice = { id, host, port: remoteInput.port, nickname: remoteInput.nickname.trim() || undefined };
    const dup = remotes.some((r) => r.host === host && r.port === dev.port);
    setRemotes((prev) => {
      const next = [...prev, dev];
      if (isLocal) persistRemotes(next);
      return next;
    });
    setExpandedRemotes((prev) => new Set(prev).add(id)); // 默认展开 → 引用计数 effect 建连
    setRemoteInput({ host: "", port: 18700, nickname: "" });
    setRemoteOpen(false);
    if (dup) {
      setNotice(`已添加（${host}:${dev.port} 已存在同地址设备）。`);
      setTimeout(() => setNotice(""), 5000);
    }
  };

  /** 删除远程设备：关其所有 Tab + 显式销毁 transport（引用计数 effect 不再遍历已删 devId）+ 移出列表。 */
  const removeRemote = (dev: RemoteDevice) => {
    setConfirmState({
      title: "删除远程设备",
      icon: <IconTrash />,
      message: `删除远程设备「${dev.nickname?.trim() || `${dev.host}:${dev.port}`}」？将关闭其所有打开的串口标签。`,
      confirmText: "删除",
      tone: "danger",
      onConfirm: () => {
        openPorts.filter((p) => parsePortId(p).devId === dev.id).forEach((pid) => prunePort(pid));
        unsubsByDev.current.get(dev.id)?.forEach((fn) => fn());
        unsubsByDev.current.delete(dev.id);
        transportsRef.current.get(dev.id)?.dispose();
        transportsRef.current.delete(dev.id);
        remoteAddrRef.current.delete(dev.id);
        setDevOnline((prev) => {
          const n = { ...prev };
          delete n[dev.id];
          return n;
        });
        setRemotes((prev) => {
          const next = prev.filter((r) => r.id !== dev.id);
          if (isLocal) persistRemotes(next);
          return next;
        });
        setExpandedRemotes((prev) => {
          const n = new Set(prev);
          n.delete(dev.id);
          return n;
        });
        setConfirmState(null);
      },
    });
  };

  /** 手动重连：dispose 旧 transport + 清地址缓存 + 确保 wanted → 引用计数 effect 重建（重试 WS）。 */
  const reconnectRemote = (dev: RemoteDevice) => {
    unsubsByDev.current.get(dev.id)?.forEach((fn) => fn());
    unsubsByDev.current.delete(dev.id);
    transportsRef.current.get(dev.id)?.dispose();
    transportsRef.current.delete(dev.id);
    remoteAddrRef.current.delete(dev.id);
    setDevOnline((prev) => {
      const n = { ...prev };
      delete n[dev.id];
      return n;
    });
    setExpandedRemotes((prev) => {
      const n = new Set(prev);
      n.add(dev.id);
      return n;
    });
  };

  const refreshPorts = (devId?: string) => {
    if (devId) transportsRef.current.get(devId)?.list();
    else transportsRef.current.forEach((t) => t.list());
  };

  /** 按复合键查端口信息（devId 桶 + 裸 name）。多 Transport 端口查找的唯一入口。 */
  const portInfoOf = (pid: PortId): PortInfo | undefined => {
    const { devId, name } = parsePortId(pid);
    return portsByDev[devId]?.find((p) => p.name === name);
  };
  const aliasOf = (pid: PortId) => portInfoOf(pid)?.alias;

  /** 提交别名：写 ports.json + 刷新列表使别名立即显示。空串 = 清除。 */
  const commitAlias = async (pid: PortId, alias: string) => {
    setAliasEdit(null);
    const { devId, name } = parsePortId(pid);
    try {
      await transportsRef.current.get(devId)?.setAlias(name, alias);
      refreshPorts(devId);
    } catch (e) {
      setErrorMsg("设置别名失败: " + String(e));
      setTimeout(() => setErrorMsg(""), 5000);
    }
  };

  const activeHolders = activePort ? portInfoOf(activePort)?.holders ?? 0 : 0;
  /** 串口分组：本地卡（仅桌面）+ 远程设备卡（按 remotes 顺序）。每卡带 devId/label/online/ports。 */
  const portGroups: { devId: string; label: string; online?: boolean; ports: PortInfo[] }[] = [
    ...(isLocal ? [{ devId: "local", label: "本地", online: devOnline["local"], ports: portsByDev["local"] ?? [] }] : []),
    ...remotes.map((d) => ({
      devId: d.id,
      label: d.nickname?.trim() || `${d.host}:${d.port}`,
      online: devOnline[d.id],
      ports: portsByDev[d.id] ?? [],
    })),
  ];
  /** 平铺所有端口（带 pid），供 PortPalette 搜索选择。 */
  const allPorts: (PortInfo & { pid: PortId })[] = portGroups.flatMap((g) => g.ports.map((p) => ({ ...p, pid: portIdOf(g.devId, p.name) })));
  const activeConfig = activePort ? portConfigs[activePort] : undefined;
  const activeTerm = activePort ? terminalsRef.current.get(activePort) : undefined;

  // 快捷键处理器表（每 render 刷新最新闭包；dispatch 经 handlersRef 读，不陈旧）。
  handlersRef.current = {
    "search.open": () => {
      const p = activeRef.current;
      if (p && terminalsRef.current.has(p)) setSearchOpen(true);
    },
    "theme.toggle": toggleTheme,
    "port.refresh": refreshPorts,
    "settings.open": () => setSettingsOpen(true),
    "about.open": () => setAboutOpen(true),
    "remote.open": () => setRemoteOpen(true),
    "macro.palette": () => setMacroPaletteOpen(true),
    "script.palette": () => setScriptPaletteOpen(true),
    "port.palette": () => setPortPaletteOpen(true),
    "activity.toggle-ports": () => setActivity(activity === "ports" ? null : "ports"),
    "activity.toggle-macros": () => setActivity(activity === "macros" ? null : "macros"),
    "activity.toggle-scripts": () => setActivity(activity === "scripts" ? null : "scripts"),
    "port.close-active": () => {
      const p = activeRef.current;
      if (p) closePort(p);
    },
    "tab.next": () => cycleTab(1),
    "tab.prev": () => cycleTab(-1),
    "tab.select": (arg) => selectTab(Number(arg)),
  };
  const modalOpen = !!(
    settingsOpen ||
    aboutOpen ||
    skillOpen ||
    pendingRun ||
    remoteOpen ||
    pendingPort ||
    aliasEdit ||
    exportMacrosOpen ||
    confirmState ||
    editing ||
    editingScript ||
    shortcutsOpen ||
    macroPaletteOpen ||
    scriptPaletteOpen ||
    portPaletteOpen
  );
  modalOpenRef.current = modalOpen;

  // 所有对话框关闭后,焦点送回活动终端(打开时焦点进了对话框,关掉后终端要重新接管输入)
  useEffect(() => {
    if (modalOpen) return;
    const id = window.setTimeout(() => {
      terminalsRef.current.get(activeRef.current)?.term.focus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [modalOpen]);

  return (
    <div className="app">
      {/* 活动栏：44px 窄竖条 */}
      <div className="activity-bar">
        <ActivityIcon icon={<IconPlug className="act-icon__svg" />} title="串口" active={activity === "ports"} onClick={() => setActivity(activity === "ports" ? null : "ports")} />
        <ActivityIcon icon={<IconBolt className="act-icon__svg" />} title="宏" active={activity === "macros"} onClick={() => setActivity(activity === "macros" ? null : "macros")} />
        {showScripts && (
          <ActivityIcon icon={<IconCode className="act-icon__svg" />} title="脚本" active={activity === "scripts"} onClick={() => setActivity(activity === "scripts" ? null : "scripts")} />
        )}
        <div className="activity-bar__spacer" />
        {isTauri() && <ActivityIcon icon={<IconGlobe className="act-icon__svg" />} title="添加远程设备" active={false} onClick={() => setRemoteOpen(true)} />}
        <ActivityIcon
          icon={theme === "dark" ? <IconMoon className="act-icon__svg" /> : <IconSun className="act-icon__svg" />}
          title={theme === "dark" ? "切换亮色模式" : "切换暗色模式"}
          active={false}
          onClick={toggleTheme}
        />
        <div className="manage">
          <ActivityIcon icon={<IconSliders className="act-icon__svg" />} title="管理" active={manageMenu} onClick={() => setManageMenu(!manageMenu)} />
          {manageMenu && (
            <>
              <div className="manage-backdrop" onClick={() => setManageMenu(false)} />
              <div className="manage-menu">
                <button className="manage-menu__item" onClick={() => { setSettingsOpen(true); setManageMenu(false); }}>
                  <IconGear /> 设置
                </button>
                <button className="manage-menu__item" onClick={() => { setAboutOpen(true); setManageMenu(false); }}>
                  <IconInfo /> 关于
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 次侧栏：当前活动项内容，收起时不占位 */}
      {activity && (
        <>
        <aside className="sidebar" style={{ width: sidebarWidth }}>
          {(!isTauri() || isRemote) && (
            <div className="sidebar__conn">
              <span className={`dot ${connected ? "on" : "off"}`} />
              {isRemote ? "远程" : "Web"} · {connConfig.host}:{connConfig.port}
            </div>
          )}

          {activity === "ports" && (
            <>
              <div className="section-head">
                <h4 className="section-head__title">PORTS</h4>
                <button className="icon-btn" onClick={() => refreshPorts()} title="刷新">
                  <IconRefresh />
                </button>
              </div>
              {portGroups.map((grp) => {
                const dev = grp.devId === "local" ? null : remotes.find((r) => r.id === grp.devId);
                return (
                <div key={grp.devId} className="macro-group">
                  <div className="port-group__head">
                    <button className="port-group__toggle" onClick={() => togglePortGroup(grp.devId)}>
                      <span className={`dot ${grp.online ? "on" : "off"}`} />
                      <span className="macro-group__caret">{portCollapsed.has(grp.devId) ? "▶" : "▼"}</span>
                      <span className="port-group__name">{grp.label}</span>
                    </button>
                    <div className="port-group__actions">
                      <span className="port-group__count">{grp.ports.length}</span>
                      {/* 按钮区固定占位(46px)：本地卡无按钮也占位，使 count 列在所有卡上对齐 */}
                      <div className="port-group__btns">
                        {dev && (
                          <>
                            {grp.online !== true && (
                              <button className="port-group__action" title="重连设备" onClick={() => reconnectRemote(dev)}><IconRefresh /></button>
                            )}
                            <button className="port-group__action port-group__action--danger" title="删除设备" onClick={() => removeRemote(dev)}><IconTrash /></button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  {!portCollapsed.has(grp.devId) &&
                    (grp.ports.length === 0 ? (
                      <p className="sidebar__empty">{grp.online === false ? "未连接" : "无可用端口"}</p>
                    ) : (
                      grp.ports.map((p) => {
                        const pid = portIdOf(grp.devId, p.name);
                        const isActive = pid === activePort;
                        const editingThis = aliasEdit?.port === pid && aliasEdit?.where === "list";
                        const canForce = grp.devId === "local" && p.opened;
                        return (
                          <div key={p.name} className="port-item-row" data-active={isActive} data-opened={p.opened ? "true" : undefined} data-force={canForce ? "true" : undefined} data-editing={editingThis ? "true" : undefined}>
                            <div
                              className="port-item"
                              role="button"
                              tabIndex={0}
                              onClick={() => {
                                if (!editingThis) triggerPort(pid);
                              }}
                              onKeyDown={(e) => {
                                if (editingThis) return;
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  triggerPort(pid);
                                }
                              }}
                            >
                              <span className={`port-item__dot${p.opened ? " open" : ""}`} />
                              <span className="port-item__name">
                                {editingThis ? (
                                  <InlineAliasInput
                                    initial={p.alias ?? ""}
                                    placeholder={`为 ${p.name} 设置别名`}
                                    onCommit={(alias) => commitAlias(pid, alias)}
                                    onCancel={() => setAliasEdit(null)}
                                  />
                                ) : (
                                  <PortLabel name={p.name} alias={p.alias} />
                                )}
                              </span>
                              {p.opened && p.holders > 0 && <span className="port-item__holders">{p.holders}</span>}
                            </div>
                            <button
                              className="port-item__edit"
                              title={`设置 ${p.name} 别名`}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => setAliasEdit({ port: pid, where: "list" })}
                            >
                              <IconEdit />
                            </button>
                            {canForce && (
                              <button
                                className="port-item__force"
                                title={`强制关闭 ${p.name}（断开远程）`}
                                onClick={() => forceClosePort(pid)}
                              >
                                <IconPower />
                              </button>
                            )}
                          </div>
                        );
                      })
                    ))}
                </div>
              );
              })}
            </>
          )}

          {activity === "macros" && (
            <>
              <div className="section-head">
                <h4 className="section-head__title">
                  MACROS{activePort && <span className="accent">→ {activePort}</span>}
                </h4>
                <div className="section-head__actions">
                  <button className="icon-btn" onClick={() => importInputRef.current?.click()} title="导入宏">
                    <IconImport />
                  </button>
                  <button
                    className="icon-btn"
                    onClick={() => setExportMacrosOpen(true)}
                    disabled={Object.keys(macros).length === 0}
                    title="导出宏（可多选 / 全选）"
                  >
                    <IconExport />
                  </button>
                  <button className="icon-btn" onClick={() => openMacroEditor(null)} title="新增宏">
                    <IconPlus />
                  </button>
                </div>
                <input
                  ref={importInputRef}
                  type="file"
                  accept=".json,application/json"
                  style={{ display: "none" }}
                  onChange={onImportFile}
                />
              </div>
              {Object.keys(macros).length === 0 && <p className="sidebar__empty">无宏（点 ＋ 新增）</p>}
              {groupBy(Object.entries(macros), (m) => m.group).map((g) => (
                <div key={g.name} className="macro-group">
                  <GroupHead
                    name={g.name}
                    count={g.items.length}
                    collapsed={macroCollapsed.has(g.name)}
                    onToggle={() => toggleMacroGroup(g.name)}
                    onRename={(n) => renameMacroGroup(g.name, n)}
                    onDissolve={() => askDissolveMacroGroup(g.name)}
                    menuHidden={g.name === "未分组"}
                  />
                  {!macroCollapsed.has(g.name) && g.items.map(([name]) => (
                    <div key={name} className="macro-row">
                      <button
                        className="macro-run"
                        onClick={() => {
                          runMacro(name);
                          // 运行后焦点交还终端:否则焦点留在按钮上,回车会再次触发本按钮(重复运行宏)
                          activeTerm?.term.focus();
                        }}
                        disabled={!activePort}
                      >
                        <IconPlay />
                        <span className="macro-run__label">{name}</span>
                      </button>
                      <button className="macro-action macro-action--edit" onClick={() => openMacroEditor(name)} title="编辑">
                        <IconEdit />
                      </button>
                      <button className="macro-action macro-action--danger" onClick={() => deleteMacro(name)} title="删除">
                        <IconTrash />
                      </button>
                    </div>
                  ))}
                </div>
              ))}
              {[...macroRuns.entries()].map(([runId, card]) => (
                <div key={runId} className={card.status === "running" ? "script-task" : `script-task script-task--${card.success ? "ok" : "err"}`}>
                  {card.status === "running" ? (
                    <div className="script-task__head" title={`${card.name} 运行中`}>
                      <span className="script-task__name">⟳ {card.name}</span>
                      <span className="script-task__status">运行中…</span>
                      <button
                        className="script-task__stop"
                        title="停止宏"
                        onClick={() => transportsRef.current.get(card.devId)?.stopMacro(runId)}
                      >停止</button>
                    </div>
                  ) : (
                    <div className="script-task__head">
                      <span className="script-task__msg">{card.success ? "✓" : "✗"} {card.name}: {card.message}</span>
                      <button
                        className="macro-result__close"
                        title="关闭"
                        onClick={() => setMacroRuns((prev) => { const n = new Map(prev); n.delete(runId); return n; })}
                      >×</button>
                    </div>
                  )}
                </div>
              ))}
            </>
          )}

          {activity === "scripts" && (
            <>
              <div className="section-head">
                <h4 className="section-head__title">
                  SCRIPTS{activePort && <span className="accent">→ {activePort}</span>}
                </h4>
                <div className="section-head__actions">
                  <button className="icon-btn" onClick={() => scriptImportInputRef.current?.click()} title="导入脚本">
                    <IconImport />
                  </button>
                  <button
                    className="icon-btn"
                    onClick={() => setExportScriptsOpen(true)}
                    disabled={Object.keys(scripts).length === 0}
                    title="导出脚本（可多选 / 全选）"
                  >
                    <IconExport />
                  </button>
                  <button className="icon-btn" onClick={() => openScriptEditor(null)} title="新增脚本">
                    <IconPlus />
                  </button>
                  <button
                    className="icon-btn"
                    title="脚本编写指南(查看 / 复制给外部 Agent)"
                    onClick={() => {
                      setSkillOpen(true);
                      if (skillText === null) {
                        transportsRef.current.get(isLocal ? "local" : remotes[0]?.id ?? "")?.getScriptSkill().then(setSkillText).catch(() => {});
                      }
                    }}
                  >
                    <IconInfo />
                  </button>
                </div>
                <input
                  ref={scriptImportInputRef}
                  type="file"
                  accept=".json,application/json"
                  style={{ display: "none" }}
                  onChange={onImportScripts}
                />
              </div>
              {Object.keys(scripts).length === 0 && <p className="sidebar__empty">无脚本（点 ＋ 新增）</p>}
              {groupBy(Object.entries(scripts), (s) => s.group).map((g) => (
                <div key={g.name} className="macro-group">
                  <GroupHead
                    name={g.name}
                    count={g.items.length}
                    collapsed={scriptCollapsed.has(g.name)}
                    onToggle={() => toggleScriptGroup(g.name)}
                    onRename={(n) => renameScriptGroup(g.name, n)}
                    onDissolve={() => askDissolveScriptGroup(g.name)}
                    menuHidden={g.name === "未分组"}
                  />
                  {!scriptCollapsed.has(g.name) && g.items.map(([name]) => (
                    <div key={name} className="macro-row">
                      <button
                        className="macro-run"
                        onClick={() => {
                          runScript(name);
                          // 仅在不弹参数框时回焦终端;弹框场景焦点应进对话框(由 modalOpen effect 接管)
                          if (!scripts[name]?.params?.length) activeTerm?.term.focus();
                        }}
                      >
                        <IconPlay />
                        <span className="macro-run__label">{name}</span>
                      </button>
                      <button className="macro-action macro-action--edit" onClick={() => openScriptEditor(name)} title="编辑">
                        <IconEdit />
                      </button>
                      <button className="macro-action macro-action--danger" onClick={() => deleteScript(name)} title="删除">
                        <IconTrash />
                      </button>
                    </div>
                  ))}
                </div>
              ))}
              {[...scriptRuns.entries()].map(([runId, card]) => (
                <div
                  key={runId}
                  className={card.status === "running" ? `script-task${expandedLog === runId ? " script-task--open" : ""}` : `script-task script-task--${card.success ? "ok" : "err"}`}
                >
                  {card.status === "running" ? (
                    <>
                      <div
                        className="script-task__head"
                        onClick={() => setExpandedLog((v) => (v === runId ? null : runId))}
                        role="button"
                      >
                        <span className="script-task__name" title={card.name}>⟳ {card.name}</span>
                        <span className="script-task__status">运行中…</span>
                        <button
                          className="script-task__stop"
                          title="停止脚本"
                          onClick={(e) => { e.stopPropagation(); transportsRef.current.get(card.devId)?.stopScript(runId); }}
                        >停止</button>
                      </div>
                      {expandedLog === runId && (
                        <div className="script-log-list script-log-list--live">
                          {card.logs.length === 0 && (
                            <div className="script-log-list__line script-log-list__line--muted">（等待 log 输出…）</div>
                          )}
                          {card.logs.map((line, i) => (
                            <div key={i} className="script-log-list__line">{line}</div>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <div
                        className="script-task__head"
                        onClick={card.logs.length > 0 ? () => setExpandedLog((v) => (v === runId ? null : runId)) : undefined}
                        role={card.logs.length > 0 ? "button" : undefined}
                      >
                        <span className="script-task__msg">{card.success ? "✓" : "✗"} {card.name}: {card.message}</span>
                        <button
                          className="macro-result__close"
                          title="关闭"
                          onClick={(e) => {
                            e.stopPropagation();
                            setScriptRuns((prev) => { const n = new Map(prev); n.delete(runId); return n; });
                            if (expandedLog === runId) setExpandedLog(null);
                          }}
                        >×</button>
                      </div>
                      {expandedLog === runId && card.logs.length > 0 && (
                        <div className="script-log-list">
                          {card.logs.map((line, i) => (
                            <div key={i} className="script-log-list__line">{line}</div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </>
          )}
        </aside>
        <div
          className="sidebar-resizer"
          onMouseDown={(e) => {
            e.preventDefault();
            sidebarDrag.current = { x: e.clientX, w: sidebarWidth };
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
            const onMove = (ev: MouseEvent) => {
              const ds = sidebarDrag.current;
              if (!ds) return;
              setSidebarWidth(Math.max(180, Math.min(480, ds.w + (ev.clientX - ds.x))));
            };
            const onUp = () => {
              sidebarDrag.current = null;
              document.body.style.cursor = "";
              document.body.style.userSelect = "";
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          }}
          onDoubleClick={() => setSidebarWidth(240)}
          title="拖动调整宽度(双击重置)"
        />
        </>
      )}

      <main className="main">
        {errorMsg && (
          <div className="banner banner--err">
            <IconAlert /> {errorMsg}
          </div>
        )}
        {notice && (
          <div className="banner banner--notice">
            <IconInfo /> {notice}
          </div>
        )}
        {serviceError && (
          <div className="banner banner--err">
            <IconAlert /> {serviceError}
            <button className="banner__close" onClick={() => setServiceError("")} title="关闭">
              <IconClose />
            </button>
          </div>
        )}

        {/* 分栏布局：递归渲染 layout（split→flex，leaf→GroupView 含标签栏+终端区） */}
        {renderPane(layout)}
        {/* TermView 实例池：固定渲染于此（offscreen 隐藏），DOM 由 TermView 经 appendChild
            挪入所属 group 的终端容器（DOM reparent）。跨 group 搬 tab 只换容器、组件不重建 → 保 scrollback。 */}
        <div className="term-pool" aria-hidden>
          {openPorts.map((port) => {
            const gid = groupOfPort.get(port);
            const g = gid ? groups[gid] : undefined;
            return (
              <TermView
                key={port}
                port={port}
                targetContainer={gid ? groupContainers.get(gid) ?? null : null}
                visible={!!g && g.activePort === port}
                focused={!!g && gid === focusedGroupId && g.activePort === port}
                onWrite={(p, data) => {
                  touch(p, "tx");
                  const { devId, name } = parsePortId(p);
                  transportsRef.current.get(devId)?.write(name, data);
                }}
                onReady={(inst) => {
                  if (inst) terminalsRef.current.set(port, inst);
                  else terminalsRef.current.delete(port);
                }}
                disconnected={disconnectedPorts.has(port)}
                onReconnect={() => reconnectPort(port)}
              />
            );
          })}
        </div>

        {/* 通道条：活动端口的仪器状态条 + TX/RX LED（签名）。置底 */}
        {activePort && activeConfig && (
          <div className="channel-strip">
            <span className="channel-strip__port">
              <PortLabel name={activePort} alias={aliasOf(activePort)} />
            </span>
            <span className="channel-strip__sep">·</span>
            <span className="channel-strip__config">{formatConfig(activeConfig)}</span>
            {activeHolders > 0 && (
              <>
                <span className="channel-strip__sep">·</span>
                <span className="channel-strip__holders">● {activeHolders} 人</span>
              </>
            )}
            <span className="channel-strip__spacer" />
            <Leds port={activePort} activityRef={activityRef} />
          </div>
        )}
      </main>

      {/* 串口配置对话框（key=pendingPort：换端口重挂，别名输入状态重置） */}
      {pendingPort && (
        <SerialConfigDialog
          key={pendingPort}
          port={pendingPort}
          config={serialConfig}
          initialAlias={aliasOf(pendingPort) ?? ""}
          onChange={setSerialConfig}
          onConfirm={confirmOpen}
          onCancel={() => setPendingPort(null)}
        />
      )}

      {/* 宏批量导出对话框 */}
      {exportMacrosOpen && (
        <ExportMacrosDialog
          macros={macros}
          onConfirm={async (names) => {
            const obj: Record<string, Macro> = {};
            for (const n of names) obj[n] = macros[n];
            try {
              const saved = await downloadJson("serial-studio-macros.json", obj);
              if (saved) setExportMacrosOpen(false); // 用户取消（saved=false）则保持对话框打开
            } catch (e) {
              setErrorMsg("导出失败: " + String(e));
              setTimeout(() => setErrorMsg(""), 5000);
            }
          }}
          onCancel={() => setExportMacrosOpen(false)}
        />
      )}

      {/* 脚本批量导出对话框 */}
      {exportScriptsOpen && (
        <ExportScriptsDialog
          scripts={scripts}
          onConfirm={async (names) => {
            const obj: Record<string, Script> = {};
            for (const n of names) obj[n] = scripts[n];
            try {
              const saved = await downloadJson("serial-studio-scripts.json", obj);
              if (saved) setExportScriptsOpen(false);
            } catch (e) {
              setErrorMsg("导出失败: " + String(e));
              setTimeout(() => setErrorMsg(""), 5000);
            }
          }}
          onCancel={() => setExportScriptsOpen(false)}
        />
      )}

      {/* 设置面板 */}
      {settingsOpen && (
        <SettingsPanel
          connConfig={connConfig}
          srvSettings={srvSettings}
          showServer={isTauri() && !isRemote}
          onOpenShortcuts={() => setShortcutsOpen(true)}
          onConnChange={(c) => {
            saveConn(c);
            setConnConfig(c);
          }}
          onSaveSrv={async (s) => {
            if (!isTauri()) return;
            try {
              await tauriInvoke("apply_settings", { settings: s });
              setSrvSettings(s);
              setErrorMsg("");
              setConnConfig({ host: s.ws_host, port: s.ws_port });
            } catch (e) {
              setErrorMsg(String(e));
              setTimeout(() => setErrorMsg(""), 5000);
            }
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {aboutOpen && <AboutDialog version={version} onClose={() => setAboutOpen(false)} />}
      {skillOpen && (
        <ScriptSkillDialog text={skillText ?? "加载中…"} onClose={() => setSkillOpen(false)} />
      )}
      {pendingRun && scripts[pendingRun]?.params?.length && (
        <ScriptRunParamsDialog
          scriptName={pendingRun}
          params={scripts[pendingRun]!.params!}
          onConfirm={(args) => { doRun(pendingRun, args); setPendingRun(null); }}
          onCancel={() => setPendingRun(null)}
        />
      )}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      {macroPaletteOpen && (
        <MacroPalette
          macros={macros}
          activePort={activePort}
          onRun={runMacro}
          onClose={() => {
            setMacroPaletteOpen(false);
            // 关面板后焦点还给活动终端，否则执行完宏无法继续键入（同 SearchBar）
            activeTerm?.term.focus();
          }}
        />
      )}
      {scriptPaletteOpen && (
        <ScriptPalette
          scripts={scripts}
          activePort={activePort}
          onRun={runScript}
          onClose={() => {
            setScriptPaletteOpen(false);
            activeTerm?.term.focus();
          }}
        />
      )}
      {portPaletteOpen && (
        <PortPalette
          ports={allPorts}
          onSelect={triggerPort}
          onClose={() => {
            setPortPaletteOpen(false);
            activeTerm?.term.focus();
          }}
        />
      )}
      {remoteOpen && <RemoteDialog input={remoteInput} onChange={setRemoteInput} onConfirm={addRemote} onCancel={() => setRemoteOpen(false)} />}

      {confirmState && (
        <ConfirmDialog
          title={confirmState.title}
          icon={confirmState.icon}
          message={confirmState.message}
          confirmText={confirmState.confirmText}
          tone={confirmState.tone}
          onConfirm={confirmState.onConfirm}
          onCancel={() => setConfirmState(null)}
        />
      )}

      {/* 宏编辑器 */}
      {editing && (
        <MacroEditor
          name={editorName}
          macro={editorMacro}
          error={editorError}
          isNew={editing.isNew}
          groups={Array.from(new Set(Object.values(macros).map((m) => m.group).filter((g): g is string => !!g)))}
          onName={setEditorName}
          onMacroChange={setEditorMacro}
          onSave={saveMacroDef}
          onDelete={() => deleteMacro(editing.name)}
          onCancel={() => setEditing(null)}
        />
      )}

      {/* 脚本编辑器 */}
      {editingScript && (
        <ScriptEditor
          name={editorScriptName}
          script={editorScript}
          error={editorScriptError}
          isNew={editingScript.isNew}
          groups={Array.from(new Set(Object.values(scripts).map((s) => s.group).filter((g): g is string => !!g)))}
          onName={setEditorScriptName}
          onScriptChange={setEditorScript}
          onSave={saveScriptDef}
          onDelete={() => deleteScript(editingScript.name)}
          onCancel={() => setEditingScript(null)}
        />
      )}
    </div>
  );
}
