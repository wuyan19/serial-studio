/** 应用壳：左侧导航 + 侧栏工具入口（主题切换/添加远端/设置/关于）+ 右侧终端面板。
 * 全局对话框（设置/关于/添加远端）在此挂载，页面经 context 请求打开。
 * WS 数据面连接随壳启动（单例，终端面板/设备页共用）。 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { api, type ServerSettings } from "./api";
import { ws } from "./ws";
import { RemoteDialog } from "./components/dialogs";
import { SettingsPage } from "./components/settings-page";
import TermPanel, { type TermPanelHandle } from "./components/term-panel";
import { TitleBar } from "./components/titlebar";
import { IconGear, IconGlobe, IconLock, IconServer, IconTopology } from "./icons";
import { loadLayoutMode, saveLayoutMode, type LayoutMode } from "./layout";
import type { SshHost } from "./types";

type DialogKind = null | "settings" | "remote";

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
  { to: "/devices", label: "设备", icon: <IconServer /> },
  { to: "/leases", label: "占用", icon: <IconLock /> },
];

export default function App() {
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(loadLayoutMode);
  const [sshHosts, setSshHosts] = useState<SshHost[]>([]);
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [version, setVersion] = useState("");
  const [remoteInput, setRemoteInput] = useState({ host: "", port: 18700, nickname: "" });
  const [existingRemotes, setExistingRemotes] = useState<string[]>([]);
  const [connUp, setConnUp] = useState(true);
  const termPanel = useRef<TermPanelHandle>(null);

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
  const changeLayout = useCallback((m: LayoutMode) => {
    setLayoutMode(m);
    saveLayoutMode(m);
  }, []);

  return (
    <ShellContext.Provider
      value={{ openDialog, sshHosts, openTerminal, toggleTermPanel }}
    >
      <div className="shell">
        <TitleBar layoutMode={layoutMode} onLayoutChange={changeLayout} />
        <div className="shell-row" data-layout={layoutMode}>
        <aside className="sidebar">
          <nav>
            {nav.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.to === "/"} title={n.label}>
                {n.icon}
              </NavLink>
            ))}
          </nav>
          <div className="sidebar__tools">
            <button className="tool-btn" onClick={() => openDialog("remote")} title="添加远程设备">
              <IconGlobe />
            </button>
            <button className="tool-btn" onClick={() => openDialog("settings")} title="设置">
              <IconGear />
            </button>
          </div>
        </aside>
          <div className="work-area">
            <main className="content">
              <Outlet />
            </main>
            <TermPanel ref={termPanel} sshHosts={sshHosts} mode={layoutMode} />
          </div>
        </div>
        <footer className="statusbar">
          <span className={`statusbar__conn${connUp ? "" : " statusbar__conn--off"}`}>
            <span className={`dot${connUp ? " on" : ""}`} />
            {connUp ? "已连接" : "重连中…"}
          </span>
        </footer>
      </div>

      {dialog === "settings" && (
        <SettingsPage version={version} settings={settings} onClose={() => setDialog(null)} />
      )}
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
