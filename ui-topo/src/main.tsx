import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { Navigate, createBrowserRouter, RouterProvider, useNavigate, useParams, useSearchParams } from "react-router-dom";
import App, { useShell } from "./App";
import Topologies from "./pages/Topologies";
import TopologyEdit from "./pages/TopologyEdit";
import Devices from "./pages/Devices";
import Leases from "./pages/Leases";
import "./styles.css";

/** /terminal 旧链接兼容：终端宿主已迁右侧面板——有 ?open= 直达开会话，
 *  无则仅展开面板，然后跳设备页（终端不再是目的地）。 */
function TerminalRedirect() {
  const [params] = useSearchParams();
  const { openTerminal, toggleTermPanel } = useShell();
  const navigate = useNavigate();
  useEffect(() => {
    const key = params.get("open");
    if (key) openTerminal(key);
    else toggleTermPanel();
    navigate("/devices", { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <p className="muted">正在跳转…</p>;
}

/** 拓扑详情页已撤（信息并入总览大卡片）：旧深链带 id 锚点直达对应卡。 */
function TopoRedirect() {
  const { id } = useParams();
  return <Navigate to={id ? `/#topo-${id}` : "/"} replace />;
}

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <Topologies /> },
      { path: "topologies/new", element: <TopologyEdit /> },
      // 详情页已撤（信息并入总览大卡片）——旧深链锚点直达对应卡
      { path: "topologies/:id", element: <TopoRedirect /> },
      { path: "topologies/:id/edit", element: <TopologyEdit /> },
      { path: "devices", element: <Devices /> },
      { path: "leases", element: <Leases /> },
      { path: "terminal", element: <TerminalRedirect /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
