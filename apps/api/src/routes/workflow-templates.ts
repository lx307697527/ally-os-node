import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { AppEnv } from "../auth/session.ts";
import { requirePermission } from "../authz/middleware.ts";
import { recordAudit } from "../audit/audit-log.ts";
import { parseWorkflowTemplate, referencedBlocks } from "../workflow/engine.ts";
import { actionBlock, conditionBlock } from "../workflow/blocks.ts";

/**
 * 流程模板端点（#220 切片 1：配置工作室的流程配置面）。
 *
 * 模板管理在 `workflow.configure` 权限点后面（owner/admin 默认持有）——改流程
 * = 改全员的工作方式。definition 在保存时过四道校验：zod 结构 → 拓扑语义
 * （initial/target/自环）→ XState 可达性 → 积木存在性（gates/entryActions 引用
 * 的名字必须在注册表里）；在飞实例拿到的是定义快照，模板行一经创建不改定义
 * （替换 = 停用旧行建新键，版本化随 #226 进场）。
 *
 * subject_type 是开集 text：四个对象（线索/商机/订单履约/偏差）的流程可以
 * 在各自的业务域落地前先行配置；「能不能真的启动」由实例侧的属主域注册表
 * （workflow/registry.ts）裁决，两层各说各的话。
 */

const createBody = z.object({
  subjectType: z.string().trim().min(1).max(64),
  templateKey: z
    .string()
    .trim()
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, "template keys must be lower_snake_case"),
  productType: z.string().trim().min(1).max(64).optional(),
  isDefault: z.boolean().default(false),
  definition: z.unknown(),
});

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

export function workflowTemplatesRoutes(deps: { db: Db }) {
  const app = new Hono<AppEnv>();
  const requireWorkflowConfigure = requirePermission("workflow.configure");

  app.post("/api/workflow-templates", requireWorkflowConfigure, async (c) => {
    const parsed = createBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const body = parsed.data;
    const template = parseWorkflowTemplate(body.definition);
    if (!template.ok) {
      return c.json({ error: "invalid_definition", detail: template.error }, 422);
    }
    // 积木存在性在保存时收口：引用不存在的积木，模板当场拒绝——不带病入库
    const blocks = referencedBlocks(template.template);
    const missingGates = blocks.gates.filter((name) => conditionBlock(name) === undefined);
    const missingActions = blocks.actions.filter((name) => actionBlock(name) === undefined);
    if (missingGates.length > 0 || missingActions.length > 0) {
      return c.json(
        { error: "unknown_block", detail: { gates: missingGates, actions: missingActions } },
        422,
      );
    }
    // 部分唯一索引（每类型至多一个默认模板）不在 onConflictDoNothing 的目标里，
    // 撞上它说明这个 subjectType 已有默认模板——结构不变式的 409，不是意外
    let inserted: { id: string }[];
    try {
      inserted = await deps.db
        .insert(schema.workflowTemplates)
        .values({
          subjectType: body.subjectType,
          templateKey: body.templateKey,
          ...(body.productType !== undefined ? { productType: body.productType } : {}),
          isDefault: body.isDefault,
          definition: body.definition,
          createdById: c.get("user").id,
        })
        .onConflictDoNothing({
          target: [schema.workflowTemplates.subjectType, schema.workflowTemplates.templateKey],
        })
        .returning({ id: schema.workflowTemplates.id });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json({ error: "default_template_exists" }, 409);
      }
      throw err;
    }
    const row = inserted[0];
    if (row === undefined) {
      return c.json({ error: "template_exists" }, 409);
    }
    await recordAudit(deps.db, {
      actor: c.get("user").id,
      action: "workflow.template_created",
      target: row.id,
      detail: {
        subjectType: body.subjectType,
        templateKey: body.templateKey,
        ...(body.productType !== undefined ? { productType: body.productType } : {}),
        isDefault: body.isDefault,
        states: Object.keys(template.template.states),
      },
    });
    return c.json({ id: row.id }, 201);
  });

  app.get("/api/workflow-templates", requireWorkflowConfigure, async (c) => {
    const subjectType = c.req.query("subjectType")?.trim();
    const rows = await deps.db
      .select()
      .from(schema.workflowTemplates)
      .where(subjectType !== undefined && subjectType !== "" ? eq(schema.workflowTemplates.subjectType, subjectType) : undefined)
      .orderBy(asc(schema.workflowTemplates.subjectType), asc(schema.workflowTemplates.templateKey));
    return c.json({ templates: rows });
  });

  app.get("/api/workflow-templates/:id", requireWorkflowConfigure, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const rows = await deps.db
      .select()
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, id.data))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({ template: row });
  });

  return app;
}
