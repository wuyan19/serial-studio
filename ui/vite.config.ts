import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // Tauri 内嵌时前端从 tauri:// 加载；相对资源路径用 base: "./" 更稳
  base: "./",
});
