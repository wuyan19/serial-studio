/** 终端页：端口选择 → （串口）参数对话框 / （SSH）直开 → xterm 标签页。
 * 数据回流：WS 二进制帧按端口键路由到各 tab 的 TermHandle（此前缺失，终端空白）。
 * 回调全部 useCallback 稳定 + TermView 内部再 ref 化——双保险防 xterm 重建风暴。
 * SSH 失败闭环抄 serial-studio：auth_failed 重输密码、host_key_* 指纹确认。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, channelPortKey, type Device, type PortView } from "../api";
import { ws } from "../ws";
import { useShell } from "../App";
import TermView, { type TermHandle } from "../components/term";
import { SerialConfigDialog, SshAuthDialog, SshTrustDialog } from "../components/dialogs";
import { DEFAULT_SERIAL_CONFIG, type SerialConfig, type SshHost, type SshOpenError } from "../types";

interface Tab {
  port: string;
  label: string;
}

export default function Terminal() {
  const [params] = useSearchParams();
  const { sshHosts, openDialog } = useShell();
  const [devices, setDevices] = useState<Device[]>([]);
  const [ports, setPorts] = useState<PortView[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [pendingSerial, setPendingSerial] = useState<PortView | null>(null);
  const [sshFail, setSshFail] = useState<{ port: string; host: SshHost | undefined; error: SshOpenError } | null>(null);
  const [lastError, setLastError] = useState("");
  const handles = useRef(new Map<string, TermHandle>());
  const [connLost, setConnLost] = useState(false);

  useEffect(() => {
    const offPorts = ws.on("ports", setPorts);
    // 数据回流：二进制帧 → 对应 tab 的 xterm（此前缺失，终端永远空白）
    const offData = ws.on("data", (port, data) => handles.current.get(port)?.write(data));
    const offClosed = ws.on("closed", (port) => {
      setTabs((ts) => ts.filter((t) => t.port !== port));
      handles.current.delete(port);
    });
    const offConn = ws.on("connected", (on) => setConnLost(!on));
    api.devices().then(setDevices).catch(() => {});
    return () => {
      offPorts();
      offData();
      offClosed();
      offConn();
    };
  }, []);

  const addTab = useCallback((port: string, label: string) => {
    setTabs((ts) => (ts.some((t) => t.port === port) ? ts : [...ts, { port, label }]));
    setActive(port);
  }, []);

  const openPort = useCallback(
    async (p: PortView, config?: SerialConfig) => {
      setLastError(`正在打开 ${p.name} …（SSH 建连可能数秒）`);
      try {
        const r = await ws.open(p.name, config as unknown as Record<string, unknown>);
        setLastError("");
        addTab(r.port, p.alias ? `${p.alias}（${p.name}）` : p.name);
      } catch (e) {
        const err = e as Error & { ssh?: SshOpenError };
        if (err.ssh) {
          setLastError("");
          const hostId = p.name.split("::")[0];
          setSshFail({ port: p.name, host: sshHosts.find((h) => h.id === hostId), error: err.ssh });
          return;
        }
        // 非 SSH 失败必须可见（此前只 console.warn，用户无从得知"为什么没反应"）
        setLastError(`打开 ${p.name} 失败：${err.message}`);
      }
    },
    [addTab, sshHosts],
  );

  // 入口：?open=PORT（设备通道/设备库双击直达）→ 按类别走串口参数或直开
  const bootRef = useRef(false);
  useEffect(() => {
    if (bootRef.current) return;
    const target = params.get("open");
    if (!target) return;
    bootRef.current = true;
    const tryOpen = (list: PortView[]) => {
      const p = list.find((x) => x.name === target);
      if (!p) return;
      if (p.kind === "serial") setPendingSerial(p);
      else void openPort(p);
    };
    if (ports.length > 0) tryOpen(ports);
    else api.ports().then(tryOpen).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, ports]);

  const startOpen = (p: PortView) => {
    setPicker(false);
    if (p.kind === "serial" && !p.opened) setPendingSerial(p);
    else void openPort(p);
  };

  const closeTab = (port: string) => {
    ws.close(port);
    handles.current.delete(port);
    setTabs((ts) => {
      const next = ts.filter((t) => t.port !== port);
      setActive((a) => (a === port ? (next.at(-1)?.port ?? null) : a));
      return next;
    });
  };

  // TermView 回调：稳定引用（TermView 内部还有 ref 兜底，这里防的是父渲染扩散）
  const handleWrite = useCallback((port: string, data: string) => ws.write(port, data), []);
  const handleResize = useCallback(
    (port: string, cols: number, rows: number) => ws.resize(port, cols, rows),
    [],
  );
  const handleReady = useCallback((port: string, h: TermHandle) => {
    handles.current.set(port, h);
    h.focus();
  }, []);

  /** SSH 认证闭环：重输密码。协议无"仅本次密码"通道——勾选更新（默认）落库后
   *  重开必成；不勾选则按旧记录重试（旧密码错时会再弹本框，用户自然勾上）。 */
  const retryWithPassword = (password: string, updateSaved: boolean) => {
    const fail = sshFail;
    setSshFail(null);
    if (!fail?.host) return;
    if (updateSaved) {
      ws.sshSave(
        sshHosts.map((h) =>
          h.id === fail.host!.id ? { ...h, auth: { type: "password", password } } : h,
        ),
      );
    }
    const p =
      ports.find((x) => x.name === fail.port) ??
      ({ name: fail.port, opened: false, holders: 0 } as PortView);
    void openPort(p);
  };

  const trustAndReopen = () => {
    const fail = sshFail;
    setSshFail(null);
    if (!fail?.host) return;
    ws.sshTrustHost(fail.host.id);
    const p = ports.find((x) => x.name === fail.port);
    if (p) void openPort(p);
  };

  return (
    <section className="page page--fill">
      <div className="page-head">
        <h1>终端</h1>
        <div className="row-actions">
          {connLost && <span className="error">连接断开，重连中…</span>}
          <button className="btn btn--primary" onClick={() => setPicker(true)}>
            打开端口
          </button>
        </div>
      </div>

      {lastError && (
        <p className="error" style={{ marginTop: -6 }}>
          {lastError}{" "}
          <button className="link" onClick={() => setLastError("")}>
            关闭
          </button>
        </p>
      )}

      {tabs.length === 0 ? (
        <div className="term-blank">
          <p className="muted">尚无终端。点「打开端口」或到设备页的通道行开终端。</p>
        </div>
      ) : (
        <div className="term-tabs">
          <div className="term-tabbar">
            {tabs.map((t) => (
              <button
                key={t.port}
                className={`term-tab${active === t.port ? " term-tab--active" : ""}`}
                onClick={() => {
                  setActive(t.port);
                  handles.current.get(t.port)?.focus();
                }}
                title={t.port}
              >
                <span className="term-tab__label">{t.label}</span>
                <span
                  className="term-tab__close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.port);
                  }}
                >
                  ×
                </span>
              </button>
            ))}
          </div>
          <div className="term-area">
            {tabs.map((t) => (
              <div key={t.port} className="term-pane" style={{ display: active === t.port ? "block" : "none" }}>
                <TermView
                  port={t.port}
                  onWrite={handleWrite}
                  onResize={handleResize}
                  onReady={(h) => handleReady(t.port, h)}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {picker && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setPicker(false)}>
          <div className="dialog dialog--med" role="dialog" aria-modal="true" aria-label="打开终端" onClick={(e) => e.stopPropagation()}>
            <h3 className="dialog__title">打开终端</h3>
            <div className="port-picker">
              <p className="dialog__hint">设备通道（被测设备注册表）</p>
              {devices.length === 0 && (
                <p className="dialog__hint">暂无被测设备（设备页注册，或直接用下方裸端口）。</p>
              )}
              {devices.flatMap((d) =>
                d.channels.map((c, i) => (
                  <button
                    key={`${d.id}-${i}`}
                    className="port-picker__item"
                    onClick={() => {
                      const key = channelPortKey(c);
                      const p = ports.find((x) => x.name === key);
                      setPicker(false);
                      if (p) startOpen(p);
                      else void openPort({ name: key, opened: false, holders: 0 } as PortView);
                    }}
                    title={channelPortKey(c)}
                  >
                    <span>
                      {d.name} · {c.type === "serial" ? `串口 ${c.port}` : "SSH"}
                    </span>
                    <span className="muted mono">{channelPortKey(c)}</span>
                  </button>
                )),
              )}
              <p className="dialog__hint" style={{ marginTop: 10 }}>
                裸端口（未注册设备）
              </p>
              {ports
                .filter((p) => p.kind !== "ssh" || p.instance == null)
                .map((p) => (
                  <button key={p.name} className="port-picker__item" onClick={() => startOpen(p)} title={p.name}>
                    <span>{p.alias ? `${p.alias}（${p.name}）` : p.name}</span>
                    <span className="muted">{p.opened ? `已开 · ${p.holders} 人` : p.device?.label ?? ""}</span>
                  </button>
                ))}
            </div>
          </div>
        </div>
      )}

      {pendingSerial && (
        <SerialConfigDialog
          key={pendingSerial.name}
          port={pendingSerial.name}
          config={DEFAULT_SERIAL_CONFIG}
          initialAlias={pendingSerial.alias ?? ""}
          onChange={() => {}}
          onConfirm={(c) => {
            const p = pendingSerial;
            setPendingSerial(null);
            void openPort(p, c);
          }}
          onCancel={() => setPendingSerial(null)}
        />
      )}

      {sshFail?.error.kind === "auth_failed" && sshFail.host && (
        <SshAuthDialog
          host={sshFail.host}
          onRetryPassword={retryWithPassword}
          onEdit={() => {
            setSshFail(null);
            openDialog("ssh");
          }}
          onCancel={() => setSshFail(null)}
        />
      )}
      {(sshFail?.error.kind === "host_key_unknown" || sshFail?.error.kind === "host_key_changed") && sshFail.host && (
        <SshTrustDialog
          host={sshFail.host}
          error={sshFail.error as Extract<SshOpenError, { kind: "host_key_unknown" | "host_key_changed" }>}
          onTrust={trustAndReopen}
          onCancel={() => setSshFail(null)}
        />
      )}
    </section>
  );
}
