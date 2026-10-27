import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import App from "./App";
import Topologies from "./pages/Topologies";
import TopologyDetail from "./pages/TopologyDetail";
import TopologyEdit from "./pages/TopologyEdit";
import Devices from "./pages/Devices";
import Leases from "./pages/Leases";
import Placeholder from "./pages/Placeholder";
import "./styles.css";

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <Topologies /> },
      { path: "topologies/new", element: <TopologyEdit /> },
      { path: "topologies/:id", element: <TopologyDetail /> },
      { path: "topologies/:id/edit", element: <TopologyEdit /> },
      { path: "devices", element: <Devices /> },
      { path: "leases", element: <Leases /> },
      { path: "terminal", element: <Placeholder title="终端" phase="P1" /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
