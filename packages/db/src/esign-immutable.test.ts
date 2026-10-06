import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "./index.ts";

// 集成测试：需要真实 PostgreSQL（append-only 是数据库触发器的行为，应用层测不出）。
// 未设 DATABASE_URL 时跳过。
//
// #219 的不可变底线（Part 11.200）：签名是「发生过的事实」，改写或抹掉都不存在
// 合法业务路径（更正走新记录/变更流程），无条件拒绝——与 audit_events 的 0007
// 同一裁决，触发器在 0012。
//
// 本文件跑在共享库上，**不 TRUNCATE、不做全表断言**（纪律详见 docs/audit.md
// 「测试清库的唯一通道」）。esign_signatures 的行要挂真实用户（signer_id 外键），
// 用户行按唯一邮箱现场建，测试结束不清理（临时性可接受：并行文件互不读取对方
// 的行，断言全部按 clientToken 前缀收窄到自己的行）。
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("esign_signatures append-only (#219, integration)", () => {
  const { db, pool } = createDb(databaseUrl ?? "");
  const runId = `${String(Date.now())}-${String(process.pid)}`;

  afterAll(async () => {
    await pool.end();
  });

  // 外键要真实用户；邮箱带 runId 保证不撞已有行（撞了就是测试间干扰，让它红）
  async function ensureSigner(): Promise<string> {
    const email = `esign-immutable-${runId}@example.com`;
    await db
      .insert(schema.authUser)
      .values({ name: "Esign Immutable", email })
      .onConflictDoNothing();
    const rows = await db
      .select({ id: schema.authUser.id })
      .from(schema.authUser)
      .where(eq(schema.authUser.email, email))
      .limit(1);
    const id = rows[0]?.id;
    if (id === undefined) throw new Error("signer row missing after upsert");
    return id;
  }

  async function insertSignature(clientToken: string): Promise<string> {
    await db.insert(schema.esignSignatures).values({
      subjectType: "immutable-check",
      // 每条签名一个独立 subject：同人同义唯一约束（一人一号）会拦下同 key 的
      // 第二行，而本测试要打的是 append-only 触发器，不是去重约束
      subjectId: randomUUID(),
      signerId: await ensureSigner(),
      meaning: "performed",
      recordVersion: "v1",
      recordHash: "00".repeat(32),
      signedAt: new Date(),
      clientToken,
    });
    return clientToken;
  }

  it("accepts inserts — a signature exists once it is made", async () => {
    await runMigrations(db);
    const clientToken = `insert-${runId}`;
    await insertSignature(clientToken);
    const rows = await db
      .select()
      .from(schema.esignSignatures)
      .where(eq(schema.esignSignatures.clientToken, clientToken));
    expect(rows).toHaveLength(1);
  });

  it("rejects UPDATE — a made signature is never rewritten", async () => {
    const clientToken = `update-${runId}`;
    await insertSignature(clientToken);
    const err = await rejectionOf(
      db
        .update(schema.esignSignatures)
        .set({ recordVersion: "v2-rewritten" })
        .where(eq(schema.esignSignatures.clientToken, clientToken)),
    );
    // drizzle 把 pg 错误包进 DrizzleQueryError（message 是失败的 SQL），触发器的
    // RAISE 在 cause 链上——断言打在真实原因上，而不是任何拒绝都算数
    expect(causeMessage(err)).toMatch(/append-only: UPDATE/);
    const rows = await db
      .select()
      .from(schema.esignSignatures)
      .where(eq(schema.esignSignatures.clientToken, clientToken));
    expect(rows[0]?.recordVersion).toBe("v1");
  });

  it("rejects DELETE — a made signature is never erased", async () => {
    const clientToken = `delete-${runId}`;
    await insertSignature(clientToken);
    const err = await rejectionOf(
      db.delete(schema.esignSignatures).where(eq(schema.esignSignatures.clientToken, clientToken)),
    );
    expect(causeMessage(err)).toMatch(/append-only: DELETE/);
    const rows = await db
      .select()
      .from(schema.esignSignatures)
      .where(eq(schema.esignSignatures.clientToken, clientToken));
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
