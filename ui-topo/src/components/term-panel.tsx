/** 终端面板（壳层右栏，常驻）：终端的唯一宿主。
 *  从旧 /terminal 页整体迁移——面板随壳挂载、切页不卸载，tab 列表与 xterm
 *  回滚缓冲跨页存活（此前切页即丢）。收起 = display:none 保活，展开时
 *  TermView 内置 ResizeObserver 自动重 fit。
 *  外部入口（设备页按钮 / 旧链接 ?open=）经 ShellContext.openTerminal(key)
 *  走 openByKey：设备通道即点即开（串口用通道存储配置），裸串口仍弹参数框。
 *  宽度/开合/最大化持久化 localStorage（首启收起）。 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  api,
  channelPortKey,
  channelSerialConfig,
  sshChannelLabel,
  type Device,
  type PortView,
} from "../api";
import { ws } from "../ws";
import TermView, { type TermHandle } from "./term";
import { SerialConfigDialog, SshAuthDialog, SshTrustDialog } from "./dialogs";
import { IconChevronsRight, IconExpand, IconSsh } from "../icons";
import { DEFAULT_SERIAL_CONFIG, type SerialConfig, type SshHost, type SshOpenError } from "../types";

const STORE_KEY = "topo-hub-term-panel";
const WIDTH_MIN = 320;
const WIDTH_MAX = 720;
const WIDTH_DEFAULT = 480;

interface PanelLayout {
  open: boolean;
  width: number;
  max: boolean;
}

function loadLayout(): PanelLayout {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<PanelLayout>;
      return {
        open: !!v.open,
        width: Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Number(v.width) || WIDTH_DEFAULT)),
        max: !!v.max,
      };
    }
  } catch {
    /* 损坏回退默认 */
  }
  return { open: false, width: WIDTH_DEFAULT, max: false };
}

export interface TermPanelHandle {
  openPanel: () => void;
  togglePanel: () => void;
  openByKey: (key: string) => void;
}

interface Tab {
  port: string;
  label: string;
}

const TermPanel = forwardRef<
  TermPanelHandle,
  { sshHosts: SshHost[]; openSshManager: () => void }
>(function TermPanel({ sshHosts, openSshManager }, ref) {
  const [layout, setLayout] = useState<PanelLayout>(loadLayout);
  const [devices, setDevices] = useState<Device[]>([]);
  const [ports, setPorts] = useState<PortView[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [pendingSerial, setPendingSerial] = useState<PortView | null>(null);
  const [sshFail, setSshFail] = useState<{
    port: string;
    host: SshHost | undefined;
    error: SshOpenError;
  } | null>(null);
  const [lastError, setLastError] = useState("");
  const [connLost, setConnLost] = useState(false);
  const handles = useRef(new Map<string, TermHandle>());

  useEffect(() => {
    localStorage.setItem(STORE_KEY, JSON.stringify(layout));
  }, [layout]);

  useEffect(() => {
    const offPorts = ws.on("ports", setPorts);
    // 数据回流：二进制帧 → 对应 tab 的 xterm
    const offData = ws.on("data", (port, data) => handles.current.get(port)?.write(data));
    const offClosed = ws.on("closed", (port) => {
      setTabs((ts) => ts.filter((t) => t.port !== port));
      handles.current.delete(port);
    });
    const offConn = ws.on("connected", (on) => setConnLost(!on));
    // 初始拉取：WS 首次端口推送在面板挂载前已发生（壳启动即连即推），只靠订阅会漏
    api.ports().then(setPorts).catch(() => {});
    api.devices().then(setDevices).catch(() => {});
    return () => {
      offPorts();
      offData();
      offClosed();
      offConn();
    };
  }, []);

  // 展开时焦点归位活跃终端（收起期间焦点在内容区）
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    if (!layout.open) return;
    const t = setTimeout(() => activeRef.current && handles.current.get(activeRef.current)?.focus(), 60);
    return () => clearTimeout(t);
  }, [layout.open]);

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
        // 非 SSH 失败必须可见（只 console.warn 用户无从得知"为什么没反应"）
        setLastError(`打开 ${p.name} 失败：${err.message}`);
      }
    },
    [addTab, sshHosts],
  );

  /** 统一入口：key = 端口键。设备通道即点即开（串口带通道存储配置），
   *  裸端口按类型走串口参数框或直开。数据未就绪时现拉再试。 */
  const openByKey = useCallback(
    async (key: string) => {
      setLayout((l) => ({ ...l, open: true }));
      let devs = devices;
      let prts = ports;
      if (devs.length === 0 || prts.length === 0) {
        try {
          [devs, prts] = await Promise.all([api.devices(), api.ports()]);
          setDevices(devs);
          setPorts(prts);
        } catch {
          /* 用现有数据走兜底 */
        }
      }
      const hit = devs
        .flatMap((d) => d.channels.map((c) => ({ d, c })))
        .find(({ c }) => channelPortKey(c) === key);
      if (hit) {
        const p = prts.find((x) => x.name === key) ??
          ({ name: key, opened: false, holders: 0 } as PortView);
        if (hit.c.type === "serial") {
          void openPort(p, channelSerialConfig(hit.c) as SerialConfig);
        } else {
          void openPort(p);
        }
        return;
      }
      const p = prts.find((x) => x.name === key);
      if (!p) {
        setLastError(`端口 ${key} 不在位或不存在`);
        return;
      }
      if (p.kind === "serial") setPendingSerial(p);
      else void openPort(p);
    },
    [devices, ports, openPort],
  );

  useImperativeHandle(
    ref,
    () => ({
      openPanel: () => setLayout((l) => ({ ...l, open: true })),
      togglePanel: () => setLayout((l) => ({ ...l, open: !l.open })),
      openByKey: (key: string) => void openByKey(key),
    }),
    [openByKey],
  );

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

  /** 裸端口 = 未归属任何设备通道的端口（与 device.rs Channel::covers 同构：
   *  串口通道精确匹配端口键、SSH 通道按复合键首段匹配）。已注册的走设备通道区。 */
  const barePorts = useMemo(() => {
    const ownedSerial = new Set<string>();
    const ownedSsh = new Set<string>();
    for (const d of devices)
      for (const c of d.channels) {
        if (c.type === "serial" && c.port) ownedSerial.add(c.port.toLowerCase());
        if (c.type === "ssh") ownedSsh.add(c.id);
      }
    return ports.filter(
      (p) =>
        !ownedSerial.has(p.name.toLowerCase()) &&
        !(p.name.includes("::") && ownedSsh.has(p.name.split("::")[0])),
    );
  }, [ports, devices]);

  // TermView 回调：稳定引用（TermView 内部还有 ref 兜底，防 xterm 重建风暴）
  const handleWrite = useCallback((port: string, data: string) => ws.write(port, data), []);
  const handleResize = useCallback(
    (port: string, cols: number, rows: number) => ws.resize(port, cols, rows),
    [],
  );
  const handleReady = useCallback((port: string, h: TermHandle) => {
    handles.current.set(port, h);
    h.focus();
  }, []);

  /** 左缘拖拽调宽（最大化态不拖）。键盘等价：← 加宽 / → 收窄。 */
  const beginResize = (e: React.PointerEvent) => {
    if (e.button !== 0 || layout.max) return;
    const startX = e.clientX;
    const startWidth = layout.width;
    const move = (ev: PointerEvent) => {
      const w = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, startWidth + (startX - ev.clientX)));
      setLayout((l) => ({ ...l, width: w }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("panel-resizing");
    };
    document.body.classList.add("panel-resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const nudgeWidth = (delta: number) => {
    if (layout.max) return;
    setLayout((l) => ({ ...l, width: Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, l.width + delta)) }));
  };

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
    <>
      <aside
        id="term-panel"
        className={
          layout.open
            ? `term-panel${layout.max ? " term-panel--max" : ""}`
            : "term-panel term-panel--hidden"
        }
        style={layout.max ? undefined : { width: layout.width }}
        aria-label="终端"
      >
        {layout.open && !layout.max && (
          <div
            className="term-panel__resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整终端面板宽度"
            tabIndex={0}
            onPointerDown={beginResize}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") {
                e.preventDefault();
                nudgeWidth(24);
              } else if (e.key === "ArrowRight") {
                e.preventDefault();
                nudgeWidth(-24);
              }
            }}
          />
        )}
        <header className="term-panel__head">
          {connLost && (
            <span className="term-panel__conn" title="连接断开，重连中…" role="status" />
          )}
          <div className="term-panel__tabs" role="tablist" aria-label="终端会话">
            {tabs.map((t) => (
              <div
                key={t.port}
                role="tab"
                tabIndex={0}
                aria-selected={active === t.port}
                className={`term-tab${active === t.port ? " term-tab--active" : ""}`}
                onClick={() => {
                  setActive(t.port);
                  handles.current.get(t.port)?.focus();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setActive(t.port);
                    handles.current.get(t.port)?.focus();
                  }
                }}
                title={t.port}
              >
                <span className="term-tab__label">{t.label}</span>
                <button
                  type="button"
                  className="term-tab__close"
                  aria-label={`关闭 ${t.label}`}
                  title="关闭"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.port);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <button
            className="term-panel__btn"
            title="打开端口"
            onClick={() => setPicker(true)}
          >
            ＋
          </button>
          <button
            className={`term-panel__btn${layout.max ? " term-panel__btn--on" : ""}`}
            title={layout.max ? "还原宽度" : "放大面板"}
            onClick={() => setLayout((l) => ({ ...l, max: !l.max }))}
          >
            <IconExpand />
          </button>
          <button
            className="term-panel__btn"
            title="收起面板"
            onClick={() => setLayout((l) => ({ ...l, open: false }))}
          >
            <IconChevronsRight />
          </button>
        </header>
        <div className="term-panel__body">
          {lastError && (
            <p className="open-note" role="status">
              {lastError}{" "}
              <button className="link" onClick={() => setLastError("")}>
                关闭
              </button>
            </p>
          )}
          {tabs.length === 0 ? (
            <div className="term-blank">
              <IconSsh className="term-blank__icon" />
              <p className="muted">尚无终端。从设备页的通道行打开，或在此选择端口。</p>
              <button className="btn btn--primary" onClick={() => setPicker(true)}>
                打开端口
              </button>
            </div>
          ) : (
            <div className="term-area">
              {tabs.map((t) => (
                <div
                  key={t.port}
                  className="term-pane"
                  style={{ display: active === t.port ? "block" : "none" }}
                >
                  <TermView
                    port={t.port}
                    onWrite={handleWrite}
                    onResize={handleResize}
                    onReady={(h) => handleReady(t.port, h)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {picker && (
          <div
            className="dialog-overlay"
            onMouseDown={(e) => e.target === e.currentTarget && setPicker(false)}
          >
            <div
              className="dialog dialog--med"
              role="dialog"
              aria-modal="true"
              aria-label="打开终端"
              onClick={(e) => e.stopPropagation()}
            >
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
                        // 设备通道即点即开：串口用通道存储的完整配置（不弹参数框）
                        if (c.type === "serial") {
                          void openPort(
                            p ?? ({ name: key, opened: false, holders: 0 } as PortView),
                            channelSerialConfig(c) as unknown as SerialConfig,
                          );
                        } else if (p) startOpen(p);
                        else void openPort({ name: key, opened: false, holders: 0 } as PortView);
                      }}
                      title={channelPortKey(c)}
                    >
                      <span>
                        {d.name} ·{" "}
                        {c.type === "serial"
                          ? `串口 ${c.port} ${channelSerialConfig(c).baud_rate}bps`
                          : `SSH ${sshChannelLabel(c)}`}
                      </span>
                      <span className="muted mono">{channelPortKey(c)}</span>
                    </button>
                  )),
                )}
                <p className="dialog__hint" style={{ marginTop: 10 }}>
                  裸端口（未注册设备）
                </p>
                {barePorts
                  .filter((p) => p.kind !== "ssh" || p.instance == null)
                  .map((p) => (
                    <button
                      key={p.name}
                      className="port-picker__item"
                      onClick={() => startOpen(p)}
                      title={p.name}
                    >
                      <span>{p.alias ? `${p.alias}（${p.name}）` : p.name}</span>
                      <span className="muted">
                        {p.opened ? `已开 · ${p.holders} 人` : (p.device?.label ?? "")}
                      </span>
                    </button>
                  ))}
                {barePorts.length === 0 && <p className="dialog__hint">全部端口已归属设备。</p>}
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
              openSshManager();
            }}
            onCancel={() => setSshFail(null)}
          />
        )}
        {(sshFail?.error.kind === "host_key_unknown" || sshFail?.error.kind === "host_key_changed") &&
          sshFail.host && (
            <SshTrustDialog
              host={sshFail.host}
              error={
                sshFail.error as Extract<
                  SshOpenError,
                  { kind: "host_key_unknown" | "host_key_changed" }
                >
              }
              onTrust={trustAndReopen}
              onCancel={() => setSshFail(null)}
            />
          )}
      </aside>

      {!layout.open && (
        <div className="term-rail">
          <button
            className="term-rail__btn"
            title="展开终端面板"
            aria-expanded={false}
            aria-controls="term-panel"
            onClick={() => setLayout((l) => ({ ...l, open: true }))}
          >
            <IconSsh />
            {tabs.length > 0 && (
              <span className="term-rail__count" title={`${tabs.length} 个活跃会话`}>
                {tabs.length}
              </span>
            )}
          </button>
        </div>
      )}
    </>
  );
});

export default TermPanel;
