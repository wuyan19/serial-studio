"use strict";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const icon = (name, className = "") => `<svg class="icon ${className}" aria-hidden="true"><use href="#i-${name}" /></svg>`;
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const STORAGE_KEY = "serial-studio-codex-design-v1";
const FONT_SIZES = { compact: 14, standard: 15, large: 16 };
const groups = [
  { id: "ap", name: "AP 调试", collapsed: false },
  { id: "gateway", name: "网关验证", collapsed: false },
  { id: "local", name: "本机连接", collapsed: false },
];
const connections = [
  { id: "ap-serial", name: "AP-502 调试串口", short: "AP-502", address: "/dev/ttyUSB0", type: "serial", group: "ap", online: true, config: "115200 · 8N1", host: "ap-502", device: "AP502-M", rx: 2540, tx: 128 },
  { id: "ap-ssh", name: "AP-502 Shell", short: "AP Shell", address: "root@192.168.20.51", type: "ssh", group: "ap", online: true, config: "SSH · 端口 22", host: "ap-502", device: "AP502-M", rx: 1784, tx: 96 },
  { id: "sensor", name: "传感器调试", short: "传感器", address: "/dev/ttyUSB1", type: "serial", group: "ap", online: false, config: "115200 · 8N1", host: "sensor", device: "Sensor Board", rx: 0, tx: 0 },
  { id: "gateway-ssh", name: "ESG6000 网关", short: "ESG6000", address: "admin@192.168.20.10", type: "ssh", group: "gateway", online: true, config: "SSH · 端口 22", host: "esg6000", device: "ESG6000", rx: 4096, tx: 256 },
  { id: "gateway-serial", name: "网关 Console", short: "Console", address: "COM7", type: "serial", group: "gateway", online: false, config: "9600 · 8N1", host: "gateway", device: "ESG6000", rx: 0, tx: 0 },
  { id: "esp32", name: "ESP32 开发板", short: "ESP32", address: "/dev/cu.usbserial-210", type: "serial", group: "local", online: false, config: "115200 · 8N1", host: "esp32", device: "ESP32", rx: 0, tx: 0 },
  { id: "bluetooth", name: "蓝牙串口", short: "Bluetooth", address: "/dev/cu.Bluetooth", type: "serial", group: "local", online: false, config: "9600 · 8N1", host: "bluetooth", device: "Bluetooth", rx: 0, tx: 0 },
];
const libraries = {
  macros: [
    { id: "m-version", name: "读取版本", group: "设备初始化", meta: "3 个步骤 · 发送 / 等待" },
    { id: "m-reboot", name: "重启设备", group: "设备初始化", meta: "4 个步骤 · 发送 / 延时" },
    { id: "m-network", name: "查看网络接口", group: "网络诊断", meta: "2 个步骤 · 发送 / 等待" },
    { id: "m-ping", name: "连通性检查", group: "网络诊断", meta: "3 个步骤 · 发送 / 等待" },
  ],
  scripts: [
    { id: "s-device", name: "设备信息采集", group: "设备检查", meta: "JavaScript · 当前端口" },
    { id: "s-network", name: "网络状态检查", group: "设备检查", meta: "JavaScript · 当前端口" },
    { id: "s-stress", name: "串口循环测试", group: "自动化测试", meta: "JavaScript · 支持参数" },
  ],
};

let preferences = {};
try { preferences = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { preferences = {}; }
let theme = preferences.theme === "dark" ? "dark" : "light";
let size = Object.hasOwn(FONT_SIZES, preferences.size) ? preferences.size : "standard";
let tabIds = ["ap-serial", "ap-ssh", "gateway-ssh"];
let activeId = tabIds[0];
let query = "";
let activePanel = "connections";
const libraryCollapsed = new Set();
let dialogAction = null;
let menuTrigger = null;
let toastTimer;
let idSequence = 0;
const sessions = new Map();

function savePreferences() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme, size })); } catch { /* Preview remains usable without storage. */ }
}

function connectionById(id) { return connections.find((connection) => connection.id === id); }
function currentConnection() { return connectionById(activeId); }
function groupById(id) { return groups.find((group) => group.id === id); }
function formatBytes(bytes) { return bytes >= 1024 ? `${(bytes / 1024).toFixed(2)} KB` : `${bytes} B`; }

function showToast(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  toastTimer = setTimeout(() => { $("#toast").hidden = true; }, 2600);
}

function renderGroups() {
  let matchCount = 0;
  $("#connection-groups").innerHTML = groups.map((group) => {
    const all = connections.filter((connection) => connection.group === group.id);
    const filtered = all.filter((connection) => `${connection.name} ${connection.address} ${connection.type} ${group.name}`.toLowerCase().includes(query));
    if (query && !filtered.length) return "";
    matchCount += filtered.length;
    const collapsed = group.collapsed && !query;
    return `<section class="connection-group" data-group-id="${escapeHtml(group.id)}"><div class="group-head"><button class="group-toggle" data-action="toggle-group" data-group="${escapeHtml(group.id)}" aria-expanded="${!collapsed}">${icon("chevron")}<span>${escapeHtml(group.name)}</span><span class="group-count">${all.length}</span></button><button class="icon-button group-menu" data-action="group-menu" data-group="${escapeHtml(group.id)}" aria-label="管理分组 ${escapeHtml(group.name)}" title="管理分组">${icon("more")}</button></div><div class="group-items" ${collapsed ? "hidden" : ""}>${filtered.map((connection) => `<div class="connection-row" draggable="true" data-connection-id="${escapeHtml(connection.id)}" data-active="${connection.id === activeId}"><button class="connection-open" data-action="open" data-id="${escapeHtml(connection.id)}" ${connection.id === activeId ? 'aria-current="true"' : ""} title="${escapeHtml(connection.address)} · ${connection.online ? "已连接" : "点击连接"}">${icon(connection.type === "ssh" ? "terminal" : "plug", "connection-type-icon")}<span class="connection-label"><span class="connection-name">${escapeHtml(connection.name)}</span><span class="connection-address">${escapeHtml(connection.address)}</span></span></button>${connection.online ? '<span class="status-dot" title="已连接" role="img" aria-label="已连接"></span>' : ""}<button class="icon-button connection-menu" data-action="connection-menu" data-id="${escapeHtml(connection.id)}" aria-label="管理连接 ${escapeHtml(connection.name)}" title="管理连接">${icon("more")}</button></div>`).join("")}${!filtered.length ? '<p class="group-empty">拖动连接到这里</p>' : ""}</div></section>`;
  }).join("");
  if (query && !matchCount) $("#connection-groups").innerHTML = '<p class="no-results">没有找到匹配的连接</p>';
  $("#connection-count").textContent = connections.length;
}

function renderTabs() {
  $("#session-tabs").innerHTML = tabIds.map((id) => {
    const connection = connectionById(id);
    const raw = connection.type === "ssh" ? "SSH" : connection.address.split("/").pop();
    return `<div class="session-tab" data-active="${id === activeId}"><button role="tab" id="tab-${escapeHtml(id)}" class="tab-select" aria-selected="${id === activeId}" aria-controls="session-panel" tabindex="${id === activeId ? 0 : -1}" data-tab-id="${escapeHtml(id)}">${connection.online ? '<span class="status-dot"></span>' : icon("pause")}<span class="tab-alias">${escapeHtml(connection.short)}</span><span class="tab-port">${escapeHtml(raw)}</span></button><button class="icon-button tab-close" data-close-tab="${escapeHtml(id)}" aria-label="关闭 ${escapeHtml(connection.name)} 标签" title="关闭标签">${icon("close")}</button></div>`;
  }).join("");
  $("#session-count").textContent = `${tabIds.length} 个会话`;
}

function renderSession() {
  const connection = currentConnection();
  $("#session-panel").hidden = !connection;
  $("#empty-state").hidden = Boolean(connection);
  ["#connection-toggle", "#clear-terminal", "#connection-info"].forEach((selector) => { $(selector).disabled = !connection; });
  sessions.forEach((session, id) => { session.mount.hidden = id !== activeId; });
  if (!connection) {
    $("#status-connection").innerHTML = '<span class="status-dot offline"></span>未连接';
    ["#status-type", "#status-address", "#status-config", "#status-traffic", "#terminal-dimensions"].forEach((selector) => { $(selector).textContent = ""; });
    return;
  }
  $("#session-panel").setAttribute("aria-labelledby", `tab-${connection.id}`);
  $("#status-connection").innerHTML = `<span class="status-dot ${connection.online ? "" : "offline"}"></span>${connection.online ? "已连接" : "已断开"}`;
  $("#status-type").textContent = connection.type === "ssh" ? "SSH" : "串口";
  $("#status-address").textContent = connection.address;
  $("#status-address").title = connection.address;
  $("#status-config").textContent = connection.config;
  $("#connection-toggle").innerHTML = `${icon(connection.online ? "pause" : "play")}<span>${connection.online ? "断开" : "重连"}</span>`;
  const session = sessions.get(connection.id) || createSession(connection);
  session.mount.hidden = false;
  session.term.options.disableStdin = !connection.online;
  fitActiveTerminal();
  updateTraffic(connection);
}

function updateTraffic(connection) {
  if (connection.id !== activeId) return;
  $("#status-traffic").textContent = `↓ ${formatBytes(connection.rx)}  ↑ ${formatBytes(connection.tx)}`;
}

function render() { renderSidebar(); renderTabs(); renderSession(); }

function openConnection(id, reconnect = true) {
  const connection = connectionById(id);
  if (!connection) return;
  if (!tabIds.includes(id)) tabIds.push(id);
  if (!connection.online && reconnect) {
    connection.online = true;
    const session = sessions.get(id);
    if (session) {
      session.term.writeln("\r\nConnection re-established.");
      session.buffer = "";
      session.caret = 0;
      writePrompt(session);
    }
  }
  activeId = id;
  render();
  document.getElementById(`tab-${id}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  if (matchMedia("(max-width: 740px)").matches) setSidebar(false);
  sessions.get(id)?.term.focus();
}

function closeTab(id) {
  const index = tabIds.indexOf(id);
  if (index < 0) return;
  const session = sessions.get(id);
  if (session) { session.term.dispose(); session.mount.remove(); sessions.delete(id); }
  connectionById(id).online = false;
  tabIds.splice(index, 1);
  if (activeId === id) activeId = tabIds[Math.min(index, tabIds.length - 1)] || null;
  render();
  if (activeId) document.getElementById(`tab-${activeId}`)?.focus();
}

function applyTheme(nextTheme) {
  theme = nextTheme;
  document.documentElement.dataset.theme = theme;
  $$('[data-theme-choice]').forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.themeChoice === theme)));
  const label = `切换为${theme === "light" ? "深色" : "浅色"}主题`;
  $("#theme-toggle").setAttribute("aria-label", label);
  $("#theme-toggle").title = label;
  $("#theme-toggle").innerHTML = icon(theme === "light" ? "moon" : "sun");
  sessions.forEach((session) => { session.term.options.theme = terminalTheme(); });
  savePreferences();
}

function applySize(nextSize) {
  size = nextSize;
  document.documentElement.dataset.size = size;
  $$('[data-size-choice]').forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.sizeChoice === size)));
  $("#font-size-label").textContent = `${FONT_SIZES[size]} px`;
  $("#size-status").textContent = `${FONT_SIZES[size]}px`;
  sessions.forEach((session) => { session.term.options.fontSize = FONT_SIZES[size]; });
  fitActiveTerminal();
  savePreferences();
  updateViewport();
}

function updateViewport() {
  const bounds = $("#app-shell").getBoundingClientRect();
  $("#viewport-size").textContent = `${Math.round(bounds.width)} × ${Math.round(bounds.height)}`;
}

function setSidebar(open) {
  const mobile = matchMedia("(max-width: 740px)").matches;
  document.body.classList.toggle("sidebar-open", mobile && open);
  document.body.classList.toggle("sidebar-hidden", !mobile && !open);
  $("#sidebar-backdrop").hidden = !mobile || !open;
  $("#sidebar-toggle").setAttribute("aria-expanded", String(open));
}

function sidebarIsOpen() {
  return matchMedia("(max-width: 740px)").matches ? document.body.classList.contains("sidebar-open") : !document.body.classList.contains("sidebar-hidden");
}

function toggleAppearance(open = $("#appearance-panel").hidden) {
  $("#appearance-panel").hidden = !open;
  $("#appearance-toggle").setAttribute("aria-expanded", String(open));
  if (open) updateViewport();
}

function hideMenu(restoreFocus = false) {
  $("#context-menu").hidden = true;
  if (restoreFocus) menuTrigger?.focus();
}

function showMenu(trigger, items) {
  hideMenu();
  menuTrigger = trigger;
  const menu = $("#context-menu");
  menu.replaceChildren();
  items.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.role = "menuitem";
    button.textContent = item.label;
    button.addEventListener("click", () => { hideMenu(); item.action(); });
    menu.append(button);
  });
  menu.hidden = false;
  const bounds = trigger.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(bounds.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(bounds.bottom + 5, innerHeight - menu.offsetHeight - 8))}px`;
  menu.querySelector("button")?.focus();
}

function openDialog({ title, description, fields, submitLabel, onSubmit, wide = false }) {
  hideMenu();
  toggleAppearance(false);
  $("#dialog-title").textContent = title;
  $("#dialog-description").textContent = description;
  $("#dialog-submit").textContent = submitLabel;
  $("#dialog-fields").innerHTML = fields;
  dialogAction = onSubmit;
  $("#editor-dialog").classList.toggle("dialog-wide", wide);
  $("#editor-dialog").setAttribute("aria-label", title);
  if (!$("#editor-dialog").open) $("#editor-dialog").showModal();
  $("#dialog-fields input, #dialog-fields select")?.focus();
}

function groupOptions(selected) { return groups.map((group) => `<option value="${escapeHtml(group.id)}" ${group.id === selected ? "selected" : ""}>${escapeHtml(group.name)}</option>`).join(""); }

function editGroup(group = null) {
  openDialog({ title: group ? "重命名分组" : "新建分组", description: "按项目、设备或调试用途组织你的连接。", fields: `<label class="dialog-field">分组名称<input name="name" required maxlength="24" placeholder="例如：Wi-Fi 7 联调" value="${escapeHtml(group?.name || "")}" /></label>`, submitLabel: group ? "保存" : "创建分组", onSubmit: (data) => {
    const name = String(data.get("name")).trim();
    if (!name) return false;
    if (groups.some((item) => item !== group && item.name === name)) { showToast("这个分组名称已存在"); return false; }
    if (group) group.name = name;
    else groups.push({ id: `group-${++idSequence}`, name, collapsed: false });
    render();
    showToast(group ? "分组名称已更新" : `已创建「${name}」，可拖动连接到这里`);
    return true;
  } });
}

function moveConnection(connection) {
  openDialog({ title: "移动到分组", description: connection.name, fields: `<label class="dialog-field">目标分组<select name="group">${groupOptions(connection.group)}</select></label>`, submitLabel: "移动", onSubmit: (data) => {
    connection.group = String(data.get("group"));
    groupById(connection.group).collapsed = false;
    render();
    showToast(`已移至「${groupById(connection.group).name}」`);
    return true;
  } });
}

function newConnection() {
  openDialog({ title: "新建连接", description: "添加一个演示连接，体验新的列表与会话布局。", fields: `<label class="dialog-field">连接名称<input name="name" required maxlength="40" placeholder="例如：实验室 AP" /></label><label class="dialog-field">连接类型<select name="type"><option value="serial">串口</option><option value="ssh">SSH</option></select></label><label class="dialog-field">端口或地址<input name="address" required maxlength="160" placeholder="/dev/ttyUSB2 或 root@192.168.1.1" /></label><label class="dialog-field">所属分组<select name="group">${groupOptions("ap")}</select></label>`, submitLabel: "创建并打开", onSubmit: (data) => {
    const name = String(data.get("name")).trim();
    const address = String(data.get("address")).trim();
    if (!name || !address) return false;
    const type = String(data.get("type"));
    const connection = { id: `connection-${++idSequence}`, name, short: name, address, type, group: String(data.get("group")), online: true, config: type === "ssh" ? "SSH · 端口 22" : "115200 · 8N1", host: "device", device: name, rx: 0, tx: 0 };
    connections.push(connection);
    groupById(connection.group).collapsed = false;
    openConnection(connection.id);
    showToast(`已创建「${name}」演示连接`);
    return true;
  } });
}

function terminalTheme() {
  const styles = getComputedStyle(document.documentElement);
  const color = (token) => styles.getPropertyValue(token).trim();
  return {
    background: color("--canvas"), foreground: color("--text"),
    cursor: color("--text"), cursorAccent: color("--canvas"),
    selectionBackground: color("--selected"), selectionInactiveBackground: color("--hover"),
    black: "#252524", brightBlack: color("--secondary"),
    red: theme === "light" ? "#aa423b" : "#e49c95",
    green: color("--green"), yellow: color("--amber"),
    blue: theme === "light" ? "#436b99" : "#a3bedb",
    magenta: theme === "light" ? "#875786" : "#cbaaca",
    cyan: theme === "light" ? "#397471" : "#9bcac5",
    white: "#eeeee9", brightWhite: "#ffffff",
  };
}

function promptFor(connection, colored = true) {
  const user = connection.type === "ssh" ? connection.address.split("@")[0] : "root";
  const prompt = `${user}@${connection.host}:~${user === "root" ? "#" : "$"} `;
  return colored ? `\x1b[32m${prompt}\x1b[0m` : prompt;
}

function writePrompt(session) { session.term.write(promptFor(session.connection)); }

function fitActiveTerminal() {
  const session = sessions.get(activeId);
  if (!session || session.mount.hidden || !session.mount.clientWidth || !session.mount.clientHeight) return;
  session.fit.fit();
  $("#terminal-dimensions").textContent = `${session.term.cols} × ${session.term.rows}`;
}

function createSession(connection) {
  const mount = document.createElement("div");
  mount.className = "terminal-mount";
  mount.dataset.terminalId = connection.id;
  $("#terminal-stage").append(mount);
  const term = new Terminal({
    fontFamily: '"Demo Plex Mono", monospace', fontSize: FONT_SIZES[size],
    fontWeight: 400, fontWeightBold: 500, lineHeight: 1.5,
    cursorBlink: true, cursorStyle: "block", cursorInactiveStyle: "outline",
    scrollback: 3000, convertEol: true, screenReaderMode: true,
    theme: terminalTheme(), disableStdin: !connection.online,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(mount);
  fit.fit();
  const session = { connection, mount, term, fit, buffer: "", caret: 0, history: [], historyIndex: -1, draft: "" };
  sessions.set(connection.id, session);
  term.textarea.setAttribute("aria-label", `${connection.name}终端输入`);
  term.attachCustomKeyEventHandler((event) => {
    if ((event.metaKey || event.ctrlKey) && ["=", "+", "-", "0"].includes(event.key)) return false;
    if ((event.metaKey || event.ctrlKey) && ["k", "n"].includes(event.key.toLowerCase())) return false;
    return true;
  });
  term.onData((data) => handleTerminalData(session, data));
  writeInitialOutput(session);
  return session;
}

function writeInitialOutput(session) {
  const { term, connection } = session;
  if (connection.type === "serial") {
    [
      "[    0.000000] Booting Linux on physical CPU 0x0",
      "[    0.000000] Linux version 5.15.167 (builder@openwrt)",
      "[    0.104716] Machine model: " + connection.device,
      "[    0.417382] Serial: 8250/16550 driver, 16 ports",
      "[    1.328153] eth0: link up (1000Mbps/Full duplex)",
      "[    2.471921] br-lan: port 1(eth0) entered forwarding state",
      "[    3.010582] procd: - init complete -",
    ].forEach((line) => term.writeln(`\x1b[90m${line}\x1b[0m`));
    term.writeln("");
    term.writeln("BusyBox v1.36.1 built-in shell (ash)");
  } else {
    term.writeln(`Connecting to ${connection.address}...`);
    term.writeln(`\x1b[90mSSH-2.0-OpenSSH_9.6 · publickey authentication\x1b[0m`);
    term.writeln(`Last login: Fri Oct 30 09:40:18 2026 from 192.168.20.2`);
    term.writeln("");
    term.writeln("Linux " + connection.host + " 5.15.167 #1 SMP aarch64");
  }
  term.writeln("");
  term.writeln(promptFor(connection) + "cat /etc/os-release");
  term.writeln('NAME="OpenWrt"');
  term.writeln('VERSION="23.05.5"');
  term.writeln(`PRETTY_NAME="OpenWrt 23.05.5 · ${connection.device}"`);
  term.writeln("");
  term.writeln(promptFor(connection) + "ip -br addr");
  const address = connection.id.includes("gateway") ? "192.168.20.10" : "192.168.20.51";
  term.writeln("lo         UNKNOWN   127.0.0.1/8 ::1/128");
  term.writeln(`br-lan     UP        ${address}/24`);
  term.writeln("eth0       UP        10.10.0.2/24");
  term.writeln("wlan0      UP        172.16.0.1/24");
  term.writeln("");
  writePrompt(session);
}

function columnWidth(value) {
  return [...value].reduce((width, character) => width + (character.codePointAt(0) >= 0x1100 && /[^\u2000-\u206f]/u.test(character) ? 2 : 1), 0);
}

function redrawInput(session) {
  session.term.write("\r\x1b[2K" + promptFor(session.connection) + session.buffer);
  const remaining = columnWidth([...session.buffer].slice(session.caret).join(""));
  if (remaining) session.term.write(`\x1b[${remaining}D`);
}

function handleTerminalData(session, data) {
  if (!session.connection.online) return;
  const characters = [...session.buffer];
  if (data === "\x1b[A" || data === "\x1b[B") {
    if (!session.history.length) return;
    if (session.historyIndex === -1) session.draft = session.buffer;
    session.historyIndex = data === "\x1b[A" ? Math.min(session.historyIndex + 1, session.history.length - 1) : Math.max(session.historyIndex - 1, -1);
    session.buffer = session.historyIndex < 0 ? session.draft : session.history[session.history.length - 1 - session.historyIndex];
    session.caret = [...session.buffer].length;
    redrawInput(session);
    return;
  }
  if (data === "\x1b[D" || data === "\x1b[C") {
    const next = session.caret + (data === "\x1b[D" ? -1 : 1);
    if (next >= 0 && next <= characters.length) {
      const movingRight = next > session.caret;
      const distance = columnWidth(characters[movingRight ? session.caret : next]);
      session.term.write(`\x1b[${distance}${movingRight ? "C" : "D"}`);
      session.caret = next;
    }
    return;
  }
  if (data === "\x7f" || data === "\b") {
    if (session.caret > 0) {
      characters.splice(--session.caret, 1);
      session.buffer = characters.join("");
      redrawInput(session);
    }
    return;
  }
  if (data === "\x1b[3~") {
    characters.splice(session.caret, 1);
    session.buffer = characters.join("");
    redrawInput(session);
    return;
  }
  if (["\x1b[H", "\x01", "\x1b[F", "\x05"].includes(data)) {
    session.caret = ["\x1b[H", "\x01"].includes(data) ? 0 : characters.length;
    redrawInput(session);
    return;
  }
  if (data === "\x03") {
    session.term.write("^C\r\n");
    session.buffer = "";
    session.caret = 0;
    writePrompt(session);
    return;
  }
  if (data === "\x0c") { clearTerminal(); return; }
  if (data === "\r") { executeCommand(session); return; }
  if (data.startsWith("\x1b")) return;
  for (const character of data.replace(/\r\n/g, "\r")) {
    if (character === "\r" || character === "\n") { executeCommand(session); continue; }
    if (character < " " || character === "\x7f") continue;
    if (session.buffer.length >= 512) continue;
    const input = [...session.buffer];
    input.splice(session.caret++, 0, character);
    session.buffer = input.join("");
    redrawInput(session);
  }
}

function commandOutput(command, connection) {
  if (command === "help") return ["Commands: uname, cat /etc/os-release, ip, ping,", "          uptime, ls, pwd, whoami, echo, clear, exit"];
  if (command === "cat /etc/os-release") return ['NAME="OpenWrt"', 'VERSION="23.05.5"', `PRETTY_NAME="OpenWrt 23.05.5 · ${connection.device}"`];
  if (/^uname\b/.test(command)) return [`Linux ${connection.host} 5.15.167 #1 SMP aarch64 GNU/Linux`];
  if (/^(ip|ifconfig)\b/.test(command)) return ["lo         UNKNOWN   127.0.0.1/8 ::1/128", `br-lan     UP        ${connection.id.includes("gateway") ? "192.168.20.10" : "192.168.20.51"}/24`, "eth0       UP        10.10.0.2/24", "wlan0      UP        172.16.0.1/24"];
  if (/^ping\b/.test(command)) {
    const target = command.split(/\s+/).pop();
    return [`PING ${target}: 56 data bytes`, `64 bytes from ${target}: seq=0 ttl=64 time=0.623 ms`, `64 bytes from ${target}: seq=1 ttl=64 time=0.518 ms`, `64 bytes from ${target}: seq=2 ttl=64 time=0.571 ms`, "", "3 packets transmitted, 3 received, 0% packet loss"];
  }
  if (command === "uptime") return ["09:41:26 up 2 days, 04:18, load average: 0.08, 0.12, 0.09"];
  if (command === "ls") return ["bin  dev  etc  lib  mnt  proc  root  sys  tmp  usr  var"];
  if (command === "pwd") return ["/root"];
  if (command === "whoami") return [connection.type === "ssh" ? connection.address.split("@")[0] : "root"];
  if (/^echo(?:\s|$)/.test(command)) return [command.slice(4).trim().replace(/^(["'])(.*)\1$/, "$2")];
  return [`sh: ${command.split(/\s+/)[0]}: not found`];
}

function executeCommand(session) {
  const command = session.buffer.trim();
  session.term.write("\r\n");
  session.buffer = "";
  session.caret = 0;
  session.historyIndex = -1;
  if (!command) { writePrompt(session); return; }
  session.history.push(command);
  if (session.history.length > 100) session.history.shift();
  session.connection.tx += new TextEncoder().encode(command).length + 1;
  if (command === "clear") { session.term.write("\x1b[2J\x1b[H"); writePrompt(session); updateTraffic(session.connection); return; }
  if (command === "exit") {
    session.term.writeln("logout\r\nConnection closed.");
    session.connection.online = false;
    render();
    return;
  }
  const output = commandOutput(command, session.connection);
  output.forEach((line) => session.term.writeln(line));
  session.connection.rx += new TextEncoder().encode(output.join("\n")).length;
  writePrompt(session);
  updateTraffic(session.connection);
}

function clearTerminal() {
  const session = sessions.get(activeId);
  if (!session) return;
  session.term.write("\x1b[2J\x1b[H");
  session.buffer = "";
  session.caret = 0;
  if (session.connection.online) writePrompt(session);
  session.term.focus();
}

function showConnectionInfo(connection) {
  openDialog({ title: "连接信息", description: connection.name, fields: `<dl class="connection-info-fields">${[["类型", connection.type === "ssh" ? "SSH" : "串口"], ["地址", connection.address], ["参数", connection.config], ["分组", groupById(connection.group).name], ["状态", connection.online ? "已连接" : "未连接"]].map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>`, submitLabel: "完成", onSubmit: () => true });
}

function renderSidebar() {
  const isConnectionPanel = activePanel === "connections";
  $("#connection-groups").hidden = !isConnectionPanel;
  $("#library-list").hidden = isConnectionPanel;
  $("#library-actions").hidden = isConnectionPanel;
  $("#macro-count").textContent = libraries.macros.length;
  $("#script-count").textContent = libraries.scripts.length;
  if (isConnectionPanel) { renderGroups(); return; }
  const kind = activePanel === "macros" ? "宏" : "脚本";
  const items = libraries[activePanel].filter((item) => `${item.name} ${item.group}`.includes(query));
  const names = [...new Set(items.map((item) => item.group))];
  $("#library-list").innerHTML = `<div class="library-target">当前目标端口<strong>${escapeHtml(currentConnection()?.name || "未选择端口")}</strong></div>` + names.map((name) => {
    const grouped = items.filter((item) => item.group === name);
    const key = `${activePanel}:${name}`;
    return `<section class="library-group"><button class="library-group-title" data-library-group="${escapeHtml(key)}" aria-expanded="${!libraryCollapsed.has(key)}">${icon("chevron")}${escapeHtml(name)}<span class="group-count">${grouped.length}</span></button><div ${libraryCollapsed.has(key) ? "hidden" : ""}>${grouped.map((item) => `<div class="library-row"><button class="library-item-open" data-library-edit="${item.id}" title="编辑${kind}">${icon(activePanel === "macros" ? "bolt" : "code")}<span><span class="library-item-name">${escapeHtml(item.name)}</span><span class="library-item-meta">${escapeHtml(item.meta)}</span></span></button><button class="icon-button" data-library-run="${item.id}" aria-label="运行${kind} ${escapeHtml(item.name)}" title="运行">${icon("play")}</button><button class="icon-button" data-library-menu="${item.id}" aria-label="管理${kind} ${escapeHtml(item.name)}" title="管理">${icon("more")}</button></div>`).join("")}</div></section>`;
  }).join("") + (!items.length ? '<p class="no-results">没有匹配的条目</p>' : "");
}

function switchPanel(panel) {
  activePanel = panel;
  query = "";
  $("#connection-search").value = "";
  const kind = panel === "connections" ? "连接" : panel === "macros" ? "宏" : "脚本";
  $("#connection-search").placeholder = `搜索${kind}…`;
  $("#create-label").textContent = `新建${kind}`;
  $("#list-heading").textContent = `${kind}分组`;
  $("#new-group").setAttribute("aria-label", panel === "connections" ? "新建分组" : `新建${kind}`);
  $("#new-group").title = panel === "connections" ? "新建分组" : `新建${kind}`;
  $$("[data-panel]").forEach((button) => {
    const selected = button.dataset.panel === panel;
    button.classList.toggle("active", selected);
    if (selected) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  renderSidebar();
}

function createForPanel() { activePanel === "connections" ? newConnection() : editLibraryItem(activePanel); }

function editLibraryItem(panel, item = null) {
  const macro = panel === "macros";
  const kind = macro ? "宏" : "脚本";
  const script = 'await clear();\nawait send("uname -a");\nconst result = await expect("Linux", 3000);\nif (!result) throw new Error("Device response timed out");\nlog(result);';
  const content = macro
    ? '<table class="step-preview"><thead><tr><th>#</th><th>操作</th><th>内容</th></tr></thead><tbody><tr><td>1</td><td>发送</td><td class="mono">uname -a</td></tr><tr><td>2</td><td>等待</td><td>匹配 Linux，超时 3000 ms</td></tr><tr><td>3</td><td>延时</td><td>500 ms</td></tr></tbody></table><button class="text-button" type="button" data-layout-action="添加步骤">＋ 添加步骤</button>'
    : `<label class="dialog-field">JavaScript<textarea name="code" spellcheck="false">${escapeHtml(item?.code || script)}</textarea></label>`;
  openDialog({ title: `${item ? "编辑" : "新建"}${kind}`, description: `目标端口：${currentConnection()?.name || "运行时选择"}`, wide: true,
    fields: `<div class="field-row"><label class="dialog-field">名称<input name="name" required maxlength="40" value="${escapeHtml(item?.name || "")}" placeholder="${macro ? "例如：读取版本" : "例如：设备信息采集"}" /></label><label class="dialog-field">分组<input name="group" value="${escapeHtml(item?.group || (macro ? "设备初始化" : "设备检查"))}" required /></label></div>${content}`,
    submitLabel: "保存", onSubmit: (data) => {
      const value = { id: item?.id || `library-${++idSequence}`, name: String(data.get("name")).trim(), group: String(data.get("group")).trim(), meta: macro ? "3 个步骤 · 发送 / 等待" : "JavaScript · 当前端口", code: String(data.get("code") || "") };
      if (!value.name || !value.group) return false;
      if (item) Object.assign(item, value); else libraries[panel].push(value);
      renderSidebar();
      showToast(`${kind}已保存到演示列表`);
      return true;
    } });
}

function addRemoteDevice() {
  openDialog({ title: "添加远程设备", description: "连接远程 Serial Studio 服务。", fields: '<div class="field-row"><label class="dialog-field">地址<input name="host" required placeholder="192.168.1.50" /></label><label class="dialog-field">端口<input name="port" type="number" min="1" max="65535" value="18700" required /></label></div><label class="dialog-field">昵称<input name="nickname" maxlength="40" placeholder="可选，如「实验室服务器」" /></label><p class="library-hint">添加后作为远程设备分组显示在连接列表中。</p>', submitLabel: "添加", onSubmit: (data) => {
    const host = String(data.get("host")).trim();
    if (!host) return false;
    const name = String(data.get("nickname")).trim() || host;
    const id = `remote-${++idSequence}`;
    groups.push({ id, name, collapsed: false, remote: true });
    connections.push({ id: `${id}-serial`, name: "远程串口", short: name, address: `${host}:${data.get("port")}::/dev/ttyUSB0`, type: "serial", group: id, online: false, config: "115200 · 8N1", host: "remote", device: name, rx: 0, tx: 0 });
    switchPanel("connections");
    showToast("远程设备已添加到演示列表");
    return true;
  } });
}

function showSettings() {
  openDialog({ title: "设置", description: "界面、服务监听与脚本选项。", wide: true,
    fields: `<div class="settings-nav" role="tablist" aria-label="设置分类"><button type="button" role="tab" data-setting-tab="general" aria-selected="true">常规</button><button type="button" role="tab" data-setting-tab="server" aria-selected="false">本地服务</button><button type="button" role="tab" data-setting-tab="shortcuts" aria-selected="false">快捷键</button></div><div data-setting-content="general"><label class="settings-row"><span>主题<small>窗口与终端同步切换</small></span><select name="theme"><option value="light" ${theme === "light" ? "selected" : ""}>浅色</option><option value="dark" ${theme === "dark" ? "selected" : ""}>深色</option></select></label><label class="settings-row"><span>界面与终端字号<small>统一字号与控件间距</small></span><select name="size">${Object.entries(FONT_SIZES).map(([id, pixels]) => `<option value="${id}" ${size === id ? "selected" : ""}>${pixels} px</option>`).join("")}</select></label><label class="settings-row"><span>脚本日志<small>log 输出自动落盘</small></span><input type="checkbox" name="script_logs" checked /></label></div><div data-setting-content="server" hidden><div class="settings-section-title">服务器监听</div><label class="dialog-field">监听地址<input name="listen" value="127.0.0.1" /></label><div class="field-row"><label class="dialog-field">WebSocket 端口<input name="ws_port" type="number" value="18700" /></label><label class="dialog-field">Telnet 端口<input name="telnet_port" type="number" value="18701" /></label></div><label class="settings-row"><span>远程脚本<small>允许远程执行 JS 脚本</small></span><input type="checkbox" name="remote_scripts" /></label></div><div data-setting-content="shortcuts" hidden><table class="step-preview"><tbody><tr><td>搜索</td><td>⌘ / Ctrl + K</td></tr><tr><td>新建</td><td>⌘ / Ctrl + N</td></tr><tr><td>字号</td><td>⌘ / Ctrl + ＋ / −</td></tr><tr><td>清屏</td><td>Ctrl + L</td></tr></tbody></table></div>`,
    submitLabel: "应用", onSubmit: (data) => { applyTheme(String(data.get("theme"))); applySize(String(data.get("size"))); showToast("演示外观已应用"); return true; } });
}

$("#library-list").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const group = button.dataset.libraryGroup;
  if (group) { libraryCollapsed.has(group) ? libraryCollapsed.delete(group) : libraryCollapsed.add(group); renderSidebar(); return; }
  const item = libraries[activePanel].find((entry) => entry.id === (button.dataset.libraryEdit || button.dataset.libraryRun || button.dataset.libraryMenu));
  if (!item) return;
  if (button.dataset.libraryRun) { showToast(`「${item.name}」运行入口 · 目标：${currentConnection()?.name || "未选择端口"}（布局演示）`); return; }
  if (button.dataset.libraryMenu) {
    showMenu(button, [{ label: "编辑", action: () => editLibraryItem(activePanel, item) }, { label: "删除", action: () => { libraries[activePanel] = libraries[activePanel].filter((entry) => entry !== item); renderSidebar(); } }]);
  } else editLibraryItem(activePanel, item);
});
$("#add-remote").addEventListener("click", addRemoteDevice);
$("#settings-open").addEventListener("click", showSettings);
$("#library-import").addEventListener("click", () => showToast("导入入口（布局演示）"));
$("#library-export").addEventListener("click", () => showToast("导出入口（布局演示）"));
$("#dialog-fields").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.settingTab) {
    $$("[data-setting-tab]").forEach((tab) => tab.setAttribute("aria-selected", String(tab === button)));
    $$("[data-setting-content]").forEach((panel) => { panel.hidden = panel.dataset.settingContent !== button.dataset.settingTab; });
  }
  if (button.dataset.layoutAction) showToast(`${button.dataset.layoutAction}入口（布局演示）`);
});

$("#connection-groups").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const group = groupById(button.dataset.group);
  const connection = connectionById(button.dataset.id);
  switch (button.dataset.action) {
    case "toggle-group": group.collapsed = !group.collapsed; renderGroups(); break;
    case "open": openConnection(connection.id); break;
    case "group-menu": showMenu(button, [{ label: "重命名分组", action: () => editGroup(group) }, { label: "在此分组新建连接", action: () => { newConnection(); $('#dialog-fields select[name="group"]').value = group.id; } }, { label: group.collapsed ? "展开分组" : "折叠分组", action: () => { group.collapsed = !group.collapsed; renderGroups(); } }]); break;
    case "connection-menu": showMenu(button, [{ label: "打开连接", action: () => openConnection(connection.id) }, { label: "移动到分组…", action: () => moveConnection(connection) }, { label: "连接信息", action: () => showConnectionInfo(connection) }]); break;
  }
});

$("#connection-groups").addEventListener("dragstart", (event) => {
  const row = event.target.closest(".connection-row");
  if (!row) return;
  event.dataTransfer.setData("text/plain", row.dataset.connectionId);
  event.dataTransfer.effectAllowed = "move";
  row.classList.add("dragging");
});
$("#connection-groups").addEventListener("dragover", (event) => {
  const group = event.target.closest("[data-group-id]");
  if (!group) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  $$("[data-drop-target]").forEach((item) => delete item.dataset.dropTarget);
  group.dataset.dropTarget = "true";
});
$("#connection-groups").addEventListener("dragleave", (event) => {
  const group = event.target.closest("[data-group-id]");
  if (group && !group.contains(event.relatedTarget)) delete group.dataset.dropTarget;
});
$("#connection-groups").addEventListener("drop", (event) => {
  const group = event.target.closest("[data-group-id]");
  if (!group) return;
  event.preventDefault();
  const connection = connectionById(event.dataTransfer.getData("text/plain"));
  if (!connection) return;
  connection.group = group.dataset.groupId;
  groupById(connection.group).collapsed = false;
  render();
  showToast(`已移至「${groupById(connection.group).name}」`);
});
$("#connection-groups").addEventListener("dragend", () => {
  $$(".dragging").forEach((item) => item.classList.remove("dragging"));
  $$("[data-drop-target]").forEach((item) => delete item.dataset.dropTarget);
});

$("#session-tabs").addEventListener("click", (event) => {
  const close = event.target.closest("[data-close-tab]");
  const tab = event.target.closest("[data-tab-id]");
  if (close) closeTab(close.dataset.closeTab);
  else if (tab) openConnection(tab.dataset.tabId, false);
});
$("#session-tabs").addEventListener("keydown", (event) => {
  if (!event.target.matches('[role="tab"]')) return;
  const index = tabIds.indexOf(activeId);
  const nextIndex = { ArrowRight: (index + 1) % tabIds.length, ArrowLeft: (index - 1 + tabIds.length) % tabIds.length, Home: 0, End: tabIds.length - 1 }[event.key];
  if (nextIndex === undefined) return;
  event.preventDefault();
  openConnection(tabIds[nextIndex], false);
  document.getElementById(`tab-${activeId}`)?.focus();
});
$("#connection-search").addEventListener("input", (event) => { query = event.target.value.toLowerCase().trim(); renderSidebar(); });
$("#new-group").addEventListener("click", () => activePanel === "connections" ? editGroup() : editLibraryItem(activePanel));
$("#new-connection").addEventListener("click", createForPanel);
["#tab-add", "#empty-connect"].forEach((selector) => $(selector).addEventListener("click", newConnection));
$$("[data-panel]").forEach((button) => button.addEventListener("click", () => switchPanel(button.dataset.panel)));
$("#appearance-toggle").addEventListener("click", () => toggleAppearance());
$("#appearance-close").addEventListener("click", () => { toggleAppearance(false); $("#appearance-toggle").focus(); });
$("#theme-toggle").addEventListener("click", () => applyTheme(theme === "light" ? "dark" : "light"));
$$('[data-theme-choice]').forEach((button) => button.addEventListener("click", () => applyTheme(button.dataset.themeChoice)));
$$('[data-size-choice]').forEach((button) => button.addEventListener("click", () => applySize(button.dataset.sizeChoice)));
$$('[data-window-choice]').forEach((button) => button.addEventListener("click", () => {
  document.body.dataset.window = button.dataset.windowChoice;
  $$('[data-window-choice]').forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
  updateViewport();
}));
$("#sidebar-toggle").addEventListener("click", () => setSidebar(!sidebarIsOpen()));
$("#sidebar-backdrop").addEventListener("click", () => setSidebar(false));
$("#clear-terminal").addEventListener("click", clearTerminal);
$("#connection-info").addEventListener("click", () => { if (currentConnection()) showConnectionInfo(currentConnection()); });
$("#connection-toggle").addEventListener("click", () => {
  const connection = currentConnection();
  if (!connection) return;
  connection.online = !connection.online;
  const session = sessions.get(connection.id);
  if (session) {
    session.buffer = "";
    session.caret = 0;
    session.term.writeln(connection.online ? "\r\nConnection re-established." : "\r\nConnection closed.");
    if (connection.online) writePrompt(session);
  }
  render();
  if (connection.online) session?.term.focus();
});
$("#editor-form").addEventListener("submit", (event) => { event.preventDefault(); if (dialogAction?.(new FormData(event.target))) $("#editor-dialog").close(); });
["#dialog-close", "#dialog-cancel"].forEach((selector) => $(selector).addEventListener("click", () => $("#editor-dialog").close()));
$("#editor-dialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close(); } });
document.addEventListener("click", (event) => {
  if (!event.target.closest("#context-menu, .group-menu, .connection-menu")) hideMenu();
  if (!event.target.closest("#appearance-panel, #appearance-toggle")) toggleAppearance(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { hideMenu(true); toggleAppearance(false); if (matchMedia("(max-width: 740px)").matches) setSidebar(false); }
  if ($("#editor-dialog").open) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSidebar(true); $("#connection-search").focus(); }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") { event.preventDefault(); createForPanel(); }
  if ((event.metaKey || event.ctrlKey) && ["=", "+", "-", "0"].includes(event.key)) {
    event.preventDefault();
    const sizes = Object.keys(FONT_SIZES);
    applySize(event.key === "0" ? "standard" : sizes[Math.max(0, Math.min(2, sizes.indexOf(size) + (event.key === "-" ? -1 : 1)))]);
  }
});
$("#context-menu").addEventListener("keydown", (event) => {
  const buttons = [...event.currentTarget.querySelectorAll("button")];
  const index = buttons.indexOf(document.activeElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
  if (event.key === "Tab") hideMenu();
});
matchMedia("(max-width: 740px)").addEventListener("change", () => setSidebar(!matchMedia("(max-width: 740px)").matches));
new ResizeObserver(() => { updateViewport(); fitActiveTerminal(); }).observe($("#terminal-stage"));
applyTheme(theme);
applySize(size);
setSidebar(!matchMedia("(max-width: 740px)").matches);
Promise.all([
  document.fonts.load('400 15px "Demo Plex Mono"'),
  document.fonts.load('500 15px "Demo Plex Mono"'),
]).then(render, render);
