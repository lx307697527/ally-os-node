import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { AppEnv } from "../auth/session.ts";
import { requirePermission } from "../authz/middleware.ts";
import { recordAudit } from "../audit/audit-log.ts";
import { restorerFor } from "../records/deleted-records.ts";

/**
 * 删除记录端点（#29 切片 2）。老-老系统对应物是 /admin/deleted-records 对快照表
 * 的直读；新系统删除 = 软删行 + 台账快照（records/deleted-records.ts），读取收敛
 * 在这里：`audit.read` 权限点门（owner/admin，与审计日志同一批读者）——恢复是
 * 「把全公司可见性已关闭的行重新打开」的合规面动词，查看与恢复同门。
 *
 * 「已删除的记录可以查看和恢复」(#29 验收第 2 条)：
 * - 查看 = GET 列表（台账行 + 快照原样，谁删的/什么时候/删时长什么样）；
 * - 恢复 = POST restore，恢复器注册表逐域裁决「怎么救」，未注册类型 fail closed。
 * 恢复在台账行锁内进行：已在飞/已恢复/行已不在，各自有明确的 409 说法。
 */

export const DELETED_RECORDS_PAGE_DEFAULT = 50;
export const DELETED_RECORDS_PAGE_MAX = 200;

const querySchema = z.object({
  limit: z.coerce.number().int().positive().max(DELETED_RECORDS_PAGE_MAX).default(DELETED_RECORDS_PAGE_DEFAULT),
  offset: z.coerce.number().int().nonnegative().default(0),
});

const restoreBody = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});

export function deletedRecordsRoutes(deps: { db: Db }) {
  const app = new Hono<AppEnv>();
  const requireAuditRead = requirePermission("audit.read");

  app.get("/api/deleted-records", requireAuditRead, async (c) => {
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const { limit, offset } = parsed.data;
    const deletedBy = alias(schema.authUser, "deleted_by_user");
    const restoredBy = alias(schema.authUser, "restored_by_user");
    const [rows, totals] = await Promise.all([
      deps.db
        .select({
          id: schema.deletedRecords.id,
          subjectType: schema.deletedRecords.subjectType,
          subjectId: schema.deletedRecords.subjectId,
          title: schema.deletedRecords.title,
          snapshot: schema.deletedRecords.snapshot,
          deletedBy: { id: deletedBy.id, name: deletedBy.name },
          deletedAt: schema.deletedRecords.deletedAt,
          restoredBy: { id: restoredBy.id, name: restoredBy.name },
          restoredAt: schema.deletedRecords.restoredAt,
        })
        .from(schema.deletedRecords)
        .leftJoin(deletedBy, eq(schema.deletedRecords.deletedBy, deletedBy.id))
        .leftJoin(restoredBy, eq(schema.deletedRecords.restoredBy, restoredBy.id))
        .orderBy(desc(schema.deletedRecords.deletedAt), desc(schema.deletedRecords.id))
        .limit(limit)
        .offset(offset),
      deps.db.select({ n: sql<number>`count(*)::int` }).from(schema.deletedRecords),
    ]);
    return c.json({ records: rows, total: totals[0]?.n ?? 0 });
  });

  app.post("/api/deleted-records/:id/restore", requireAuditRead, async (c) => {
    const idParse = z.uuid().safeParse(c.req.param("id"));
    if (!idParse.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    // reason 可选：为什么恢复是台账与审计的语境，不是门槛（恢复本身已过 audit.read 门）
    const body = restoreBody.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const me = c.get("user");
    const restored = await deps.db.transaction(async (tx): Promise<TxRestoreOutcome> => {
      // 台账行锁：并发恢复/停用裁决在同一行上排队，锁内状态是唯一真相
      const rows = await tx
        .select()
        .from(schema.deletedRecords)
        .where(eq(schema.deletedRecords.id, idParse.data))
        .for("update")
        .limit(1);
      const ledgerRow = rows[0];
      if (ledgerRow === undefined) {
        return { kind: "not_found" };
      }
      if (ledgerRow.restoredAt !== null) {
        return { kind: "conflict", code: "restored_already" };
      }
      const restorer = restorerFor(ledgerRow.subjectType);
      if (restorer === undefined) {
        // 删得掉的恢复不回来比删不掉更糟：未注册类型的恢复 fail closed
        return { kind: "conflict", code: "restore_unsupported" };
      }
      const outcome = await restorer(tx, ledgerRow.subjectId);
      if (outcome === null) {
        return { kind: "conflict", code: "subject_missing" };
      }
      await tx
        .update(schema.deletedRecords)
        .set({ restoredAt: new Date(), restoredBy: me.id })
        .where(eq(schema.deletedRecords.id, ledgerRow.id));
      // 恢复是「谁、何时、把哪条记录救了回来」的受监管动词：审计动词与细节由
      // 属主域的恢复器给出；target = 被恢复的业务行 id——记录的活动流在恢复后
      // 能看到 deleted → restored 的完整圈
      await recordAudit(tx, {
        actor: me.id,
        action: outcome.action,
        target: ledgerRow.subjectId,
        detail: {
          ...outcome.detail,
          ledgerId: ledgerRow.id,
          ...(body.data.reason === undefined ? {} : { reason: body.data.reason }),
        },
      });
      return { kind: "restored", ledgerId: ledgerRow.id };
    });
    if (restored.kind === "not_found") {
      return c.json({ error: "not_found" }, 404);
    }
    if (restored.kind === "conflict") {
      return c.json({ error: restored.code }, 409);
    }
    const fresh = await readLedgerRow(deps.db, restored.ledgerId);
    return c.json({ record: fresh });
  });

  return app;
}

type TxRestoreOutcome =
  | { kind: "not_found" }
  | { kind: "conflict"; code: "restored_already" | "restore_unsupported" | "subject_missing" }
  | { kind: "restored"; ledgerId: string };

/** 恢复后的台账行读法（与列表同一投影），left join 人名 */
async function readLedgerRow(db: Db, id: string) {
  const deletedBy = alias(schema.authUser, "deleted_by_user");
  const restoredBy = alias(schema.authUser, "restored_by_user");
  const where: SQL[] = [eq(schema.deletedRecords.id, id)];
  const rows = await db
    .select({
      id: schema.deletedRecords.id,
      subjectType: schema.deletedRecords.subjectType,
      subjectId: schema.deletedRecords.subjectId,
      title: schema.deletedRecords.title,
      snapshot: schema.deletedRecords.snapshot,
      deletedBy: { id: deletedBy.id, name: deletedBy.name },
      deletedAt: schema.deletedRecords.deletedAt,
      restoredBy: { id: restoredBy.id, name: restoredBy.name },
      restoredAt: schema.deletedRecords.restoredAt,
    })
    .from(schema.deletedRecords)
    .leftJoin(deletedBy, eq(schema.deletedRecords.deletedBy, deletedBy.id))
    .leftJoin(restoredBy, eq(schema.deletedRecords.restoredBy, restoredBy.id))
    .where(and(...where))
    .limit(1);
  return rows[0] ?? null;
}
