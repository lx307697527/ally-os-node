import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "./index.ts";

// 集成测试：需要真实 PostgreSQL（append-only 是数据库触发器的行为，应用层测不出）。
// 未设 DATABASE_URL 时跳过。
//
// #220 的历史底线：状态机的流转历史是「发生过的事实」，改写或抹掉都不存在合法
// 业务路径（回到过去 = 新的流转行，交给属主域表达），无条件拒绝——与 audit_events
// （0007）、esign_signatures（0012）同一裁决，触发器在 0013。
//
// 本文件跑在共享库上，不 TRUNCATE、不做全表断言（纪律详见 docs/audit.md
// 「测试清库的唯一通道」）。历史行要挂真实用户（actor_id 外键），按 runId 隔离。
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("workflow_transitions append-only (#220, integration)", () => {
  const { db, pool } = createDb(databaseUrl ?? "");
  const runId = `${String(Date.now())}-${String(process.pid)}`;

  afterAll(async () => {
    await pool.end();
  });

  /** 历史行挂真实用户（actor_id FK 不带 CASCADE）；用户行按 runId 隔离、不清理 */
  async function ensureActor(): Promise<string> {
    const email = `workflow-immutable-${runId}@example.com`;
    await db.insert(schema.authUser).values({ name: "Workflow Immutable", email }).onConflictDoNothing();
    const rows = await db
      .select({ id: schema.authUser.id })
      .from(schema.authUser)
      .where(eq(schema.authUser.email, email))
      .limit(1);
    const id = rows[0]?.id;
    if (id === undefined) throw new Error("actor row missing after upsert");
    return id;
  }

  async function insertTransition(instanceId: string, note: string): Promise<string> {
    await runMigrations(db);
    const inserted = await db
      .insert(schema.workflowTransitions)
      .values({
        instanceId,
        fromState: "new",
        toState: "contacted",
        event: "CONTACT",
        note,
        actorId: await ensureActor(),
      })
      .returning({ id: schema.workflowTransitions.id });
    const id = inserted[0]?.id;
    if (id === undefined) throw new Error("transition row missing after insert");
    return id;
  }

  async function insertInstance(key: string): Promise<string> {
    await runMigrations(db);
    const instance = await db
      .insert(schema.workflowInstances)
      .values({
        subjectType: "immutable-check",
        subjectId: randomUUID(),
        templateKey: key,
        definition: { initial: "new", states: { new: {}, contacted: {} } },
        currentState: "new",
      })
      .returning({ id: schema.workflowInstances.id });
    const id = instance[0]?.id;
    if (id === undefined) throw new Error("instance row missing after insert");
    return id;
  }

  it("accepts inserts — history exists once it is written", async () => {
    const note = `insert-${runId}`;
    await insertTransition(await insertInstance(`t-${runId}`), note);
    const rows = await db
      .select({ id: schema.workflowTransitions.id })
      .from(schema.workflowTransitions)
      .where(eq(schema.workflowTransitions.note, note));
    expect(rows).toHaveLength(1);
  });

  it("rejects row updates and deletes", async () => {
    const rowId = await insertTransition(await insertInstance(`t2-${runId}`), `guard-${runId}`);
    // RAISE 在 cause 链上——断言打在真实原因上，而不是任何拒绝都算数
    const updateErr = await rejectionOf(
      db.update(schema.workflowTransitions).set({ toState: "rewritten" }).where(eq(schema.workflowTransitions.id, rowId)),
    );
    expect(causeMessage(updateErr)).toMatch(/append-only: UPDATE/);
    const deleteErr = await rejectionOf(
      db.delete(schema.workflowTransitions).where(eq(schema.workflowTransitions.id, rowId)),
    );
    expect(causeMessage(deleteErr)).toMatch(/append-only: DELETE/);
    // 行还在：拒绝不是静默的
    const rows = await db
      .select({ id: schema.workflowTransitions.id })
      .from(schema.workflowTransitions)
      .where(eq(schema.workflowTransitions.id, rowId));
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
