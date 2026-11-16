/** 应用壳：左侧导航 + 侧栏工具入口（主题切换/添加远端/设置/关于）+ 右侧终端面板。
 * 全局对话框（设置/关于/添加远端）在此挂载，页面经 context 请求打开。
 * WS 数据面连接随壳启动（单例，终端面板/设备页共用）。 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { api, type ServerSettings } from "./api";
import { ws } from "./ws";
import { getTheme, setTheme, subscribe, THEMES, type Theme } from "./theme";
import { AboutDialog, RemoteDialog } from "./components/dialogs";
import { SettingsPage } from "./components/settings-page";
import TermPanel, { type TermPanelHandle } from "./components/term-panel";
import { IconGear, IconGlobe, IconInfo, IconLock, IconPlug, IconTopology } from "./icons";
import type { SshHost } from "./types";

type DialogKind = null | "settings" | "about" | "remote";

interface ShellCtx {
  openDialog: (k: Exclude<DialogKind, null>) => void;
  sshHosts: SshHost[];
  /** 直达开终端（面板随之展开）；面板宿主在壳层，切页不丢会话。 */
  openTerminal: (key: string) => void;
  toggleTermPanel: () => void;
}

export const ShellContext = createContext<ShellCtx>({
  openDialog: () => {},
  sshHosts: [],
  openTerminal: () => {},
  toggleTermPanel: () => {},
});
export const useShell = () => useContext(ShellContext);

const nav = [
  { to: "/", label: "拓扑", icon: <IconTopology /> },
  { to: "/devices", label: "设备", icon: <IconPlug /> },
  { to: "/leases", label: "占用", icon: <IconLock /> },
];

export default function App() {
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const [sshHosts, setSshHosts] = useState<SshHost[]>([]);
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [version, setVersion] = useState("");
  const [remoteInput, setRemoteInput] = useState({ host: "", port: 18700, nickname: "" });
  const [existingRemotes, setExistingRemotes] = useState<string[]>([]);
  const [connUp, setConnUp] = useState(true);
  const termPanel = useRef<TermPanelHandle>(null);

  useEffect(() => subscribe(setThemeState), []);
  useEffect(() => {
    ws.start();
    const offHosts = ws.on("sshHosts", (hosts) => setSshHosts(hosts));
    // 连接状态灯：数据面断连时全站可见（此前只有终端页有提示）
    const offConn = ws.on("connected", setConnUp);
    void ws.version().then((v) => setVersion(v.version)).catch(() => {});
    return () => {
      offHosts();
      offConn();
    };
  }, []);

  const openDialog = useCallback((k: Exclude<DialogKind, null>) => {
    setDialog(k);
    if (k === "settings") {
      api.settings().then(setSettings).catch(() => setSettings(null));
    }
    if (k === "remote") {
      api
        .remotes()
        .then((list) => setExistingRemotes(list.map((d) => `${d.host}:${d.port}`)))
        .catch(() => {});
    }
  }, []);

  const openTerminal = useCallback((key: string) => {
    termPanel.current?.openByKey(key);
  }, []);
  const toggleTermPanel = useCallback(() => {
    termPanel.current?.togglePanel();
  }, []);

  return (
    <ShellContext.Provider
      value={{ openDialog, sshHosts, openTerminal, toggleTermPanel }}
    >
      <div className="shell">
        <div className="shell-row">
        <aside className="sidebar">
          <div
            className="brand"
            title={connUp ? "已连接服务器" : "连接断开，重连中…"}
          >
            <span className={`brand__dot${connUp ? "" : " brand__dot--off"}`} />
            <span className="brand-text">topo-hub</span>
          </div>
          <nav>
            {nav.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.to === "/"} title={n.label}>
                {n.icon}
                <span className="nav-label">{n.label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="sidebar__tools">
            <button className="tool-btn" onClick={() => openDialog("remote")} title="添加远程设备">
              <IconGlobe />
              <span className="nav-label">添加远端</span>
            </button>
            <button className="tool-btn" onClick={() => openDialog("settings")} title="设置">
              <IconGear />
              <span className="nav-label">设置</span>
            </button>
            <button className="tool-btn" onClick={() => openDialog("about")} title="关于">
              <IconInfo />
              <span className="nav-label">关于</span>
            </button>
            <select
              className="theme-select"
              value={theme}
              onChange={(e) => setTheme(e.target.value as Theme)}
              title="主题"
              aria-label="主题"
            >
              {THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        </aside>
          <main className="content">
            <Outlet />
          </main>
          <TermPanel ref={termPanel} sshHosts={sshHosts} />
        </div>
        <footer className="statusbar">
          <span className={`statusbar__conn${connUp ? "" : " statusbar__conn--off"}`}>
            <span className={`dot${connUp ? " on" : ""}`} />
            {connUp ? "已连接" : "重连中…"}
          </span>
          <span className="statusbar__msg">
            topo-hub{version ? ` · ${version}` : ""}
          </span>
        </footer>
      </div>

      {dialog === "settings" && (
        <SettingsPage version={version} settings={settings} onClose={() => setDialog(null)} />
      )}
      {dialog === "about" && <AboutDialog version={version} onClose={() => setDialog(null)} />}
      {dialog === "remote" && (
        <RemoteDialog
          input={remoteInput}
          onChange={setRemoteInput}
          existing={existingRemotes}
          onConfirm={() => {
            api
              .remotes()
              .then((list) => {
                const next = [
                  ...list,
                  {
                    id: crypto.randomUUID(),
                    host: remoteInput.host.trim(),
                    port: remoteInput.port,
                    nickname: remoteInput.nickname.trim() || undefined,
                  },
                ];
                return api.saveRemotes(next);
              })
              .then(() => {
                setRemoteInput({ host: "", port: 18700, nickname: "" });
                setDialog(null);
              })
              .catch(() => {});
          }}
          onCancel={() => setDialog(null)}
        />
      )}
    </ShellContext.Provider>
  );
}
