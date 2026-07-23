import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface PortInfo {
  name: string;
  opened: boolean;
}
interface MacroInfo {
  name: string;
  description?: string;
}
interface MacroResult {
  name: string;
  success: boolean;
  message: string;
}

/**
 * Serial Studio 前端（Tauri 与浏览器共用，只走 WS）。
 */
export default function App() {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [macros, setMacros] = useState<MacroInfo[]>([]);
  const [macroResult, setMacroResult] = useState<MacroResult | null>(null);
  const [connected, setConnected] = useState(false);
  const [selectedPort, setSelectedPort] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const selectedRef = useRef("");
  selectedRef.current = selectedPort;

  // WS 连接（只连一次）
  useEffect(() => {
    const host = location.hostname || "localhost";
    const ws = new WebSocket(`ws://${host}:8080/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      ws.send(JSON.stringify({ action: "list_macros" }));
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
        case "data":
          if (msg.port === selectedRef.current && termRef.current) {
            termRef.current.write(hexToBytes(msg.data));
          }
          break;
        case "opened":
        case "closed":
          ws.send(JSON.stringify({ action: "list" }));
          break;
        case "macro_result":
          setMacroResult({ name: msg.name, success: msg.success, message: msg.message });
          break;
      }
    };

    return () => ws.close();
  }, []);

  // 终端初始化（selectedPort 变化时重建）
  useEffect(() => {
    if (!selectedPort) return;
    const container = document.getElementById("term-container");
    if (!container) return;

    const term = new Terminal();
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    term.focus();
    termRef.current = term;

    term.onData((data) => {
      wsRef.current?.send(
        JSON.stringify({ action: "write", port: selectedPort, data, encoding: "text" })
      );
    });

    const onResize = () => fit.fit();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      term.dispose();
      termRef.current = null;
    };
  }, [selectedPort]);

  const openPort = (port: string) => {
    wsRef.current?.send(
      JSON.stringify({ action: "open", port, config: { baud_rate: 115200 } })
    );
    setSelectedPort(port);
  };

  const closePort = () => {
    if (selectedPort) {
      wsRef.current?.send(JSON.stringify({ action: "close", port: selectedPort }));
      setSelectedPort("");
    }
  };

  const runMacro = (name: string) => {
    if (!selectedPort) {
      setMacroResult({ name, success: false, message: "请先选择并打开一个串口" });
      return;
    }
    setMacroResult({ name, success: true, message: "运行中..." });
    wsRef.current?.send(
      JSON.stringify({ action: "run_macro", name, port: selectedPort })
    );
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
        }}
      >
        <h3 style={{ marginTop: 0 }}>🔌 Serial Studio</h3>
        <p style={{ fontSize: 13 }}>状态: {connected ? "🟢 已连接" : "🔴 未连接"}</p>

        <h4 style={{ marginBottom: 8 }}>端口</h4>
        {ports.length === 0 && <p style={{ color: "#888", fontSize: 13 }}>无可用端口</p>}
        {ports.map((p) => (
          <div key={p.name} style={{ marginBottom: 6 }}>
            <button
              onClick={() => !p.opened && openPort(p.name)}
              disabled={p.opened}
              style={{
                width: "100%",
                textAlign: "left",
                padding: "6px 8px",
                background: p.name === selectedPort ? "#0e639c" : "#2d2d2d",
                color: "#ddd",
                border: "1px solid #444",
                cursor: p.opened ? "default" : "pointer",
                borderRadius: 3,
              }}
            >
              {p.opened ? "📂" : "📁"} {p.name}
            </button>
          </div>
        ))}
        {selectedPort && (
          <button
            onClick={closePort}
            style={{
              marginTop: 4,
              marginBottom: 8,
              width: "100%",
              padding: 6,
              background: "#5a1d1d",
              color: "#ddd",
              border: "1px solid #444",
              cursor: "pointer",
              borderRadius: 3,
              fontSize: 12,
            }}
          >
            关闭 {selectedPort}
          </button>
        )}

        {macros.length > 0 && (
          <>
            <h4 style={{ marginTop: 16, marginBottom: 8, borderTop: "1px solid #333", paddingTop: 12 }}>
              ⚡ 宏 {selectedPort ? `→ ${selectedPort}` : ""}
            </h4>
            {macros.map((m) => (
              <div key={m.name} style={{ marginBottom: 6 }}>
                <button
                  onClick={() => runMacro(m.name)}
                  title={m.description}
                  disabled={!selectedPort}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: "6px 8px",
                    background: "#2d2d2d",
                    color: selectedPort ? "#ddd" : "#666",
                    border: "1px solid #444",
                    cursor: selectedPort ? "pointer" : "not-allowed",
                    borderRadius: 3,
                    fontSize: 13,
                  }}
                >
                  ▶ {m.name}
                  {m.description && (
                    <span style={{ display: "block", fontSize: 11, color: "#888", marginTop: 2 }}>
                      {m.description}
                    </span>
                  )}
                </button>
              </div>
            ))}
            {macroResult && (
              <div
                style={{
                  marginTop: 8,
                  padding: 6,
                  fontSize: 11,
                  borderRadius: 3,
                  background: macroResult.success && macroResult.message !== "运行中..."
                    ? "#1a3a1a"
                    : macroResult.message === "运行中..."
                    ? "#2d2d2d"
                    : "#3a1a1a",
                  color: macroResult.success && macroResult.message !== "运行中..."
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
          </>
        )}
      </aside>
      <main style={{ flex: 1, padding: 12, background: "#000", boxSizing: "border-box" }}>
        {selectedPort ? (
          <div id="term-container" style={{ height: "100%" }} />
        ) : (
          <p style={{ color: "#888" }}>← 选择左侧端口开始</p>
        )}
      </main>
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
