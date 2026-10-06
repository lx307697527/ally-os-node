import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/src/**/*.test.{ts,tsx}", "packages/*/src/**/*.test.ts"],
    environment: "node",
    // 每文件临时库的 teardown（pool.end + drop database with (force)）在 postgres
    // 并行 DDL/连接风暴下可能超过默认 10s（#221 切片 2 把临时库文件 +1 后实测
    // 复现）：teardown 慢 ≠ 测试失败，给足窗口让自愈发生，不吞真失败
    hookTimeout: 30_000,
  },
});
