import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
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
  getRemoteFromUrl,
  initConn,
  isTauri,
  loadConfig,
  loadMacrosLocal,
  persistMacros,
  saveConfig,
  saveConn,
  tauriInvoke,
  addStepBtnStyle,
} from "./lib";
import { LocalTransport, RemoteTransport, type Transport } from "./transport";
import {
  AboutDialog,
  ActivityIcon,
  MacroEditor,
  newStep,
  RemoteDialog,
  SerialConfigDialog,
  SettingsPanel,
  TermView,
  validateMacro,
} from "./components";

/**
 * Serial Studio 前端主组件（Tauri 与浏览器共用）。
 * 数据面走 Transport（本地 IPC / 远程 WS），控制面走 Tauri invoke。
 * VS Code 风布局：活动栏 + 可收起次侧栏 + 主终端区。
 */
export default function App() {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [macros, setMacros] = useState<Record<string, Macro>>({});
  const [macroResult, setMacroResult] = useState<MacroResult | null>(null);
  const [connected, setConnected] = useState(false);
  const [openPorts, setOpenPorts] = useState<string[]>([]);
  const [activePort, setActivePort] = useState("");
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
  const [portDialogOpen, setPortDialogOpen] = useState(false);
  const [manageMenu, setManageMenu] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [version, setVersion] = useState("");

  const transportRef = useRef<Transport | null>(null);
  const terminalsRef = useRef<Map<string, TermInstance>>(new Map());
  const activeRef = useRef("");
  activeRef.current = activePort;

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
        const inst = terminalsRef.current.get(port);
        if (inst) inst.term.write(data);
      }),
      t.onPortOpened(() => { t.list().then(setPorts); }),
      t.onPortClosed((port) => {
        // 端口全局关闭（末位释放/被强制关闭）：清掉本会话的标签和终端
        setOpenPorts((prev) => {
          const rest = prev.filter((p) => p !== port);
          if (activeRef.current === port) setActivePort(rest[rest.length - 1] ?? "");
          return rest;
        });
        terminalsRef.current.delete(port);
        t.list().then(setPorts);
      }),
      t.onHolders(() => { t.list().then(setPorts); }),
      t.onError((msg) => { setErrorMsg(msg); setTimeout(() => setErrorMsg(""), 5000); }),
      t.onMacroResult((name, success, message) => setMacroResult({ name, success, message })),
    ];
    return () => { unsubs.forEach((fn) => fn()); t.dispose(); };
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
      import("@tauri-apps/api/app").then(({ getVersion }) => getVersion()).then(setVersion).catch(() => {});
    }
  }, []);

  const confirmOpen = async (config: SerialConfig) => {
    const port = pendingPort;
    if (!port) return;
    saveConfig(config);
    setPendingPort(null);
    try {
      const res = await transportRef.current?.open(port, config);
      if (!res) return;
      // 成功占有（首开或附加）：创建本会话的终端标签
      setOpenPorts((prev) => (prev.includes(port) ? prev : [...prev, port]));
      setActivePort(port);
      if (!res.opened) {
        // 附加到已开端口：请求的 config 被忽略，告知用户实际配置
        const c = res.config;
        setNotice(`已加入 ${res.port}（当前 ${res.holders} 人在线）。端口实际配置为 ${c.baud_rate} 波特、换行 ${c.line_ending.toUpperCase()}；你填的配置已忽略。`);
        setTimeout(() => setNotice(""), 6000);
      }
    } catch (e) {
      setErrorMsg(String(e));
      setTimeout(() => setErrorMsg(""), 5000);
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
  };

  const forceClosePort = (port: string) => {
    if (!confirm(`强制关闭 ${port}？将断开所有持有者。`)) return;
    transportRef.current?.forceClose(port);
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
    if (!trimmedName) { setEditorError("宏名不能为空"); return; }
    const err = validateMacro(editorMacro);
    if (err) { setEditorError(err); return; }
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
      {/* 活动栏（VS Code 风）：48px 窄竖条 */}
      <div style={{ width: 48, background: "#181818", borderRight: "1px solid #2a2a2a", display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 8, gap: 4, flexShrink: 0 }}>
        <ActivityIcon icon="🔌" title="串口" active={activity === "ports"} onClick={() => setActivity(activity === "ports" ? null : "ports")} />
        <ActivityIcon icon="⚡" title="宏" active={activity === "macros"} onClick={() => setActivity(activity === "macros" ? null : "macros")} />
        <div style={{ flex: 1 }} />
        {isTauri() && (<ActivityIcon icon="🌐" title="打开远程窗口" active={false} onClick={() => setRemoteOpen(true)} />)}
        <div style={{ position: "relative" }}>
          <ActivityIcon icon="⚙" title="管理" active={manageMenu} onClick={() => setManageMenu(!manageMenu)} />
          {manageMenu && (
            <div style={{ position: "absolute", bottom: 0, left: 52, background: "#2d2d2d", border: "1px solid #444", borderRadius: 4, padding: 4, minWidth: 100, zIndex: 200, boxShadow: "0 4px 12px rgba(0,0,0,0.5)" }}>
              <button onClick={() => { setSettingsOpen(true); setManageMenu(false); }} style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 10px", background: "transparent", color: "#ddd", border: "none", cursor: "pointer", fontSize: 13, borderRadius: 3 }}>⚙ 设置</button>
              <button onClick={() => { setAboutOpen(true); setManageMenu(false); }} style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 10px", background: "transparent", color: "#ddd", border: "none", cursor: "pointer", fontSize: 13, borderRadius: 3 }}>ℹ 关于</button>
            </div>
          )}
        </div>
      </div>

      {/* 次侧栏：当前活动项内容，收起时不占位 */}
      {activity && (
        <aside style={{ width: 240, borderRight: "1px solid #333", padding: 12, background: "#1e1e1e", color: "#ddd", boxSizing: "border-box", overflowY: "auto", display: "flex", flexDirection: "column" }}>
          {(!isTauri() || isRemote) && (
            <p style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>
              {isRemote ? "🔗 远程" : "🌐 Web"} · {connected ? "🟢 已连接" : "🔴 未连接"} ({connConfig.host}:{connConfig.port})
            </p>
          )}

          {activity === "ports" && (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <h4 style={{ margin: 0 }}>串口</h4>
                <button onClick={() => setPortDialogOpen(true)} title="刷新" style={addStepBtnStyle}>⟳</button>
              </div>
              {ports.length === 0 && (<p style={{ color: "#888", fontSize: 13 }}>无可用端口</p>)}
              {ports.map((p) => {
                const isActive = p.name === activePort;
                return (
                  <div key={p.name} style={{ marginBottom: 6 }}>
                    <button onClick={() => (openPorts.includes(p.name) ? switchPort(p.name) : setPendingPort(p.name))}
                      style={{ width: "100%", textAlign: "left", padding: "6px 8px", background: isActive ? "#0e639c" : "#2d2d2d", color: "#ddd", border: "1px solid #444", cursor: "pointer", borderRadius: 3 }}>
                      {p.opened ? "📂" : "📁"} {p.name}
                      {p.opened && p.holders > 0 && (
                        <span style={{ marginLeft: 6, fontSize: 11, color: "#888" }}>· {p.holders} 人</span>
                      )}
                    </button>
                  </div>
                );
              })}
            </>
          )}

          {activity === "macros" && (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <h4 style={{ margin: 0 }}>宏 {activePort ? `→ ${activePort}` : ""}</h4>
                <button onClick={() => openMacroEditor(null)} title="新增宏" style={{ background: "none", border: "1px solid #444", color: "#ddd", cursor: "pointer", borderRadius: 3, padding: "2px 8px", fontSize: 13 }}>＋</button>
              </div>
              {Object.keys(macros).length === 0 && (<p style={{ color: "#888", fontSize: 13 }}>无宏（点 ＋ 新增）</p>)}
              {Object.entries(macros).map(([name, m]) => (
                <div key={name} style={{ marginBottom: 6 }}>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button onClick={() => runMacro(name)} disabled={!activePort}
                      style={{ flex: 1, textAlign: "left", padding: "6px 8px", background: "#2d2d2d", color: activePort ? "#ddd" : "#666", border: "1px solid #444", cursor: activePort ? "pointer" : "not-allowed", borderRadius: 3, fontSize: 13 }}>
                      ▶ {name}
                      {m.description && (<span style={{ display: "block", fontSize: 11, color: "#888", marginTop: 2 }}>{m.description}</span>)}
                    </button>
                    <button onClick={() => openMacroEditor(name)} title="编辑" style={{ background: "#2d2d2d", color: "#ddd", border: "1px solid #444", cursor: "pointer", borderRadius: 3, padding: "0 6px", fontSize: 13 }}>✎</button>
                    <button onClick={() => deleteMacro(name)} title="删除" style={{ background: "#2d2d2d", color: "#ff7b72", border: "1px solid #444", cursor: "pointer", borderRadius: 3, padding: "0 6px", fontSize: 13 }}>🗑</button>
                  </div>
                </div>
              ))}
              {macroResult && (
                <div style={{ marginTop: 8, padding: 6, fontSize: 11, borderRadius: 3, background: macroResult.success && macroResult.message !== "运行中..." ? "#1a3a1a" : macroResult.message === "运行中..." ? "#2d2d2d" : "#3a1a1a", color: macroResult.success && macroResult.message !== "运行中..." ? "#7ee787" : macroResult.message === "运行中..." ? "#888" : "#ff7b72", wordBreak: "break-all" }}>
                  {macroResult.success ? "✓" : "✗"} {macroResult.name}: {macroResult.message}
                </div>
              )}
            </>
          )}
        </aside>
      )}

      <main style={{ flex: 1, display: "flex", flexDirection: "column", background: "#000", minWidth: 0 }}>
        {/* Tab 栏 */}
        <div style={{ display: "flex", borderBottom: "1px solid #333", background: "#1e1e1e", minHeight: 30, overflowX: "auto" }}>
          {openPorts.length === 0 && (<span style={{ color: "#666", padding: "6px 12px", fontSize: 13 }}>未打开端口</span>)}
          {openPorts.map((port) => {
            const isActive = port === activePort;
            return (
              <div key={port} onClick={() => switchPort(port)}
                style={{ padding: "6px 12px", cursor: "pointer", color: isActive ? "#fff" : "#888", background: isActive ? "#2d2d2d" : "transparent", borderRight: "1px solid #333", fontSize: 13, display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
                <span>📂 {port}</span>
                {isLocal && (
                  <span onClick={(e) => { e.stopPropagation(); forceClosePort(port); }} style={{ color: "#f0883e", cursor: "pointer", padding: "0 4px" }} title={`强制关闭 ${port}（踢掉所有持有者）`}>⚡</span>
                )}
                <span onClick={(e) => { e.stopPropagation(); closePort(port); }} style={{ color: "#ff7b72", cursor: "pointer", padding: "0 4px" }} title={`关闭 ${port}`}>✕</span>
              </div>
            );
          })}
        </div>

        {errorMsg && (<div style={{ padding: "6px 12px", background: "#3a1a1a", color: "#ff7b72", fontSize: 12 }}>⚠ {errorMsg}</div>)}
        {notice && (<div style={{ padding: "6px 12px", background: "#3a3a1a", color: "#d29922", fontSize: 12 }}>ℹ {notice}</div>)}

        {/* 终端区：每个 openPort 一个 TermView，display 切换可见（不销毁） */}
        <div style={{ flex: 1, position: "relative" }}>
          {openPorts.map((port) => (
            <TermView key={port} port={port} active={port === activePort}
              onWrite={(p, data) => transportRef.current?.write(p, data)}
              onReady={(inst) => { if (inst) terminalsRef.current.set(port, inst); else terminalsRef.current.delete(port); }}
            />
          ))}
          {openPorts.length === 0 && (<div style={{ color: "#888", padding: 16 }}>点左侧 🔌 打开串口</div>)}
        </div>
      </main>

      {/* 串口配置对话框 */}
      {pendingPort && (
        <SerialConfigDialog port={pendingPort} config={serialConfig} onChange={setSerialConfig} onConfirm={confirmOpen} onCancel={() => setPendingPort(null)} />
      )}

      {/* 设置面板 */}
      {settingsOpen && (
        <SettingsPanel connConfig={connConfig} srvSettings={srvSettings} showServer={isTauri() && !isRemote}
          onConnChange={(c) => { saveConn(c); setConnConfig(c); }}
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

      {aboutOpen && (<AboutDialog version={version} onClose={() => setAboutOpen(false)} />)}
      {remoteOpen && (<RemoteDialog input={remoteInput} onChange={setRemoteInput} onConfirm={openRemoteWindow} onCancel={() => setRemoteOpen(false)} />)}

      {/* 宏编辑器 */}
      {editing && (
        <MacroEditor name={editorName} macro={editorMacro} error={editorError} isNew={editing.isNew}
          onName={setEditorName} onMacroChange={setEditorMacro} onSave={saveMacroDef}
          onDelete={() => deleteMacro(editing.name)} onCancel={() => setEditing(null)} />
      )}
    </div>
  );
}
