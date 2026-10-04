import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "./index.ts";
import { runMigrations } from "./migrations.ts";

// 集成测试：需要真实 PostgreSQL，未设 DATABASE_URL 时跳过。
const databaseUrl = process.env.DATABASE_URL;

// 回归（2026-10-04）：两个进程对着同一个全新库并发跑 runMigrations，各自读
// journal 都判定「没跑过」，一起 CREATE TABLE 时 Postgres 在 pg_type 上报
// 重复键。runMigrations 现在用 advisory lock 串行化——这个测试就是那把锁的
// 证明：本地快机上，不加锁的版本几乎必红。
describe.skipIf(!databaseUrl)("runMigrations (integration)", () => {
  const adminPool = new pg.Pool({ connectionString: adminUrl(databaseUrl) });

  afterAll(async () => {
    await adminPool.end();
  });

  it("serializes concurrent migrators on a fresh database", async () => {
    if (!databaseUrl) throw new Error("unreachable: suite is skipped without DATABASE_URL");
    const dbName = `migration_race_${String(Date.now())}_${String(process.pid)}`;
    // 标识符不能走参数绑定，名字是本进程拼出来的固定格式，注入面可控。
    await adminPool.query(`create database "${dbName}"`);
    try {
      const raceUrl = new URL(databaseUrl);
      raceUrl.pathname = `/${dbName}`;
      const a = createDb(raceUrl.toString());
      const b = createDb(raceUrl.toString());
      try {
        await expect(Promise.all([runMigrations(a.db), runMigrations(b.db)])).resolves.toHaveLength(2);
      } finally {
        await Promise.all([a.pool.end(), b.pool.end()]);
      }
    } finally {
      await adminPool.query(`drop database if exists "${dbName}" with (force)`);
    }
  });
});

/** 同一实例上连 maintenance 库（postgres）用的管理连接串。 */
function adminUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl) return ""; // 套件被跳过时不会被用到
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}
