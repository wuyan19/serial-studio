import { useEffect, useRef, useState } from "react";
import type {
  ConnConfig,
  Macro,
  MacroResult,
  PortInfo,
  SerialConfig,
  SrvSettings,
  TermInstance,
} from "./types";
import {
  downloadJson,
  getRemoteFromUrl,
  initConn,
  isTauri,
  loadConfig,
  loadMacrosLocal,
  persistMacros,
  saveConfig,
  saveConn,
  tauriInvoke,
} from "./lib";
import { LocalTransport, RemoteTransport, type Transport } from "./transport";
import {
  AboutDialog,
  ActivityIcon,
  AliasDialog,
  ConfirmDialog,
  ExportMacrosDialog,
  MacroEditor,
  newStep,
  PortLabel,
  RemoteDialog,
  SearchBar,
  SerialConfigDialog,
  SettingsPanel,
  TermView,
  validateMacro,
} from "./components";
import {
  IconAlert,
  IconBolt,
  IconClose,
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
  const [activePort, setActivePort] = useState("");
  const [portConfigs, setPortConfigs] = useState<Record<string, SerialConfig>>({});
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
  type ActivityView = "ports" | "macros" | null;
  const [activity, setActivity] = useState<ActivityView>(null);
  const [manageMenu, setManageMenu] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  /** 通用确认弹窗状态（替代原生 confirm）。null = 关闭。 */
  const [confirmState, setConfirmState] = useState<{
    title: string;
    icon?: React.ReactNode;
    message: string;
    confirmText?: string;
    tone?: "primary" | "danger";
    onConfirm: () => void;
  } | null>(null);
  /** 正在编辑别名的端口（null = 关闭别名对话框）。 */
  const [aliasEditPort, setAliasEditPort] = useState<string | null>(null);
  /** 宏批量导出对话框是否打开。 */
  const [exportMacrosOpen, setExportMacrosOpen] = useState(false);
  const [version, setVersion] = useState("");
  const [serviceError, setServiceError] = useState("");
  const [theme, setThemeState] = useState<Theme>(() => getTheme());

  const transportRef = useRef<Transport | null>(null);
  const terminalsRef = useRef<Map<string, TermInstance>>(new Map());
  const importInputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef("");
  activeRef.current = activePort;
  /** per-port 字节流活动时间戳——驱动 TX/RX LED。 */
  const activityRef = useRef<Map<string, Activity>>(new Map());
  const touch = (port: string, dir: "rx" | "tx") => {
    const e = activityRef.current.get(port) ?? { rx: 0, tx: 0 };
    e[dir] = performance.now();
    activityRef.current.set(port, e);
  };

  const isLocal = isTauri() && !isRemote;

  // 数据面连接。本地模式用 IPC（常驻不重连）；远程/Web 用 WS（connConfig 变化重建）
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
        // 端口全局关闭（末位释放/被强制关闭）：清掉本会话的标签和终端
        setOpenPorts((prev) => {
          const rest = prev.filter((p) => p !== port);
          if (activeRef.current === port) setActivePort(rest[rest.length - 1] ?? "");
          return rest;
        });
        setPortConfigs((prev) => {
          if (!prev[port]) return prev;
          const next = { ...prev };
          delete next[port];
          return next;
        });
        terminalsRef.current.delete(port);
        activityRef.current.delete(port);
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
    ];
    return () => {
      unsubs.forEach((fn) => fn());
      t.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLocal, connConfig]);

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

  // 版本号（Tauri getAppVersion）
  useEffect(() => {
    if (isTauri()) {
      import("@tauri-apps/api/app")
        .then(({ getVersion }) => getVersion())
        .then(setVersion)
        .catch(() => {});
    }
  }, []);

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

  // Ctrl+F：在活动终端开搜索框。capture 阶段先于 xterm 拦截，避免被终端吃掉。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
        if (activePort && terminalsRef.current.has(activePort)) {
          e.preventDefault();
          e.stopPropagation();
          setSearchOpen(true);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [activePort]);

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
      setActivePort(port);
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

  const closePort = (port: string) => {
    transportRef.current?.close(port);
    terminalsRef.current.delete(port);
    setOpenPorts((prev) => {
      const rest = prev.filter((p) => p !== port);
      if (activeRef.current === port) setActivePort(rest[rest.length - 1] ?? "");
      return rest;
    });
    setPortConfigs((prev) => {
      if (!prev[port]) return prev;
      const next = { ...prev };
      delete next[port];
      return next;
    });
    activityRef.current.delete(port);
  };

  const forceClosePort = (port: string) => {
    setConfirmState({
      title: "强制关闭端口",
      icon: <IconPower />,
      message: `强制关闭 ${port}？这将立即断开所有持有者（含其它窗口/会话），且不可恢复。`,
      confirmText: "强制关闭",
      tone: "danger",
      onConfirm: () => {
        transportRef.current?.forceClose(port);
        setConfirmState(null);
      },
    });
  };

  const switchPort = (port: string) => setActivePort(port);

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
    setAliasEditPort(null);
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

  return (
    <div className="app">
      {/* 活动栏：44px 窄竖条 */}
      <div className="activity-bar">
        <ActivityIcon icon={<IconPlug className="act-icon__svg" />} title="串口" active={activity === "ports"} onClick={() => setActivity(activity === "ports" ? null : "ports")} />
        <ActivityIcon icon={<IconBolt className="act-icon__svg" />} title="宏" active={activity === "macros"} onClick={() => setActivity(activity === "macros" ? null : "macros")} />
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
        <aside className="sidebar">
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
                return (
                  <div key={p.name} className="port-item-row" data-active={isActive} data-opened={p.opened ? "true" : undefined} data-force={isLocal && p.opened ? "true" : undefined}>
                    <button
                      className="port-item"
                      onClick={() => {
                        if (openPorts.includes(p.name)) {
                          switchPort(p.name);
                        } else if (p.opened) {
                          // 已被其它会话打开：本次为附加，配置会被忽略 → 直接打开，不弹配置框
                          void openPort(p.name, serialConfig);
                        } else {
                          setPendingPort(p.name);
                        }
                      }}
                    >
                      <span className={`port-item__dot${p.opened ? " open" : ""}`} />
                      <span className="port-item__name">
                        <PortLabel name={p.name} alias={p.alias} />
                      </span>
                      {p.opened && p.holders > 0 && <span className="port-item__holders">{p.holders}</span>}
                    </button>
                    <button
                      className="port-item__edit"
                      title={`设置 ${p.name} 别名`}
                      onClick={() => setAliasEditPort(p.name)}
                    >
                      <IconEdit />
                    </button>
                    {isLocal && p.opened && (
                      <button
                        className="port-item__force"
                        title={`强制关闭 ${p.name}（踢掉所有持有者）`}
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
        </aside>
      )}

      <main className="main">
        {/* Tab 栏 */}
        <div className="tab-bar">
          {openPorts.length === 0 && <span className="tab-bar__empty">未打开端口</span>}
          {openPorts.map((port) => {
            const isActive = port === activePort;
            return (
              <div key={port} className="tab" data-active={isActive} onClick={() => switchPort(port)}>
                <span className="tab__dot" />
                <span className="tab__name">
                  <PortLabel name={port} alias={aliasOf(port)} />
                </span>
                <span
                  className="tab__btn tab__btn--close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closePort(port);
                  }}
                  title={`关闭 ${port}`}
                >
                  <IconClose />
                </span>
              </div>
            );
          })}
        </div>

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

        {/* 通道条：活动端口的仪器状态条 + TX/RX LED（签名） */}
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

        {/* 终端区：每个 openPort 一个 TermView，display 切换可见（不销毁） */}
        <div className="term-area">
          {openPorts.map((port) => (
            <TermView
              key={port}
              port={port}
              active={port === activePort}
              onWrite={(p, data) => {
                touch(p, "tx"); // 签名：发出字节 → TX 亮
                transportRef.current?.write(p, data);
              }}
              onReady={(inst) => {
                if (inst) terminalsRef.current.set(port, inst);
                else terminalsRef.current.delete(port);
              }}
            />
          ))}
          {openPorts.length === 0 && (
            <div className="term-empty">
              <IconPlug className="term-empty__icon" />
              <div>从左侧 PORTS 打开一个串口开始收发</div>
            </div>
          )}
          {searchOpen && activeTerm?.search && (
            <SearchBar
              searchAddon={activeTerm.search}
              onClose={() => {
                setSearchOpen(false);
                activeTerm?.term.focus();
              }}
            />
          )}
        </div>
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

      {/* 别名编辑对话框 */}
      {aliasEditPort && (
        <AliasDialog
          port={aliasEditPort}
          initial={aliasOf(aliasEditPort) ?? ""}
          onConfirm={(alias) => commitAlias(aliasEditPort, alias)}
          onCancel={() => setAliasEditPort(null)}
        />
      )}

      {/* 宏批量导出对话框 */}
      {exportMacrosOpen && (
        <ExportMacrosDialog
          macros={macros}
          onConfirm={(names) => {
            const obj: Record<string, Macro> = {};
            for (const n of names) obj[n] = macros[n];
            downloadJson("serial-studio-macros.json", obj);
            setExportMacrosOpen(false);
          }}
          onCancel={() => setExportMacrosOpen(false)}
        />
      )}

      {/* 设置面板 */}
      {settingsOpen && (
        <SettingsPanel
          connConfig={connConfig}
          srvSettings={srvSettings}
          showServer={isTauri() && !isRemote}
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
    </div>
  );
}
