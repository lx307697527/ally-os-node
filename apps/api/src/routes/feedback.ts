import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { AppEnv } from "../auth/session.ts";

/**
 * 反馈上报的提交端点（#129，老系统 FEAT-198 submit_feedback_report 的直译）。
 * 管理队列（/feedback-reports 的管理面、状态流转、GitHub 回写）随管理域迁移
 * 落地；本切片是「入口」：任何登录者可提交，拿到 BR- 编号回执。
 *
 * 附件（老 ≤3 张图片进私有桶）随 @ally/storage 基建补列，expand-only。
 */

/** 表单类型：老 FORM_FEEDBACK_TYPES 的直译。process_gap 只有 AI 助手会归档
 * （FEAT-775），那个外延没迁，所以 API 也不收。 */
const FEEDBACK_TYPES = ["bug_report", "feature_request"] as const;

const FEEDBACK_PRIORITIES = ["low", "medium", "high", "critical"] as const;

/** 老字段上限逐值渡河：title 200、description 5000、steps 5000。 */
const submitBody = z.object({
  type: z.enum(FEEDBACK_TYPES),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(5000),
  stepsToReproduce: z.string().trim().min(1).max(5000).optional(),
  priority: z.enum(FEEDBACK_PRIORITIES),
});

/** BR- + 8 位 hex（老 report_number 形态）。randomBytes 撞号概率可忽略，
 * 唯一索引兜底：撞了重掷，最多三轮。 */
function newReportNumber(): string {
  return `BR-${randomBytes(4).toString("hex")}`;
}

export function feedbackRoutes(deps: { db: Db }) {
  const app = new Hono<AppEnv>();

  app.post("/api/feedback-reports", async (c) => {
    const parsed = submitBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    // 提交人从会话解析（老 RPC 裁定：不是请求参数）；姓名/邮箱落快照
    const user = c.get("user");
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const reportNumber = newReportNumber();
        await deps.db.insert(schema.feedbackReports).values({
          reportNumber,
          type: parsed.data.type,
          title: parsed.data.title,
          description: parsed.data.description,
          stepsToReproduce: parsed.data.stepsToReproduce,
          priority: parsed.data.priority,
          submittedByUserId: user.id,
          submitterName: user.name,
          submitterEmail: user.email,
        });
        return c.json({ reportNumber }, 201);
      } catch (err) {
        // 编号撞唯一索引重掷（drizzle 0.45 把 PG 错误包进 cause 链）；
        // 其他错误交全局 onError
        if (!isUniqueViolation(err) || attempt === 2) {
          throw err;
        }
      }
    }
    // 第三轮要么 return 要么 throw，这里不可达；类型收口用
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}

/** Postgres unique_violation（沿 cause 链找，同 shadow-account 的识别逻辑） */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if ("code" in current && (current as { code?: unknown }).code === "23505") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
