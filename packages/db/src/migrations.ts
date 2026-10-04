import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Db } from "./index.ts";

export const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

// 并发迁移会在这里炸：两个进程同时跑 drizzle 的 migrate，各自读 journal 都判定
// 「没跑过」，然后一起 CREATE TABLE——Postgres 在 pg_type 上报重复键
// （审计于 2026-10-04：vitest 并行文件打全新库时复现，本地快机上稳定）。
// drizzle 的 migrate 没有跨进程互斥，用一把会话级 advisory lock 串起来；
// 拿到锁的进程重新读 journal，看到迁移已应用就直接跳过。
const MIGRATION_LOCK_KEY = 8_142_736_001;

export async function runMigrations(db: Db) {
  // advisory lock 是会话级的：锁、解锁和 migrate 必须在同一条连接上，
  // 所以从池里取一条专用连接，而不是走 db.execute（池会换连接）。
  const client = await db.$client.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await migrate(db, { migrationsFolder });
    } finally {
      await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
