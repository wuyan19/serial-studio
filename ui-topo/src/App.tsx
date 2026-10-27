import { NavLink, Outlet } from "react-router-dom";

const nav = [
  { to: "/", label: "拓扑" },
  { to: "/devices", label: "设备库" },
  { to: "/leases", label: "占用" },
  { to: "/terminal", label: "终端" },
];

export default function App() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">topo-hub</div>
        <nav>
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === "/"}>
              {n.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
