# Serial Studio

**English** · [简体中文](README.zh-CN.md)

<p><img src="crates/tauri-app/icons/icon.png" width="84" alt="Serial Studio icon"></p>

![Tauri](https://img.shields.io/badge/Tauri-2.x-blue)
![Rust](https://img.shields.io/badge/Rust-2021-orange)
![React](https://img.shields.io/badge/React-18-61dafb)
![License](https://img.shields.io/badge/license-MIT-green)

**A multi-form serial-port terminal — desktop, web, and remote. Built with Tauri + Rust + React.**

Serial Studio lets you talk to serial devices from a polished desktop app, from any
browser on your network, or driven by an LLM over MCP — all backed by the same Rust core.
Multiple clients can share a single port, you can script repetitive exchanges as macros,
and label ports with device aliases.

> _Screenshots coming soon._

---

## ✨ Features

- **Multi-port terminal** — concurrent ports in tabs, powered by xterm.js.
- **Port sharing** — multiple windows / clients attach to the same port. The first opener's
  config wins; later clients join read/write. Force-close kicks every holder off.
- **Macros** — step sequences (`send` / `delay` / `expect` / `clear`), importable / exportable
  as JSON so they travel between machines.
- **Port aliases** — label a port with the device it connects, e.g. `GPS (COM7)`.
- **Three ways in:**
  - **Local** desktop app (IPC, bypasses the network entirely).
  - **Web** — open `http://host:port/` in a browser; the UI is embedded in the binary.
  - **Remote** — connect a desktop window to another machine's Serial Studio.
- **MCP** — expose the serial port to LLMs (`serial_list` / `send` / `read` / `grep` /
  `status` / `clear`), addressable by port name **or** alias.
- **Telnet** — works with classic terminal clients.
- **Instrumented UI** — dark/light themes, in-terminal search (Ctrl+F), font zoom, RX/TX LEDs.

## 🧱 Architecture

Control plane and data plane are deliberately separated:

- **Control plane** (Tauri IPC) — settings, service lifecycle, alias & macro persistence.
- **Data plane** (axum) — WebSocket, MCP, Telnet; all adapters over the same
  `SerialManager` + `EventBus`.

### Crates

| Crate | Role |
|---|---|
| `ss-core` | Serial manager: port ownership (acquire / release / force-close), RX buffer, macro runner. Pure runtime — no persistence, no UI. |
| `ss-server` | axum WS / MCP / Telnet + embedded SPA (`rust-embed`). Shared by the Tauri shell and the standalone binary. |
| `serial-studio` (`tauri-app`) | The Tauri shell — service supervisor + control-plane commands. |

## 🛠 Tech stack

Tauri 2 · Rust (edition 2021, axum, serialport, tokio) · React 18 · TypeScript · Vite · xterm.js

## 📋 Requirements

- Rust (stable)
- Node.js (for the frontend)
- Windows: WebView2 (preinstalled on Win 10/11)
- A serial port (real or virtual)

## 🚀 Getting started

```bash
# build frontend + release binary
npm install --prefix ui
cargo tauri build

# or run in dev (hot-reload frontend)
cargo tauri dev
```

The release artifact is `serial-studio.exe`.

## 📖 Usage

- **Desktop** — run `serial-studio.exe`.
- **Web / in-browser** — the app runs a server (WS `18700`, Telnet `18701`). From any machine
  on the LAN, open `http://<host>:18700/`; the UI is served from the binary itself.
- **Remote window** — from the desktop app, open a remote window to another Serial Studio host.
- **Headless** — `serial-studio.exe --no-gui` runs only the backend (no window).

## ⚙️ Configuration

Runtime config lives next to the binary:

| File | Holds |
|---|---|
| `settings.json` | server listen address / WS port / Telnet port |
| `ports.json` | per-port metadata (aliases) |
| `macros.json` | macros |

## 🤖 MCP

`POST /mcp` speaks JSON-RPC. Six tools: `serial_list`, `serial_send`, `serial_read`,
`serial_status`, `serial_grep`, `serial_clear`. The `port` argument accepts a real port name
**or** an alias.

```jsonc
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "serial_send", "arguments": { "port": "GPS", "data": "AT", "timeout_ms": 1000 } }
}
```

## 🔒 Security note

The server binds `0.0.0.0` by default and carries **no authentication**. Anyone who can reach
the port can open / send to your serial ports and read their output. Bind to `127.0.0.1` in
`settings.json`, or sit behind a firewall / VPN, for anything beyond a trusted LAN.

## 📁 Project layout

```
serial-studio/
├─ crates/
│  ├─ core/        # ss-core: serial manager + port ownership + macros
│  ├─ server/      # ss-server: axum WS/MCP/Telnet + embedded SPA
│  └─ tauri-app/   # serial-studio: Tauri shell (control plane)
├─ ui/             # React + TS + Vite frontend
└─ Cargo.toml      # workspace
```

## 🤝 Contributing

Issues and pull requests welcome. This is a small project — keep changes scoped and match the
existing style.

## 📄 License

MIT — see [LICENSE](LICENSE).
