import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

/** 是否在 Tauri 桌面环境（有控制面 IPC） */
function isTauri(): boolean {
  return !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}
/** 动态调用 Tauri 命令（Web 模式不加载 @tauri-apps/api） */
async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

interface PortInfo {
  name: string;
  opened: boolean;
}
/** 宏步骤（判别联合，与后端 MacroStep 对齐） */
type MacroStep =
  | { type: "send"; data: string; format: string; auto_newline: boolean }
  | { type: "delay"; ms: number }
  | { type: "expect"; pattern: string; timeout_ms: number }
  | { type: "clear" };
type StepType = MacroStep["type"];
interface Macro {
  description?: string;
  steps: MacroStep[];
}
interface MacroResult {
  name: string;
  success: boolean;
  message: string;
}
interface TermInstance {
  term: Terminal;
  fit: FitAddon;
}

/**
 * Serial Studio 前端（Tauri 与浏览器共用，只走 WS）。
 *
 * 多标签页：每个打开的端口一个独立 Terminal 实例（Map<port, TermInstance>），
 * 切换 tab 只切 DOM 可见性（display），不销毁 Terminal——历史完整保留。
 */
export default function App() {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [macros, setMacros] = useState<Record<string, Macro>>({});
  const [macroResult, setMacroResult] = useState<MacroResult | null>(null);
  const [connected, setConnected] = useState(false);
  const [openPorts, setOpenPorts] = useState<string[]>([]);
  const [activePort, setActivePort] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  // ②串口配置：打开前弹对话框编辑，记忆上次（localStorage）
  const [pendingPort, setPendingPort] = useState<string | null>(null);
  const [serialConfig, setSerialConfig] = useState<SerialConfig>(loadConfig);
  // ③连接/服务器配置
  const [connConfig, setConnConfig] = useState<ConnConfig>(initConn);
  const isRemote = !!getRemoteFromUrl(); // 远程窗口（?remote=）模式
  // 打开远程窗口对话框
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [remoteInput, setRemoteInput] = useState({ host: "", port: 18700 });
  const [srvSettings, setSrvSettings] = useState<SrvSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // ④宏管理
  const [editing, setEditing] = useState<{ name: string; isNew: boolean } | null>(null);
  const [editorName, setEditorName] = useState("");
  const [editorMacro, setEditorMacro] = useState<Macro>({ steps: [] });
  const [editorError, setEditorError] = useState("");

  const transportRef = useRef<Transport | null>(null);
  const terminalsRef = useRef<Map<string, TermInstance>>(new Map());
  const activeRef = useRef("");
  activeRef.current = activePort;

  // 是否本地模式（Tauri + 无远程地址）——本地模式用 IPC，不走 connConfig
  const isLocal = isTauri() && !isRemote;

  // 数据面连接。本地模式用 IPC（常驻不重连）；远程/Web 用 WS（connConfig 变化重建）
  useEffect(() => {
    const t = isLocal ? new LocalTransport() : new RemoteTransport(connConfig.host, connConfig.port);
    transportRef.current = t;
    const unsubs = [
      t.onConnectedChange((conn) => {
        setConnected(conn);
        if (conn) t.list().then(setPorts);
      }),
      t.onData((port, data) => {
        // 按 port 路由到对应 terminal（不管是否 active，都写入保留历史）
        const inst = terminalsRef.current.get(port);
        if (inst) inst.term.write(data);
      }),
      t.onPortOpened((port) => {
        setOpenPorts((prev) =>
          prev.includes(port) ? prev : [...prev, port]
        );
        setActivePort(port);
        t.list().then(setPorts);
      }),
      t.onPortClosed(() => {
        t.list().then(setPorts);
      }),
      t.onError((msg) => {
        setErrorMsg(msg);
        setTimeout(() => setErrorMsg(""), 5000);
      }),
      t.onMacroResult((name, success, message) =>
        setMacroResult({ name, success, message })
      ),
    ];
    return () => {
      unsubs.forEach((fn) => fn());
      t.dispose();
    };
  }, [isLocal, connConfig]);

  // ③服务器配置：Tauri 控制面 invoke 读本地 settings.json（不依赖 WS 运行）
  useEffect(() => {
    if (!isTauri()) return;
    tauriInvoke<SrvSettings>("get_settings")
      .then((s) => {
        setSrvSettings(s);
        // 本地模式：端口对齐本地服务实际监听口
        // 仅当不一致才改（返回原对象 → 引用不变 → 不触发 WS useEffect 重连）
        if (!isRemote) {
          setConnConfig((c) =>
            c.port === s.ws_port ? c : { host: "127.0.0.1", port: s.ws_port }
          );
        }
      })
      .catch(() => {});
  }, []);

  // ④宏加载：Tauri → invoke load_macros（exe 同目录 macros.json）；
  //   Web → localStorage 回退。跟着用户走，不存服务端。
  useEffect(() => {
    if (isTauri()) {
      tauriInvoke<Record<string, Macro>>("load_macros")
        .then(setMacros)
        .catch((e) => console.error("加载宏失败", e));
    } else {
      setMacros(loadMacrosLocal());
    }
  }, []);

  // 点端口 → 弹配置对话框（pendingPort）；确认后才真正 open
  const confirmOpen = (config: SerialConfig) => {
    if (!pendingPort) return;
    saveConfig(config);
    transportRef.current?.open(pendingPort, config);
    setPendingPort(null);
  };

  const closePort = (port: string) => {
    transportRef.current?.close(port);
    terminalsRef.current.delete(port); // 立即停掉 data 路由
    setOpenPorts((prev) => {
      const rest = prev.filter((p) => p !== port);
      if (activeRef.current === port) {
        setActivePort(rest[rest.length - 1] ?? "");
      }
      return rest;
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

  // ④宏管理
  const openMacroEditor = (name: string | null) => {
    if (name && macros[name]) {
      setEditing({ name, isNew: false });
      setEditorName(name);
      // 深拷贝，编辑不影响原对象
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
    // 步骤级校验（send data 非空、delay/expect 数值合法等）
    const err = validateMacro(editorMacro);
    if (err) {
      setEditorError(err);
      return;
    }
    // 纯前端：宏存本地文件（跟着用户走），不存服务端
    const next = { ...macros, [trimmedName]: editorMacro };
    setMacros(next);
    await persistMacros(next);
    setEditing(null);
  };

  const deleteMacro = async (name: string) => {
    if (!confirm(`删除宏 "${name}"？`)) return;
    const next = { ...macros };
    delete next[name];
    setMacros(next);
    await persistMacros(next);
    setEditing(null);
  };

  // VS Code 风：开新窗口连接远程服务（本地窗口保留）
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

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "sans-serif" }}>
      <aside
        style={{
          width: 240,
          borderRight: "1px solid #333",
          padding: 12,
          background: "#1e1e1e",
          color: "#ddd",
          boxSizing: "border-box",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ marginTop: 0 }}>🔌 Serial Studio</h3>
          <button
            onClick={() => setSettingsOpen(true)}
            title="设置"
            style={{ background: "none", border: "none", color: "#ddd", cursor: "pointer", fontSize: 18, padding: "0 4px" }}
          >
            ⚙
          </button>
        </div>
        {/* 连接状态：仅远程/Web 显示（本地模式透明，无需关心连接细节） */}
        {(!isTauri() || isRemote) && (
          <p style={{ fontSize: 13 }}>
            {isRemote ? "🔗 远程" : "🌐 Web"} · {connected ? "🟢 已连接" : "🔴 未连接"}{" "}
            ({connConfig.host}:{connConfig.port})
          </p>
        )}
        {isTauri() && (
          <button
            onClick={() => setRemoteOpen(true)}
            title="打开远程窗口（新窗口连接远程服务）"
            style={{
              width: "100%",
              marginBottom: 8,
              padding: "5px 8px",
              background: "#2d2d2d",
              color: "#ddd",
              border: "1px solid #444",
              borderRadius: 3,
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            🌐 打开远程窗口
          </button>
        )}

        <h4 style={{ marginBottom: 8 }}>端口</h4>
        {ports.length === 0 && (
          <p style={{ color: "#888", fontSize: 13 }}>无可用端口</p>
        )}
        {ports.map((p) => {
          const isActive = p.name === activePort;
          return (
            <div key={p.name} style={{ marginBottom: 6 }}>
              <button
                onClick={() => (p.opened ? switchPort(p.name) : setPendingPort(p.name))}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "6px 8px",
                  background: isActive ? "#0e639c" : "#2d2d2d",
                  color: "#ddd",
                  border: "1px solid #444",
                  cursor: "pointer",
                  borderRadius: 3,
                }}
              >
                {p.opened ? "📂" : "📁"} {p.name}
              </button>
            </div>
          );
        })}

        <h4
          style={{
            marginTop: 16,
            marginBottom: 8,
            borderTop: "1px solid #333",
            paddingTop: 12,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>⚡ 宏 {activePort ? `→ ${activePort}` : ""}</span>
          <button
            onClick={() => openMacroEditor(null)}
            title="新增宏"
            style={{
              background: "none",
              border: "1px solid #444",
              color: "#ddd",
              cursor: "pointer",
              borderRadius: 3,
              padding: "2px 8px",
              fontSize: 13,
            }}
          >
            ＋
          </button>
        </h4>
        {Object.keys(macros).length === 0 && (
          <p style={{ color: "#888", fontSize: 13 }}>无宏（点 ＋ 新增）</p>
        )}
        {Object.entries(macros).map(([name, m]) => (
          <div key={name} style={{ marginBottom: 6 }}>
            <div style={{ display: "flex", gap: 4 }}>
              <button
                onClick={() => runMacro(name)}
                disabled={!activePort}
                style={{
                  flex: 1,
                  textAlign: "left",
                  padding: "6px 8px",
                  background: "#2d2d2d",
                  color: activePort ? "#ddd" : "#666",
                  border: "1px solid #444",
                  cursor: activePort ? "pointer" : "not-allowed",
                  borderRadius: 3,
                  fontSize: 13,
                }}
              >
                ▶ {name}
                {m.description && (
                  <span
                    style={{
                      display: "block",
                      fontSize: 11,
                      color: "#888",
                      marginTop: 2,
                    }}
                  >
                    {m.description}
                  </span>
                )}
              </button>
              <button
                onClick={() => openMacroEditor(name)}
                title="编辑"
                style={{
                  background: "#2d2d2d",
                  color: "#ddd",
                  border: "1px solid #444",
                  cursor: "pointer",
                  borderRadius: 3,
                  padding: "0 6px",
                  fontSize: 13,
                }}
              >
                ✎
              </button>
              <button
                onClick={() => deleteMacro(name)}
                title="删除"
                style={{
                  background: "#2d2d2d",
                  color: "#ff7b72",
                  border: "1px solid #444",
                  cursor: "pointer",
                  borderRadius: 3,
                  padding: "0 6px",
                  fontSize: 13,
                }}
              >
                🗑
              </button>
            </div>
          </div>
        ))}
        {macroResult && (
          <div
            style={{
              marginTop: 8,
              padding: 6,
              fontSize: 11,
              borderRadius: 3,
              background:
                macroResult.success && macroResult.message !== "运行中..."
                  ? "#1a3a1a"
                  : macroResult.message === "运行中..."
                  ? "#2d2d2d"
                  : "#3a1a1a",
              color:
                macroResult.success && macroResult.message !== "运行中..."
                  ? "#7ee787"
                  : macroResult.message === "运行中..."
                  ? "#888"
                  : "#ff7b72",
              wordBreak: "break-all",
            }}
          >
            {macroResult.success ? "✓" : "✗"} {macroResult.name}: {macroResult.message}
          </div>
        )}
      </aside>

      <main
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          background: "#000",
          minWidth: 0,
        }}
      >
        {/* Tab 栏 */}
        <div
          style={{
            display: "flex",
            borderBottom: "1px solid #333",
            background: "#1e1e1e",
            minHeight: 30,
            overflowX: "auto",
          }}
        >
          {openPorts.length === 0 && (
            <span style={{ color: "#666", padding: "6px 12px", fontSize: 13 }}>
              未打开端口
            </span>
          )}
          {openPorts.map((port) => {
            const isActive = port === activePort;
            return (
              <div
                key={port}
                onClick={() => switchPort(port)}
                style={{
                  padding: "6px 12px",
                  cursor: "pointer",
                  color: isActive ? "#fff" : "#888",
                  background: isActive ? "#2d2d2d" : "transparent",
                  borderRight: "1px solid #333",
                  fontSize: 13,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  whiteSpace: "nowrap",
                }}
              >
                <span>📂 {port}</span>
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    closePort(port);
                  }}
                  style={{
                    color: "#ff7b72",
                    cursor: "pointer",
                    padding: "0 4px",
                  }}
                  title={`关闭 ${port}`}
                >
                  ✕
                </span>
              </div>
            );
          })}
        </div>

        {/* 错误提示条 */}
        {errorMsg && (
          <div
            style={{
              padding: "6px 12px",
              background: "#3a1a1a",
              color: "#ff7b72",
              fontSize: 12,
            }}
          >
            ⚠ {errorMsg}
          </div>
        )}

        {/* 终端区：每个 openPort 一个 TermView，display 切换可见（不销毁） */}
        <div style={{ flex: 1, position: "relative" }}>
          {openPorts.map((port) => (
            <TermView
              key={port}
              port={port}
              active={port === activePort}
              onWrite={(p, data) => transportRef.current?.write(p, data)}
              onReady={(inst) => {
                if (inst) terminalsRef.current.set(port, inst);
                else terminalsRef.current.delete(port);
              }}
            />
          ))}
          {openPorts.length === 0 && (
            <div style={{ color: "#888", padding: 16 }}>← 选择左侧端口开始</div>
          )}
        </div>
      </main>

      {/* ②串口配置对话框 */}
      {pendingPort && (
        <SerialConfigDialog
          port={pendingPort}
          config={serialConfig}
          onChange={setSerialConfig}
          onConfirm={confirmOpen}
          onCancel={() => setPendingPort(null)}
        />
      )}

      {/* ③设置面板 */}
      {settingsOpen && (
        <SettingsPanel
          connConfig={connConfig}
          srvSettings={srvSettings}
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
              // WS 端口可能变了，用新地址重连
              setConnConfig({ host: s.ws_host, port: s.ws_port });
            } catch (e) {
              setErrorMsg(String(e));
              setTimeout(() => setErrorMsg(""), 5000);
            }
          }}
          showServer={isTauri() && !isRemote}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {/* ⑤远程连接对话框 */}
      {remoteOpen && (
        <RemoteDialog
          input={remoteInput}
          onChange={setRemoteInput}
          onConfirm={openRemoteWindow}
          onCancel={() => setRemoteOpen(false)}
        />
      )}

      {/* ④宏编辑器 */}
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

/**
 * 单个终端视图：保持 mounted（在 openPorts 期间），用 display 切换可见性。
 * mount 时创建 Terminal 实例，unmount（端口关闭、移出 openPorts）时才 dispose。
 */
function TermView({
  port,
  active,
  onWrite,
  onReady,
}: {
  port: string;
  active: boolean;
  onWrite: (port: string, data: string) => void;
  onReady: (inst: TermInstance | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // 创建 terminal（port 不变，只创建一次）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal();
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fitRef.current = fit;
    onReady({ term, fit });

    const disposable = term.onData((data) => {
      onWrite(port, data);
    });

    // 初次 fit（可能延迟到可见后才能算对尺寸）
    const timer = setTimeout(() => {
      try {
        fit.fit();
        term.focus();
      } catch {
        /* 容器还未可见，等 active 切换时再 fit */
      }
    }, 50);

    return () => {
      clearTimeout(timer);
      disposable.dispose();
      term.dispose();
      fitRef.current = null;
      onReady(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port]);

  // active 切换时重新 fit（从隐藏到可见，尺寸变了）
  useEffect(() => {
    if (active && fitRef.current) {
      const timer = setTimeout(() => {
        try {
          fitRef.current?.fit();
        } catch {
          /* ignore */
        }
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [active]);

  // 窗口尺寸变化时 fit（仅 active 的需要）
  useEffect(() => {
    if (!active) return;
    const onResize = () => {
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [active]);

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        inset: 0,
        display: active ? "block" : "none",
      }}
    />
  );
}

// ===== ②串口配置 =====
interface SerialConfig {
  baud_rate: number;
  data_bits: string;
  stop_bits: string;
  parity: string;
  flow_control: string;
  line_ending: string;
}

const CONFIG_KEY = "serial-studio-config";
const DEFAULT_CONFIG: SerialConfig = {
  baud_rate: 115200,
  data_bits: "eight",
  stop_bits: "one",
  parity: "none",
  flow_control: "none",
  line_ending: "crlf",
};

function loadConfig(): SerialConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return DEFAULT_CONFIG;
}

function saveConfig(config: SerialConfig) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    /* ignore */
  }
}

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

const selectStyle: React.CSSProperties = {
  background: "#2d2d2d",
  color: "#ddd",
  border: "1px solid #444",
  borderRadius: 3,
  padding: "4px 6px",
  fontSize: 13,
  flex: 1,
};
const btnStyleCancel: React.CSSProperties = {
  padding: "6px 16px",
  background: "#2d2d2d",
  color: "#ddd",
  border: "1px solid #444",
  borderRadius: 3,
  cursor: "pointer",
};
const btnStyleConfirm: React.CSSProperties = {
  padding: "6px 16px",
  background: "#0e639c",
  color: "#fff",
  border: "1px solid #0e639c",
  borderRadius: 3,
  cursor: "pointer",
};

function ConfigRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
      <span style={{ width: 64, color: "#888" }}>{label}</span>
      {children}
    </div>
  );
}

function SerialConfigDialog({
  port,
  config,
  onChange,
  onConfirm,
  onCancel,
}: {
  port: string;
  config: SerialConfig;
  onChange: (c: SerialConfig) => void;
  onConfirm: (c: SerialConfig) => void;
  onCancel: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#1e1e1e",
          color: "#ddd",
          border: "1px solid #444",
          borderRadius: 6,
          padding: 16,
          minWidth: 320,
          fontSize: 13,
        }}
      >
        <h3 style={{ marginTop: 0, marginBottom: 12 }}>打开 {port}</h3>
        <ConfigRow label="波特率">
          <select
            value={config.baud_rate}
            onChange={(e) => onChange({ ...config, baud_rate: Number(e.target.value) })}
            style={selectStyle}
          >
            {BAUD_RATES.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </ConfigRow>
        <ConfigRow label="数据位">
          <select
            value={config.data_bits}
            onChange={(e) => onChange({ ...config, data_bits: e.target.value })}
            style={selectStyle}
          >
            <option value="eight">8</option>
            <option value="seven">7</option>
            <option value="six">6</option>
            <option value="five">5</option>
          </select>
        </ConfigRow>
        <ConfigRow label="停止位">
          <select
            value={config.stop_bits}
            onChange={(e) => onChange({ ...config, stop_bits: e.target.value })}
            style={selectStyle}
          >
            <option value="one">1</option>
            <option value="two">2</option>
          </select>
        </ConfigRow>
        <ConfigRow label="校验">
          <select
            value={config.parity}
            onChange={(e) => onChange({ ...config, parity: e.target.value })}
            style={selectStyle}
          >
            <option value="none">None</option>
            <option value="odd">Odd</option>
            <option value="even">Even</option>
          </select>
        </ConfigRow>
        <ConfigRow label="流控">
          <select
            value={config.flow_control}
            onChange={(e) => onChange({ ...config, flow_control: e.target.value })}
            style={selectStyle}
          >
            <option value="none">None</option>
            <option value="software">Software (XON/XOFF)</option>
            <option value="hardware">Hardware (RTS/CTS)</option>
          </select>
        </ConfigRow>
        <ConfigRow label="换行符">
          <select
            value={config.line_ending}
            onChange={(e) => onChange({ ...config, line_ending: e.target.value })}
            style={selectStyle}
          >
            <option value="crlf">CRLF (\r\n) — Windows/AT</option>
            <option value="lf">LF (\n) — Linux/Unix</option>
            <option value="cr">CR (\r)</option>
          </select>
        </ConfigRow>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onCancel} style={btnStyleCancel}>取消</button>
          <button onClick={() => onConfirm(config)} style={btnStyleConfirm}>打开</button>
        </div>
      </div>
    </div>
  );
}

// ===== ③连接 / 服务器配置 =====
interface ConnConfig {
  host: string;
  port: number;
}
interface SrvSettings {
  ws_host: string;
  ws_port: number;
  telnet_port: number;
}

const CONN_KEY = "serial-studio-conn";
function loadConn(): ConnConfig {
  try {
    const raw = localStorage.getItem(CONN_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return { host: location.hostname || "localhost", port: 18700 };
}

/** 远程窗口：URL ?remote=host:port 携带远程地址 */
function getRemoteFromUrl(): ConnConfig | null {
  const remote = new URLSearchParams(location.search).get("remote");
  if (!remote) return null;
  const [host, portStr] = remote.split(":");
  const port = parseInt(portStr, 10);
  return host && port ? { host, port } : null;
}

/** 初始连接：远程窗口（?remote）> 本地模式（Tauri 连本机服务）> Web（loadConn） */
function initConn(): ConnConfig {
  return getRemoteFromUrl() ?? (isTauri() ? { host: "127.0.0.1", port: 18700 } : loadConn());
}
function saveConn(c: ConnConfig) {
  try {
    localStorage.setItem(CONN_KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

// 宏是用户配置：Tauri 模式存 exe 同目录 macros.json（控制面 invoke），
// Web 模式回退 localStorage（浏览器无文件权限）。跟着用户走，不存服务端。
const MACROS_KEY = "serial-studio-macros";

/** Web 模式：从 localStorage 读（首次为空，无内置示例） */
function loadMacrosLocal(): Record<string, Macro> {
  try {
    const raw = localStorage.getItem(MACROS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return {};
}

function persistMacrosLocal(macros: Record<string, Macro>) {
  try {
    localStorage.setItem(MACROS_KEY, JSON.stringify(macros));
  } catch {
    /* ignore */
  }
}

/** 持久化宏：Tauri → invoke save_macros；Web → localStorage */
async function persistMacros(macros: Record<string, Macro>) {
  if (isTauri()) {
    try {
      await tauriInvoke("save_macros", { macros });
    } catch (e) {
      console.error("保存宏失败", e);
    }
  } else {
    persistMacrosLocal(macros);
  }
}

const inputStyle: React.CSSProperties = {
  background: "#2d2d2d",
  color: "#ddd",
  border: "1px solid #444",
  borderRadius: 3,
  padding: "4px 6px",
  fontSize: 13,
  flex: 1,
};

function SettingsPanel({
  connConfig,
  srvSettings,
  onConnChange,
  onSaveSrv,
  showServer,
  onClose,
}: {
  connConfig: ConnConfig;
  srvSettings: SrvSettings | null;
  onConnChange: (c: ConnConfig) => void;
  onSaveSrv: (s: SrvSettings) => void;
  showServer: boolean;
  onClose: () => void;
}) {
  const [conn, setConn] = useState<ConnConfig>(connConfig);
  const [srv, setSrv] = useState<SrvSettings | null>(srvSettings);
  const [saved, setSaved] = useState(false);

  // 服务器设置从后端更新时同步到本地编辑态
  useEffect(() => {
    setSrv(srvSettings);
  }, [srvSettings]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#1e1e1e",
          color: "#ddd",
          border: "1px solid #444",
          borderRadius: 6,
          padding: 16,
          minWidth: 360,
          fontSize: 13,
          maxHeight: "80vh",
          overflowY: "auto",
        }}
      >
        <h3 style={{ marginTop: 0, marginBottom: 12 }}>⚙ 设置</h3>

        {/* (a) 连接配置：远程/Web 模式改连的服务（本地模式连本地固定，隐藏） */}
        {!showServer && (
        <div
          style={{
            marginBottom: 16,
            borderBottom: "1px solid #333",
            paddingBottom: 12,
          }}
        >
          <div style={{ fontWeight: "bold", marginBottom: 8 }}>
            连接（前端 → 服务器）
          </div>
          <ConfigRow label="主机">
            <input
              value={conn.host}
              onChange={(e) => setConn({ ...conn, host: e.target.value })}
              style={inputStyle}
            />
          </ConfigRow>
          <ConfigRow label="端口">
            <input
              type="number"
              value={conn.port}
              onChange={(e) => setConn({ ...conn, port: Number(e.target.value) })}
              style={inputStyle}
            />
          </ConfigRow>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8, gap: 8 }}>
            <button onClick={onClose} style={btnStyleCancel}>
              关闭
            </button>
            <button onClick={() => onConnChange(conn)} style={btnStyleConfirm}>
              应用并重连
            </button>
          </div>
          <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>
            改连别的远程 Serial Studio 服务
          </div>
        </div>
        )}

        {/* (b) 服务器监听配置（仅本地模式）：invoke apply_settings 保存 + 热重启 */}
        {showServer && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontWeight: "bold", marginBottom: 8 }}>
            服务器监听（热重启生效）
          </div>
          {srv ? (
            <>
              <ConfigRow label="监听地址">
                <input
                  value={srv.ws_host}
                  onChange={(e) => setSrv({ ...srv, ws_host: e.target.value })}
                  style={inputStyle}
                />
              </ConfigRow>
              <ConfigRow label="WS 端口">
                <input
                  type="number"
                  value={srv.ws_port}
                  onChange={(e) => setSrv({ ...srv, ws_port: Number(e.target.value) })}
                  style={inputStyle}
                />
              </ConfigRow>
              <ConfigRow label="Telnet 端口">
                <input
                  type="number"
                  value={srv.telnet_port}
                  onChange={(e) => setSrv({ ...srv, telnet_port: Number(e.target.value) })}
                  style={inputStyle}
                />
              </ConfigRow>
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  marginTop: 8,
                  gap: 8,
                  alignItems: "center",
                }}
              >
                {saved && (
                  <span style={{ color: "#7ee787", fontSize: 11 }}>已应用</span>
                )}
                <button onClick={onClose} style={btnStyleCancel}>
                  关闭
                </button>
                <button
                  onClick={() => {
                    onSaveSrv(srv);
                    setSaved(true);
                    setTimeout(() => setSaved(false), 3000);
                  }}
                  style={btnStyleConfirm}
                >
                  应用
                </button>
              </div>
            </>
          ) : (
            <div style={{ color: "#888" }}>加载中…</div>
          )}
        </div>
        )}

      </div>
    </div>
  );
}

const textareaStyle: React.CSSProperties = {
  background: "#1a1a1a",
  color: "#ddd",
  border: "1px solid #444",
  borderRadius: 3,
  padding: "6px",
  fontSize: 12,
  fontFamily: "monospace",
  boxSizing: "border-box",
};

/** 生成带默认字段的步骤 */
function newStep(type: StepType): MacroStep {
  switch (type) {
    case "send":
      return { type: "send", data: "", format: "text", auto_newline: true };
    case "delay":
      return { type: "delay", ms: 500 };
    case "expect":
      return { type: "expect", pattern: "", timeout_ms: 3000 };
    case "clear":
      return { type: "clear" };
  }
}

/** 步骤级校验，返回错误消息或 null */
function validateMacro(m: Macro): string | null {
  if (m.steps.length === 0) return "至少需要一个步骤";
  for (let i = 0; i < m.steps.length; i++) {
    const s = m.steps[i];
    const tag = `步骤 ${i + 1}`;
    switch (s.type) {
      case "send":
        if (!s.data.trim()) return `${tag}：send 数据不能为空`;
        break;
      case "delay":
        if (!s.ms || s.ms <= 0) return `${tag}：delay 毫秒须 > 0`;
        break;
      case "expect":
        if (!s.pattern.trim()) return `${tag}：expect 匹配模式不能为空`;
        if (!s.timeout_ms || s.timeout_ms <= 0) return `${tag}：expect 超时须 > 0`;
        break;
    }
  }
  return null;
}

const addStepBtnStyle: React.CSSProperties = {
  padding: "4px 10px",
  background: "#2d2d2d",
  color: "#7ee787",
  border: "1px solid #444",
  borderRadius: 3,
  cursor: "pointer",
  fontSize: 12,
};

const miniBtn: React.CSSProperties = {
  background: "#2d2d2d",
  color: "#ddd",
  border: "1px solid #444",
  borderRadius: 3,
  cursor: "pointer",
  padding: "0 6px",
  fontSize: 12,
};

const stepIcon: Record<StepType, string> = {
  send: "→",
  delay: "⏱",
  expect: "⏳",
  clear: "✕",
};

function MacroEditor({
  name,
  macro,
  error,
  isNew,
  onName,
  onMacroChange,
  onSave,
  onDelete,
  onCancel,
}: {
  name: string;
  macro: Macro;
  error: string;
  isNew: boolean;
  onName: (s: string) => void;
  onMacroChange: (m: Macro) => void;
  onSave: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const setDesc = (description: string) => onMacroChange({ ...macro, description });
  const setStep = (i: number, s: MacroStep) => {
    const steps = macro.steps.slice();
    steps[i] = s;
    onMacroChange({ ...macro, steps });
  };
  const addStep = (type: StepType) =>
    onMacroChange({ ...macro, steps: [...macro.steps, newStep(type)] });
  const removeStep = (i: number) =>
    onMacroChange({ ...macro, steps: macro.steps.filter((_, j) => j !== i) });
  const moveStep = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= macro.steps.length) return;
    const steps = macro.steps.slice();
    [steps[i], steps[j]] = [steps[j], steps[i]];
    onMacroChange({ ...macro, steps });
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#1e1e1e",
          color: "#ddd",
          border: "1px solid #444",
          borderRadius: 6,
          padding: 16,
          width: 560,
          maxWidth: "90vw",
          fontSize: 13,
          maxHeight: "85vh",
          overflowY: "auto",
        }}
      >
        <h3 style={{ marginTop: 0, marginBottom: 12 }}>
          {isNew ? "新增宏" : `编辑 ${name}`}
        </h3>
        <ConfigRow label="名称">
          <input
            value={name}
            onChange={(e) => onName(e.target.value)}
            disabled={!isNew}
            style={{ ...inputStyle, opacity: isNew ? 1 : 0.5 }}
          />
        </ConfigRow>
        <ConfigRow label="描述">
          <input
            value={macro.description ?? ""}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="可选"
            style={inputStyle}
          />
        </ConfigRow>

        <div style={{ color: "#888", marginBottom: 6, marginTop: 4 }}>步骤</div>
        {macro.steps.length === 0 && (
          <p style={{ color: "#888", fontSize: 12 }}>无步骤（点下方添加）</p>
        )}
        {macro.steps.map((s, i) => (
          <StepEditor
            key={i}
            step={s}
            index={i}
            total={macro.steps.length}
            onChange={(ns) => setStep(i, ns)}
            onRemove={() => removeStep(i)}
            onMoveUp={() => moveStep(i, -1)}
            onMoveDown={() => moveStep(i, 1)}
          />
        ))}
        <div style={{ display: "flex", gap: 6, margin: "8px 0 12px", flexWrap: "wrap" }}>
          <button onClick={() => addStep("send")} style={addStepBtnStyle}>＋ 发送</button>
          <button onClick={() => addStep("delay")} style={addStepBtnStyle}>＋ 延时</button>
          <button onClick={() => addStep("expect")} style={addStepBtnStyle}>＋ 等待</button>
          <button onClick={() => addStep("clear")} style={addStepBtnStyle}>＋ 清空</button>
        </div>

        {error && (
          <div style={{ color: "#ff7b72", fontSize: 12, marginBottom: 8 }}>⚠ {error}</div>
        )}

        <details style={{ marginBottom: 8 }}>
          <summary style={{ cursor: "pointer", color: "#888" }}>JSON 预览（只读）</summary>
          <pre
            style={{
              ...textareaStyle,
              margin: "6px 0 0",
              padding: 8,
              maxHeight: 160,
              overflow: "auto",
              whiteSpace: "pre-wrap",
            }}
          >
            {JSON.stringify(macro, null, 2)}
          </pre>
        </details>

        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <div>
            {!isNew && (
              <button onClick={onDelete} style={btnStyleCancel}>🗑 删除</button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onCancel} style={btnStyleCancel}>取消</button>
            <button onClick={onSave} style={btnStyleConfirm}>保存</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 单步编辑器：类型切换 + 动态字段 + 排序/删除 */
function StepEditor({
  step,
  index,
  total,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  step: MacroStep;
  index: number;
  total: number;
  onChange: (s: MacroStep) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const changeType = (type: StepType) => {
    if (type === step.type) return;
    onChange(newStep(type)); // 切换类型重置为默认字段
  };

  return (
    <div
      style={{
        border: "1px solid #3a3a3a",
        borderRadius: 4,
        padding: 8,
        marginBottom: 6,
        background: "#252525",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span style={{ color: "#888", width: 18, textAlign: "center" }}>{stepIcon[step.type]}</span>
        <span style={{ color: "#888", fontSize: 11 }}>#{index + 1}</span>
        <select
          value={step.type}
          onChange={(e) => changeType(e.target.value as StepType)}
          style={{ ...selectStyle, flex: "0 0 auto", width: 80 }}
        >
          <option value="send">发送</option>
          <option value="delay">延时</option>
          <option value="expect">等待</option>
          <option value="clear">清空</option>
        </select>
        <div style={{ flex: 1 }} />
        <button
          onClick={onMoveUp}
          disabled={index === 0}
          title="上移"
          style={{ ...miniBtn, opacity: index === 0 ? 0.3 : 1 }}
        >↑</button>
        <button
          onClick={onMoveDown}
          disabled={index === total - 1}
          title="下移"
          style={{ ...miniBtn, opacity: index === total - 1 ? 0.3 : 1 }}
        >↓</button>
        <button onClick={onRemove} title="删除" style={{ ...miniBtn, color: "#ff7b72" }}>✕</button>
      </div>
      <div style={{ paddingLeft: 24 }}>
        {step.type === "send" && (
          <>
            <textarea
              value={step.data}
              onChange={(e) => onChange({ ...step, data: e.target.value })}
              placeholder="发送内容"
              rows={1}
              style={{ ...textareaStyle, width: "100%", minHeight: 28 }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4, flexWrap: "wrap" }}>
              <label style={{ color: "#888", fontSize: 12 }}>
                格式
                <select
                  value={step.format}
                  onChange={(e) => onChange({ ...step, format: e.target.value })}
                  style={{ ...selectStyle, marginLeft: 6, flex: "0 0 auto", width: 72 }}
                >
                  <option value="text">text</option>
                  <option value="hex">hex</option>
                </select>
              </label>
              <label style={{ color: "#888", fontSize: 12, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={step.auto_newline}
                  onChange={(e) => onChange({ ...step, auto_newline: e.target.checked })}
                  style={{ marginRight: 4 }}
                />
                自动换行（按端口设置）
              </label>
            </div>
          </>
        )}
        {step.type === "delay" && (
          <label style={{ color: "#888", fontSize: 12 }}>
            等待
            <input
              type="number"
              value={step.ms}
              onChange={(e) => onChange({ ...step, ms: Number(e.target.value) })}
              min={1}
              style={{ ...inputStyle, display: "inline-block", width: 80, margin: "0 6px" }}
            />
            毫秒
          </label>
        )}
        {step.type === "expect" && (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
            <label style={{ color: "#888", fontSize: 12, flex: 1, minWidth: 120 }}>
              等待匹配
              <input
                value={step.pattern}
                onChange={(e) => onChange({ ...step, pattern: e.target.value })}
                placeholder="正则 / 子串"
                style={{ ...inputStyle, display: "block", marginTop: 2 }}
              />
            </label>
            <label style={{ color: "#888", fontSize: 12 }}>
              超时
              <input
                type="number"
                value={step.timeout_ms}
                onChange={(e) => onChange({ ...step, timeout_ms: Number(e.target.value) })}
                min={1}
                style={{ ...inputStyle, display: "inline-block", width: 70, margin: "0 6px" }}
              />
              ms
            </label>
          </div>
        )}
        {step.type === "clear" && (
          <div style={{ color: "#888", fontSize: 12 }}>清空接收缓冲区</div>
        )}
      </div>
    </div>
  );
}

/** 远程连接对话框（VS Code 风：开新窗口连远程服务，本地保留） */
function RemoteDialog({
  input,
  onChange,
  onConfirm,
  onCancel,
}: {
  input: { host: string; port: number };
  onChange: (v: { host: string; port: number }) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
        style={{
          background: "#1e1e1e",
          color: "#ddd",
          border: "1px solid #444",
          borderRadius: 6,
          padding: 16,
          width: 380,
          maxWidth: "90vw",
          fontSize: 13,
        }}
      >
        <h3 style={{ marginTop: 0, marginBottom: 12 }}>🌐 打开远程窗口</h3>
        <ConfigRow label="地址">
          <input
            value={input.host}
            onChange={(e) => onChange({ ...input, host: e.target.value })}
            placeholder="192.168.1.50"
            style={inputStyle}
            autoFocus
          />
        </ConfigRow>
        <ConfigRow label="端口">
          <input
            type="number"
            value={input.port}
            onChange={(e) => onChange({ ...input, port: Number(e.target.value) })}
            style={inputStyle}
          />
        </ConfigRow>
        <p style={{ fontSize: 11, color: "#888", margin: "8px 0" }}>
          将在新窗口连接远程 Serial Studio 服务，本地窗口保留。
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onCancel} style={btnStyleCancel}>取消</button>
          <button onClick={onConfirm} style={btnStyleConfirm}>连接</button>
        </div>
      </div>
    </div>
  );
}

function hexToBytes(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

/** 数据面传输抽象：屏蔽 IPC/WS 协议差异。组件只懂领域（port/bytes/macro）。 */
interface Transport {
  list(): Promise<PortInfo[]>;
  open(port: string, config: SerialConfig): Promise<void>;
  close(port: string): Promise<void>;
  write(port: string, data: string): Promise<void>;
  runMacro(name: string, port: string, macro: Macro): Promise<void>;
  onData(cb: (port: string, data: Uint8Array) => void): () => void;
  onPortOpened(cb: (port: string) => void): () => void;
  onPortClosed(cb: (port: string) => void): () => void;
  onError(cb: (msg: string) => void): () => void;
  onMacroResult(cb: (name: string, success: boolean, msg: string) => void): () => void;
  onConnectedChange(cb: (connected: boolean) => void): () => void;
  dispose(): void;
}

/** WS 实现（远程/Web 模式）。封装 WS 协议细节（action/type/hex 编解码）。 */
class RemoteTransport implements Transport {
  private ws: WebSocket;
  private listResolver: ((p: PortInfo[]) => void) | null = null;
  private handlers = {
    data: new Set<(port: string, data: Uint8Array) => void>(),
    opened: new Set<(port: string) => void>(),
    closed: new Set<(port: string) => void>(),
    error: new Set<(msg: string) => void>(),
    macroResult: new Set<(name: string, success: boolean, msg: string) => void>(),
    connected: new Set<(c: boolean) => void>(),
  };

  constructor(host: string, port: number) {
    this.ws = new WebSocket(`ws://${host}:${port}/ws`);
    this.ws.onopen = () => this.handlers.connected.forEach((cb) => cb(true));
    this.ws.onclose = () => this.handlers.connected.forEach((cb) => cb(false));
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case "ports":
          if (this.listResolver) {
            this.listResolver(msg.ports as PortInfo[]);
            this.listResolver = null;
          }
          break;
        case "data":
          this.handlers.data.forEach((cb) => cb(msg.port, hexToBytes(msg.data)));
          break;
        case "opened":
          this.handlers.opened.forEach((cb) => cb(msg.port));
          break;
        case "closed":
          this.handlers.closed.forEach((cb) => cb(msg.port));
          break;
        case "error":
          this.handlers.error.forEach((cb) => cb(msg.message));
          break;
        case "macro_result":
          this.handlers.macroResult.forEach((cb) =>
            cb(msg.name, msg.success, msg.message)
          );
          break;
      }
    };
  }

  async list() {
    this.ws.send(JSON.stringify({ action: "list" }));
    return new Promise<PortInfo[]>((resolve) => {
      this.listResolver = resolve;
    });
  }
  async open(port: string, config: SerialConfig) {
    this.ws.send(JSON.stringify({ action: "open", port, config }));
  }
  async close(port: string) {
    this.ws.send(JSON.stringify({ action: "close", port }));
  }
  async write(port: string, data: string) {
    this.ws.send(JSON.stringify({ action: "write", port, data, encoding: "text" }));
  }
  async runMacro(name: string, port: string, macro: Macro) {
    this.ws.send(JSON.stringify({ action: "run_macro", name, port, macro }));
  }

  onData(cb: (port: string, data: Uint8Array) => void) {
    this.handlers.data.add(cb);
    return () => { this.handlers.data.delete(cb); };
  }
  onPortOpened(cb: (port: string) => void) {
    this.handlers.opened.add(cb);
    return () => { this.handlers.opened.delete(cb); };
  }
  onPortClosed(cb: (port: string) => void) {
    this.handlers.closed.add(cb);
    return () => { this.handlers.closed.delete(cb); };
  }
  onError(cb: (msg: string) => void) {
    this.handlers.error.add(cb);
    return () => { this.handlers.error.delete(cb); };
  }
  onMacroResult(cb: (name: string, success: boolean, msg: string) => void) {
    this.handlers.macroResult.add(cb);
    return () => { this.handlers.macroResult.delete(cb); };
  }
  onConnectedChange(cb: (connected: boolean) => void) {
    this.handlers.connected.add(cb);
    // 已连上则立即通知（注册晚于 onopen 的情况）
    if (this.ws.readyState === WebSocket.OPEN) cb(true);
    return () => { this.handlers.connected.delete(cb); };
  }

  dispose() {
    this.ws.close();
  }
}

/** IPC 实现（本地模式）：Tauri invoke 命令 + event 监听。绕过 WS，进程内直连。 */
class LocalTransport implements Transport {
  private unlisten: Array<() => void> = [];
  private handlers = {
    data: new Set<(port: string, data: Uint8Array) => void>(),
    opened: new Set<(port: string) => void>(),
    closed: new Set<(port: string) => void>(),
    error: new Set<(msg: string) => void>(),
    macroResult: new Set<(name: string, success: boolean, msg: string) => void>(),
    connected: new Set<(c: boolean) => void>(),
  };

  constructor() {
    // 本地 IPC 不会断，视为永远已连接
    this.handlers.connected.forEach((cb) => cb(true));
    // 订阅后端 emit 的 serial 事件
    this.setupEvents();
  }

  private setupEvents() {
    const setup = async () => {
      const { listen } = await import("@tauri-apps/api/event");
      this.unlisten.push(
        await listen<{ port: string; data: string }>("serial-data", (e) => {
          this.handlers.data.forEach((cb) => cb(e.payload.port, hexToBytes(e.payload.data)));
        })
      );
      this.unlisten.push(
        await listen<string>("serial-opened", (e) =>
          this.handlers.opened.forEach((cb) => cb(e.payload)))
      );
      this.unlisten.push(
        await listen<string>("serial-closed", (e) =>
          this.handlers.closed.forEach((cb) => cb(e.payload)))
      );
      this.unlisten.push(
        await listen<{ message: string }>("serial-error", (e) =>
          this.handlers.error.forEach((cb) => cb(e.payload.message)))
      );
      this.unlisten.push(
        await listen<{ name: string; success: boolean; message: string }>(
          "macro-result",
          (e) =>
            this.handlers.macroResult.forEach((cb) =>
              cb(e.payload.name, e.payload.success, e.payload.message)
            )
        )
      );
    };
    setup().catch((e) => console.error("本地事件订阅失败", e));
  }

  async list() {
    return tauriInvoke<PortInfo[]>("list_ports");
  }
  async open(port: string, config: SerialConfig) {
    await tauriInvoke("open_port", { port, config });
  }
  async close(port: string) {
    await tauriInvoke("close_port", { port });
  }
  async write(port: string, data: string) {
    await tauriInvoke("write_port", { port, data });
  }
  async runMacro(name: string, port: string, macro: Macro) {
    await tauriInvoke("run_macro", { name, port, macro });
  }

  onData(cb: (port: string, data: Uint8Array) => void) {
    this.handlers.data.add(cb);
    return () => { this.handlers.data.delete(cb); };
  }
  onPortOpened(cb: (port: string) => void) {
    this.handlers.opened.add(cb);
    return () => { this.handlers.opened.delete(cb); };
  }
  onPortClosed(cb: (port: string) => void) {
    this.handlers.closed.add(cb);
    return () => { this.handlers.closed.delete(cb); };
  }
  onError(cb: (msg: string) => void) {
    this.handlers.error.add(cb);
    return () => { this.handlers.error.delete(cb); };
  }
  onMacroResult(cb: (name: string, success: boolean, msg: string) => void) {
    this.handlers.macroResult.add(cb);
    return () => { this.handlers.macroResult.delete(cb); };
  }
  onConnectedChange(cb: (connected: boolean) => void) {
    this.handlers.connected.add(cb);
    cb(true); // IPC 永远已连接
    return () => { this.handlers.connected.delete(cb); };
  }

  dispose() {
    this.unlisten.forEach((fn) => fn());
  }
}

/** 按模式创建 Transport：本地 → IPC；远程/Web → WS */
function createTransport(): Transport {
  const remote = getRemoteFromUrl();
  if (isTauri() && !remote) return new LocalTransport();
  const { host, port } = remote ? remote : loadConn();
  return new RemoteTransport(host, port);
}
