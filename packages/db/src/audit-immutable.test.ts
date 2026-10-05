import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "./index.ts";

// 集成测试：需要真实 PostgreSQL（append-only 是数据库触发器的行为，应用层测不出）。
// 未设 DATABASE_URL 时跳过。
//
// #29 的不可变底线，老系统同裁决：core.audit_log 拒绝行级 UPDATE/DELETE
// （fix747 + fix906），理由不是「没有合法流量所以拦不住」——恰恰相反，不存在
// 合法流量，所以无条件拒绝；拦的正是绕过应用的人工写路径。
//
// 本文件跑在共享库上，**不 TRUNCATE、不做全表断言**：vitest 并行跑测试文件，
// 别的文件正往同一张表里写行——清库和全表计数都是双向干扰。每条测试用带
// 唯一前缀的 action，断言只认自己的行（纪律详见 docs/audit.md「测试清库的唯一
// 通道」）。
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("audit_events append-only (#29, integration)", () => {
  const { db, pool } = createDb(databaseUrl ?? "");
  const runId = `${String(Date.now())}-${String(process.pid)}`;

  afterAll(async () => {
    await pool.end();
  });

  function uniqueAction(test: string): string {
    return `immutable-${test}-${runId}`;
  }

  it("accepts inserts — appending is the table's whole job", async () => {
    await runMigrations(db);
    const action = uniqueAction("insert");
    await db.insert(schema.auditEvents).values({
      actor: "actor-1",
      action,
      target: "target-1",
      detail: { role: "admin" },
    });
    const rows = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, action));
    expect(rows).toHaveLength(1);
  });

  it("rejects UPDATE — a written audit line is never rewritten", async () => {
    const action = uniqueAction("update");
    await db.insert(schema.auditEvents).values({ action });
    const err = await rejectionOf(
      db.update(schema.auditEvents).set({ action: uniqueAction("rewritten") }).where(eq(schema.auditEvents.action, action)),
    );
    // drizzle 把 pg 错误包进 DrizzleQueryError（message 是失败的 SQL），触发器的
    // RAISE 在 cause 链上——断言打在真实原因上，而不是任何拒绝都算数
    expect(causeMessage(err)).toMatch(/append-only: UPDATE/);
    // 拒绝必须是真实的：原行原样还在，没有被改写
    const rows = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, action));
    expect(rows).toHaveLength(1);
  });

  it("rejects DELETE — a written audit line is never erased", async () => {
    const action = uniqueAction("delete");
    await db.insert(schema.auditEvents).values({ action });
    const err = await rejectionOf(db.delete(schema.auditEvents));
    expect(causeMessage(err)).toMatch(/append-only: DELETE/);
    // 拒绝必须是真实的：行还在
    const rows = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, action));
    expect(rows).toHaveLength(1);
  });
});

/** 测试只关心「拒绝 + 原因」：拿不到拒绝算失败（undefined 进断言报错） */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return new Error("expected the statement to be rejected, but it succeeded");
}

/** drizzle 的包装错误把 pg 的原始错误挂在 cause 上；逐层找带 message 的那层 */
function causeMessage(err: unknown): string {
  let current: unknown = err;
  while (current instanceof Error) {
    if (current.message.includes("append-only")) return current.message;
    current = (current as { cause?: unknown }).cause;
  }
  return err instanceof Error ? err.message : String(err);
}
