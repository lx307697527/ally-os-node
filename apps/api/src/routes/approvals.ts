import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { Logger } from "pino";
import type { AppEnv } from "../auth/session.ts";
import { requirePermission } from "../authz/middleware.ts";
import { recordAudit } from "../audit/audit-log.ts";
import { loadVisibleSubject } from "../subjects/registry.ts";
import {
  actOnApproval,
  approvalLevelsSchema,
  approvalRequestView,
  approvalTodo,
  isUniqueViolation,
  submitApprovalRequest,
} from "../approval/service.ts";

/**
 * 审批端点（#221 切片 1）。
 *
 * 配置面（审批线管理）在 `approval.configure` 权限点后面（owner/admin 默认持有）
 * ——改审批路线 = 改全员谁有权裁决什么，与 workflow.configure 同一批人的裁决。
 * 配置一经创建不改定义（替换 = 停用旧行 + 新键，随 #226 版本化进场）；本切片
 * 连停用都不开（workflow-templates 同裁），先立住「配置不可变」的纪律。
 *
 * 请求面（提交 / 详情 / 待办 / 裁决）在会话门后：提交与详情过单据可见性门
 * （subjects/registry.ts，看得到单据才看得到它的审批）；待办与裁决由配置点名
 * 裁决（users/roles 命中即授权，#221「配置审批人（指定人员或角色）」）——角色
 * 审批人不要求恰好是单据可见者，两扇门各管各的。要求签名的级别在服务层过
 * 2FA 门 + 签名仪式（esign 内核，#219），拒绝语义见 approval/service.ts。
 */

const createConfigBody = z.object({
  subjectType: z.string().trim().min(1).max(64),
  configKey: z
    .string()
    .trim()
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, "approval keys must be lower_snake_case"),
  name: z.string().trim().min(1).max(200),
  levels: z.unknown(),
});

const submitBody = z.object({
  subjectType: z.string().trim().min(1).max(64),
  subjectId: z.uuid(),
  configKey: z.string().trim().min(1).max(64),
});

const actBody = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    note: z.string().trim().max(2000).optional(),
    // 签名仪式的输入（requireSignature 级别必带，缺一不可）
    password: z.string().min(1).max(200).optional(),
    clientToken: z.uuid().optional(),
  })
  .refine((body) => (body.password === undefined) === (body.clientToken === undefined), {
    message: "password and clientToken must be provided together",
  });

export function approvalsRoutes(deps: { db: Db; logger: Logger; notifyUsers: (userIds: string[]) => Promise<void> }) {
  const app = new Hono<AppEnv>();
  const requireApprovalConfigure = requirePermission("approval.configure");

  // ── 配置面 ──────────────────────────────────────────────────────────────

  app.post("/api/approval-configs", requireApprovalConfigure, async (c) => {
    const parsed = createConfigBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const body = parsed.data;
    const levels = approvalLevelsSchema.safeParse(body.levels);
    if (!levels.success) {
      return c.json(
        { error: "invalid_levels", detail: levels.error.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
        422,
      );
    }
    let inserted: { id: string }[];
    try {
      inserted = await deps.db
        .insert(schema.approvalConfigs)
        .values({
          subjectType: body.subjectType,
          configKey: body.configKey,
          name: body.name,
          levels: levels.data,
          createdById: c.get("user").id,
        })
        .onConflictDoNothing({
          target: [schema.approvalConfigs.subjectType, schema.approvalConfigs.configKey],
        })
        .returning({ id: schema.approvalConfigs.id });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json({ error: "config_exists" }, 409);
      }
      throw err;
    }
    const row = inserted[0];
    if (row === undefined) {
      return c.json({ error: "config_exists" }, 409);
    }
    await recordAudit(deps.db, {
      actor: c.get("user").id,
      action: "approval.config_created",
      target: row.id,
      detail: {
        subjectType: body.subjectType,
        configKey: body.configKey,
        name: body.name,
        steps: levels.data.map((level) => level.name),
      },
    });
    return c.json({ id: row.id }, 201);
  });

  app.get("/api/approval-configs", requireApprovalConfigure, async (c) => {
    const subjectType = c.req.query("subjectType")?.trim();
    const rows = await deps.db
      .select()
      .from(schema.approvalConfigs)
      .where(
        subjectType !== undefined && subjectType !== ""
          ? eq(schema.approvalConfigs.subjectType, subjectType)
          : undefined,
      )
      .orderBy(asc(schema.approvalConfigs.subjectType), asc(schema.approvalConfigs.configKey));
    return c.json({ configs: rows });
  });

  // ── 请求面 ──────────────────────────────────────────────────────────────

  app.post("/api/approval-requests", async (c) => {
    const parsed = submitBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const body = parsed.data;
    // 单据可见性门：类型未注册 400，不存在/不可见 404（反探测，与评论同扇）
    const visible = await loadVisibleSubject(deps.db, body.subjectType, body.subjectId, c.get("user").id);
    if (visible === "unregistered") {
      return c.json({ error: "invalid_subject" }, 400);
    }
    if (visible === null) {
      return c.json({ error: "not_found" }, 404);
    }
    const outcome = await submitApprovalRequest(deps.db, {
      subjectType: body.subjectType,
      subjectId: body.subjectId,
      configKey: body.configKey,
      submitterId: c.get("user").id,
    });
    if (outcome.status === "rejected") {
      if (outcome.reason === "levels_invalid") {
        // 配置行被外力改歪：服务端数据问题，不探细节给客户端
        deps.logger.error({ configKey: body.configKey }, "approval config has invalid levels");
        throw new Error(`approval config ${body.configKey} has invalid levels`);
      }
      if (outcome.reason === "payload_required") {
        // 带 outcome 自动化的 subject（批准要执行业务效果）必须由属主域路由带
        // 参数提交；通用端点不收 payload，对这类类型直接拒（422）——堵住
        // 「批了也批不出效果」的无参数死请求占住在飞位
        return c.json({ error: "payload_required" }, 422);
      }
      return c.json(
        {
          error: outcome.reason,
          ...(outcome.requestId !== undefined ? { requestId: outcome.requestId } : {}),
        },
        outcome.reason === "already_pending" ? 409 : 404,
      );
    }
    return c.json({ requestId: outcome.requestId }, 201);
  });

  // 待我审批（在飞且当前级点名我 / 我的角色命中配置）：配置点名即授权
  app.get("/api/approval-requests/todo", async (c) => {
    const rows = await approvalTodo(deps.db, {
      id: c.get("user").id,
      roles: c.get("authz").roles,
    });
    return c.json({ requests: rows });
  });

  app.get("/api/approval-requests/:id", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const view = await approvalRequestView(deps.db, id.data);
    if (view === null) {
      return c.json({ error: "not_found" }, 404);
    }
    // 详情与提交同一扇门：单据可见者看得到这条审批（含各级裁决与签名摘要）
    const visible = await loadVisibleSubject(
      deps.db,
      view.subjectType,
      view.subjectId,
      c.get("user").id,
    );
    if (visible === null || visible === "unregistered") {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({ request: view });
  });

  app.post("/api/approval-requests/:id/actions", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const parsed = actBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const outcome = await actOnApproval(
      deps.db,
      {
        requestId: id.data,
        actorId: c.get("user").id,
        actorRoles: c.get("authz").roles,
        actorTwoFactorEnabled: c.get("user").twoFactorEnabled,
        decision: parsed.data.decision,
        note: parsed.data.note,
        ...(parsed.data.password !== undefined && parsed.data.clientToken !== undefined
          ? { signature: { password: parsed.data.password, clientToken: parsed.data.clientToken } }
          : {}),
      },
      { notifyUsers: deps.notifyUsers },
    );
    if (outcome.status === "rejected") {
      if (outcome.reason === "concurrent_conflict") {
        deps.logger.info({ requestId: id.data }, "approval action conflict");
      }
      const status: Record<string, 401 | 403 | 404 | 409 | 422> = {
        invalid_credentials: 401,
        not_approver: 403,
        two_factor_required: 403,
        not_found: 404,
        already_signed: 409,
        request_closed: 409,
        concurrent_conflict: 409,
        signature_required: 422,
      };
      return c.json({ error: outcome.reason }, status[outcome.reason] ?? 422);
    }
    return c.json(
      {
        requestId: outcome.requestId,
        actionId: outcome.actionId,
        decision: outcome.decision,
        requestStatus: outcome.requestStatus,
        currentStep: outcome.currentStep,
      },
      200,
    );
  });

  return app;
}
