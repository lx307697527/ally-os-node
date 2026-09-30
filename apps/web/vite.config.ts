import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget = process.env.VITE_API_PROXY ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 本地开发把 API 请求转发到 apps/api；线上由负载均衡按路径分流
    proxy: {
      "/api": apiTarget,
      "/health": apiTarget,
    },
  },
});
