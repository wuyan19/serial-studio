import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type {
  ConnConfig,
  Macro,
  MacroStep,
  SerialConfig,
  SrvSettings,
  StepType,
  TermInstance,
} from "./types";
import {
  addStepBtnStyle,
  BAUD_RATES,
  btnStyleCancel,
  btnStyleConfirm,
  inputStyle,
  miniBtn,
  selectStyle,
  textareaStyle,
} from "./lib";

// ===== 通用 =====

export function ConfigRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
      <span style={{ minWidth: 72, color: "#888", whiteSpace: "nowrap", flexShrink: 0 }}>{label}</span>
      {children}
    </div>
  );
}

// ===== 终端视图 =====

export function TermView({
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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const term = new Terminal();
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fitRef.current = fit;
    onReady({ term, fit });
    const disposable = term.onData((data) => onWrite(port, data));
    const timer = setTimeout(() => {
      try { fit.fit(); term.focus(); } catch { /* 容器未可见 */ }
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

  useEffect(() => {
    if (active && fitRef.current) {
      const timer = setTimeout(() => {
        try { fitRef.current?.fit(); } catch { /* ignore */ }
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const onResize = () => {
      try { fitRef.current?.fit(); } catch { /* ignore */ }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [active]);

  return (
    <div
      ref={containerRef}
      style={{ position: "absolute", inset: 0, display: active ? "block" : "none" }}
    />
  );
}

// ===== 串口配置对话框 =====

export function SerialConfigDialog({
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
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#1e1e1e", color: "#ddd", border: "1px solid #444", borderRadius: 6, padding: 16, minWidth: 320, fontSize: 13 }}>
        <h3 style={{ marginTop: 0, marginBottom: 12 }}>打开 {port}</h3>
        <ConfigRow label="波特率">
          <select value={config.baud_rate} onChange={(e) => onChange({ ...config, baud_rate: Number(e.target.value) })} style={selectStyle}>
            {BAUD_RATES.map((b) => (<option key={b} value={b}>{b}</option>))}
          </select>
        </ConfigRow>
        <ConfigRow label="数据位">
          <select value={config.data_bits} onChange={(e) => onChange({ ...config, data_bits: e.target.value })} style={selectStyle}>
            <option value="eight">8</option><option value="seven">7</option><option value="six">6</option><option value="five">5</option>
          </select>
        </ConfigRow>
        <ConfigRow label="停止位">
          <select value={config.stop_bits} onChange={(e) => onChange({ ...config, stop_bits: e.target.value })} style={selectStyle}>
            <option value="one">1</option><option value="two">2</option>
          </select>
        </ConfigRow>
        <ConfigRow label="校验">
          <select value={config.parity} onChange={(e) => onChange({ ...config, parity: e.target.value })} style={selectStyle}>
            <option value="none">None</option><option value="odd">Odd</option><option value="even">Even</option>
          </select>
        </ConfigRow>
        <ConfigRow label="流控">
          <select value={config.flow_control} onChange={(e) => onChange({ ...config, flow_control: e.target.value })} style={selectStyle}>
            <option value="none">None</option><option value="software">Software (XON/XOFF)</option><option value="hardware">Hardware (RTS/CTS)</option>
          </select>
        </ConfigRow>
        <ConfigRow label="换行符">
          <select value={config.line_ending} onChange={(e) => onChange({ ...config, line_ending: e.target.value })} style={selectStyle}>
            <option value="crlf">CRLF (\r\n) — Windows/AT</option><option value="lf">LF (\n) — Linux/Unix</option><option value="cr">CR (\r)</option>
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

// ===== 设置面板 =====

export function SettingsPanel({
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

  useEffect(() => { setSrv(srvSettings); }, [srvSettings]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#1e1e1e", color: "#ddd", border: "1px solid #444", borderRadius: 6, padding: 16, minWidth: 360, fontSize: 13, maxHeight: "80vh", overflowY: "auto" }}>
        <h3 style={{ marginTop: 0, marginBottom: 12 }}>⚙ 设置</h3>

        {!showServer && (
        <div style={{ marginBottom: 16, borderBottom: "1px solid #333", paddingBottom: 12 }}>
          <div style={{ fontWeight: "bold", marginBottom: 8 }}>连接（前端 → 服务器）</div>
          <ConfigRow label="主机">
            <input value={conn.host} onChange={(e) => setConn({ ...conn, host: e.target.value })} style={inputStyle} />
          </ConfigRow>
          <ConfigRow label="端口">
            <input type="number" value={conn.port} onChange={(e) => setConn({ ...conn, port: Number(e.target.value) })} style={inputStyle} />
          </ConfigRow>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8, gap: 8 }}>
            <button onClick={onClose} style={btnStyleCancel}>关闭</button>
            <button onClick={() => onConnChange(conn)} style={btnStyleConfirm}>应用并重连</button>
          </div>
          <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>改连别的远程 Serial Studio 服务</div>
        </div>
        )}

        {showServer && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontWeight: "bold", marginBottom: 8 }}>服务器监听（热重启生效）</div>
          {srv ? (
            <>
              <ConfigRow label="监听地址">
                <input value={srv.ws_host} onChange={(e) => setSrv({ ...srv, ws_host: e.target.value })} style={inputStyle} />
              </ConfigRow>
              <ConfigRow label="WS 端口">
                <input type="number" value={srv.ws_port} onChange={(e) => setSrv({ ...srv, ws_port: Number(e.target.value) })} style={inputStyle} />
              </ConfigRow>
              <ConfigRow label="Telnet 端口">
                <input type="number" value={srv.telnet_port} onChange={(e) => setSrv({ ...srv, telnet_port: Number(e.target.value) })} style={inputStyle} />
              </ConfigRow>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8, gap: 8, alignItems: "center" }}>
                {saved && (<span style={{ color: "#7ee787", fontSize: 11 }}>已应用</span>)}
                <button onClick={onClose} style={btnStyleCancel}>关闭</button>
                <button onClick={() => { onSaveSrv(srv); setSaved(true); setTimeout(() => setSaved(false), 3000); }} style={btnStyleConfirm}>应用</button>
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

// ===== 宏编辑器 =====

export function newStep(type: StepType): MacroStep {
  switch (type) {
    case "send": return { type: "send", data: "", format: "text", auto_newline: true };
    case "delay": return { type: "delay", ms: 500 };
    case "expect": return { type: "expect", pattern: "", timeout_ms: 3000 };
    case "clear": return { type: "clear" };
  }
}

export function validateMacro(m: Macro): string | null {
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

const stepIcon: Record<StepType, string> = { send: "→", delay: "⏱", expect: "⏳", clear: "✕" };

export function MacroEditor({
  name, macro, error, isNew, onName, onMacroChange, onSave, onDelete, onCancel,
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
  const addStep = (type: StepType) => onMacroChange({ ...macro, steps: [...macro.steps, newStep(type)] });
  const removeStep = (i: number) => onMacroChange({ ...macro, steps: macro.steps.filter((_, j) => j !== i) });
  const moveStep = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= macro.steps.length) return;
    const steps = macro.steps.slice();
    [steps[i], steps[j]] = [steps[j], steps[i]];
    onMacroChange({ ...macro, steps });
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#1e1e1e", color: "#ddd", border: "1px solid #444", borderRadius: 6, padding: 16, width: 560, maxWidth: "90vw", fontSize: 13, maxHeight: "85vh", overflowY: "auto" }}>
        <h3 style={{ marginTop: 0, marginBottom: 12 }}>{isNew ? "新增宏" : `编辑 ${name}`}</h3>
        <ConfigRow label="名称">
          <input value={name} onChange={(e) => onName(e.target.value)} disabled={!isNew} style={{ ...inputStyle, opacity: isNew ? 1 : 0.5 }} />
        </ConfigRow>
        <ConfigRow label="描述">
          <input value={macro.description ?? ""} onChange={(e) => setDesc(e.target.value)} placeholder="可选" style={inputStyle} />
        </ConfigRow>
        <div style={{ color: "#888", marginBottom: 6, marginTop: 4 }}>步骤</div>
        {macro.steps.length === 0 && (<p style={{ color: "#888", fontSize: 12 }}>无步骤（点下方添加）</p>)}
        {macro.steps.map((s, i) => (
          <StepEditor key={i} step={s} index={i} total={macro.steps.length}
            onChange={(ns) => setStep(i, ns)} onRemove={() => removeStep(i)}
            onMoveUp={() => moveStep(i, -1)} onMoveDown={() => moveStep(i, 1)} />
        ))}
        <div style={{ display: "flex", gap: 6, margin: "8px 0 12px", flexWrap: "wrap" }}>
          <button onClick={() => addStep("send")} style={addStepBtnStyle}>＋ 发送</button>
          <button onClick={() => addStep("delay")} style={addStepBtnStyle}>＋ 延时</button>
          <button onClick={() => addStep("expect")} style={addStepBtnStyle}>＋ 等待</button>
          <button onClick={() => addStep("clear")} style={addStepBtnStyle}>＋ 清空</button>
        </div>
        {error && (<div style={{ color: "#ff7b72", fontSize: 12, marginBottom: 8 }}>⚠ {error}</div>)}
        <details style={{ marginBottom: 8 }}>
          <summary style={{ cursor: "pointer", color: "#888" }}>JSON 预览（只读）</summary>
          <pre style={{ ...textareaStyle, margin: "6px 0 0", padding: 8, maxHeight: 160, overflow: "auto", whiteSpace: "pre-wrap" }}>
            {JSON.stringify(macro, null, 2)}
          </pre>
        </details>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <div>{!isNew && (<button onClick={onDelete} style={btnStyleCancel}>🗑 删除</button>)}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onCancel} style={btnStyleCancel}>取消</button>
            <button onClick={onSave} style={btnStyleConfirm}>保存</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StepEditor({
  step, index, total, onChange, onRemove, onMoveUp, onMoveDown,
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
    onChange(newStep(type));
  };

  return (
    <div style={{ border: "1px solid #3a3a3a", borderRadius: 4, padding: 8, marginBottom: 6, background: "#252525" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span style={{ color: "#888", width: 18, textAlign: "center" }}>{stepIcon[step.type]}</span>
        <span style={{ color: "#888", fontSize: 11 }}>#{index + 1}</span>
        <select value={step.type} onChange={(e) => changeType(e.target.value as StepType)} style={{ ...selectStyle, flex: "0 0 auto", width: 80 }}>
          <option value="send">发送</option><option value="delay">延时</option><option value="expect">等待</option><option value="clear">清空</option>
        </select>
        <div style={{ flex: 1 }} />
        <button onClick={onMoveUp} disabled={index === 0} title="上移" style={{ ...miniBtn, opacity: index === 0 ? 0.3 : 1 }}>↑</button>
        <button onClick={onMoveDown} disabled={index === total - 1} title="下移" style={{ ...miniBtn, opacity: index === total - 1 ? 0.3 : 1 }}>↓</button>
        <button onClick={onRemove} title="删除" style={{ ...miniBtn, color: "#ff7b72" }}>✕</button>
      </div>
      <div style={{ paddingLeft: 24 }}>
        {step.type === "send" && (
          <>
            <textarea value={step.data} onChange={(e) => onChange({ ...step, data: e.target.value })} placeholder="发送内容" rows={1} style={{ ...textareaStyle, width: "100%", minHeight: 28 }} />
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4, flexWrap: "wrap" }}>
              <label style={{ color: "#888", fontSize: 12 }}>
                格式
                <select value={step.format} onChange={(e) => onChange({ ...step, format: e.target.value })} style={{ ...selectStyle, marginLeft: 6, flex: "0 0 auto", width: 72 }}>
                  <option value="text">text</option><option value="hex">hex</option>
                </select>
              </label>
              <label style={{ color: "#888", fontSize: 12, cursor: "pointer" }}>
                <input type="checkbox" checked={step.auto_newline} onChange={(e) => onChange({ ...step, auto_newline: e.target.checked })} style={{ marginRight: 4 }} />
                自动换行（按端口设置）
              </label>
            </div>
          </>
        )}
        {step.type === "delay" && (
          <label style={{ color: "#888", fontSize: 12 }}>
            等待
            <input type="number" value={step.ms} onChange={(e) => onChange({ ...step, ms: Number(e.target.value) })} min={1} style={{ ...inputStyle, display: "inline-block", width: 80, margin: "0 6px" }} />
            毫秒
          </label>
        )}
        {step.type === "expect" && (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
            <label style={{ color: "#888", fontSize: 12, flex: 1, minWidth: 120 }}>
              等待匹配
              <input value={step.pattern} onChange={(e) => onChange({ ...step, pattern: e.target.value })} placeholder="正则 / 子串" style={{ ...inputStyle, display: "block", marginTop: 2 }} />
            </label>
            <label style={{ color: "#888", fontSize: 12 }}>
              超时
              <input type="number" value={step.timeout_ms} onChange={(e) => onChange({ ...step, timeout_ms: Number(e.target.value) })} min={1} style={{ ...inputStyle, display: "inline-block", width: 70, margin: "0 6px" }} />
              ms
            </label>
          </div>
        )}
        {step.type === "clear" && (<div style={{ color: "#888", fontSize: 12 }}>清空接收缓冲区</div>)}
      </div>
    </div>
  );
}

// ===== 活动栏 / 关于 / 远程 =====

export function ActivityIcon({ icon, title, active, onClick }: { icon: string; title: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} title={title}
      style={{ width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, background: "transparent", color: active ? "#fff" : "#888", border: "none", borderLeft: active ? "2px solid #fff" : "2px solid transparent", cursor: "pointer", boxSizing: "border-box" }}>
      {icon}
    </button>
  );
}

export function AboutDialog({ version, onClose }: { version: string; onClose: () => void }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div style={{ background: "#1e1e1e", color: "#ddd", border: "1px solid #444", borderRadius: 6, padding: 24, width: 360, maxWidth: "90vw", textAlign: "center" }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>🔌</div>
        <h3 style={{ margin: "0 0 4px" }}>Serial Studio</h3>
        <p style={{ color: "#888", margin: "0 0 16px", fontSize: 13 }}>版本 {version || "..."}</p>
        <p style={{ color: "#aaa", fontSize: 13, lineHeight: 1.6, marginBottom: 16 }}>
          多形态串口通信工具<br />本地/远程双模式 · Tauri + WebSocket
        </p>
        <button onClick={onClose} style={btnStyleConfirm}>关闭</button>
      </div>
    </div>
  );
}

export function RemoteDialog({ input, onChange, onConfirm, onCancel }: {
  input: { host: string; port: number };
  onChange: (v: { host: string; port: number }) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div style={{ background: "#1e1e1e", color: "#ddd", border: "1px solid #444", borderRadius: 6, padding: 16, width: 380, maxWidth: "90vw", fontSize: 13 }}>
        <h3 style={{ marginTop: 0, marginBottom: 12 }}>🌐 打开远程窗口</h3>
        <ConfigRow label="地址">
          <input value={input.host} onChange={(e) => onChange({ ...input, host: e.target.value })} placeholder="192.168.1.50" style={inputStyle} autoFocus />
        </ConfigRow>
        <ConfigRow label="端口">
          <input type="number" value={input.port} onChange={(e) => onChange({ ...input, port: Number(e.target.value) })} style={inputStyle} />
        </ConfigRow>
        <p style={{ fontSize: 11, color: "#888", margin: "8px 0" }}>将在新窗口连接远程 Serial Studio 服务，本地窗口保留。</p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onCancel} style={btnStyleCancel}>取消</button>
          <button onClick={onConfirm} style={btnStyleConfirm}>连接</button>
        </div>
      </div>
    </div>
  );
}
