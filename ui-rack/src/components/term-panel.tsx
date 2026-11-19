/** 终端面板（壳层右栏/底部条，常驻）：终端的唯一宿主。
 *  从旧 /terminal 页整体迁移——面板随壳挂载、切页不卸载，tab 列表与 xterm
 *  回滚缓冲跨页存活（此前切页即丢）。收起 = display:none 保活（分隔条常驻
 *  承载拖出/双击展开），展开时 TermView 内置 ResizeObserver 自动重 fit。
 *  外部入口（设备页按钮 / 旧链接 ?open=）经 ShellContext.openTerminal(key)
 *  走 openByKey：设备通道即点即开（串口用通道存储配置），裸串口仍弹参数框。
 *  分隔条手势照 serial-studio 侧栏 Splitter（VS Code 模型，见 beginResize）。
 *  宽度/高度/开合/最大化持久化 localStorage（首启收起）。 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { useLivePorts } from "../use-ports";
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
import { IconChevronsRight, IconSsh } from "../icons";
import type { LayoutMode } from "../layout";
import { DEFAULT_SERIAL_CONFIG, type SerialConfig, type SshHost, type SshOpenError } from "../types";

const STORE_KEY = "devicerack-term-panel";
const WIDTH_MIN = 260;
const WIDTH_MAX = 960;
/** 有效上限再扣内容区最小可用宽（窗口窄时先于常量上限生效）。 */
const widthCeiling = () => Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, window.innerWidth - 420));
const WIDTH_DEFAULT = 480;
/** 底部终端形态（term-bottom/rows）的纵向尺寸档位。 */
const HEIGHT_MIN = 140;
const HEIGHT_MAX = 560;
const heightCeiling = () => Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, window.innerHeight - 260));
const HEIGHT_DEFAULT = 280;
/** 分隔条手势参数（照抄 serial-studio 侧栏 Splitter 的 VS Code 模型）：
 *  收起阈值（鼠标越过面板最小尺寸继续外推的距离线）与展开阈值（收起后
 *  自「武装点」反拖 SPLITTER_EXPAND_DX）分居两侧恒不重叠——慢速拖动
 *  不会收起↔展开来回震荡（收起瞬间武装点必已越过收起线，展开阈值
 *  = 武装点−80 又恒在收起线内侧）。 */
const SPLITTER_EXPAND_DX = 80;
const COLLAPSE_W = 200; // 右栏：鼠标离 work-area 右缘 < 200px（< WIDTH_MIN 260）
const COLLAPSE_H = 120; // 底部：鼠标离 work-area 底缘 < 120px（< HEIGHT_MIN 140）

interface PanelLayout {
  open: boolean;
  width: number;
  /** 底部形态高度（右栏形态用不到，跨模式切换各自记忆）。 */
  height: number;
}

function loadLayout(): PanelLayout {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<PanelLayout>;
      return {
        open: !!v.open,
        width: Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Number(v.width) || WIDTH_DEFAULT)),
        height: Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, Number(v.height) || HEIGHT_DEFAULT)),
      };
    }
  } catch {
    /* 损坏回退默认 */
  }
  return { open: false, width: WIDTH_DEFAULT, height: HEIGHT_DEFAULT };
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
  { sshHosts: SshHost[]; mode: LayoutMode }
>(function TermPanel({ sshHosts, mode }, ref) {
  const navigate = useNavigate();
  const [layout, setLayout] = useState<PanelLayout>(loadLayout);
  /** 终端条形态（底部）vs 右栏形态：拖拽轴/尺寸属性随布局模式切换
   *  （columns 左右分栏同 standard 的宽度拖拽，仅无侧栏）。 */
  const horizontal = mode === "term-bottom" || mode === "rows";
  const [devices, setDevices] = useState<Device[]>([]);
  const ports = useLivePorts();
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
    // 数据回流：二进制帧 → 对应 tab 的 xterm
    const offData = ws.on("data", (port, data) => handles.current.get(port)?.write(data));
    const offClosed = ws.on("closed", (port) => {
      setTabs((ts) => ts.filter((t) => t.port !== port));
      handles.current.delete(port);
    });
    const offConn = ws.on("connected", (on) => setConnLost(!on));
    // 初始拉取：WS 首次端口推送在面板挂载前已发生（壳启动即连即推），只靠订阅会漏
    api.devices().then(setDevices).catch(() => {});
    return () => {
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

  /** 分隔条拖拽（照 serial-studio 侧栏 Splitter）：
   *  线贴鼠标——尺寸 = 鼠标到 work-area 内缘的距离（clamp 上下限），跟手不越界；
   *  展开态外推越过收起线 → 收起（面板 display:none 保活，只剩分隔条）；
   *  收起后自武装点反拖 80px → 展开（展开瞬间线停在 clamp 值，鼠标追上后继续跟手）；
   *  尺寸更新 rAF 合帧（高刷鼠标事件每帧最多渲染一次）。 */
  const beginResize = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).parentElement?.getBoundingClientRect();
    if (!rect) return;
    // 轴上距离：右栏 = 鼠标到右缘，底部 = 鼠标到底缘（外推 = 距离增大）
    const dist = (cx: number, cy: number) =>
      horizontal ? rect.bottom - cy : rect.right - cx;
    const COLLAPSE = horizontal ? COLLAPSE_H : COLLAPSE_W;
    const applySize = (d: number) => {
      setLayout((l) =>
        horizontal
          ? { ...l, open: true, height: Math.min(heightCeiling(), Math.max(HEIGHT_MIN, d)) }
          : { ...l, open: true, width: Math.min(widthCeiling(), Math.max(WIDTH_MIN, d)) },
      );
    };
    let collapsedNow = !layout.open; // 闭包本地跟踪（setState 后读不到新值）
    let arm = dist(e.clientX, e.clientY); // 展开「武装点」：收起瞬间/按下时
    document.body.classList.add("panel-resizing");
    if (horizontal) document.body.classList.add("panel-resizing-row");
    let raf = 0;
    let pending: number | null = null;
    const flush = () => {
      raf = 0;
      if (pending === null) return;
      applySize(pending);
      pending = null;
    };
    const move = (ev: PointerEvent) => {
      const d = dist(ev.clientX, ev.clientY);
      if (collapsedNow) {
        // 展开 = 向内拖（d 增大）。阈值取 max(武装点, 收起线)+80：收起态
        // 分隔条贴边（武装点≈0），裸 arm+80 会落回收起区 → 展开瞬间又被
        // 收起（震荡）；抬高到收起线+80 保证展开后必在收起区外侧。
        const expandAt = Math.max(arm, COLLAPSE) + SPLITTER_EXPAND_DX;
        if (d > expandAt) {
          collapsedNow = false;
          applySize(d);
        }
        return;
      }
      if (d < COLLAPSE) {
        collapsedNow = true;
        arm = d;
        // 丢弃合帧中的残留尺寸：pointerup 的 flush 会把它重新 open:true
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        pending = null;
        setLayout((l) => ({ ...l, open: false }));
        return;
      }
      pending = d;
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const up = () => {
      if (raf) cancelAnimationFrame(raf);
      flush(); // 补上合帧中最后一帧
      document.body.classList.remove("panel-resizing");
      document.body.classList.remove("panel-resizing-row");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** 双击：收起 → 展开并回默认尺寸；展开 → 重置默认尺寸（同 main 语义）。 */
  const doubleClickReset = () => {
    setLayout((l) => ({
      ...l,
      open: true,
      ...(horizontal ? { height: HEIGHT_DEFAULT } : { width: WIDTH_DEFAULT }),
    }));
  };

  /** 键盘微调（收窄方向 ←/↑、加宽方向 →/↓，随轴）；到下限停（不联动收起）。 */
  const nudgeSize = (delta: number) => {
    setLayout((l) =>
      horizontal
        ? { ...l, height: Math.min(heightCeiling(), Math.max(HEIGHT_MIN, l.height + delta)) }
        : { ...l, width: Math.min(widthCeiling(), Math.max(WIDTH_MIN, l.width + delta)) },
    );
  };

  /** SSH 认证闭环：重输密码。勾选更新（默认）= 写回属主设备的 SSH 通道
   *  （devices.json 是唯一真源；凭据库 ssh.json 是设备保存时的投影，直写会被
   *  下次投影覆盖——旧 SSH 管理弹窗的直写路径已随其退役）。写回后再重开。 */
  const retryWithPassword = (password: string, updateSaved: boolean) => {
    const fail = sshFail;
    setSshFail(null);
    if (!fail?.host) return;
    const reopen = () => {
      const p =
        ports.find((x) => x.name === fail.port) ??
        ({ name: fail.port, opened: false, holders: 0 } as PortView);
      void openPort(p);
    };
    if (!updateSaved) {
      reopen();
      return;
    }
    void (async () => {
      try {
        const devices = await api.devices();
        const dev = devices.find((d) =>
          d.channels.some((c) => c.type === "ssh" && c.id === fail.host!.id),
        );
        if (!dev) {
          setLastError("未找到该 SSH 通道的属主设备，请在设备页更新认证");
          return;
        }
        await api.updateDevice(dev.id, {
          name: dev.name,
          model: dev.model,
          location: dev.location,
          channels: dev.channels.map((c) =>
            c.type === "ssh" && c.id === fail.host!.id
              ? { ...c, auth: { type: "password", password } }
              : c,
          ),
        });
        reopen();
      } catch (e) {
        setLastError(`保存认证失败：${e instanceof Error ? e.message : String(e)}`);
      }
    })();
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
      {/* 分隔条：面板内缘常驻（work-area 直接子级——面板收起后整个终端区
          只剩这条，拖出/双击即展开；VS Code 手势模型见 beginResize） */}
      <div
          className={`term-resizer${horizontal ? " term-resizer--row" : ""}`}
          role="separator"
          aria-orientation={horizontal ? "horizontal" : "vertical"}
          aria-label={horizontal ? "调整终端面板高度" : "调整终端面板宽度"}
          tabIndex={0}
          title="拖动调整大小（双击展开/重置；拖到最小自动收起，反方向拖出展开）"
          onPointerDown={beginResize}
          onDoubleClick={doubleClickReset}
          onKeyDown={(e) => {
            if (horizontal) {
              if (e.key === "ArrowUp") {
                e.preventDefault();
                nudgeSize(24);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                nudgeSize(-24);
              }
            } else if (e.key === "ArrowLeft") {
              e.preventDefault();
              nudgeSize(24);
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              nudgeSize(-24);
            }
          }}
        />
      <aside
        id="term-panel"
        className={layout.open ? "term-panel" : "term-panel term-panel--hidden"}
        style={horizontal ? { height: layout.height } : { width: layout.width }}
        aria-label="终端"
      >
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
              // SSH 配置(用户名/密钥/主机)归设备编辑页管——凭据库只是投影
              setSshFail(null);
              navigate("/devices");
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
    </>
  );
});

export default TermPanel;
