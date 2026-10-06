import { Hono, type Context } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { Db } from "@ally/db";
import type { AppEnv } from "../auth/session.ts";
import { loadVisibleSubject } from "../subjects/registry.ts";
import { workflowSubjectSpec } from "../workflow/registry.ts";
import { applyTransition, subjectFlow, transitionHistory } from "../workflow/service.ts";

/**
 * 流程实例端点（#220 切片 1）。
 *
 * 实例的启动不开 HTTP 面：startWorkflow 是属主域创建业务记录时的进程内调用
 * （线索建成即起步），没有「用户凭空启动一个流程」的业务动作。
 *
 * 读与推都在属主域的可见性门后面（subjects/registry.ts，与评论/关注同一扇）：
 * 看得到对象才看得到对象的状态与历史；推进另有两道内核裁决——流转是员工动作
 * （纯 customer 角色在服务层即拒，403），以及模板流转上的 roles/requireNote/
 * gates（403/422，语义在 service）。被拒的推进不探测任何额外信息：不存在与
 * 不可见同答 404，反探测与任务详情同一裁定。
 */

const paramsSchema = z.object({
  subjectType: z.string().trim().min(1).max(64),
  subjectId: z.uuid(),
});

const transitionBody = z.object({
  event: z.string().trim().min(1).max(64),
  note: z.string().trim().max(2000).optional(),
});

/** service 拒绝语义 → HTTP 状态：角色不够 403，业务门/拓扑不允许 422 */
function rejectionStatus(reason: string): 403 | 404 | 409 | 422 {
  switch (reason) {
    case "role_required":
      return 403;
    case "not_found":
      return 404;
    case "concurrent_conflict":
      return 409;
    default:
      return 422;
  }
}

export function workflowInstancesRoutes(deps: { db: Db; logger: Logger }) {
  const app = new Hono<AppEnv>();

  // 可见性门：类型未注册 400（workflow 注册表）、不存在/不可见 404；三处读法共用
  async function gate(c: Context<AppEnv>): Promise<Response | null> {
    const params = paramsSchema.safeParse(c.req.param());
    if (!params.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    if (workflowSubjectSpec(params.data.subjectType) === undefined) {
      return c.json({ error: "subject_type_unregistered" }, 400);
    }
    const visible = await loadVisibleSubject(
      deps.db,
      params.data.subjectType,
      params.data.subjectId,
      c.get("user").id,
    );
    if (visible === null || visible === "unregistered") {
      return c.json({ error: "not_found" }, 404);
    }
    return null;
  }

  app.get("/api/workflow-instances/:subjectType/:subjectId", async (c) => {
    const blocked = await gate(c);
    if (blocked !== null) return blocked;
    const { subjectType, subjectId } = paramsSchema.parse(c.req.param());
    const outcome = await subjectFlow(deps.db, subjectType, subjectId);
    if (outcome.status === "none") {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({ flow: outcome.view });
  });

  app.post("/api/workflow-instances/:subjectType/:subjectId/transitions", async (c) => {
    const blocked = await gate(c);
    if (blocked !== null) return blocked;
    const { subjectType, subjectId } = paramsSchema.parse(c.req.param());
    const body = transitionBody.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const outcome = await applyTransition(deps.db, {
      subjectType,
      subjectId,
      actorId: c.get("user").id,
      actorRoles: c.get("authz").roles,
      event: body.data.event,
      note: body.data.note,
    });
    if (outcome.status === "rejected") {
      if (outcome.reason === "concurrent_conflict") {
        deps.logger.info({ subjectType, subjectId, event: body.data.event }, "workflow transition conflict");
      }
      return c.json(
        {
          error: outcome.reason,
          ...(outcome.gateName !== undefined ? { gate: outcome.gateName } : {}),
        },
        rejectionStatus(outcome.reason),
      );
    }
    return c.json(
      {
        from: outcome.from,
        to: outcome.to,
        instanceId: outcome.instanceId,
        ...(outcome.actionErrors.length > 0 ? { actionErrors: outcome.actionErrors } : {}),
      },
      200,
    );
  });

  app.get("/api/workflow-instances/:subjectType/:subjectId/transitions", async (c) => {
    const blocked = await gate(c);
    if (blocked !== null) return blocked;
    const { subjectType, subjectId } = paramsSchema.parse(c.req.param());
    const rows = await transitionHistory(deps.db, subjectType, subjectId);
    return c.json({ transitions: rows });
  });

  return app;
}
