import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  ActionId,
  ConnConfig,
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
  downloadJson,
  getMode,
  initConn,
  isTauri,
  loadConfig,
  parsePortId,
  persistMacros,
  persistRemotes,
  persistScripts,
  portIdOf,
  saveConfig,
  saveConn,
  tauriInvoke,
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
  IconMoon,
  IconSun,
} from "./icons";
import { getTheme, nextThemeLabel, subscribe, toggleTheme, type Theme } from "./theme";
import { eventToCombo, findAction } from "./shortcuts";

type Activity = { rx: number; tx: number };

/** 主题切换按钮图标（按主题查表；新增主题在 theme.ts 登记后在此加一条）。 */
const THEME_ICONS: Record<Theme, React.ReactNode> = {
  dark: <IconMoon className="act-icon__svg" />,
  light: <IconSun className="act-icon__svg" />,
};

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
  // ===== 运行结果 toast:宏/脚本完成时若对应面板不可见,右下角浮出结果,点击打开面板 =====
  type Toast = { id: number; ok: boolean; text: string; panel: "macros" | "scripts" };
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);
  const pushToast = useCallback((ok: boolean, text: string, panel: "macros" | "scripts") => {
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

  /** 真正发起占有：建终端标签、记实际配置；附加时提示沿用既有配置。返回 acquire 结果（供调用方按 opened 决策）。
   *  稳定回调（dispatch/setter 永不 stale）：bindTransport 重连重放与 UI 触发共用同一入口。 */
  const openPort = useCallback(async (pid: PortId, config: SerialConfig) => {
    const { devId, name } = parsePortId(pid);
    try {
      const res = await transportsRef.current.get(devId)?.open(name, config);
      if (!res) return undefined;
      // 成功占有（首开或附加）：记录端口实际配置 + 建 tab 进焦点 group + 清断开标记，全部由 reducer 承担
      dispatch({ type: "port_acquired", pid, config: res.config });
      if (!res.opened) {
        // 附加到已开端口：请求的 config 被忽略，告知实际配置
        const c = res.config;
        libNotify(`已加入 ${res.port}（当前 ${res.holders} 人在线）；端口沿用既有配置 ${c.baud_rate} 波特、换行 ${c.line_ending.toUpperCase()}。如需修改配置，请强制关闭该端口后重新打开。`, 8000);
      }
      return res;
    } catch (e) {
      libError(String(e));
      return undefined;
    }
  }, [libNotify, libError]);

  /** 从分栏与端口清单移除端口（关端口共用：用户主动关 + 远端被关）。状态变更全在 reducer；
   *  此处仅清终端实例/活动时间戳等会话级资源（副作用不进 reducer）。 */
  const prunePort = useCallback((pid: PortId) => {
    terminalsRef.current.delete(pid);
    activityRef.current.delete(pid);
    dispatch({ type: "prune_port", pid });
  }, []);

  /** 把 Transport 的所有事件绑到指定 devId。事件回调只 dispatch（永不 stale），
   *  重连重放经 sessionRef 读最新会话状态。返回取消函数。 */
  const bindTransport = useCallback((devId: string, t: Transport): (() => void)[] => {
    return [
      t.onPorts((list) => dispatch({ type: "ports_listed", devId, ports: list })),
      t.onConnectedChange((conn) => {
        dispatch({ type: "dev_online", devId, online: conn });
        if (conn) {
          t.list();
          // 重连成功：重放本设备断开待重连的端口（首次连上时集合为空 → 空操作，天然区分首次/重连）。
          // 配置取 acquire 时记录的 portConfigs（断开待重连的端口必有记录），失败则 tab 保持断开态待手动重试。
          const st = sessionRef.current;
          for (const pid of st.disconnectedPorts) {
            if (parsePortId(pid).devId !== devId) continue;
            void openPort(pid, st.portConfigs[pid] ?? DEFAULT_CONFIG);
          }
        } else {
          // 断连:运行中卡片转"已中止"失败态(不删除——结果可回看,而非静默蒸发)。
          // 只转 running——已完成(✓/✗)的结果是既成事实,断线不该把它翻写成失败。
          // 被中断的进未读角标;面板不可见时 toast(与自然完成的反馈通道对齐)。
          const interruptedMacros = [...macroRunsRef.current.entries()].filter(
            ([, c]) => c.devId === devId && c.status === "running"
          );
          const interruptedScripts = [...scriptRunsRef.current.entries()].filter(
            ([, c]) => c.devId === devId && c.status === "running"
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
              if (card.devId === devId && card.status === "running") {
                n.set(rid, { ...card, status: "done", success: false, message: "连接断开，已中止" });
              }
            }
            return n;
          });
          setMacroRuns((prev) => {
            const n = new Map(prev);
            for (const [rid, card] of n) {
              if (card.devId === devId && card.status === "running") {
                n.set(rid, { ...card, status: "done", success: false, message: "连接断开，已中止" });
              }
            }
            return n;
          });
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
        dispatch({ type: "port_opened_evt", devId, port });
      }),
      t.onPortClosed((port) => {
        // 端口全局关闭（末位释放/被强制关闭）：清掉本会话的标签、终端与分栏归属
        prunePort(portIdOf(devId, port));
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
        libError(`设置别名失败：${String(e)}，请重试或检查配置目录写入权限`);
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
      const { devId, name } = parsePortId(pid);
      const info = portsByDev[devId]?.find((p) => p.name === name);
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
    const { devId, name: portName } = parsePortId(activePort);
    setMacroRuns((prev) => new Map(prev).set(runId, { name, devId, status: "running" }));
    transportsRef.current.get(devId)?.runMacro(name, portName, macros[name], runId);
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
      libError(isLocal ? "本地服务未就绪，无法运行脚本；请重启应用后重试" : "尚无可用连接，请先添加并连接一台远程设备");
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

  /** 添加远程设备：生成稳定 UUID + 持久化（桌面）+ 默认展开（触发按需连接）。
   *  重复地址由 RemoteDialog 内联拦截(含 Enter 路径),此处再兜一层防御——
   *  校验只在 UI 入口做等于只拦鼠标不拦键盘。 */
  const addRemote = () => {
    const host = remoteInput.host.trim();
    if (!host) return;
    if (remotes.some((r) => r.host === host && r.port === remoteInput.port)) return;
    const id = crypto.randomUUID();
    const dev: RemoteDevice = { id, host, port: remoteInput.port, nickname: remoteInput.nickname.trim() || undefined };
    setRemotes((prev) => {
      const next = [...prev, dev];
      if (isLocal) persistRemotes(next);
      return next;
    });
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
        unsubsByDev.current.get(dev.id)?.forEach((fn) => fn());
        unsubsByDev.current.delete(dev.id);
        transportsRef.current.get(dev.id)?.dispose();
        transportsRef.current.delete(dev.id);
        remoteAddrRef.current.delete(dev.id);
        dispatch({ type: "teardown_dev", devId: dev.id });
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
    dispatch({ type: "teardown_dev", devId: dev.id });
    setExpandedRemotes((prev) => {
      const n = new Set(prev);
      n.add(dev.id);
      return n;
    });
  };

  /** 断开在线设备:有开着的 tab 先确认(一并关闭);无 tab 直接断。
   *  实现 = 关 tab + 移出 expandedRemotes → 引用计数 effect 自动 dispose。
   *  与「删除设备」的差别:保留设备定义,可随时重连。 */
  const disconnectRemote = (dev: RemoteDevice) => {
    const label = dev.nickname?.trim() || `${dev.host}:${dev.port}`;
    const tabs = openPorts.filter((p) => parsePortId(p).devId === dev.id);
    const doDisconnect = () => {
      tabs.forEach((pid) => prunePort(pid));
      setExpandedRemotes((prev) => {
        const n = new Set(prev);
        n.delete(dev.id);
        return n;
      });
    };
    if (tabs.length > 0) {
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
  /** 平铺所有端口（带 pid），供 PortPalette 搜索选择。 */
  const allPorts: (PortInfo & { pid: PortId })[] = portGroups.flatMap((g) => g.ports.map((p) => ({ ...p, pid: portIdOf(g.devId, p.name) })));
  const activeConfig = activePort ? portConfigs[activePort] : undefined;
  const activeTerm = activePort ? terminalsRef.current.get(activePort) : undefined;

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

  // 全局快捷键 listener：模态打开时不挂（天然抑制），关闭后重挂。capture 阶段拦截。
  useEffect(() => {
    if (modalOpen) return;
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
  }, [dispatchAction, modalOpen]);

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
        <ActivityIcon
          icon={THEME_ICONS[theme]}
          title={`切换到 ${nextThemeLabel(theme)}`}
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
                <button className="manage-menu__item" onClick={() => { setShortcutsOpen(true); setManageMenu(false); }}>
                  <IconKeyboard /> 键盘快捷键
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
                onStop={(runId, devId) => transportsRef.current.get(devId)?.stopMacro(runId)}
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
                onStop={(runId, devId) => transportsRef.current.get(devId)?.stopScript(runId)}
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
                  setActivity(t.panel);
                  setToasts((prev) => prev.filter((x) => x.id !== t.id));
                }}
              >
                <span className="toast__mark">{t.ok ? "✓" : "✗"}</span>
                <span className="toast__text">{t.text}</span>
                <span className="toast__go">查看</span>
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

/** 分栏拖动手柄宽度(px),与 CSS .pane-divider 的 flex-basis 保持一致(命中区 10px)。 */
const PANE_DIVIDER_W = 10;

/** 分栏拖动手柄:拖动按容器内坐标实时改比例(reducer 内 clamp 0.15–0.85),双击复位 0.5。
 *  容器取 parentElement(即 .pane-split)。比例按"两子格可用空间"算——须扣除手柄自身宽,
 *  否则手柄永远滞后光标约半个手柄宽。拖动监听挂 window,组件卸载兜底移除
 *  (防拖动中布局坍缩/重构后悬空监听继续 dispatch 过期 path)。 */
function PaneDivider({ dir, onRatio }: { dir: PaneDir; onRatio: (r: number) => void }) {
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);
  const start = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const move = (ev: MouseEvent) => {
      const total = (dir === "row" ? rect.width : rect.height) - PANE_DIVIDER_W;
      const pos = dir === "row" ? ev.clientX - rect.left : ev.clientY - rect.top;
      onRatio((pos - PANE_DIVIDER_W / 2) / total);
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
