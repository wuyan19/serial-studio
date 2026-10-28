/** 应用壳：左侧导航 + 顶栏全局入口（主题切换/SSH 设备/添加远端/设置/关于）+ 右侧终端面板。
 * 全局对话框（设置/关于/SSH 管理/添加远端）在此挂载，页面经 context 请求打开。
 * WS 数据面连接随壳启动（单例，终端面板/设备库/SSH 管理共用）。 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { api, type ServerSettings } from "./api";
import { ws } from "./ws";
import { getTheme, setTheme, subscribe, THEMES, type Theme } from "./theme";
import {
  AboutDialog,
  ConfirmDialog,
  RemoteDialog,
  SettingsPanel,
  SshManagerDialog,
} from "./components/dialogs";
import TermPanel, { type TermPanelHandle } from "./components/term-panel";
import type { SshHost } from "./types";

type DialogKind = null | "settings" | "about" | "ssh" | "remote";

interface ShellCtx {
  openDialog: (k: Exclude<DialogKind, null>) => void;
  sshHosts: SshHost[];
  /** 更新单台 SSH 设备（认证闭环重输密码后改记录）并打开管理弹窗。 */
  editSsh: (host: SshHost) => void;
  /** 直达开终端（面板随之展开）；面板宿主在壳层，切页不丢会话。 */
  openTerminal: (key: string) => void;
  toggleTermPanel: () => void;
}

export const ShellContext = createContext<ShellCtx>({
  openDialog: () => {},
  sshHosts: [],
  editSsh: () => {},
  openTerminal: () => {},
  toggleTermPanel: () => {},
});
export const useShell = () => useContext(ShellContext);

const nav = [
  { to: "/", label: "拓扑" },
  { to: "/devices", label: "设备库" },
  { to: "/leases", label: "占用" },
];

export default function App() {
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const [sshHosts, setSshHosts] = useState<SshHost[]>([]);
  const [sshTests, setSshTests] = useState<Record<string, "testing" | "ok" | "fail">>({});
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [version, setVersion] = useState("");
  const [remoteInput, setRemoteInput] = useState({ host: "", port: 18700, nickname: "" });
  const [existingRemotes, setExistingRemotes] = useState<string[]>([]);
  const [deleteSsh, setDeleteSsh] = useState<SshHost | null>(null);
  const [connUp, setConnUp] = useState(true);
  const termPanel = useRef<TermPanelHandle>(null);

  useEffect(() => subscribe(setThemeState), []);
  useEffect(() => {
    ws.start();
    const offHosts = ws.on("sshHosts", (hosts) => setSshHosts(hosts));
    const offTest = ws.on("sshTestResult", (id, ok) =>
      setSshTests((t) => ({ ...t, [id]: ok ? "ok" : "fail" })),
    );
    // 连接状态灯：数据面断连时全站可见（此前只有终端页有提示）
    const offConn = ws.on("connected", setConnUp);
    void ws.version().then((v) => setVersion(v.version)).catch(() => {});
    return () => {
      offHosts();
      offTest();
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

  /** SSH 设备保存（全量表覆盖协议）。新建设备生成 UUID。 */
  const commitSsh = (host: SshHost, isNew: boolean) => {
    const next = isNew
      ? [...sshHosts, { ...host, id: crypto.randomUUID() }]
      : sshHosts.map((h) => (h.id === host.id ? host : h));
    ws.sshSave(next);
  };

  /** 认证闭环的直达编辑：更新单台记录（如新密码）落库后打开管理弹窗。 */
  const editSsh = (host: SshHost) => {
    if (sshHosts.some((h) => h.id === host.id)) {
      ws.sshSave(sshHosts.map((h) => (h.id === host.id ? host : h)));
    }
    setDialog("ssh");
  };

  const openTerminal = useCallback((key: string) => {
    termPanel.current?.openByKey(key);
  }, []);
  const toggleTermPanel = useCallback(() => {
    termPanel.current?.togglePanel();
  }, []);

  return (
    <ShellContext.Provider
      value={{ openDialog, sshHosts, editSsh, openTerminal, toggleTermPanel }}
    >
      <div className="shell">
        <aside className="sidebar">
          <div
            className="brand"
            title={connUp ? "已连接服务器" : "连接断开，重连中…"}
          >
            <span className={`brand__dot${connUp ? "" : " brand__dot--off"}`} /> topo-hub
          </div>
          <nav>
            {nav.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.to === "/"}>
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="sidebar__tools">
            <button className="tool-btn" onClick={() => openDialog("remote")} title="添加远程设备">
              添加远端
            </button>
            <button className="tool-btn" onClick={() => openDialog("settings")} title="设置">
              设置
            </button>
            <button className="tool-btn" onClick={() => openDialog("about")} title="关于">
              关于
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
        <TermPanel ref={termPanel} sshHosts={sshHosts} openSshManager={() => openDialog("ssh")} />
      </div>

      {dialog === "settings" && (
        <SettingsPanel
          settings={settings}
          onClose={() => setDialog(null)}
          onSave={(s) => {
            api
              .saveSettings(s)
              .then(setSettings)
              .catch(() => {});
          }}
        />
      )}
      {dialog === "about" && <AboutDialog version={version} onClose={() => setDialog(null)} />}
      {dialog === "ssh" && (
        <SshManagerDialog
          hosts={sshHosts}
          testOf={(id) => sshTests[id]}
          onCommit={commitSsh}
          onDelete={(h) => setDeleteSsh(h)}
          onTest={(id) => {
            setSshTests((t) => ({ ...t, [id]: "testing" }));
            ws.sshTest(id);
          }}
          onClose={() => setDialog(null)}
        />
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
      {deleteSsh && (
        <ConfirmDialog
          title="删除 SSH 设备"
          tone="danger"
          confirmText="删除"
          message={`删除「${deleteSsh.nickname || `${deleteSsh.username}@${deleteSsh.host}`}」？其活跃会话将被终结。`}
          onConfirm={() => {
            ws.sshSave(sshHosts.filter((h) => h.id !== deleteSsh.id));
            setDeleteSsh(null);
          }}
          onCancel={() => setDeleteSsh(null)}
        />
      )}
    </ShellContext.Provider>
  );
}
