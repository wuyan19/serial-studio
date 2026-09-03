import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { isTauri } from "./lib";
import "./styles.css";

// 桌面壳(Tauri WebView2/WKWebView/webkitgtk)里未 preventDefault 的空白处右键会弹
// 浏览器默认菜单(后退/刷新/打印/检查)——桌面应用观感突兀,全局拦掉。仅 Tauri 形态
// 拦截:Web 模式跑在普通浏览器里,原生右键(选中后复制/检查等)是用户预期,不动。
// 各自持右键菜单的区域(终端/侧栏设备卡/宏分组头)不受影响:它们本就自行 preventDefault
// 再渲染浮层,不依赖浏览器默认行为。可编辑元素留白——输入框右键的剪切/复制/粘贴
// 仍有用(与 GroupHead 重命名态放行原生右键是同一意图,CodeMirror 编辑区 contenteditable 同理)。
if (isTauri()) {
  document.addEventListener("contextmenu", (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest('input, textarea, [contenteditable="true"]')) return;
    e.preventDefault();
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
