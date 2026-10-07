import { and, eq } from "drizzle-orm";
import { ruleSpecSchema, type ActionResult, type ActionSpec } from "@ally/automations";
import { schema, type Db } from "@ally/db";
import {
  executeCreateTask,
  executeNotify,
  executeSendEmail,
  type ActionContext,
  type ActionDeps,
  type ActionServices,
} from "./actions.ts";

/**
 * automation-run 任务（#224「动作通过 pg-boss 执行，可重试、可观测，失败告警」）：
 * 输入一个 run 行（扫描器在「触发命中且条件通过」时插入），顺序执行规则的动作，
 * 结果逐动作写回 action_results。
 *
 * 重试协议（三层）：
 * 1. 处理器对重复投递幂等——run 不是 pending（或规则/spec 没了）按终态处理；
 * 2. 动作失败不终结 run（保持 pending）：每个动作在自己的事务里执行，事务提交后
 *    把「含本次结果的动作清单」带外写回——pg-boss 按队列默认重试 3 次（60s 指数
 *    退避），每次尝试都触发 runner.ts 的失败告警；重试只补失败的那个动作，已
 *    成功的按 action_results 跳过（动作行存在 ⟺ 该动作已提交，不重跑）；
 * 3. 重试耗尽后 run 停在 pending，由扫描器的滞留清障（give-up 阈值）终判 failed
 *    ——「什么时候算彻底失败」只有知道重试上限的一方（扫描器的阈值）能回答。
 *
 * 并发协议：每个动作的事务先对 run 行 SELECT … FOR UPDATE——重发/重投的两个
 * 处理器在行锁上排队，后到者重读 action_results，看到该动作已成功即跳过，动作
 * 不会双跑。终判 UPDATE 带 pending 守卫，不覆写滞留清障可能已写入的 failed。
 */

export const AUTOMATION_RUN_JOB = "automation-run";

export interface AutomationRunJobData {
  runId: string;
}

type RuleLoad =
  | { kind: "gone" }
  | { kind: "no-rule" }
  | { kind: "bad-spec" }
  | { kind: "ready"; actions: ActionSpec[]; ctx: ActionContext };

async function loadRuleSpec(db: Db, runId: string): Promise<RuleLoad> {
  const runRows = await db
    .select()
    .from(schema.automationRuns)
    .where(eq(schema.automationRuns.id, runId))
    .limit(1);
  const run = runRows[0];
  if (run?.status !== "pending") return { kind: "gone" };
  if (run.ruleId === null) return { kind: "no-rule" };
  const ruleRows = await db
    .select()
    .from(schema.automationRules)
    .where(eq(schema.automationRules.id, run.ruleId))
    .limit(1);
  const rule = ruleRows[0];
  if (rule === undefined) return { kind: "no-rule" };
  // 保存时校验过形状，这里再 parse 是防呆（手工改库、未来导入）；坏了终判失败，
  // 不带病执行
  const parsed = ruleSpecSchema.safeParse({
    trigger: rule.trigger,
    conditions: rule.conditions,
    actions: rule.actions,
  });
  if (!parsed.success) return { kind: "bad-spec" };
  return {
    kind: "ready",
    actions: parsed.data.actions,
    ctx: {
      ruleId: rule.id,
      ruleName: rule.name,
      createdById: rule.createdById,
      runId: run.id,
    },
  };
}

function baseResults(actionResults: unknown): ActionResult[] {
  if (!Array.isArray(actionResults)) return [];
  return actionResults.filter(
    (item): item is ActionResult =>
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      "status" in item &&
      typeof (item as ActionResult).status === "string",
  );
}

async function recordFailure(
  db: Db,
  runId: string,
  index: number,
  type: ActionSpec["type"],
  error: string,
): Promise<void> {
  const rows = await db
    .select({ actionResults: schema.automationRuns.actionResults })
    .from(schema.automationRuns)
    .where(eq(schema.automationRuns.id, runId))
    .limit(1);
  const base = baseResults(rows[0]?.actionResults);
  await db
    .update(schema.automationRuns)
    .set({ actionResults: [...base.slice(0, index), { type, status: "failed", error }] })
    .where(eq(schema.automationRuns.id, runId));
}

export async function runAutomationRun(deps: ActionDeps, data: AutomationRunJobData): Promise<void> {
  const rule = await loadRuleSpec(deps.db, data.runId);
  if (rule.kind === "gone") return;
  if (rule.kind === "no-rule") {
    await deps.db
      .update(schema.automationRuns)
      .set({ status: "failed", error: "rule no longer exists", finishedAt: new Date() })
      .where(
        and(eq(schema.automationRuns.id, data.runId), eq(schema.automationRuns.status, "pending")),
      );
    return;
  }
  if (rule.kind === "bad-spec") {
    await deps.db
      .update(schema.automationRuns)
      .set({ status: "failed", error: "rule spec is invalid", finishedAt: new Date() })
      .where(
        and(eq(schema.automationRuns.id, data.runId), eq(schema.automationRuns.status, "pending")),
      );
    return;
  }

  for (const [index, action] of rule.actions.entries()) {
    // 每个动作一个事务：行锁串行化并发处理器；动作语句失败会让事务进入 aborted
    // 状态（后续 COMMIT 必败），所以错误在回调内捕获进 errors、事务拒绝在外层
    // 吞掉——真正的错误细节由 errors[0] 带出
    const errors: string[] = [];
    try {
      await deps.db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(schema.automationRuns)
          .where(eq(schema.automationRuns.id, data.runId))
          .for("update")
          .limit(1);
        const run = locked[0];
        if (run?.status !== "pending") return;
        const base = baseResults(run.actionResults);
        if (base[index]?.status === "succeeded") return;
        // 动作只写行：insert 面的通道直接接事务连接（完整 Db 带 $client，
        // 事务对象不满足），发布/邮件/日志走 services。
        // 分发是穷举 switch：动作联合新进类型而这里没接执行器时，编译期
        // 「使用前未赋值」直接挡住，不留运行期静默漏派的口子
        const services: ActionServices = deps;
        try {
          let result: ActionResult;
          switch (action.type) {
            case "create_task":
              result = await executeCreateTask(tx, services, rule.ctx, action);
              break;
            case "notify":
              result = await executeNotify(tx, services, rule.ctx, action);
              break;
            case "send_email":
              result = await executeSendEmail(tx, services, rule.ctx, action);
              break;
          }
          await tx
            .update(schema.automationRuns)
            .set({ actionResults: [...base.slice(0, index), result] })
            .where(eq(schema.automationRuns.id, data.runId));
        } catch (err) {
          errors.push(err instanceof Error ? err.message : "unknown error");
        }
      });
    } catch (txErr) {
      // 事务拒绝：动作语句失败后的 COMMIT 必败（错误已捕获），或事务本身失败
      // （基础设施问题）——后者在这里补记
      if (errors.length === 0) {
        errors.push(txErr instanceof Error ? txErr.message : "unknown error");
      }
    }
    if (errors.length > 0) {
      // 进度带外落库（重试只补这个动作），再抛给 pg-boss 走重试与告警
      const message = errors[0] ?? "unknown error";
      await recordFailure(deps.db, data.runId, index, action.type, message);
      throw new Error(`automation action failed: ${message}`);
    }
  }

  // 全部动作成功 → 终判（pending 守卫：滞留清障竞态时不覆写已终判的行）
  const updated = await deps.db
    .update(schema.automationRuns)
    .set({ status: "succeeded", finishedAt: new Date() })
    .where(and(eq(schema.automationRuns.id, data.runId), eq(schema.automationRuns.status, "pending")))
    .returning({ id: schema.automationRuns.id });
  if (updated.length === 0) {
    deps.logger.warn({ runId: data.runId }, "automation run already finalized by sweeper");
  }
}
