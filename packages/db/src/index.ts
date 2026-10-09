import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.ts";

export { schema };
export { runMigrations } from "./migrations.ts";

export function createDb(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  // 空闲连接的后端被杀（对端重启、测试拆库 with (force) 抢在优雅关闭完成前）时
  // pg 把错误转发到 pool 的 'error' 事件；没有监听器就是 uncaught exception 打爆
  // 进程。挂空监听器：损坏的客户端由池在下一次 acquire 时淘汰自愈，查询面错误
  // 照常上抛，这里只吞掉「无人在等」的连接事件（pg 文档建议的标准形态）。
  pool.on("error", () => undefined);
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>["db"];
