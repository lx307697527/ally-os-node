import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { resolveBuildId, versionPlugin } from "./src/build/version-plugin.ts";

const apiTarget = process.env.VITE_API_PROXY ?? "http://localhost:3000";

export default defineConfig({
  // #129 slice 3: every build pins its id (git SHA, or a timestamp when no
  // repository is present) into the bundle AND drops it as /version.json
  // next to index.html — the two ends the runtime watch compares.
  plugins: [react(), tailwindcss(), versionPlugin({ buildId: resolveBuildId() })],
  server: {
    port: 5173,
    // 本地开发把 API 请求转发到 apps/api；线上由负载均衡按路径分流
    proxy: {
      "/api": apiTarget,
      "/health": apiTarget,
    },
  },
});
