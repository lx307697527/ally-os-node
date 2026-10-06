import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { AppEnv } from "../auth/session.ts";
import { requirePermission } from "../authz/middleware.ts";
import { recordAudit } from "../audit/audit-log.ts";
import { NUMBERING_DATE_FORMATS } from "../numbering/service.ts";
import { numberedSubjectSpec, numberedSubjects } from "../numbering/registry.ts";

/** pg 的唯一约束冲突（23505）：形状收窄而不引依赖（pg 是 @ally/db 的传递依赖）。
 * drizzle 会把驱动错误包进 DrizzleQueryError.cause，沿因果链找码 */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth++) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === "23505") return true;
    current = candidate.cause;
  }
  return false;
}

/**
 * 编号规则端点（#225 切片 1：配置工作室的编号配置面）。
 *
 * 全部在 `numbering.configure` 权限点后面（owner/admin 默认持有，与
 * workflow.configure / approval.configure / custom_fields.configure 同一批配置
 * 工作室管理者）——改编号规则 = 改所有之后发出的单据号。分配没有 HTTP 面：
 * 发号发生在属主域创建单据的事务里（numbering/service.ts allocateDocumentNumber，
 * 与 workflow 实例启动同一裁法），配置面只管规则的增改查。
 *
 * 规则的改写纪律与字段定义不同：编号格式（前缀/日期段/位宽/label）允许就地改
 * ——「修改编号规则后新单据使用新格式」是验收题意，改动历史由审计承载
 * （real-change-only：无实效变更不写审计）；起始号不可改（对已在发的系列无效果，
 * 语义误导），重开系列 = 停用旧规则另建（部分唯一索引保证一对象一套生效规则）。
 */

const createBody = z.object({
  subject: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(200),
  prefix: z.string().trim().max(16).default(""),
  dateFormat: z.enum(NUMBERING_DATE_FORMATS).nullable().default(null),
  padding: z.number().int().min(0).max(10).default(4),
  startNumber: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
});

// strict：起始号刻意不在可改清单里（对已在发的系列无效果，改了也是语义误导），
// 打错的 startNumber 必须显式 400 而不是被静默剥掉——管理员会以为系列已重开
const patchBody = z
  .object({
    label: z.string().trim().min(1).max(200).optional(),
    prefix: z.string().trim().max(16).optional(),
    dateFormat: z.enum(NUMBERING_DATE_FORMATS).nullable().optional(),
    padding: z.number().int().min(0).max(10).optional(),
    active: z.boolean().optional(),
  })
  .strict();

interface RuleRow {
  id: string;
  subject: string;
  label: string;
  prefix: string;
  dateFormat: (typeof NUMBERING_DATE_FORMATS)[number] | null;
  padding: number;
  startNumber: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function presentRule(rule: RuleRow, lastIssued: number | null) {
  return {
    id: rule.id,
    subject: rule.subject,
    label: rule.label,
    prefix: rule.prefix,
    dateFormat: rule.dateFormat,
    padding: rule.padding,
    startNumber: rule.startNumber,
    active: rule.active,
    lastIssued,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

export function numberingRulesRoutes(deps: { db: Db; logger: Logger }) {
  const app = new Hono<AppEnv>();
  const requireNumberingConfigure = requirePermission("numbering.configure");

  // 可编号对象清单（属主域经 numbering/registry.ts 注册的集合）：配置 UI 的
  // 下拉数据源，也是「为什么我配不了 X」的第一诊断口
  app.get("/api/numbering-rules/subjects", requireNumberingConfigure, (c) => {
    return c.json({ subjects: numberedSubjects() });
  });

  app.post("/api/numbering-rules", requireNumberingConfigure, async (c) => {
    const parsed = createBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const body = parsed.data;
    // 未注册类型不能配：注册是属主域「我真的会在这里发号」的承诺，配一条永远
    // 没人用的规则是死配置（fail closed，与表单 schema 端点同一扇门）
    if (numberedSubjectSpec(body.subject) === undefined) {
      return c.json({ error: "unregistered_subject" }, 400);
    }
    // 同对象并发建规则：部分唯一索引（active 行）兜底，撞 23505 与「已存在」
    // 同答 409（不能把合法并发当 500 喷回去）
    let inserted: { id: string }[];
    try {
      inserted = await deps.db
        .insert(schema.numberingRules)
        .values({
          subject: body.subject,
          label: body.label,
          prefix: body.prefix,
          dateFormat: body.dateFormat,
          padding: body.padding,
          startNumber: body.startNumber,
          createdById: c.get("user").id,
        })
        .returning({ id: schema.numberingRules.id });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json({ error: "rule_exists" }, 409);
      }
      throw err;
    }
    const row = inserted[0];
    if (row === undefined) {
      return c.json({ error: "internal_error" }, 500);
    }
    await recordAudit(deps.db, {
      actor: c.get("user").id,
      action: "numbering.rule_created",
      target: row.id,
      detail: {
        subject: body.subject,
        label: body.label,
        prefix: body.prefix,
        dateFormat: body.dateFormat,
        padding: body.padding,
        startNumber: body.startNumber,
      },
    });
    return c.json({ id: row.id }, 201);
  });

  app.get("/api/numbering-rules", requireNumberingConfigure, async (c) => {
    // 停用规则一并返回（留档可查）；last_issued 是「已发出的最大号」，从未发号
    // 的规则为 null——不是 0（0 会冒充「已发到 0 号」的语义）
    const rows = await deps.db
      .select({
        rule: schema.numberingRules,
        lastIssued: schema.numberingSequences.lastIssued,
      })
      .from(schema.numberingRules)
      .leftJoin(schema.numberingSequences, eq(schema.numberingSequences.ruleId, schema.numberingRules.id))
      .orderBy(asc(schema.numberingRules.subject), asc(schema.numberingRules.createdAt));
    return c.json({ rules: rows.map((r) => presentRule(r.rule, r.lastIssued)) });
  });

  app.patch("/api/numbering-rules/:id", requireNumberingConfigure, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const parsed = patchBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const found = await deps.db
      .select()
      .from(schema.numberingRules)
      .where(eq(schema.numberingRules.id, id.data));
    const current = found[0];
    if (current === undefined) {
      return c.json({ error: "not_found" }, 404);
    }
    // 起始号不在 patchBody 里：只对从未发号的系列有意义，且改动会被既有计数行
    // 静默盖过——显式拒绝比静默忽略诚实；重开系列 = 停旧建新
    const body = parsed.data;
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (body.label !== undefined && body.label !== current.label) {
      changes.label = { from: current.label, to: body.label };
    }
    if (body.prefix !== undefined && body.prefix !== current.prefix) {
      changes.prefix = { from: current.prefix, to: body.prefix };
    }
    if (body.dateFormat !== undefined && body.dateFormat !== current.dateFormat) {
      changes.dateFormat = { from: current.dateFormat, to: body.dateFormat };
    }
    if (body.padding !== undefined && body.padding !== current.padding) {
      changes.padding = { from: current.padding, to: body.padding };
    }
    if (body.active !== undefined && body.active !== current.active) {
      changes.active = { from: current.active, to: body.active };
    }
    const changeKeys = Object.keys(changes);
    if (changeKeys.length === 0) {
      // 无实效变更：幂等返回现状，不留审计行（与 comment edit 同一纪律——
      // 审计只记真变更，活动流投影才不会被 no-op 刷屏）
      return c.json(presentRule(current, null));
    }
    const updated = await deps.db
      .update(schema.numberingRules)
      .set({
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.prefix !== undefined ? { prefix: body.prefix } : {}),
        ...(body.dateFormat !== undefined ? { dateFormat: body.dateFormat } : {}),
        ...(body.padding !== undefined ? { padding: body.padding } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.numberingRules.id, id.data))
      .returning({
        id: schema.numberingRules.id,
        subject: schema.numberingRules.subject,
        label: schema.numberingRules.label,
        prefix: schema.numberingRules.prefix,
        dateFormat: schema.numberingRules.dateFormat,
        padding: schema.numberingRules.padding,
        startNumber: schema.numberingRules.startNumber,
        active: schema.numberingRules.active,
        createdAt: schema.numberingRules.createdAt,
        updatedAt: schema.numberingRules.updatedAt,
      });
    const row = updated[0];
    if (row === undefined) {
      return c.json({ error: "internal_error" }, 500);
    }
    await recordAudit(deps.db, {
      actor: c.get("user").id,
      action: "numbering.rule_updated",
      target: row.id,
      detail: { subject: row.subject, changes },
    });
    return c.json(presentRule(row, null));
  });

  return app;
}
