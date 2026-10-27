import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // dev 端口错开旧 ui 的 5173（保持关闭）
  server: {
    port: 5175,
    proxy: { "/api": "http://127.0.0.1:18800" },
  },
  // 嵌入后恒伺服于根路径；相对 base("./") 会在多层路由(/topologies/:id)下把
  // assets 解析到 /topologies/assets/ 而白屏——用绝对路径
  base: "/",
});
