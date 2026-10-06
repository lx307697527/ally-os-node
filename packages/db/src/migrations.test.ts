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
      // 这两个池连着的库在本测试尾部被 drop (force)：拆库瞬间若还有空闲池连接
      // 未收完，Postgres 的 57P01 会被 pg Pool 按「空闲客户端出错」语义重发到
      // pool 对象上——没有监听就是未捕获异常，整轮 vitest 红（2026-10-06 CI：
      // 416 条测试全绿、仅此一处异步报错）。这是预期的拆除错误，按 pg 文档挂
      // 空 listener 吞掉；断言本身不受影响。
      for (const { pool } of [a, b]) pool.on("error", () => {});
      try {
        // 断言的是「并发迁移被串行化」的语义，不是速度：默认 5s 预算是给快机
        // 单测的，全量套件并行（65 worker 都在打同一个 postgres）时曾把它顶爆
        // （#110 切片 5 在套件里 +11 条 DB 测试后本地必红）。给足余量，让机器
        // 忙时测的仍然是那把锁，不是时钟。
        await expect(
          Promise.all([runMigrations(a.db), runMigrations(b.db)]),
        ).resolves.toHaveLength(2);
      } finally {
        await Promise.all([a.pool.end(), b.pool.end()]);
      }
    } finally {
      await adminPool.query(`drop database if exists "${dbName}" with (force)`);
    }
  }, 30_000);
});

/** 同一实例上连 maintenance 库（postgres）用的管理连接串。 */
function adminUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl) return ""; // 套件被跳过时不会被用到
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}
