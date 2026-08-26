import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  ActionId,
  ConnConfig,
  CaptureSession,
  Macro,
  PaneDir,
  PaneHalf,
  PaneNode,
  PortId,
  PortInfo,
  RemoteDevice,
  Script,
  ScriptRunCard,
  MacroRunCard,
  SerialConfig,
  SrvSettings,
  TermInstance,
} from "./types";
import { leafGroupIds } from "./pane-tree";
import {
  DEFAULT_CONFIG,
  alignRemotesId,
  defaultCaptureName,
  displayPortName,
  downloadJson,
  getMode,
  initConn,
  isTauri,
  loadConfig,
  loadScriptArgs,
  mergeChunks,
  parsePortId,
  persistMacros,
  persistRemotes,
  persistScriptArgs,
  persistScripts,
  portIdOf,
  saveConfig,
  saveConn,
  tauriInvoke,
  wireToPid,
  bucketPidOf,
} from "./lib";
import { initialSession, sessionReducer } from "./store";
import {
  isMacroLike,
  isScriptLike,
  loadMacros,
  loadScripts,
  type LibrarySpec,
  useNamedLibrary,
} from "./library";
import { LocalTransport, RemoteTransport, type Transport } from "./transport";
import {
  AboutDialog,
  ActivityIcon,
  ConfirmDialog,
  ExportMacrosDialog,
  ExportScriptsDialog,
  GroupView,
  MacroEditor,
  MacroPalette,
  ScriptPalette,
  PortPalette,
  newStep,
  PortLabel,
  RemoteDialog,
  RunCards,
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
import { MacroRow, NamedLibraryPanel, PortsPanel, ScriptRow } from "./components/sidebar";
import { TitleBar } from "./components/titlebar";
import {
  IconAlert,
  IconBolt,
  IconClose,
  IconCode,
  IconGear,
  IconGlobe,
  IconInfo,
  IconKeyboard,
  IconPlug,
  IconPower,
  IconSliders,
  IconTrash,
  IconShirt,
  IconCheck,
} from "./icons";
import { getTheme, setTheme, subscribe, toggleTheme, THEMES, type Theme } from "./theme";
import { eventToCombo, findAction } from "./shortcuts";

type Activity = { rx: number; tx: number };

/* 主题图标/清单均从 theme.ts 注册表读取(THEMES),此处不再持有映射表。 */

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

/** 宏库差异面（模块级常量：仅依赖导入，引用稳定，供 useNamedLibrary 挂载加载不重跑）。 */
const MACRO_SPEC: LibrarySpec<Macro> = {
  label: "宏",
  isItemLike: isMacroLike,
  validateItem: (m) => validateMacro(m),
  newItem: () => ({ description: "", steps: [newStep("send")] }),
  importBase: "导入的宏",
  importHint: '导入失败：未找到有效宏（需 {"名称": {steps:[...]}} 或单个宏）',
  collapsedKey: "macro-groups-collapsed",
  load: loadMacros,
  persist: persistMacros,
};

/** 脚本库差异面。 */
const SCRIPT_SPEC: LibrarySpec<Script> = {
  label: "脚本",
  isItemLike: isScriptLike,
  validateItem: (s) => (s.code.trim() ? null : "脚本代码不能为空"),
  newItem: () => ({ code: "// 在此写 JS 脚本\n" }),
  importBase: "导入的脚本",
  importHint: '导入失败：未找到有效脚本（需 {"名称": {code:"..."}} 或单个脚本）',
  collapsedKey: "script-groups-collapsed",
  load: loadScripts,
  persist: persistScripts,
};

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
  // 运行形态（唯一判定点 lib.ts::getMode）：本地桌面 / 远程窗口 / Web
  const mode = getMode();
  const isRemote = mode === "remote-window";
  const isLocal = mode === "local";
  // ===== 会话状态（reducer）：transport 事件回调会读写的领域状态统一于此。
  // 事件回调只 dispatch（永不 stale），不再需要 per-state 的 ref 镜像。见 store.ts。
  const [session, dispatch] = useReducer(sessionReducer, initialSession);
  const { portsByDev, devOnline, openPorts, disconnectedPorts, portConfigs, groups, layout, focusedGroupId } = session;
  // 唯一的快照镜像：bindTransport（空依赖、只绑一次）读最新会话状态用（重连重放的端口清单）。
  const sessionRef = useRef(session);
  sessionRef.current = session;
  /** 宏运行卡片:runId → MacroRunCard(贯穿 running→done,并发各自,就地切换)。 */
  const [macroRuns, setMacroRuns] = useState<Map<string, MacroRunCard>>(new Map());
  // devOnline[devId]：该设备 WS/IPC 是否就绪，驱动折叠卡状态点（reducer 内）。
  /** 全局连接标志（兼容旧消费方：通道条/Web 远程提示）。本地看 devOnline["local"]，远程看任一就绪。 */
  const connected = isLocal ? !!devOnline["local"] : Object.values(devOnline).some(Boolean);
  /** editor-group 分栏：每个 group = 标签栏 + 终端区。端口唯一归属一个 group（不扇出）。reducer 内。 */
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
  // remotes 的快照镜像：cmdTransport 空依赖化后经此读最新列表(web 改连换 key)。
  const remotesRef = useRef(remotes);
  remotesRef.current = remotes;
  // 展开的远程设备卡（= 需要连接）。桌面端先空（mount effect 加载 remotes 后全展开 → 自动重连）；
  // Web/远程窗口默认展开其唯一设备。
  const [expandedRemotes, setExpandedRemotes] = useState<Set<string>>(() =>
    isLocal ? new Set() : new Set(["remote"]),
  );
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [remoteInput, setRemoteInput] = useState({ host: "", port: 18700, nickname: "" });
  const [srvSettings, setSrvSettings] = useState<SrvSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 脚本运行卡片:runId → ScriptRunCard(贯穿 running→done,并发各自,就地切换)。logs 为 log() 实时累积。 */
  const [scriptRuns, setScriptRuns] = useState<Map<string, ScriptRunCard>>(new Map());
  /** 脚本上次运行参数(脚本名 → 键值):参数收集框预填,二次运行只改要动的参数。
   *  localStorage 持久化(三形态统一);点「运行」时写入,「取消」不写。 */
  const [scriptArgs, setScriptArgs] = useState<Record<string, Record<string, string>>>(loadScriptArgs);
  /** 未查看的失败结果 runId 集合(驱动活动栏红角标;打开对应面板即清——"查看"清偿提醒)。 */
  const [macroUnseen, setMacroUnseen] = useState<Set<string>>(new Set());
  const [scriptUnseen, setScriptUnseen] = useState<Set<string>>(new Set());
  // runs 的 ref 镜像:断线等事件回调里读"当前谁在 running"(避免 setState updater 内收集副作用的 StrictMode 双跑)
  const macroRunsRef = useRef<Map<string, MacroRunCard>>(new Map());
  const scriptRunsRef = useRef<Map<string, ScriptRunCard>>(new Map());
  useEffect(() => {
    macroRunsRef.current = macroRuns;
    scriptRunsRef.current = scriptRuns;
  }, [macroRuns, scriptRuns]);
  /** 当前展开日志的卡片 runId(null = 收起);一次展开一个卡片。 */
  const [expandedLog, setExpandedLog] = useState<string | null>(null);
  // ===== 终端记录落盘(capture)(local 形态;会话级不持久化,headless/web 不涉及) =====
  /** pid → 记录会话(终端底部条渲染模型)。 */
  const [captureSessions, setCaptureSessions] = useState<Map<PortId, CaptureSession>>(new Map());
  // ref 镜像:onData 热路径与 flush 定时器读最新态(回调闭包不 stale)。
  const captureSessionsRef = useRef(captureSessions);
  captureSessionsRef.current = captureSessions;
  /** pid → 待写字节队列(onData 入队,flush 定时器消费;与渲染解耦故只住 ref)。 */
  const captureQueuesRef = useRef(new Map<PortId, { chunks: Uint8Array[]; bytes: number }>());
  /** 在途写盘的口集合(同口单飞:上批未落盘前不发起下批,防同 id 并发写乱序)。 */
  const captureInflightRef = useRef(new Set<PortId>());
  const setCaptureSession = useCallback((pid: PortId, s: CaptureSession | undefined) => {
    setCaptureSessions((prev) => {
      const n = new Map(prev);
      if (s) n.set(pid, s);
      else n.delete(pid);
      return n;
    });
  }, []);
  type ActivityView = "ports" | "macros" | "scripts" | null;
  // 默认展开端口面板:空终端区的引导文案("从左侧 PORTS 打开一个串口")依赖它在场
  const [activity, setActivity] = useState<ActivityView>("ports");
  /** 打开对应面板即视为"已查看" → 清未读红角标。 */
  useEffect(() => {
    if (activity === "macros") setMacroUnseen(new Set());
    if (activity === "scripts") setScriptUnseen(new Set());
  }, [activity]);
  /** 侧栏宽度(可拖动调整,localStorage 持久化,clamp 180–480)。 */
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem("sidebar-width"));
    return saved >= 180 && saved <= 480 ? saved : 240;
  });
  const sidebarDrag = useRef<{ x: number; w: number } | null>(null);
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
  /** 主题选择菜单(按注册表顺序平铺列出全部主题)。 */
  const [themeMenu, setThemeMenu] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  /** 脚本指南对话框;skillText 首次打开时拉取并缓存(null=未拉/拉取中),skillFailed 标记失败可重试。 */
  const [skillOpen, setSkillOpen] = useState(false);
  const [skillText, setSkillText] = useState<string | null>(null);
  const [skillFailed, setSkillFailed] = useState(false);
  const fetchSkill = useCallback(() => {
    setSkillText(null);
    setSkillFailed(false);
    // 注意:非本地态依赖 remotes[0] 同步派生自 connConfig(引用计数 effect 只换 transport 实例不换 id)
    const t = transportsRef.current.get(isLocal ? "local" : remotes[0]?.id ?? "");
    // transport 未建(如 Web 连接未就绪):置失败给出重试入口,而非永久「加载中…」
    if (!t) {
      setSkillFailed(true);
      return;
    }
    t.getScriptSkill().then(setSkillText).catch(() => setSkillFailed(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLocal]);
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
    confirmText: string;
    tone?: "primary" | "danger";
    onConfirm: () => void;
  } | null>(null);

  // ===== 宏/脚本库（泛型 useNamedLibrary，差异面见 MACRO_SPEC/SCRIPT_SPEC）=====
  // ui 三件套：确认弹窗 / 轻提示 / 错误横幅（库内部行为与文案由此触达宿主）。
  // 定时器先清旧的再设新的——否则第 2 条横幅会被第 1 条的旧定时器提前清掉（互踩）。
  const noticeTimer = useRef<number | null>(null);
  const errorTimer = useRef<number | null>(null);
  const libNotify = useCallback((msg: string, ms = 4000) => {
    setNotice(msg);
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(""), ms);
  }, []);
  const libError = useCallback((msg: string, ms = 5000) => {
    setErrorMsg(msg);
    if (errorTimer.current !== null) clearTimeout(errorTimer.current);
    errorTimer.current = window.setTimeout(() => setErrorMsg(""), ms);
  }, []);
  // ===== 运行结果 toast:宏/脚本完成时若对应面板不可见,右下角浮出结果,点击打开面板;
  // 也承载连接反馈等无面板消息(panel 省略,点击仅关闭) =====
  type Toast = { id: number; ok: boolean; text: string; panel?: "macros" | "scripts" };
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);
  const pushToast = useCallback((ok: boolean, text: string, panel?: "macros" | "scripts") => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev.slice(-3), { id, ok, text, panel }]); // 最多同时 4 条
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), ok ? 3000 : 6000);
  }, []);
  // 事件回调里读当前活动面板(避免闭包过期;activityRef 已被 LED 活动时间戳占用,故名 activityViewRef)
  const activityViewRef = useRef<ActivityView>(null);
  useEffect(() => {
    activityViewRef.current = activity;
  }, [activity]);
  // 库内确认(删除/解散)onConfirm 完成后自动关弹窗——对齐重构前各 handler 末尾的 setConfirmState(null)
  const libConfirm = useCallback((s: {
    title: string;
    icon?: React.ReactNode;
    message: string;
    confirmText: string;
    tone?: "primary" | "danger";
    onConfirm: () => void | Promise<void>;
  }) => {
    setConfirmState({
      ...s,
      onConfirm: async () => {
        await s.onConfirm();
        setConfirmState(null);
      },
    });
  }, []);
  const libUI = useMemo(
    () => ({ confirm: libConfirm, notify: libNotify, error: libError }),
    [libConfirm, libNotify, libError]
  );
  const macroLib = useNamedLibrary(MACRO_SPEC, libUI);
  const scriptLib = useNamedLibrary(SCRIPT_SPEC, libUI);
  // 解构成 JSX 原名，侧栏/编辑器零改动
  const {
    items: macros,
    editing,
    editorName,
    editorItem: editorMacro,
    editorError,
    setEditorName,
    setEditorItem: setEditorMacro,
    openEditor: openMacroEditor,
    saveDef: saveMacroDef,
    askDelete: deleteMacro,
    renameItemGroup: renameMacroGroup,
    askDissolve: askDissolveMacroGroup,
    importFile: onImportFile,
    collapsed: macroCollapsed,
    toggleGroup: toggleMacroGroup,
    groupNames: macroGroupNames,
  } = macroLib;
  const {
    items: scripts,
    editing: editingScript,
    editorName: editorScriptName,
    setEditorName: setEditorScriptName,
    editorItem: editorScript,
    setEditorItem: setEditorScript,
    editorError: editorScriptError,
    openEditor: openScriptEditor,
    saveDef: saveScriptDef,
    askDelete: deleteScript,
    renameItemGroup: renameScriptGroup,
    askDissolve: askDissolveScriptGroup,
    importFile: onImportScripts,
    collapsed: scriptCollapsed,
    toggleGroup: toggleScriptGroup,
    groupNames: scriptGroupNames,
    reload: reloadScripts,
  } = scriptLib;
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
  /** 端口 → 所属 group 反查（每 render 重建；端口唯一归属一个 group）。 */
  const groupOfPort: Map<string, string> = new Map();
  for (const g of Object.values(groups)) for (const p of g.ports) groupOfPort.set(p, g.id);
  /** 全局活动端口 = 聚焦 group 的活动端口（派生）。channel-strip / macro / 搜索等消费者零改动。 */
  const activePort = groups[focusedGroupId]?.activePort ?? "";

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
  /** 快捷键处理器表：每 render 用最新闭包刷新；dispatchAction 经 ref 读，菜单/action 闭包不陈旧。
   *  Partial：terminal 作用域（zoom）不经此 dispatch（在 xterm handler 内自处理）。 */
  const handlersRef = useRef<Partial<Record<ActionId, (arg?: string) => void>>>({});
  const dispatchAction = useCallback((action: ActionId, arg?: string) => {
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

  /** 命令面 transport:**按形态**而非 pid 的 devId 选择——桌面恒 local(远程设备的
   *  口由本地 manager 复合键路由到后端 DeviceClient,pid 直达);web/远窗恒唯一
   *  RemoteTransport(所有口都是所连远端的)。此前按 devId 选,远程设备/镜像口的
   *  devId 在 transportsRef 里查不到对应 transport,open/write 静默失败。
   *  remotes 经 ref 读取(web 改连换 key)——**绝不能进依赖**:本回调是
   *  cmdTransport→openPort→bindTransport 身份链的头,一旦随 remotes 变化,本地
   *  transport effect 会拆掉重建(注释自称"常驻"却守不住),重建窗口内后端
   *  devices-changed 等事件无人监听→首添设备卡死"连接中…";已开端口的 RX
   *  Channel 也随旧实例作废(串口变哑)。 */
  const cmdTransport = useCallback(
    (): Transport | undefined =>
      transportsRef.current.get(isLocal ? "local" : (remotesRef.current[0]?.id ?? "")),
    // isLocal 是模块常量(getMode 逐 render 同值);remotesRef 每 render 刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  /** 真正发起占有：建终端标签、记实际配置；附加时提示沿用既有配置。返回 acquire 结果（供调用方按 opened 决策）。
   *  稳定回调（dispatch/setter 永不 stale）：bindTransport 重连重放与 UI 触发共用同一入口。 */
  const openPort = useCallback(async (pid: PortId, config: SerialConfig) => {
    try {
      // transport 命令面收完整 pid:本地 IPC 直传(Rust 规范化),WS 侧剥首段成远端线名
      const res = await cmdTransport()?.open(pid, config);
      if (!res) return undefined;
      // 成功占有（首开或附加）：记录端口实际配置 + 建 tab 进焦点 group + 清断开标记，全部由 reducer 承担
      dispatch({ type: "port_acquired", pid, config: res.config });
      if (!res.opened) {
        // 附加到已开端口：请求的 config 被忽略，告知实际配置
        const c = res.config;
        libNotify(`已加入 ${displayPortName(pid)}（当前 ${res.holders} 人在线）；端口沿用既有配置 ${c.baud_rate} 波特、换行 ${c.line_ending.toUpperCase()}。如需修改配置，请强制关闭该端口后重新打开。`, 8000);
      }
      return res;
    } catch (e) {
      libError(String(e));
      return undefined;
    }
  }, [libNotify, libError, cmdTransport]);

  /** 从分栏与端口清单移除端口（关端口共用：用户主动关 + 远端被关）。状态变更全在 reducer；
   *  此处仅清终端实例/活动时间戳等会话级资源（副作用不进 reducer）。 */
  const prunePort = useCallback((pid: PortId) => {
    terminalsRef.current.delete(pid);
    activityRef.current.delete(pid);
    // 记录会话收尾:尾批积压 + flush + 摘句柄一条命令原子完成(忘调也无泄漏——进程退出兜底)
    const ls = captureSessionsRef.current.get(pid);
    if (ls?.id !== undefined) {
      const tail = takeCaptureQueue(pid);
      void tauriInvoke("capture_end", { id: ls.id, data: tail ? Array.from(tail) : null }).catch(() => {});
    }
    captureSessionsRef.current.delete(pid);
    captureQueuesRef.current.delete(pid);
    captureInflightRef.current.delete(pid);
    dispatch({ type: "prune_port", pid });
  }, []);

  /** 记录默认名的设备标识:remotes 昵称优先,否则键首段(uuid)。本地口返回 undefined。 */
  const devLabelOf = useCallback((pid: PortId): string | undefined => {
    const { devId } = parsePortId(pid);
    if (devId === "local") return undefined;
    return remotesRef.current.find((r) => r.id === devId)?.nickname ?? devId;
  }, []);

  /** 取走该口记录队列的剩余积压并合并(状态转换点收尾用);空队列返回 null。
   *  只碰 ref,故 useCallback([]) 稳定。 */
  const takeCaptureQueue = useCallback((pid: PortId): Uint8Array | null => {
    const q = captureQueuesRef.current.get(pid);
    if (!q || q.chunks.length === 0) return null;
    const merged = mergeChunks(q.chunks);
    q.chunks = [];
    q.bytes = 0;
    return merged;
  }, []);

  /** 选记录文件(原生保存对话框)→ 开始记录。用户取消不动现状;换文件先收尾旧句柄。
   *  对话框悬停期间旧会话保持 recording:flush 定时器照常写旧文件,数据零丢失。 */
  const selectCaptureFile = useCallback(
    async (pid: PortId) => {
      const prev = captureSessionsRef.current.get(pid);
      const defaultName = prev?.defaultName ?? defaultCaptureName(pid, devLabelOf(pid));
      try {
        const t = await tauriInvoke<{ id: number; path: string } | null>("capture_begin", { defaultName });
        if (!t) return; // 用户取消
        // await 后重读当前会话(双击双对话框/期间关 tab 的竞态防御):仍有旧句柄则
        // "尾批写旧文件 + flush + 摘句柄"一条命令原子完成——两条 IPC 会交错,单条不会
        const cur = captureSessionsRef.current.get(pid);
        if (cur?.id !== undefined && cur.id !== t.id) {
          const tail = takeCaptureQueue(pid);
          void tauriInvoke("capture_end", { id: cur.id, data: tail ? Array.from(tail) : null }).catch(
            (e) => libError(`旧记录收尾失败:${String(e)}`),
          );
        }
        captureQueuesRef.current.set(pid, { chunks: [], bytes: 0 });
        setCaptureSession(pid, { id: t.id, path: t.path, defaultName, state: "recording" });
      } catch (e) {
        libError(`选择记录文件失败:${String(e)}`);
      }
    },
    [devLabelOf, libError, setCaptureSession, takeCaptureQueue],
  );

  /** 记录中 → 暂停;暂停 → 继续(同一文件追加)。暂停前先把 ≤500ms 已入队积压写掉
   *  (记录=终端所见,已上屏数据不丢);暂停期间 RX 照常上屏但不入队。 */
  const toggleCapture = useCallback(
    (pid: PortId) => {
      const s = captureSessionsRef.current.get(pid);
      if (!s || s.id === undefined || s.state === "error") return;
      if (s.state === "recording") {
        const tail = takeCaptureQueue(pid);
        if (tail) {
          // 尾批写入失败静默(best-effort;磁盘类错误由定时器主路径 toast 报告)
          void tauriInvoke("capture_write", { id: s.id, data: Array.from(tail) }).catch(() => {});
        }
        setCaptureSession(pid, { ...s, state: "paused" });
      } else {
        setCaptureSession(pid, { ...s, state: "recording", error: undefined });
      }
    },
    [setCaptureSession, takeCaptureQueue],
  );

  // 攒批刷盘:onData 热路径只入队(零 await),此处 500ms 定时合并追加。同口单飞
  // (上批在途则留到下 tick,防同 id 并发写乱序);写失败 → 停会话 + toast。
  useEffect(() => {
    if (!isLocal) return;
    const timer = setInterval(() => {
      for (const [pid, q] of captureQueuesRef.current) {
        if (q.chunks.length === 0 || captureInflightRef.current.has(pid)) continue;
        const s = captureSessionsRef.current.get(pid);
        if (!s || s.state !== "recording" || s.id === undefined) {
          // 暂停/删除态理论队列恒空(转换点已收尾);此处残留仅是错位瞬间,丢弃保平安
          q.chunks = [];
          q.bytes = 0;
          continue;
        }
        const merged = mergeChunks(q.chunks);
        q.chunks = [];
        q.bytes = 0;
        const { id } = s;
        captureInflightRef.current.add(pid);
        void tauriInvoke("capture_write", { id, data: Array.from(merged) })
          .catch((e) => {
            // 会话同一性校验:关 tab/换文件后迟到的失败不得误伤新会话或弹假警报
            const cur = captureSessionsRef.current.get(pid);
            if (cur?.id === id) {
              setCaptureSession(pid, { ...cur, state: "error", error: String(e) });
              libError(`记录写入失败(${displayPortName(pid)}),已停止记录:${String(e)}`);
            }
          })
          .finally(() => captureInflightRef.current.delete(pid));
      }
    }, 500);
    return () => clearInterval(timer);
  }, [isLocal, libError, setCaptureSession]);

  /** 把 Transport 的所有事件绑到指定 devId。事件回调只 dispatch（永不 stale），
   *  重连重放经 sessionRef 读最新会话状态。返回取消函数。 */
  const bindTransport = useCallback((devId: string, t: Transport): (() => void)[] => {
    /** 某 devId 掉线:运行中卡片转"已中止"失败态(不删除——结果可回看,而非静默蒸发)。
     *  只转 running——已完成(✓/✗)的结果是既成事实,断线不该把它翻写成失败。
     *  被中断的进未读角标;面板不可见时 toast(与自然完成的反馈通道对齐)。
     *  transport 断连(WS 整体)与设备离线(DeviceClient 单设备)两路共用。 */
    const abortRunningFor = (downDev: string) => {
      const interruptedMacros = [...macroRunsRef.current.entries()].filter(
        ([, c]) => c.devId === downDev && c.status === "running"
      );
      const interruptedScripts = [...scriptRunsRef.current.entries()].filter(
        ([, c]) => c.devId === downDev && c.status === "running"
      );
      if (interruptedMacros.length) {
        setMacroUnseen((prev) => new Set([...prev, ...interruptedMacros.map(([rid]) => rid)]));
        if (activityViewRef.current !== "macros") {
          pushToast(false, `连接断开，宏「${interruptedMacros.map(([, c]) => c.name).join("」「")}」已中止`, "macros");
        }
      }
      if (interruptedScripts.length) {
        setScriptUnseen((prev) => new Set([...prev, ...interruptedScripts.map(([rid]) => rid)]));
        if (activityViewRef.current !== "scripts") {
          pushToast(false, `连接断开，脚本「${interruptedScripts.map(([, c]) => c.name).join("」「")}」已中止`, "scripts");
        }
      }
      setScriptRuns((prev) => {
        const n = new Map(prev);
        for (const [rid, card] of n) {
          if (card.devId === downDev && card.status === "running") {
            n.set(rid, { ...card, status: "done", success: false, message: "连接断开，已中止" });
          }
        }
        return n;
      });
      setMacroRuns((prev) => {
        const n = new Map(prev);
        for (const [rid, card] of n) {
          if (card.devId === downDev && card.status === "running") {
            n.set(rid, { ...card, status: "done", success: false, message: "连接断开，已中止" });
          }
        }
        return n;
      });
    };
    /** 某 devId 上线:重放断开待重连的端口(首次连上时集合为空 → 空操作)。 */
    const replayDisconnected = (upDev: string) => {
      const st = sessionRef.current;
      for (const pid of st.disconnectedPorts) {
        if (parsePortId(pid).devId !== upDev) continue;
        void openPort(pid, st.portConfigs[pid] ?? DEFAULT_CONFIG);
      }
    };
    // 补拉初始快照:事件是增量推送,窗口加载/刷新后早已在线的设备不会再发
    // 事件——不补拉,设备卡会永悬"连接中…"(此前只能手点重连触发 Offline/Online 沿)。
    // 远程形态为空实现(服务端 WS 打开即推快照)。
    void t.listDevices();
    return [
      t.onPorts((list) => dispatch({ type: "ports_listed", devId, ports: list })),
      t.onConnectedChange((conn) => {
        dispatch({ type: "dev_online", devId, online: conn });
        if (conn) {
          t.list();
          replayDisconnected(devId);
        } else {
          abortRunningFor(devId);
        }
      }),
      // 设备在线快照(桌面:后端 DeviceClientManager;远程:透传远端 ss 的设备表)。
      // 设备级上下线与 transport 级连接共用同一套中止/重放语义。
      t.onDevices((devices) => {
        // 桌面形态 id 对齐:后端握手学习把设备段名从占位 uuid 替换为对端实例 id
        // (段名=实例 id),Devices 推送随之带新 id。按 host:port 对齐 remotes 并写回
        // remotes.json(唯一写者仍是前端 save_remotes)。时序保证(后端先迁移后
        // online)使占位 id 从未有端口桶/打开的 tab——替换是纯增量,无需迁移键。
        if (isLocal) {
          const { list, renamed } = alignRemotesId(remotesRef.current, devices);
          if (renamed.size > 0) {
            setRemotes(list);
            persistRemotes(list);
            // 折叠键跟随替换(旧占位 id 的展开态迁移到学习 id)
            setExpandedRemotes((prev) => {
              const next = new Set<string>();
              for (const id of prev) next.add(renamed.get(id) ?? id);
              return next;
            });
          }
        }
        let anyOnline = false;
        for (const d of devices) {
          dispatch({ type: "dev_online", devId: d.id, online: d.online });
          if (d.online) {
            anyOnline = true;
            replayDisconnected(d.id);
          } else {
            abortRunningFor(d.id);
          }
        }
        // 列表是合并视图,刷新一次即可(勿在循环内逐设备拉——D 台在线会放大 D 倍)
        if (anyOnline) t.list();
      }),
      t.onData((port, data) => {
        const pid = wireToPid(devId, port); // 本地线名即 pid;远程线名加设备前缀
        touch(pid, "rx"); // 签名：收到字节 → RX 亮
        terminalsRef.current.get(pid)?.term.write(data);
        // 记录入队(仅 recording 收;热路径只 push,写盘在 flush 定时器)。
        // data 是 decodeDataFrame 每帧新分配的数组,可直接留存。
        const ls = captureSessionsRef.current.get(pid);
        if (ls?.state === "recording" && data.length > 0) {
          const q = captureQueuesRef.current.get(pid) ?? { chunks: [], bytes: 0 };
          q.chunks.push(data);
          q.bytes += data.length;
          // 内存护栏:单口积压上限 8MB(UI 冻结/后台标签堆积时丢最旧保最新)
          while (q.bytes > 8 * 1024 * 1024 && q.chunks.length > 1) {
            const head = q.chunks[0]!;
            q.bytes -= head.length;
            q.chunks.shift();
          }
          captureQueuesRef.current.set(pid, q);
        }
      }),
      t.onPortOpened((port) => {
        t.list();
        // 端口重新可用(本会话 reopen 或别处)→ 清该 tab 断开标记。保留占有权方案下
        // holder 真在、物理层已重建,清红是正确的(非上一版的"假绿")。
        dispatch({ type: "port_opened_evt", devId, port });
      }),
      t.onPortClosed((port) => {
        // 端口全局关闭（末位释放/被强制关闭）：清掉本会话的标签、终端与分栏归属
        prunePort(wireToPid(devId, port));
        t.list();
      }),
      t.onPortDisconnected((port) => {
        // 设备物理断开:保留 tab(scrollback 可继续看),仅标"已断开"待手动重连。
        // 不动 openPorts/terminalsRef/groups——重连后 onData 自动接回同一 term。
        dispatch({ type: "port_disconnected_evt", devId, port });
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
        libError(msg);
      }),
      t.onMacroResult((runId, name, success, message) => {
        // 更新对应卡片 running→done(card 不在则忽略,理论上 runMacro 已 set)。
        if (!runId) return;
        setMacroRuns((prev) => {
          const card = prev.get(runId);
          if (!card) return prev;
          return new Map(prev).set(runId, { ...card, status: "done", success, message });
        });
        // 成功结果 3s 后自动消失;失败保留(× 手动关),避免错过错误。
        if (success) setTimeout(() => setMacroRuns((prev) => { const n = new Map(prev); n.delete(runId); return n; }), 3000);
        if (!success) setMacroUnseen((prev) => new Set(prev).add(runId)); // 红角标(打开面板清偿)
        // 面板不可见时浮 toast(命令面板跑宏最常见:activity 还停在 ports)
        if (activityViewRef.current !== "macros") {
          pushToast(success, `宏「${name}」${success ? "完成" : `失败：${message ?? ""}`}`, "macros");
        }
      }),
      t.onScriptResult((runId, name, success, message) => {
        if (!runId) return;
        setScriptRuns((prev) => {
          const card = prev.get(runId);
          if (!card) return prev;
          return new Map(prev).set(runId, { ...card, status: "done", success, message });
        });
        if (!success) setScriptUnseen((prev) => new Set(prev).add(runId));
        if (activityViewRef.current !== "scripts") {
          pushToast(success, `脚本「${name}」${success ? "完成" : `失败：${message ?? ""}`}`, "scripts");
        }
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
  }, [openPort, prunePort, reloadScripts, libError, pushToast]);

  // 本地 Transport 常驻（devId="local"）：IPC 不随 connConfig 重连——重建会丢 per-port RX Channel，
  // 导致改服务监听设置后串口"变哑"（发得出收不到，重开才好）。重建窗口还会丢
  // devices-changed 等事件（首添设备卡"连接中…"的根因）——**不变量:bindTransport
  // 必须身份稳定**(其依赖链 openPort→cmdTransport 已 ref 化/空依赖,勿再引入状态依赖)。
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

  // 设备卡状态收敛看门狗:任一设备非 online(undefined=未知悬"连接中…"/false=离线)
  // 时兜底轮询设备快照。devices-changed 事件链任何一环丢失(加载竞态/webview 事件
  // 异常/后端早于监听上线/快照 false 后 Online 沿丢失)都不再导致状态永悬——后端
  // 已连上而前端不知情时 ≤1s 自动对齐。配合 dev_online reducer 幂等,离线期间的
  // 周期轮询零重渲染;全部在线时每秒仅一次空扫描。
  useEffect(() => {
    if (!isLocal) return;
    const tick = setInterval(() => {
      const st = sessionRef.current;
      if (!remotes.some((r) => st.devOnline[r.id] !== true)) return;
      transportsRef.current.get("local")?.listDevices();
    }, 1000);
    return () => clearInterval(tick);
  }, [isLocal, remotes]);

  // 远程 Transport 引用计数（按需）——仅 Web/远程窗口形态:前端直连远端 ss。
  // 桌面形态远程设备已下沉到后端(DeviceClientManager),本地只有 "local" 一个 transport,
  // 设备连接/重连/断开全由 Rust 侧管理,前端经 devices 事件观察状态。
  useEffect(() => {
    if (isLocal) return;
    // Web/远窗是单 transport 形态:所有口(含远端设备桶)都走它,恒保持连接——
    // 活跃 tab 计数按 pid 首段统计,远端设备的口不会计入本设备 id,不能作拆连依据。
    const wanted = new Set(remotes.map((d) => d.id));
    const map = transportsRef.current;
    const addrMap = remoteAddrRef.current;
    const teardown = (id: string) => {
      unsubsByDev.current.get(id)?.forEach((fn) => fn());
      unsubsByDev.current.delete(id);
      map.get(id)?.dispose();
      map.delete(id);
      addrMap.delete(id);
      dispatch({ type: "teardown_dev", devId: id });
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
  }, [remotes, bindTransport]);

  // Web/远程窗口：connConfig 变 → 同步单设备 remotes[0] 的 host/port（驱动上面的引用计数 effect 重连）。
  useEffect(() => {
    if (isLocal) return;
    setRemotes((prev) => {
      const r = prev[0];
      if (r && r.host === connConfig.host && r.port === connConfig.port) return prev;
      return [{ id: r?.id ?? "remote", host: connConfig.host, port: connConfig.port }];
    });
  }, [isLocal, connConfig.host, connConfig.port]);

  // 改连反馈：设置页「应用并重连」后以 toast 报告结果(成功/超时失败),不再点了没反应。
  const [pendingConn, setPendingConn] = useState<string | null>(null);
  // 成功判定:pendingConn 置位后 connected 稳定为 true ≥800ms——给旧连接 teardown→重建留时间,
  // 否则 teardown 前的旧 connected=true 会立刻假成功;connected 后续翻转会重置这 800ms 等待。
  useEffect(() => {
    if (!pendingConn) return;
    const ok = window.setTimeout(() => {
      if (connected) {
        pushToast(true, `已连接 ${pendingConn}`);
        setPendingConn(null);
      }
    }, 800);
    return () => window.clearTimeout(ok);
  }, [pendingConn, connected, pushToast]);
  // 失败判定:8s 内未稳定连上
  useEffect(() => {
    if (!pendingConn) return;
    const fail = window.setTimeout(() => {
      pushToast(false, `连接 ${pendingConn} 失败，请检查地址/端口与防火墙`);
      setPendingConn(null);
    }, 8000);
    return () => window.clearTimeout(fail);
  }, [pendingConn, pushToast]);

  // 服务器配置：Tauri 控制面 invoke 读本地 settings.json(失败可从设置面板重试)
  const [srvFailed, setSrvFailed] = useState(false);
  const loadSrvSettings = useCallback(() => {
    setSrvFailed(false);
    tauriInvoke<SrvSettings>("get_settings")
      .then((s) => {
        setSrvSettings(s);
        if (!isRemote) {
          setConnConfig((c) => (c.port === s.ws_port ? c : { host: "127.0.0.1", port: s.ws_port }));
        }
      })
      .catch(() => setSrvFailed(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (isTauri()) loadSrvSettings();
  }, [loadSrvSettings]);

  // 远程设备加载：桌面端 → invoke load_remotes（remotes.json 落盘）。设备在线快照
  // 不在此拉——transport 绑定时的 listDevices() 补拉已覆盖(见 bindTransport),此处
  // 再直连 invoke 是重复路径。Web/远程窗口不加载(由 connConfig 派生单设备,连接走
  // 前端 RemoteTransport)。
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

  // 主题：订阅 theme 模块，切换时同步菜单当前项勾选（入口图标固定为调色板）
  useEffect(() => subscribe(setThemeState), []);

  // 全局快捷键：单一 capture listener——combo 查 global 表 → dispatchAction。
  // 定义移至 modalOpen 计算之后（任一模态打开时不挂 listener，天然抑制——不抢对话框裸 Enter/Esc、不抢输入）。
  // 桌面若该 combo 已是菜单 accelerator，OS 先于 webview 拦截，listener 本就不会收到。

  // 原生菜单（B 层）暂不启用：Windows 上建菜单会占一条菜单栏，而所有全局快捷键已由
  // 上面的 listener 覆盖（菜单只是同一批动作的第二入口，属冗余）。要恢复原生菜单 /
  // accelerator，调 menu.ts 的 setupAppMenu(dispatch) 即可（web/远程模式自动 no-op）。
  // menu.ts 保留待用。

  // 切端口 / 关端口时收起搜索框（addon 已随实例销毁）
  useEffect(() => {
    setSearchOpen(false);
  }, [activePort]);

  /** 打开对话框确认：先 open，仅首开（opened=true）才落别名——与串口参数同逻辑（附加时别名忽略）。 */
  const confirmOpen = async (config: SerialConfig, alias: string) => {
    const pid = pendingPort;
    if (!pid) return;
    saveConfig(config);
    setPendingPort(null);
    // 对话框打开时的初始别名(open 之前取——列表状态未变,最可靠)。
    // 语义:确认即最终状态——与初始值不同才写;**空串 = 清除**(后端 apply_alias
    // 把空串归一为清除)。此前"留空直接 return"把清空误当不设置,旧别名残留。
    const initial = (aliasOf(pid) ?? "").trim();
    const trimmed = alias.trim();
    const res = await openPort(pid, config);
    if (res?.opened) {
      if (trimmed !== initial) {
        try {
          await cmdTransport()?.setAlias(pid, trimmed);
          refreshPorts();
        } catch (e) {
          libError(`设置别名失败：${String(e)}，请重试或检查配置目录写入权限`);
        }
      }
    } else if (res && !res.opened) {
      // 附加：别名未生效（端口已被其它会话先开）
      libNotify("端口已被其它会话打开，本次别名未生效。");
    }
  };

  /** 关端口：释放占有权 + 移除 tab（prune_port 全量状态变更在 reducer，prunePort 补清终端资源）。 */
  const closePort = (pid: PortId) => {
    // 关闭正在编辑别名的端口时退出编辑态：组件直接卸载会跳过 blur，否则 state 残留到端口列表
    if (aliasEdit?.port === pid) setAliasEdit(null);
    cmdTransport()?.close(pid);
    prunePort(pid);
  };

  const forceClosePort = (pid: PortId) => {
    setConfirmState({
      title: "强制关闭端口",
      icon: <IconPower />,
      message: `强制关闭 ${displayPortName(pid)}？将断开所有远程客户端并关闭该端口。`,
      confirmText: "强制关闭",
      tone: "danger",
      onConfirm: async () => {
        const t = transportsRef.current.get("local");
        if (t) {
          try {
            await t.forceClose(pid); // 踢远程持有者（force_close_others）
            await t.close(pid);      // 本地释放（远程已踢 → 末位 → 拆毁端口）
          } catch {
            /* 端口可能已被 force_close 拆毁，忽略 */
          }
        }
        prunePort(pid); // 显式清本地 tab（不依赖 onPortClosed 事件）
        setConfirmState(null);
      },
    });
  };

  /** 在聚焦 group 内切活动端口（activePort 由 groups[focused].activePort 派生）。 */
  const switchPort = (port: string) => dispatch({ type: "switch_tab", groupId: focusedGroupId, port });

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
  const switchTabInGroup = (groupId: string, port: string) =>
    dispatch({ type: "switch_tab", groupId, port });

  /** 拖 tab 到某 group 终端区半区：新建 group（装该 port）并在目标 group 处分裂。
   *  half=left/right→row，up/down→col；right/down→新 group 在后（side=end）。
   *  port 从源 group 迁出；源 group 空（且非自分裂）→ 坍缩移除。newId 生成在 reducer（确定性）。 */
  const dropHalf = (port: string, srcGroupId: string, dstGroupId: string, half: PaneHalf) =>
    dispatch({ type: "drop_half", port, srcGroupId, dstGroupId, half });
  const onDragOverHalf = (groupId: string, half: PaneHalf) => setDropHint({ overGroupId: groupId, overHalf: half });
  const onPaneDragLeave = () => setDropHint(null);

  /** 拖 tab 到另一 group 的标签栏：迁移 port 归属（源移除、目标追加 + 设其 activePort）。
   *  源 group 空 → 坍缩。TermView 经 portal 不 remount → scrollback 保留。逻辑全在 reducer。 */
  const movePort = (port: string, srcGroupId: string, dstGroupId: string) =>
    dispatch({ type: "move_port", port, srcGroupId, dstGroupId });

  /** 递归渲染分栏布局树：split→flex 容器(row/col + 比例 + 拖动手柄)，leaf→GroupView(标签栏+终端区)。
   *  path = 从根到此节点的子索引序列,供 set_split_ratio 定位(根 split 为 [])。 */
  const renderPane = (node: PaneNode, path: number[] = []) => {
    if (node.type === "split") {
      return (
        <div className={`pane-split pane-split--${node.dir}`}>
          <div className="pane-split__child" style={{ flex: node.ratio }}>
            {renderPane(node.children[0], [...path, 0])}
          </div>
          <PaneDivider
            dir={node.dir}
            onRatio={(r) => dispatch({ type: "set_split_ratio", path, ratio: r })}
          />
          <div className="pane-split__child" style={{ flex: 1 - node.ratio }}>
            {renderPane(node.children[1], [...path, 1])}
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
        onFocusGroup={() => dispatch({ type: "set_focused_group", groupId: node.groupId })}
        onWrite={(p, data) => {
          touch(p, "tx");
          cmdTransport()?.write(p, data);
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

  /** 重连断开的 tab:复用 openPort(自带 dedup + onData 路由接回同一 term)。成功即 port_acquired,
   *  断开标记由 reducer 一并清除(失败保持断开态待手动重试)。 */
  const reconnectPort = (pid: PortId) =>
    openPort(pid, portConfigs[pid] ?? DEFAULT_CONFIG);

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
      const { devId } = parsePortId(pid);
      const info = portsByDev[devId]?.find((p) => bucketPidOf(devId, p.name) === pid);
      if (info?.opened) void openPort(pid, serialConfig); // 被他会话占着：附加
      else setPendingPort(pid); // 未开：弹配置框
    }
  };

  const runMacro = (name: string) => {
    if (!activePort) {
      libError("请先选择并打开一个串口");
      return;
    }
    const runId = crypto.randomUUID();
    const devId = parsePortId(activePort).devId; // 卡片归属(展示用);命令面走形态 transport
    setMacroRuns((prev) => new Map(prev).set(runId, { name, devId, status: "running" }));
    cmdTransport()?.runMacro(name, activePort, macros[name], runId);
  };

  const doRun = (name: string, args: Record<string, string>) => {
    // 有 tab 用其端口作主端口;无 tab → 主端口空(纯 sleep/log 脚本照跑便于调试流程;
    // 有缺省 send 的脚本则 send 抛"未指定端口")。脚本天生跨多端口,不绑 tab(区别于宏)。
    const mainPort = activePort ?? "";
    const devId = activePort ? parsePortId(activePort).devId : isLocal ? "local" : (remotes[0]?.id ?? "");
    const transport = cmdTransport();
    if (!transport) {
      libError(isLocal ? "本地服务未就绪，无法运行脚本；请重启应用后重试" : "尚无可用连接，请先添加并连接一台远程设备");
      return;
    }
    const runId = crypto.randomUUID();
    setScriptRuns((prev) => new Map(prev).set(runId, { name, devId, status: "running", logs: [] }));
    setExpandedLog(runId); // 新运行自动展开:实时看进度;结束后同卡片继续展开看完整历史
    transport.runScript(name, mainPort, scripts[name], args, runId);
  };
  const runScript = (name: string) => {
    // 脚本声明了参数 → 弹收集框;否则直接跑。
    if (scripts[name]?.params?.length) {
      setPendingRun(name);
      return;
    }
    doRun(name, {});
  };

  /** 添加远程设备：生成稳定 UUID + 持久化（桌面）+ 默认展开（触发按需连接）。
   *  重复地址由 RemoteDialog 内联拦截(含 Enter 路径),此处再兜一层防御——
   *  校验只在 UI 入口做等于只拦鼠标不拦键盘。 */
  const addRemote = () => {
    const host = remoteInput.host.trim();
    if (!host) return;
    if (remotes.some((r) => r.host === host && r.port === remoteInput.port)) return;
    const id = crypto.randomUUID();
    const dev: RemoteDevice = { id, host, port: remoteInput.port, nickname: remoteInput.nickname.trim() || undefined };
    // 持久化在 updater 外调(StrictMode 双跑 updater,副作用内嵌会双发 save_remotes);
    // 重复地址已在上面拦截,这里基于当前闭包 remotes 计算即无并发风险。
    setRemotes((prev) => [...prev, dev]);
    if (isLocal) persistRemotes([...remotes, dev]);
    setExpandedRemotes((prev) => new Set(prev).add(id)); // 默认展开 → 引用计数 effect 建连
    setRemoteInput({ host: "", port: 18700, nickname: "" });
    setRemoteOpen(false);
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
        if (isLocal) {
          // 桌面:设备在后端——save_remotes 的落盘钩子触发 update_registry(断连+移除)
          dispatch({ type: "teardown_dev", devId: dev.id });
        } else {
          unsubsByDev.current.get(dev.id)?.forEach((fn) => fn());
          unsubsByDev.current.delete(dev.id);
          transportsRef.current.get(dev.id)?.dispose();
          transportsRef.current.delete(dev.id);
          remoteAddrRef.current.delete(dev.id);
          dispatch({ type: "teardown_dev", devId: dev.id });
        }
        setRemotes((prev) => prev.filter((r) => r.id !== dev.id));
        if (isLocal) persistRemotes(remotes.filter((r) => r.id !== dev.id)); // updater 外持久化(同 addRemote)
        setExpandedRemotes((prev) => {
          const n = new Set(prev);
          n.delete(dev.id);
          return n;
        });
        setConfirmState(null);
      },
    });
  };

  /** 手动重连。桌面:后端删旧连接建新(device_connect);远程窗口/Web:前端重建 transport。 */
  const reconnectRemote = (dev: RemoteDevice) => {
    if (isLocal) {
      void tauriInvoke("device_connect", { devId: dev.id }).catch((e) => libError(String(e)));
      return;
    }
    unsubsByDev.current.get(dev.id)?.forEach((fn) => fn());
    unsubsByDev.current.delete(dev.id);
    transportsRef.current.get(dev.id)?.dispose();
    transportsRef.current.delete(dev.id);
    remoteAddrRef.current.delete(dev.id);
    dispatch({ type: "teardown_dev", devId: dev.id });
    setExpandedRemotes((prev) => {
      const n = new Set(prev);
      n.add(dev.id);
      return n;
    });
  };

  /** 断开在线设备:有开着的 tab 先确认(一并关闭);无 tab 直接断。
   *  桌面:后端 device_disconnect(端口转断开态,tab 保留可重连);
   *  远程窗口/Web:关 tab + 移出 expandedRemotes → 引用计数 effect 自动 dispose。
   *  与「删除设备」的差别:保留设备定义,可随时重连。 */
  const disconnectRemote = (dev: RemoteDevice) => {
    const label = dev.nickname?.trim() || `${dev.host}:${dev.port}`;
    const tabs = openPorts.filter((p) => parsePortId(p).devId === dev.id);
    const doDisconnect = () => {
      if (isLocal) {
        // 后端断连;断开事件会经 devices-changed 到达,tab 保留(Rust 侧 drainer 标 disconnected)
        void tauriInvoke("device_disconnect", { devId: dev.id }).catch((e) => libError(String(e)));
        return;
      }
      tabs.forEach((pid) => prunePort(pid));
      setExpandedRemotes((prev) => {
        const n = new Set(prev);
        n.delete(dev.id);
        return n;
      });
    };
    if (tabs.length > 0 && !isLocal) {
      setConfirmState({
        title: "断开远程设备",
        icon: <IconPower />,
        message: `断开「${label}」？其 ${tabs.length} 个串口标签将关闭。设备仍保留在列表中，可随时重连。`,
        confirmText: "断开",
        tone: "danger",
        onConfirm: () => {
          doDisconnect();
          setConfirmState(null);
        },
      });
    } else {
      doDisconnect();
    }
  };

  const refreshPorts = (_devId?: string) => {
    // 列表来自形态 transport 的合并视图(web 下含远端设备桶),整体刷新
    cmdTransport()?.list();
  };

  /** 按复合键查端口信息。桶内条目名经 bucketPidOf 幂等转 pid 后比对——本地合并
   *  视图条目名即完整 pid(直通),web 形态条目名是远端侧键(加桶前缀),两种形态统一命中。 */
  const portInfoOf = (pid: PortId): PortInfo | undefined => {
    const { devId } = parsePortId(pid);
    return portsByDev[devId]?.find((p) => bucketPidOf(devId, p.name) === pid);
  };
  const aliasOf = (pid: PortId) => portInfoOf(pid)?.alias;

  /** 提交别名：写 ports.json + 刷新列表使别名立即显示。空串 = 清除。 */
  const commitAlias = async (pid: PortId, alias: string) => {
    setAliasEdit(null);
    try {
      await cmdTransport()?.setAlias(pid, alias);
      refreshPorts();
    } catch (e) {
      libError(`设置别名失败：${String(e)}，请重试或检查配置目录写入权限`);
    }
  };

  const activeHolders = activePort ? portInfoOf(activePort)?.holders ?? 0 : 0;
  /** 活动栏角标:运行中(绿点)优先,否则有"未查看"的失败结果(红点,打开面板即清)。 */
  const macroRunning = [...macroRuns.values()].some((c) => c.status === "running");
  const macroFailed = [...macroRuns.entries()].some(([rid, c]) => c.status === "done" && !c.success && macroUnseen.has(rid));
  const scriptRunning = [...scriptRuns.values()].some((c) => c.status === "running");
  const scriptFailed = [...scriptRuns.entries()].some(([rid, c]) => c.status === "done" && !c.success && scriptUnseen.has(rid));
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
  /** 平铺所有端口（带 pid），供 PortPalette 搜索选择。bucketPidOf 幂等转 pid。 */
  const allPorts: (PortInfo & { pid: PortId })[] = portGroups.flatMap((g) => g.ports.map((p) => ({ ...p, pid: bucketPidOf(g.devId, p.name) })));
  const activeConfig = activePort ? portConfigs[activePort] : undefined;
  const activeTerm = activePort ? terminalsRef.current.get(activePort) : undefined;
  // 通道条端口显示的设备段:pid 首段(devId)优先换设备昵称,查无昵称/非本表设备
  // (web 形态级联中段)退回裸 id;本地口("local")无前缀。悬停补 id+地址——与侧栏
  // 设备组标签的 tooltip 同一套信息。端口段由 PortLabel 承担(串口别名优先)。
  const { devId: activeDevId, name: activePortName } = parsePortId(activePort);
  const activeDev =
    activeDevId === "local" ? undefined : remotes.find((r) => r.id === activeDevId);

  // 快捷键处理器表（每 render 刷新最新闭包；dispatchAction 经 handlersRef 读，不陈旧）。
  handlersRef.current = {
    "search.open": () => {
      if (activePort && terminalsRef.current.has(activePort)) setSearchOpen(true);
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
      if (activePort) closePort(activePort);
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
  /** 活动栏弹出菜单（主题/管理）——不算模态,但同样要压住全局快捷键:
   *  菜单浮层 z-200 在对话框 z-100 之上,快捷键此时开对话框会开进菜单底下,Esc 仲裁方向错乱。 */
  const menuOpen = themeMenu || manageMenu;

  // 菜单打开时:Esc 收起菜单(capture,先于其它 Esc 处理)
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setThemeMenu(false);
        setManageMenu(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [menuOpen]);

  // 任一对话框模态打开 → 收起菜单(避免菜单浮层压在模态之上)
  useEffect(() => {
    if (modalOpen) {
      setThemeMenu(false);
      setManageMenu(false);
    }
  }, [modalOpen]);

  // 全局快捷键 listener：模态/菜单打开时不挂（天然抑制），关闭后重挂。capture 阶段拦截。
  useEffect(() => {
    if (modalOpen || menuOpen) return;
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
      const combo = eventToCombo(e);
      if (!combo) return;
      const hit = findAction(combo, "global");
      if (hit) {
        e.preventDefault();
        e.stopPropagation();
        dispatchAction(hit.id, hit.arg);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dispatchAction, modalOpen, menuOpen]);

  // 所有对话框关闭后,焦点送回活动终端(打开时焦点进了对话框,关掉后终端要重新接管输入)。
  // deps 只有 modalOpen:仅在模态关闭那一拍触发;闭包里的 activePort 即当时的活动端口。
  useEffect(() => {
    if (modalOpen) return;
    const id = window.setTimeout(() => {
      terminalsRef.current.get(activePort)?.term.focus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [modalOpen]);

  return (
    <div className="app">
      {/* 自绘标题栏:仅 Tauri 桌面(本地/远程窗口);Web 模式浏览器自带窗口管理 */}
      {isTauri() && <TitleBar />}
      <div className="app__body">
      {/* 活动栏：44px 窄竖条 */}
      <div className="activity-bar">
        <ActivityIcon icon={<IconPlug className="act-icon__svg" />} title="串口" active={activity === "ports"} onClick={() => setActivity(activity === "ports" ? null : "ports")} />
        <ActivityIcon
          icon={<IconBolt className="act-icon__svg" />}
          title="宏"
          active={activity === "macros"}
          onClick={() => setActivity(activity === "macros" ? null : "macros")}
          badge={macroRunning ? "run" : macroFailed ? "alert" : undefined}
        />
        {showScripts && (
          <ActivityIcon
            icon={<IconCode className="act-icon__svg" />}
            title="脚本"
            active={activity === "scripts"}
            onClick={() => setActivity(activity === "scripts" ? null : "scripts")}
            badge={scriptRunning ? "run" : scriptFailed ? "alert" : undefined}
          />
        )}
        <div className="activity-bar__spacer" />
        {isTauri() && <ActivityIcon icon={<IconGlobe className="act-icon__svg" />} title="添加远程设备" active={false} onClick={() => setRemoteOpen(true)} />}
        <div className="manage">
          <ActivityIcon
            icon={<IconShirt className="act-icon__svg" />}
            title="主题"
            active={themeMenu}
            onClick={() => setThemeMenu(!themeMenu)}
          />
          {themeMenu && (
            <>
              <div className="manage-backdrop" onClick={() => setThemeMenu(false)} />
              <div className="manage-menu">
                {THEMES.map((def) => {
                  const current = def.id === theme;
                  return (
                    <button
                      key={def.id}
                      className="manage-menu__item"
                      data-current={current || undefined}
                      onClick={() => {
                        setTheme(def.id);
                        setThemeMenu(false);
                      }}
                    >
                      {/* 勾选占位对齐:非当前项隐藏勾,保持文本同列 */}
                      <span style={{ display: "inline-flex", visibility: current ? "visible" : "hidden" }}>
                        <IconCheck />
                      </span>
                      {def.label}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
        <div className="manage">
          <ActivityIcon icon={<IconSliders className="act-icon__svg" />} title="管理" active={manageMenu} onClick={() => setManageMenu(!manageMenu)} />
          {manageMenu && (
            <>
              <div className="manage-backdrop" onClick={() => setManageMenu(false)} />
              <div className="manage-menu">
                <button className="manage-menu__item" onClick={() => { setSettingsOpen(true); setManageMenu(false); }}>
                  <IconGear /> 设置
                </button>
                <button className="manage-menu__item" onClick={() => { setShortcutsOpen(true); setManageMenu(false); }}>
                  <IconKeyboard /> 快捷键
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
            <PortsPanel
              portGroups={portGroups}
              remotes={remotes}
              portCollapsed={portCollapsed}
              onTogglePortGroup={togglePortGroup}
              activePort={activePort}
              aliasEditPort={aliasEdit?.where === "list" ? aliasEdit.port : null}
              onSetAliasEdit={(pid) => setAliasEdit({ port: pid, where: "list" })}
              onTriggerPort={triggerPort}
              onCommitAlias={commitAlias}
              onCancelAlias={() => setAliasEdit(null)}
              onForceClose={forceClosePort}
              onReconnectRemote={reconnectRemote}
              onDisconnectRemote={disconnectRemote}
              onRemoveRemote={removeRemote}
              onRefresh={() => refreshPorts()}
            />
          )}

          {activity === "macros" && (
            <NamedLibraryPanel
              title={<>MACROS{activePort && <span className="accent">→ {activePort}</span>}</>}
              items={macros}
              hasItems={Object.keys(macros).length > 0}
              collapsed={macroCollapsed}
              onToggleGroup={toggleMacroGroup}
              onRenameGroup={renameMacroGroup}
              onDissolveGroup={askDissolveMacroGroup}
              importRef={importInputRef}
              onImportFile={onImportFile}
              onExport={() => setExportMacrosOpen(true)}
              exportTitle="导出宏（可多选 / 全选）"
              onNew={() => openMacroEditor(null)}
              newItemLabel="宏"
              emptyHint="无宏（点 ＋ 新增）"
              storageHint={!isLocal ? "Web 模式：宏保存在本浏览器（localStorage），换浏览器或清缓存不会保留，请用导出备份。" : undefined}
              renderRow={(name) => (
                <MacroRow
                  key={name}
                  name={name}
                  disabled={!activePort}
                  onRun={() => {
                    runMacro(name);
                    // 运行后焦点交还终端:否则焦点留在按钮上,回车会再次触发本按钮(重复运行宏)
                    activeTerm?.term.focus();
                  }}
                  onEdit={() => openMacroEditor(name)}
                  onDelete={() => deleteMacro(name)}
                />
              )}
            >
              <RunCards
                runs={macroRuns}
                kindLabel="宏"
                hasLogs={false}
                expandedLog={null}
                onToggleExpand={() => {}}
                onStop={(runId) => cmdTransport()?.stopMacro(runId)}
                onDismiss={(runId) => setMacroRuns((prev) => { const n = new Map(prev); n.delete(runId); return n; })}
              />
            </NamedLibraryPanel>
          )}

          {activity === "scripts" && (
            <NamedLibraryPanel
              title={<>SCRIPTS{activePort && <span className="accent">→ {activePort}</span>}</>}
              items={scripts}
              hasItems={Object.keys(scripts).length > 0}
              collapsed={scriptCollapsed}
              onToggleGroup={toggleScriptGroup}
              onRenameGroup={renameScriptGroup}
              onDissolveGroup={askDissolveScriptGroup}
              importRef={scriptImportInputRef}
              onImportFile={onImportScripts}
              onExport={() => setExportScriptsOpen(true)}
              exportTitle="导出脚本（可多选 / 全选）"
              onNew={() => openScriptEditor(null)}
              newItemLabel="脚本"
              emptyHint="无脚本（点 ＋ 新增）"
              storageHint={!isLocal ? "Web 模式：脚本保存在本浏览器（localStorage），换浏览器或清缓存不会保留，请用导出备份。" : undefined}
              extraActions={
                <button
                  className="icon-btn"
                  title="脚本编写指南（查看 / 复制给外部 Agent）"
                  aria-label="脚本编写指南"
                  onClick={() => {
                    setSkillOpen(true);
                    if (skillText === null) fetchSkill();
                  }}
                >
                  <IconInfo />
                </button>
              }
              renderRow={(name) => (
                <ScriptRow
                  key={name}
                  name={name}
                  onRun={() => {
                    runScript(name);
                    // 仅在不弹参数框时回焦终端;弹框场景焦点应进对话框(由 modalOpen effect 接管)
                    if (!scripts[name]?.params?.length) activeTerm?.term.focus();
                  }}
                  onEdit={() => openScriptEditor(name)}
                  onDelete={() => deleteScript(name)}
                />
              )}
            >
              <RunCards
                runs={scriptRuns}
                kindLabel="脚本"
                hasLogs
                expandedLog={expandedLog}
                onToggleExpand={(runId) => setExpandedLog((v) => (v === runId ? null : runId))}
                onStop={(runId) => cmdTransport()?.stopScript(runId)}
                onDismiss={(runId) => {
                  setScriptRuns((prev) => { const n = new Map(prev); n.delete(runId); return n; });
                  if (expandedLog === runId) setExpandedLog(null);
                }}
              />
            </NamedLibraryPanel>
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
          title="拖动调整宽度（双击重置）"
        />
        </>
      )}

      <main className="main">
        {errorMsg && (
          <div className="banner banner--err" role="alert">
            <IconAlert /> {errorMsg}
            <button
              className="banner__close"
              aria-label="关闭错误提示"
              onClick={() => {
                if (errorTimer.current !== null) clearTimeout(errorTimer.current);
                setErrorMsg("");
              }}
            >
              <IconClose />
            </button>
          </div>
        )}
        {notice && (
          <div className="banner banner--notice" role="status">
            <IconInfo /> {notice}
            <button
              className="banner__close"
              aria-label="关闭提示"
              onClick={() => {
                if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
                setNotice("");
              }}
            >
              <IconClose />
            </button>
          </div>
        )}
        {serviceError && (
          <div className="banner banner--err" role="alert">
            <IconAlert /> {serviceError}
            <button className="banner__close" onClick={() => setServiceError("")} title="关闭" aria-label="关闭">
              <IconClose />
            </button>
          </div>
        )}

        {/* 分栏布局：递归渲染 layout（split→flex，leaf→GroupView 含标签栏+终端区） */}
        {renderPane(layout)}
        {/* TermView 实例池：固定渲染于此（offscreen 隐藏），DOM 由 TermView 经 appendChild
            挪入所属 group 的终端容器（DOM reparent）。跨 group 搬 tab 只换容器、组件不重建 → 保 scrollback。 */}
        {/* 运行结果 toast:面板不可见时的完成/失败反馈,点击跳对应面板 */}
        {toasts.length > 0 && (
          <div className="toast-area" aria-live="polite">
            {toasts.map((t) => (
              <button
                key={t.id}
                className={`toast toast--${t.ok ? "ok" : "err"}`}
                onClick={() => {
                  if (t.panel) setActivity(t.panel);
                  setToasts((prev) => prev.filter((x) => x.id !== t.id));
                }}
              >
                <span className="toast__mark">{t.ok ? "✓" : "✗"}</span>
                <span className="toast__text">{t.text}</span>
                {t.panel && <span className="toast__go">查看</span>}
              </button>
            ))}
          </div>
        )}

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
                  cmdTransport()?.write(p, data);
                }}
                onReady={(inst) => {
                  if (inst) terminalsRef.current.set(port, inst);
                  else terminalsRef.current.delete(port);
                }}
                disconnected={disconnectedPorts.has(port)}
                onReconnect={() => reconnectPort(port)}
                recbar={
                  isLocal
                    ? {
                        state: captureSessions.get(port)?.state ?? "idle",
                        path: captureSessions.get(port)?.path ?? "",
                        defaultName:
                          captureSessions.get(port)?.defaultName ??
                          defaultCaptureName(port, devLabelOf(port)),
                        error: captureSessions.get(port)?.error,
                        onSelect: () => void selectCaptureFile(port),
                        onToggle: () => toggleCapture(port),
                      }
                    : undefined
                }
              />
            );
          })}
        </div>

        {/* 通道条：活动端口的仪器状态条 + TX/RX LED（签名）。置底 */}
        {activePort && activeConfig && (
          <div className="channel-strip">
            <span className="channel-strip__port">
              {activeDev && (
                <span
                  className="channel-strip__dev"
                  title={`${activeDev.id} · ${activeDev.host}:${activeDev.port}`}
                >
                  {activeDev.nickname?.trim() || activeDev.id}::
                </span>
              )}
              <PortLabel name={activePortName} alias={aliasOf(activePort)} />
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
              libError(`导出失败：${String(e)}，请重试或更换保存位置`);
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
              libError(`导出失败：${String(e)}，请重试或更换保存位置`);
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
          srvFailed={srvFailed}
          onRetrySrv={loadSrvSettings}
          showServer={isTauri() && !isRemote}
          onConnChange={(c) => {
            saveConn(c);
            setConnConfig(c);
            // 关闭设置页,连接结果走 toast(成功/超时失败,见 pendingConn effects)
            setPendingConn(`${c.host}:${c.port}`);
            setSettingsOpen(false);
          }}
          onSaveSrv={async (s) => {
            if (!isTauri()) return;
            try {
              await tauriInvoke("apply_settings", { settings: s });
              setSrvSettings(s);
              setErrorMsg("");
              setConnConfig({ host: s.ws_host, port: s.ws_port });
            } catch (e) {
              libError(String(e));
            }
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {aboutOpen && <AboutDialog version={version} onClose={() => setAboutOpen(false)} />}
      {skillOpen && (
        <ScriptSkillDialog text={skillText} failed={skillFailed} onRetry={fetchSkill} onClose={() => setSkillOpen(false)} />
      )}
      {pendingRun && scripts[pendingRun]?.params?.length && (
        <ScriptRunParamsDialog
          scriptName={pendingRun}
          params={scripts[pendingRun]!.params!}
          initialValues={scriptArgs[pendingRun]}
          onConfirm={(args) => {
            // 缓存实际提交的值(而非表单中间态),下次预填;取消不写,保留上次有效值
            const next = { ...scriptArgs, [pendingRun]: args };
            setScriptArgs(next);
            persistScriptArgs(next);
            setPendingRun(null);
            doRun(pendingRun, args);
          }}
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
      {remoteOpen && (
        <RemoteDialog
          input={remoteInput}
          onChange={setRemoteInput}
          onConfirm={addRemote}
          onCancel={() => setRemoteOpen(false)}
          existing={remotes.map((r) => `${r.host}:${r.port}`)}
        />
      )}

      {/* 宏编辑器 */}
      {editing && (
        <MacroEditor
          name={editorName}
          macro={editorMacro}
          error={editorError}
          isNew={editing.isNew}
          groups={macroGroupNames}
          onName={setEditorName}
          onMacroChange={setEditorMacro}
          onSave={saveMacroDef}
          onDelete={() => deleteMacro(editing.name)}
          onCancel={macroLib.closeEditor}
        />
      )}

      {/* 脚本编辑器 */}
      {editingScript && (
        <ScriptEditor
          name={editorScriptName}
          script={editorScript}
          error={editorScriptError}
          isNew={editingScript.isNew}
          groups={scriptGroupNames}
          onName={setEditorScriptName}
          onScriptChange={setEditorScript}
          onSave={saveScriptDef}
          onDelete={() => deleteScript(editingScript.name)}
          onCancel={scriptLib.closeEditor}
        />
      )}

      {/* 确认弹窗:必须排在所有对话框之后——overlay 同 z-index 时后来者居上,
          放前面会被编辑器盖住(如编辑器 dirty 确认弹在编辑器下层不可见) */}
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
      </div>
    </div>
  );
}

/** 分栏拖动手柄:拖动按容器内坐标实时改比例(reducer 内 clamp 0.15–0.85),双击复位 0.5。
 *  容器取 parentElement(即 .pane-split)。手柄负边距悬浮在分界线上不占布局,
 *  比例直接按容器全宽算。拖动监听挂 window,组件卸载兜底移除
 *  (防拖动中布局坍缩/重构后悬空监听继续 dispatch 过期 path)。 */
function PaneDivider({ dir, onRatio }: { dir: PaneDir; onRatio: (r: number) => void }) {
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);
  const start = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const move = (ev: MouseEvent) => {
      const total = dir === "row" ? rect.width : rect.height;
      const pos = dir === "row" ? ev.clientX - rect.left : ev.clientY - rect.top;
      onRatio(pos / total);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      cleanupRef.current = null;
    };
    cleanupRef.current = up;
    document.body.style.cursor = dir === "row" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none"; // 拖动期间禁选中(同侧栏拖宽)
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  return (
    <div
      className={`pane-divider pane-divider--${dir}`}
      onMouseDown={start}
      onDoubleClick={() => onRatio(0.5)}
      role="separator"
      aria-orientation={dir === "row" ? "vertical" : "horizontal"}
      title="拖动调整比例（双击复位）"
    />
  );
}
