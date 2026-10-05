import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, schema } from "./index.ts";
import { runMigrations } from "./migrations.ts";

// 集成测试：需要真实 PostgreSQL，未设 DATABASE_URL 时跳过。
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("database (integration)", () => {
  const { db, pool } = createDb(databaseUrl ?? "");

  afterAll(async () => {
    await pool.end();
  });

  it("applies migrations idempotently and round-trips a row", async () => {
    await runMigrations(db);
    await runMigrations(db);

    const action = `test-${String(Date.now())}`;
    const [inserted] = await db.insert(schema.auditEvents).values({ action }).returning();
    expect(inserted?.id).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, action));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);

    // 不清理：#29 起 audit_events append-only（行级 DELETE 被拒），而本文件与
    // 并行测试文件共享同一个库，TRUNCATE 会抹掉别的文件正在断言的行——action
    // 带时间戳唯一前缀，残行无人依赖（共享库上的纪律：谁需要空表谁自己开独立库，
    // 见 routes/audit-events.test.ts）。
  });
});
