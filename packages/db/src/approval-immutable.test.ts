import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "./index.ts";

// 集成测试：需要真实 PostgreSQL（append-only 是数据库触发器的行为，应用层测不出）。
// 未设 DATABASE_URL 时跳过。
//
// #221 的历史底线：审批裁决是「发生过的事实」（验收原话「审批记录可追溯：谁、
// 何时、同意或驳回、意见」），改写或撤回都不存在合法业务路径——驳回到发起人是
// 新请求，不是改旧裁决。无条件拒绝——与 audit_events（0007）、esign_signatures
// （0012）、workflow_transitions（0013）同一裁决，触发器在 0014。
//
// 本文件跑在共享库上，不 TRUNCATE、不做全表断言（纪律详见 docs/audit.md
// 「测试清库的唯一通道」）。裁决行要挂真实用户与请求行，按 runId 隔离。
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("approval_actions append-only (#221, integration)", () => {
  const { db, pool } = createDb(databaseUrl ?? "");
  const runId = `${String(Date.now())}-${String(process.pid)}`;

  afterAll(async () => {
    await pool.end();
  });

  async function ensureActor(): Promise<string> {
    const email = `approval-immutable-${runId}@example.com`;
    await db.insert(schema.authUser).values({ name: "Approval Immutable", email }).onConflictDoNothing();
    const rows = await db
      .select({ id: schema.authUser.id })
      .from(schema.authUser)
      .where(eq(schema.authUser.email, email))
      .limit(1);
    const id = rows[0]?.id;
    if (id === undefined) throw new Error("actor row missing after upsert");
    return id;
  }

  async function insertRequest(key: string): Promise<string> {
    await runMigrations(db);
    const actorId = await ensureActor();
    const inserted = await db
      .insert(schema.approvalConfigs)
      .values({
        subjectType: "immutable-check",
        configKey: key,
        name: "Immutable probe",
        levels: [{ name: "only", users: [actorId], roles: [], requireSignature: false, signatureMeaning: "approved" }],
      })
      .returning({ id: schema.approvalConfigs.id });
    const configId = inserted[0]?.id;
    if (configId === undefined) throw new Error("config row missing after insert");
    const request = await db
      .insert(schema.approvalRequests)
      .values({
        configId,
        configKey: key,
        subjectType: "immutable-check",
        subjectId: randomUUID(),
        levels: [{ name: "only", users: [actorId], roles: [], requireSignature: false, signatureMeaning: "approved" }],
        submittedById: actorId,
      })
      .returning({ id: schema.approvalRequests.id });
    const id = request[0]?.id;
    if (id === undefined) throw new Error("request row missing after insert");
    return id;
  }

  async function insertAction(requestId: string, note: string): Promise<string> {
    const inserted = await db
      .insert(schema.approvalActions)
      .values({
        requestId,
        stepIndex: 0,
        levelName: "only",
        decision: "approved",
        note,
        actorId: await ensureActor(),
      })
      .returning({ id: schema.approvalActions.id });
    const id = inserted[0]?.id;
    if (id === undefined) throw new Error("action row missing after insert");
    return id;
  }

  it("accepts inserts — decisions exist once they are recorded", async () => {
    const note = `insert-${runId}`;
    await insertAction(await insertRequest(`t-${runId}`), note);
    const rows = await db
      .select({ id: schema.approvalActions.id })
      .from(schema.approvalActions)
      .where(eq(schema.approvalActions.note, note));
    expect(rows).toHaveLength(1);
  });

  it("rejects row updates and deletes", async () => {
    const rowId = await insertAction(await insertRequest(`t2-${runId}`), `guard-${runId}`);
    // RAISE 在 cause 链上——断言打在真实原因上，而不是任何拒绝都算数
    const updateErr = await rejectionOf(
      db.update(schema.approvalActions).set({ decision: "rejected" }).where(eq(schema.approvalActions.id, rowId)),
    );
    expect(causeMessage(updateErr)).toMatch(/append-only: UPDATE/);
    const deleteErr = await rejectionOf(
      db.delete(schema.approvalActions).where(eq(schema.approvalActions.id, rowId)),
    );
    expect(causeMessage(deleteErr)).toMatch(/append-only: DELETE/);
    // 行还在：拒绝不是静默的
    const rows = await db
      .select({ id: schema.approvalActions.id })
      .from(schema.approvalActions)
      .where(eq(schema.approvalActions.id, rowId));
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
