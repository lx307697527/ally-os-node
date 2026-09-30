import { createDb } from "./index.ts";
import { runMigrations } from "./migrations.ts";

// 部署流程里作为一次性任务执行：先迁移数据库，再滚动更新服务。
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const { db, pool } = createDb(databaseUrl);
try {
  await runMigrations(db);
  console.warn("migrations applied");
} finally {
  await pool.end();
}
