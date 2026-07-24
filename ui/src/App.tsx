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
interface MacroStep {
  type: string;
  data?: string;
  format?: string;
  auto_newline?: boolean;
  ms?: number;
  pattern?: string;
  timeout_ms?: number;
}
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
  const [connConfig, setConnConfig] = useState<ConnConfig>(loadConn);
  const [srvSettings, setSrvSettings] = useState<SrvSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // ④宏管理
  const [editing, setEditing] = useState<{ name: string; isNew: boolean } | null>(null);
  const [editorName, setEditorName] = useState("");
  const [editorJson, setEditorJson] = useState("");
  const [jsonError, setJsonError] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  const terminalsRef = useRef<Map<string, TermInstance>>(new Map());
  const activeRef = useRef("");
  activeRef.current = activePort;

  // WS 连接（connConfig 变化时重连：首次连接或改了连接配置）
  useEffect(() => {
    const { host, port } = connConfig;
    const ws = new WebSocket(`ws://${host}:${port}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      ws.send(JSON.stringify({ action: "list_macros" }));
      ws.send(JSON.stringify({ action: "list" }));
    };
    ws.onclose = () => setConnected(false);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case "ports":
          setPorts(msg.ports);
          break;
        case "macros":
          setMacros(msg.macros);
          break;
        case "data": {
          // 按 port 路由到对应 terminal（不管是否 active，都写入保留历史）
          const inst = terminalsRef.current.get(msg.port);
          if (inst) inst.term.write(hexToBytes(msg.data));
          break;
        }
        case "opened": {
          setOpenPorts((prev) =>
            prev.includes(msg.port) ? prev : [...prev, msg.port]
          );
          setActivePort(msg.port);
          ws.send(JSON.stringify({ action: "list" }));
          break;
        }
        case "closed":
          ws.send(JSON.stringify({ action: "list" }));
          break;
        case "error":
          setErrorMsg(msg.message);
          setTimeout(() => setErrorMsg(""), 5000);
          break;
        case "macro_result":
          setMacroResult({
            name: msg.name,
            success: msg.success,
            message: msg.message,
          });
          break;
      }
    };

    return () => ws.close();
  }, [connConfig]);

  // ③服务器配置：Tauri 控制面 invoke 读本地 settings.json（不依赖 WS 运行）
  useEffect(() => {
    if (!isTauri()) return;
    tauriInvoke<SrvSettings>("get_settings")
      .then(setSrvSettings)
      .catch(() => {});
  }, []);

  // 点端口 → 弹配置对话框（pendingPort）；确认后才真正 open
  const confirmOpen = (config: SerialConfig) => {
    if (!pendingPort) return;
    saveConfig(config);
    wsRef.current?.send(
      JSON.stringify({ action: "open", port: pendingPort, config })
    );
    setPendingPort(null);
  };

  const closePort = (port: string) => {
    wsRef.current?.send(JSON.stringify({ action: "close", port }));
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
    wsRef.current?.send(
      JSON.stringify({ action: "run_macro", name, port: activePort })
    );
  };

  // ④宏管理
  const openMacroEditor = (name: string | null) => {
    if (name && macros[name]) {
      setEditing({ name, isNew: false });
      setEditorName(name);
      setEditorJson(JSON.stringify(macros[name], null, 2));
    } else {
      setEditing({ name: "", isNew: true });
      setEditorName("");
      setEditorJson(
        JSON.stringify(
          { description: "", steps: [{ type: "send", data: "" }] },
          null,
          2
        )
      );
    }
    setJsonError("");
  };

  const saveMacroDef = () => {
    const trimmedName = editorName.trim();
    if (!trimmedName) {
      setJsonError("宏名不能为空");
      return;
    }
    let parsed: Macro;
    try {
      parsed = JSON.parse(editorJson);
    } catch (e) {
      setJsonError("JSON 解析失败: " + (e as Error).message);
      return;
    }
    wsRef.current?.send(
      JSON.stringify({ action: "save_macro", name: trimmedName, macro: parsed })
    );
    setEditing(null);
  };

  const deleteMacro = (name: string) => {
    if (!confirm(`删除宏 "${name}"？`)) return;
    wsRef.current?.send(JSON.stringify({ action: "delete_macro", name }));
    setEditing(null);
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
        <p style={{ fontSize: 13 }}>
          状态: {connected ? "🟢 已连接" : "🔴 未连接"} ({connConfig.host}:{connConfig.port})
        </p>

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
              wsRef={wsRef}
              active={port === activePort}
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
          showServer={isTauri()}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {/* ④宏编辑器 */}
      {editing && (
        <MacroEditor
          name={editorName}
          json={editorJson}
          error={jsonError}
          isNew={editing.isNew}
          onName={setEditorName}
          onJson={setEditorJson}
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
  wsRef,
  active,
  onReady,
}: {
  port: string;
  wsRef: React.RefObject<WebSocket | null>;
  active: boolean;
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
      wsRef.current?.send(
        JSON.stringify({ action: "write", port, data, encoding: "text" })
      );
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
      onClick={onCancel}
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
  return { host: location.hostname || "localhost", port: 8080 };
}
function saveConn(c: ConnConfig) {
  try {
    localStorage.setItem(CONN_KEY, JSON.stringify(c));
  } catch {
    /* ignore */
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
      onClick={onClose}
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

        {/* (a) 连接配置：前端 → 服务器，应用后立即重连 */}
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
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
            <button onClick={() => onConnChange(conn)} style={btnStyleConfirm}>
              应用并重连
            </button>
          </div>
          <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>
            用于 Web 连远程服务器，或 Tauri 连非默认端口
          </div>
        </div>

        {/* (b) 服务器监听配置（仅 Tauri 桌面）：invoke apply_settings 保存 + 热重启 */}
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
                  <span style={{ color: "#7ee787", fontSize: 11 }}>
                    已应用，服务已重启
                  </span>
                )}
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
              <div style={{ fontSize: 11, color: "#ff7b72", marginTop: 4 }}>
                ⚠ 应用后服务热重启，串口连接保留
              </div>
            </>
          ) : (
            <div style={{ color: "#888" }}>加载中…</div>
          )}
        </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={onClose} style={btnStyleCancel}>
            关闭
          </button>
        </div>
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

function MacroEditor({
  name,
  json,
  error,
  isNew,
  onName,
  onJson,
  onSave,
  onDelete,
  onCancel,
}: {
  name: string;
  json: string;
  error: string;
  isNew: boolean;
  onName: (s: string) => void;
  onJson: (s: string) => void;
  onSave: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      onClick={onCancel}
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
          width: 480,
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
        <div style={{ marginBottom: 8 }}>
          <div style={{ color: "#888", marginBottom: 4 }}>
            JSON（description + steps）
          </div>
          <textarea
            value={json}
            onChange={(e) => onJson(e.target.value)}
            style={{ ...textareaStyle, width: "100%", height: 240 }}
            spellCheck={false}
          />
        </div>
        {error && (
          <div style={{ color: "#ff7b72", fontSize: 12, marginBottom: 8 }}>
            ⚠ {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <div>
            {!isNew && (
              <button onClick={onDelete} style={btnStyleCancel}>
                🗑 删除
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onCancel} style={btnStyleCancel}>
              取消
            </button>
            <button onClick={onSave} style={btnStyleConfirm}>
              保存
            </button>
          </div>
        </div>
        <div style={{ fontSize: 11, color: "#888", marginTop: 8 }}>
          steps 类型：send(data/format/auto_newline)、delay(ms)、expect(pattern/timeout_ms)、clear
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
