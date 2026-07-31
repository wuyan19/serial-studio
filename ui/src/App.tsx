import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ActionId,
  ConnConfig,
  Group,
  Macro,
  MacroResult,
  PaneHalf,
  PaneNode,
  PortInfo,
  Script,
  ScriptResult,
  SerialConfig,
  SrvSettings,
  TermInstance,
} from "./types";
import { createRoot, leafGroupIds, removeLeaf, splitLeaf } from "./pane-tree";
import {
  downloadJson,
  getRemoteFromUrl,
  initConn,
  isTauri,
  loadConfig,
  loadMacrosLocal,
  loadScriptsLocal,
  persistMacros,
  persistScripts,
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

/**
 * Serial Studio 前端主组件（Tauri 与浏览器共用）。
 * 数据面走 Transport（本地 IPC / 远程 WS），控制面走 Tauri invoke。
 * 仪器风布局：活动栏 + 可收起次侧栏 + 通道条 + 主终端区。
 */
export default function App() {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [macros, setMacros] = useState<Record<string, Macro>>({});
  const [macroResult, setMacroResult] = useState<MacroResult | null>(null);
  const [connected, setConnected] = useState(false);
  const [openPorts, setOpenPorts] = useState<string[]>([]);
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
  const isRemote = !!getRemoteFromUrl();
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [remoteInput, setRemoteInput] = useState({ host: "", port: 18700 });
  const [srvSettings, setSrvSettings] = useState<SrvSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editing, setEditing] = useState<{ name: string; isNew: boolean } | null>(null);
  const [editorName, setEditorName] = useState("");
  const [editorMacro, setEditorMacro] = useState<Macro>({ steps: [] });
  const [editorError, setEditorError] = useState("");
  const [scripts, setScripts] = useState<Record<string, Script>>({});
  const [scriptResult, setScriptResult] = useState<ScriptResult | null>(null);
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

  const transportRef = useRef<Transport | null>(null);
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

  const isLocal = isTauri() && !isRemote;
  // 脚本入口显隐：本地主权恒显；远程/Web 取决于服务端 enable_scripting
  const showScripts = isLocal || scriptEnabled;

  // 数据面连接。本地模式 IPC 常驻——不随 connConfig 重连：connConfig 在本地仅用于显示，
  // 重建 LocalTransport 会丢掉已开端口的 per-port RX Channel，导致改服务监听设置后串口"变哑"
  // （输入发出但收不到回显/响应，重开端口才好）。远程/Web 用 WS，connConfig 变化时重建。
  // transportKey 表达此意图：本地恒为 "local"，远程随地址变。
  const transportKey = isLocal ? "local" : `${connConfig.host}:${connConfig.port}`;
  useEffect(() => {
    const t = isLocal ? new LocalTransport() : new RemoteTransport(connConfig.host, connConfig.port);
    transportRef.current = t;
    const unsubs = [
      t.onPorts(setPorts),
      t.onConnectedChange((conn) => {
        setConnected(conn);
        if (conn) t.list();
      }),
      t.onData((port, data) => {
        touch(port, "rx"); // 签名：收到字节 → RX 亮
        const inst = terminalsRef.current.get(port);
        if (inst) inst.term.write(data);
      }),
      t.onPortOpened(() => {
        t.list();
      }),
      t.onPortClosed((port) => {
        // 端口全局关闭（末位释放/被强制关闭）：清掉本会话的标签、终端与分栏归属
        prunePort(port);
        t.list();
      }),
      t.onHolders(() => {
        t.list();
      }),
      t.onMetaChanged(() => {
        // 别名等元数据变更（本机或别的客户端改的）→ 及时刷新，不必等串口事件
        t.list();
      }),
      t.onError((msg) => {
        setErrorMsg(msg);
        setTimeout(() => setErrorMsg(""), 5000);
      }),
      t.onMacroResult((name, success, message) => setMacroResult({ name, success, message })),
      t.onScriptResult((name, success, message) => setScriptResult({ name, success, message })),
    ];
    return () => {
      unsubs.forEach((fn) => fn());
      t.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transportKey]);

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

  // 脚本加载：Tauri → invoke load_scripts；Web → localStorage 回退
  useEffect(() => {
    if (isTauri()) {
      tauriInvoke<Record<string, Script>>("load_scripts").then(setScripts).catch((e) => console.error("加载脚本失败", e));
    } else {
      setScripts(loadScriptsLocal());
    }
  }, []);

  // 版本号：经 transport 统一取——本地取 Tauri app 版本，远程/Web 取服务端版本。
  // 远程窗口虽 isTauri() 为真，但连的是远程服务，版本应反映服务端而非本机 app。
  // 连接时序由 RemoteTransport.send() 内部 await open 兜底，挂载即取也不会踩 CONNECTING 异常。
  useEffect(() => {
    transportRef.current?.getVersion().then(({ version, enableScripting }) => {
      setVersion(version);
      setScriptEnabled(enableScripting);
    }).catch(() => {});
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
  const openPort = async (port: string, config: SerialConfig) => {
    try {
      const res = await transportRef.current?.open(port, config);
      if (!res) return undefined;
      // 成功占有（首开或附加）：创建本会话的终端标签，并记录端口实际配置供通道条展示
      setOpenPorts((prev) => (prev.includes(port) ? prev : [...prev, port]));
      // 进聚焦 group 并设为活动端口（端口唯一归属：openPort 是新开，此前不在任何 group）
      const fg = focusedGroupIdRef.current;
      setGroups((g) => {
        const cur = g[fg];
        if (!cur) return g;
        const ports = cur.ports.includes(port) ? cur.ports : [...cur.ports, port];
        return { ...g, [fg]: { ...cur, ports, activePort: port } };
      });
      setPortConfigs((prev) => ({ ...prev, [port]: res.config }));
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
    const port = pendingPort;
    if (!port) return;
    saveConfig(config);
    setPendingPort(null);
    const res = await openPort(port, config);
    const trimmed = alias.trim();
    if (!trimmed) return;
    if (res?.opened) {
      // 首开：别名生效
      try {
        await transportRef.current?.setAlias(port, trimmed);
        refreshPorts();
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
  const prunePort = (port: string) => {
    const gid = groupOfPortRef.current.get(port);
    setOpenPorts((prev) => prev.filter((p) => p !== port));
    setPortConfigs((prev) => {
      if (!prev[port]) return prev;
      const next = { ...prev };
      delete next[port];
      return next;
    });
    terminalsRef.current.delete(port);
    activityRef.current.delete(port);
    if (!gid) return; // 不在任何 group（异常）——上面已清端口清单/实例
    setGroups((g) => {
      const cur = g[gid];
      if (!cur) return g;
      const ports = cur.ports.filter((p) => p !== port);
      if (ports.length > 0) return { ...g, [gid]: { ...cur, ports, activePort: cur.activePort === port ? ports[ports.length - 1] : cur.activePort } };
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
  const closePort = (port: string) => {
    // 关闭正在编辑别名的端口时退出编辑态：组件直接卸载会跳过 blur，否则 state 残留到端口列表
    if (aliasEdit?.port === port) setAliasEdit(null);
    transportRef.current?.close(port);
    prunePort(port);
  };

  const forceClosePort = (port: string) => {
    setConfirmState({
      title: "强制关闭端口",
      icon: <IconPower />,
      message: `强制关闭 ${port}？将断开所有远程客户端（WS/MCP）的连接。`,
      confirmText: "强制关闭",
      tone: "danger",
      onConfirm: () => {
        transportRef.current?.forceClose(port);
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
        onSwitchTab={(port) => switchTabInGroup(node.groupId, port)}
        onCloseTab={closePort}
        onRenameTab={(port) => setAliasEdit({ port, where: "tab" })}
        onCommitAlias={commitAlias}
        onCancelAlias={() => setAliasEdit(null)}
        onFocusGroup={() => setFocusedGroupId(node.groupId)}
        onWrite={(p, data) => {
          touch(p, "tx");
          transportRef.current?.write(p, data);
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

  /** 触发某端口：已开则切过去；被他会话占着则附加；否则弹配置框。与点端口行同一流程，
   *  串口选择面板(Ctrl+I)的回车也走这里，避免两处复制三分支逻辑。 */
  const triggerPort = (name: string) => {
    if (openPorts.includes(name)) {
      // 已开：聚焦到端口所属 group 并切其 tab（端口可能不在当前聚焦 group，纯 switchPort 会 no-op）
      const gid = groupOfPort.get(name);
      if (gid) switchTabInGroup(gid, name);
      else switchPort(name);
    } else if (ports.find((p) => p.name === name)?.opened) {
      void openPort(name, serialConfig);
    } else {
      setPendingPort(name);
    }
  };

  const runMacro = (name: string) => {
    if (!activePort) {
      setMacroResult({ name, success: false, message: "请先选择并打开一个串口" });
      return;
    }
    setMacroResult({ name, success: true, message: "运行中..." });
    transportRef.current?.runMacro(name, activePort, macros[name]);
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
    const next = { ...macros, [trimmedName]: editorMacro };
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

  const doRun = (name: string, args: Record<string, string>) => {
    if (!activePort) {
      setScriptResult({ name, success: false, message: "请先选择并打开一个串口" });
      return;
    }
    setScriptResult({ name, success: true, message: "运行中..." });
    transportRef.current?.runScript(name, activePort, scripts[name], args);
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
    const next = { ...scripts, [trimmedName]: editorScript };
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

  const openRemoteWindow = async () => {
    const host = remoteInput.host.trim();
    if (!host) return;
    try {
      await tauriInvoke("open_remote_window", { host, port: remoteInput.port });
      setRemoteOpen(false);
    } catch (e) {
      setErrorMsg("打开远程窗口失败: " + e);
      setTimeout(() => setErrorMsg(""), 5000);
    }
  };

  const refreshPorts = () => {
    transportRef.current?.list();
  };

  const aliasOf = (name: string) => ports.find((p) => p.name === name)?.alias;

  /** 提交别名：写 ports.json + 刷新列表使别名立即显示。空串 = 清除。 */
  const commitAlias = async (port: string, alias: string) => {
    setAliasEdit(null);
    try {
      await transportRef.current?.setAlias(port, alias);
      refreshPorts();
    } catch (e) {
      setErrorMsg("设置别名失败: " + String(e));
      setTimeout(() => setErrorMsg(""), 5000);
    }
  };

  const activeHolders = ports.find((p) => p.name === activePort)?.holders ?? 0;
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
        {isTauri() && <ActivityIcon icon={<IconGlobe className="act-icon__svg" />} title="打开远程窗口" active={false} onClick={() => setRemoteOpen(true)} />}
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
                <button className="icon-btn" onClick={refreshPorts} title="刷新">
                  <IconRefresh />
                </button>
              </div>
              {ports.length === 0 && <p className="sidebar__empty">无可用端口</p>}
              {ports.map((p) => {
                const isActive = p.name === activePort;
                const editingThis = aliasEdit?.port === p.name && aliasEdit?.where === "list";
                return (
                  <div key={p.name} className="port-item-row" data-active={isActive} data-opened={p.opened ? "true" : undefined} data-force={isLocal && p.opened ? "true" : undefined} data-editing={editingThis ? "true" : undefined}>
                    <div
                      className="port-item"
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        if (!editingThis) triggerPort(p.name);
                      }}
                      onKeyDown={(e) => {
                        if (editingThis) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          triggerPort(p.name);
                        }
                      }}
                    >
                      <span className={`port-item__dot${p.opened ? " open" : ""}`} />
                      <span className="port-item__name">
                        {editingThis ? (
                          <InlineAliasInput
                            initial={p.alias ?? ""}
                            placeholder={`为 ${p.name} 设置别名`}
                            onCommit={(alias) => commitAlias(p.name, alias)}
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
                      onClick={() => setAliasEdit({ port: p.name, where: "list" })}
                    >
                      <IconEdit />
                    </button>
                    {isLocal && p.opened && (
                      <button
                        className="port-item__force"
                        title={`强制关闭 ${p.name}（断开远程）`}
                        onClick={() => forceClosePort(p.name)}
                      >
                        <IconPower />
                      </button>
                    )}
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
              {Object.entries(macros).map(([name]) => (
                <div key={name} className="macro-row">
                  <button className="macro-run" onClick={() => runMacro(name)} disabled={!activePort}>
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
              {macroResult && (
                <div className={`macro-result ${macroResult.success && macroResult.message !== "运行中..." ? "ok" : macroResult.message === "运行中..." ? "run" : "err"}`}>
                  {macroResult.success ? "✓" : "✗"} {macroResult.name}: {macroResult.message}
                </div>
              )}
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
                        transportRef.current?.getScriptSkill().then(setSkillText).catch(() => {});
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
              {Object.entries(scripts).map(([name]) => (
                <div key={name} className="macro-row">
                  <button className="macro-run" onClick={() => runScript(name)} disabled={!activePort}>
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
              {scriptResult && (
                <div className={`macro-result ${scriptResult.success && scriptResult.message !== "运行中..." ? "ok" : scriptResult.message === "运行中..." ? "run" : "err"}`}>
                  {scriptResult.success ? "✓" : "✗"} {scriptResult.name}: {scriptResult.message}
                </div>
              )}
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
                  transportRef.current?.write(p, data);
                }}
                onReady={(inst) => {
                  if (inst) terminalsRef.current.set(port, inst);
                  else terminalsRef.current.delete(port);
                }}
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
          ports={ports}
          onSelect={triggerPort}
          onClose={() => {
            setPortPaletteOpen(false);
            activeTerm?.term.focus();
          }}
        />
      )}
      {remoteOpen && <RemoteDialog input={remoteInput} onChange={setRemoteInput} onConfirm={openRemoteWindow} onCancel={() => setRemoteOpen(false)} />}

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
