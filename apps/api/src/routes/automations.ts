import { and, desc, eq, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import { ruleSpecSchema } from "@ally/automations";
import { automationRuleSnapshot } from "../config-versions/families.ts";
import { jsonEqual, nextConfigVersion, recordConfigRevision } from "../config-versions/service.ts";
import type { AppEnv } from "../auth/session.ts";
import { requirePermission } from "../authz/middleware.ts";
import { recordAudit } from "../audit/audit-log.ts";

/**
 * 自动化规则端点（#224 切片 1：规则配置面 + 执行日志读面）。
 *
 * 全部在 `automations.configure` 权限点后面（owner/admin 默认持有，与
 * workflow/approval/custom-fields 同一批配置工作室管理者）——新增一条规则 =
 * 改全公司的连锁反应（#224 验收第 3 条「不改代码即可新增规则并生效」的服务端
 * 半边：保存即生效，worker 扫描器每个周期读 enabled 规则，没有发布开关）。
 *
 * spec（trigger/conditions/actions）整体替换不局部合并：规则是「触发 → 条件 →
 * 动作」一个整体，PATCH 里带 spec 就是换规则。每次真实变更（改名/启停/换 spec）
 * 经配置版本台账（#226）记一个新版本并留审计，无实效变更幂等返回现状——台账
 * 是版本史与回滚的事实来源（config-versions/），行.version 与台账同步。
 * 执行日志（runs）的查看也在这扇门后：运行记录含收件人名单与业务事件细节，
 * 是配置面的一部分。
 */

const createBody = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  trigger: ruleSpecSchema.shape.trigger,
  conditions: ruleSpecSchema.shape.conditions.optional(),
  actions: ruleSpecSchema.shape.actions,
});

const patchBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  enabled: z.boolean().optional(),
  spec: z
    .object({
      trigger: ruleSpecSchema.shape.trigger,
      conditions: ruleSpecSchema.shape.conditions.optional(),
      actions: ruleSpecSchema.shape.actions,
    })
    .optional(),
});

const runsQuery = z.object({
  ruleId: z.uuid().optional(),
  status: z.enum(schema.automationRunStatus.enumValues).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// trigger 列在 schema 侧收口为 Record<string, unknown>；spec 已过 ruleSpecSchema，
// 这里的断言是 JSONB 边界的落库形态，不是绕过校验
function specValues(spec: {
  trigger: unknown;
  conditions?: unknown[] | undefined;
  actions: unknown[];
}): { trigger: Record<string, unknown>; conditions: unknown[]; actions: unknown[] } {
  return {
    trigger: spec.trigger as Record<string, unknown>,
    conditions: spec.conditions ?? [],
    actions: spec.actions,
  };
}

export function automationsRoutes(deps: { db: Db; logger: Logger }) {
  const app = new Hono<AppEnv>();
  const requireAutomationsConfigure = requirePermission("automations.configure");

  // runs 读面先于 /:id 形状的任何潜在路由注册（本切片没有 /:id 读法，顺序留正确）
  app.get("/api/automations/runs", requireAutomationsConfigure, async (c) => {
    const parsed = runsQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const query = parsed.data;
    const filters: SQL[] = [];
    if (query.ruleId !== undefined) {
      filters.push(eq(schema.automationRuns.ruleId, query.ruleId));
    }
    if (query.status !== undefined) {
      filters.push(eq(schema.automationRuns.status, query.status));
    }
    const rows = await deps.db
      .select()
      .from(schema.automationRuns)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(schema.automationRuns.createdAt))
      .limit(query.limit);
    return c.json({ runs: rows });
  });

  app.post("/api/automations", requireAutomationsConfigure, async (c) => {
    const parsed = createBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const body = parsed.data;
    const spec = specValues(body);
    const actorId = c.get("user").id;
    const row = await deps.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(schema.automationRules)
        .values({
          name: body.name,
          ...(body.description !== undefined ? { description: body.description } : {}),
          trigger: spec.trigger,
          conditions: spec.conditions,
          actions: spec.actions,
          createdById: actorId,
        })
        .returning({ id: schema.automationRules.id, version: schema.automationRules.version });
      const insertedRow = inserted[0];
      if (insertedRow === undefined) throw new Error("automation rule insert returned no row");
      // 台账 v1（#226）：创建即第一版事实，与配置行同一个事务
      await recordConfigRevision(tx, {
        subjectType: "automation_rule",
        subjectId: insertedRow.id,
        version: insertedRow.version,
        actorId,
        snapshot: automationRuleSnapshot({
          name: body.name,
          description: body.description ?? null,
          trigger: spec.trigger,
          conditions: spec.conditions,
          actions: spec.actions,
          enabled: true,
        }),
        changes: null,
        source: "created",
      });
      return insertedRow;
    });
    await recordAudit(deps.db, {
      actor: c.get("user").id,
      action: "automations.rule_created",
      target: row.id,
      detail: { name: body.name, trigger: spec.trigger, conditions: spec.conditions, actions: spec.actions },
    });
    deps.logger.info({ ruleId: row.id, name: body.name }, "automation rule created");
    return c.json({ id: row.id }, 201);
  });

  app.get("/api/automations", requireAutomationsConfigure, async (c) => {
    const rows = await deps.db
      .select()
      .from(schema.automationRules)
      .orderBy(desc(schema.automationRules.createdAt));
    return c.json({ rules: rows });
  });

  app.patch("/api/automations/:id", requireAutomationsConfigure, async (c) => {
    const ruleId = c.req.param("id");
    const parsed = patchBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const body = parsed.data;
    const existing = await deps.db
      .select()
      .from(schema.automationRules)
      .where(eq(schema.automationRules.id, ruleId))
      .limit(1);
    const before = existing[0];
    if (before === undefined) {
      return c.json({ error: "not_found" }, 404);
    }
    const nextSpec = body.spec !== undefined ? specValues(body.spec) : undefined;
    // 实效变更集（顶层字段摘要，与台账 changes 同形）：无实效变更 = 幂等返回
    // 现状，不更新、不记账、不留审计（审计只记真变更）
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (body.name !== undefined && body.name !== before.name) {
      changes.name = { from: before.name, to: body.name };
    }
    if (body.description !== undefined && !jsonEqual(body.description, before.description)) {
      changes.description = { from: before.description, to: body.description };
    }
    if (body.enabled !== undefined && body.enabled !== before.enabled) {
      changes.enabled = { from: before.enabled, to: body.enabled };
    }
    if (nextSpec !== undefined) {
      if (!jsonEqual(nextSpec.trigger, before.trigger)) {
        changes.trigger = { from: before.trigger, to: nextSpec.trigger };
      }
      if (!jsonEqual(nextSpec.conditions, before.conditions)) {
        changes.conditions = { from: before.conditions, to: nextSpec.conditions };
      }
      if (!jsonEqual(nextSpec.actions, before.actions)) {
        changes.actions = { from: before.actions, to: nextSpec.actions };
      }
    }
    if (Object.keys(changes).length === 0) {
      return c.json({ version: before.version });
    }
    const actorId = c.get("user").id;
    const version = await deps.db.transaction(async (tx) => {
      // 版本号从台账取（行.version = 台账最新版的不变式），不是行值 +1——
      // 两处真相必然漂移，一处真相（台账）+ 同事务同步
      const nextVersion = await nextConfigVersion(tx, "automation_rule", ruleId);
      const updated = await tx
        .update(schema.automationRules)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(nextSpec ?? {}),
          version: nextVersion,
          updatedAt: new Date(),
        })
        .where(eq(schema.automationRules.id, ruleId))
        .returning({ id: schema.automationRules.id });
      if (updated[0] === undefined) throw new Error("automation rule update returned no row");
      await recordConfigRevision(tx, {
        subjectType: "automation_rule",
        subjectId: ruleId,
        version: nextVersion,
        actorId,
        snapshot: automationRuleSnapshot({
          name: body.name ?? before.name,
          description: body.description !== undefined ? body.description : before.description,
          trigger: nextSpec !== undefined ? nextSpec.trigger : before.trigger,
          conditions: nextSpec !== undefined ? nextSpec.conditions : before.conditions,
          actions: nextSpec !== undefined ? nextSpec.actions : before.actions,
          enabled: body.enabled ?? before.enabled,
        }),
        changes,
        source: "updated",
      });
      return nextVersion;
    });
    await recordAudit(deps.db, {
      actor: actorId,
      action: "automations.rule_updated",
      target: ruleId,
      detail: { name: body.name ?? before.name, enabled: body.enabled ?? before.enabled, version, changes },
    });
    return c.json({ version });
  });

  app.delete("/api/automations/:id", requireAutomationsConfigure, async (c) => {
    const ruleId = c.req.param("id");
    const deleted = await deps.db
      .delete(schema.automationRules)
      .where(eq(schema.automationRules.id, ruleId))
      .returning({ id: schema.automationRules.id, name: schema.automationRules.name });
    const row = deleted[0];
    if (row === undefined) {
      return c.json({ error: "not_found" }, 404);
    }
    await recordAudit(deps.db, {
      actor: c.get("user").id,
      action: "automations.rule_deleted",
      target: ruleId,
      detail: { name: row.name },
    });
    return c.json({ ok: true });
  });

  return app;
}
