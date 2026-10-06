import { Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { Db } from "@ally/db";
import type { AppEnv } from "../auth/session.ts";
import {
  changeRuleValue,
  getRuleRow,
  InvalidRuleValueError,
  listRules,
  RuleChangeForbiddenError,
  RuleNotFoundError,
  ScheduledTimeInPastError,
  type RuleRow,
} from "../rules/service.ts";
import { InvalidDecisionTableError } from "../rules/decision-table-schema.ts";

/**
 * 规则注册表 HTTP 面（#233 切片 1）。
 *
 * 读面（列表/详情）登录即可：注册表是全公司共用的业务参数（§4.2），不是敏感
 * 数据——销售需要知道报价有效期，采购需要知道资质期限；「谁能改」才是逐规则
 * 裁决的（PATCH 路由内）。这里刻意没有 rules.configure 权限点门：该权限点属于
 * 配置工作室面（config-versions 的读史/回滚），规则的改权跟族权限点是分离的
 * （唯一「族权限点 ≠ 改权」的配置族，见 permissions.ts）。
 *
 * PATCH = 改值（立即或定时）。依据必填（refs 至少一条：裁决编号或业主决定
 * 标记）；开关的启用（关→开）过 enableBy 门（R-01-6/8/12 启用需老板确认）；
 * 无实效变更幂等 200 不记账；定时生效先落在行上（调度时刻审计），到点由
 * applyDueRuleChanges 前滚（cron 接线属 worker 域，#233 后续切片）。
 */

function ruleView(rule: RuleRow) {
  return {
    id: rule.id,
    key: rule.key,
    label: rule.label,
    category: rule.category,
    valueType: rule.valueType,
    value: rule.value ?? null,
    isSet: rule.value !== null,
    changeableBy: rule.changeableBy,
    enableBy: rule.enableBy,
    adjudicationRefs: rule.adjudicationRefs,
    riskFlag: rule.riskFlag,
    riskNote: rule.riskNote,
    scheduled:
      rule.scheduledEffectiveAt === null
        ? null
        : {
            value: rule.scheduledValue ?? null,
            effectiveAt: rule.scheduledEffectiveAt.toISOString(),
            rationale: rule.scheduledRationale,
            byId: rule.scheduledById,
          },
    counts: {
      triggers: rule.triggerCount,
      exceptions: rule.exceptionCount,
      overrides: rule.overrideCount,
    },
    version: rule.version,
    updatedAt: rule.updatedAt.toISOString(),
  };
}

const rationaleSchema = z
  .object({
    refs: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
    note: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

const patchBody = z
  .object({
    value: z.unknown(),
    rationale: rationaleSchema,
    effectiveAt: z.coerce.date().optional(),
  })
  .strict();

export function rulesRoutes(deps: { db: Db; logger: Logger }) {
  const app = new Hono<AppEnv>();

  app.get("/api/rules", async (c) => {
    const rules = await listRules(deps.db);
    return c.json({ rules: rules.map(ruleView) });
  });

  app.get("/api/rules/:key", async (c) => {
    const rule = await getRuleRow(deps.db, c.req.param("key"));
    if (rule === undefined) {
      return c.json({ error: "rule_not_found" }, 404);
    }
    return c.json({ rule: ruleView(rule) });
  });

  app.patch("/api/rules/:key", async (c) => {
    const raw: unknown = await c.req.json().catch(() => undefined);
    const parsed = patchBody.safeParse(raw);
    if (
      !parsed.success ||
      raw === null ||
      typeof raw !== "object" ||
      !("value" in raw)
    ) {
      // value 键必须存在（null = 清回「待填」是合法语义，缺失 = 请求不完整）
      return c.json({ error: "invalid_request" }, 400);
    }
    const rationale: { refs: string[]; note?: string } = { refs: parsed.data.rationale.refs };
    if (parsed.data.rationale.note !== undefined) {
      rationale.note = parsed.data.rationale.note;
    }
    try {
      const result = await changeRuleValue(deps.db, c.get("authz"), {
        key: c.req.param("key"),
        actorId: c.get("user").id,
        value: parsed.data.value,
        rationale,
        ...(parsed.data.effectiveAt !== undefined
          ? { effectiveAt: parsed.data.effectiveAt }
          : {}),
      });
      const rule = await getRuleRow(deps.db, c.req.param("key"));
      if (rule === undefined) {
        return c.json({ error: "rule_not_found" }, 404);
      }
      deps.logger.info(
        {
          key: rule.key,
          mode: result.mode,
          changed: result.changed,
          actorId: c.get("user").id,
        },
        "registry rule change",
      );
      return c.json({ ...result, rule: ruleView(rule) });
    } catch (err) {
      if (err instanceof RuleNotFoundError) {
        return c.json({ error: "rule_not_found" }, 404);
      }
      if (err instanceof RuleChangeForbiddenError) {
        return c.json(err.denial, 403);
      }
      if (err instanceof InvalidRuleValueError) {
        return c.json({ error: "invalid_value", issues: err.issues }, 400);
      }
      if (err instanceof InvalidDecisionTableError) {
        // 决策表表达式语法错：形状错误的注册表变体（ZEN 对坏单元格静默不命中，
        // 所以编译错必须在写面 400，不能等求值时变成「永远不触发的规则」）
        return c.json({ error: "invalid_value", issues: [err.message] }, 400);
      }
      if (err instanceof ScheduledTimeInPastError) {
        return c.json({ error: "invalid_effective_time" }, 400);
      }
      throw err;
    }
  });

  return app;
}
