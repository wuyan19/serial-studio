import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // dev 端口错开旧 ui 的 5173（保持关闭）
  server: {
    port: 5175,
    proxy: { "/api": "http://127.0.0.1:18800" },
  },
  // 嵌入 topo-hub 二进制从任意路径加载，相对资源路径更稳
  base: "./",
});
