import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // strictPort:5173 被占(其它项目的 vite 残留)时直接报错,而不是静默跳 5174——
  // 否则 tauri.conf.json 的 devUrl(5173)会加载到占端口那个应用的界面,窗口显示张冠李戴
  server: { port: 5173, strictPort: true },
  // Tauri 内嵌时前端从 tauri:// 加载；相对资源路径用 base: "./" 更稳
  base: "./",
});
