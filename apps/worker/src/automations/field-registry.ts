import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { AUTOMATION_ACTOR_PREFIX } from "@ally/automations";
import { schema, type Db } from "@ally/db";

/**
 * update_field 动作的 subject 注册表（#224 切片 6）。
 *
 * 「一张表的哪个字段容许自动化改、值域是什么、改完留下什么痕迹」只有记录的属主
 * 域自己知道——与 due 锚点注册表（due-registry.ts）、可签名 subject
 * （api 的 esign/registry.ts）同一裁法：内核提供接缝，属主域切片注册。注册表是
 * 声明式白名单：没注册的 subjectType / field，规则配置存得进（保存面在 API，看
 * 不到 worker 的注册表），执行必败并告警——fail closed，不会出现「改了但不该改
 * 的列」。
 *
 * 第一个成员是 task.status：任务内核（#113）的行今天就在，「X 发生 → 关单」是
 * #134 触发器清单（sync_signing_to_documents 一类「状态跟写」）里改字段的最小
 * 真实消费面。assigneeId/dueAt 刻意不在首组白名单：改经办人要带「可分配面」
 * 裁决（routes/tasks.ts 的 findAssignableUser，进 worker 会第二份实现）、静态
 * 到期时刻写进规则里是半年后必然过期的脚枪——等真实规则需求进场再议。
 */

/** 动作事务的写面：runner 的事务对象与完整 Db 都满足 */
export type FieldWriteTx = Pick<Db, "insert" | "select" | "update">;

/** 动作语境的归属信息：审计 detail 里署名是哪条规则干的 */
export interface FieldWriteContext {
  ruleId: string;
  ruleName: string;
  runId: string;
}

export interface UpdatableFieldSpec {
  /**
   * 校验值并写行。抛错 = 动作失败进重试协议（重试耗尽终判 failed + 告警），
   * 不静默跳过——「少改一个字段」必须有人看见。值先在本函数里按域词表收口
   * （保存面只保证是 JSON），非法值同样抛错。
   */
  apply(tx: FieldWriteTx, subjectId: string, value: unknown, ctx: FieldWriteContext): Promise<void>;
}

export interface UpdatableSubjectSpec {
  /** 字段名 → 写法。字段名与 API 读写面一致（camelCase），不暴露列名 */
  fields: Record<string, UpdatableFieldSpec>;
}

const UPDATABLE_SUBJECTS: Record<string, UpdatableSubjectSpec> = {};

/** 属主域切片在模块装载时注册；测试用同一条接缝注入夹具 subject */
export function registerUpdatableSubject(subjectType: string, spec: UpdatableSubjectSpec): void {
  UPDATABLE_SUBJECTS[subjectType] = spec;
}

export function updatableSubjectSpec(subjectType: string): UpdatableSubjectSpec | undefined {
  return UPDATABLE_SUBJECTS[subjectType];
}

// ── 第一个成员：task.status ──────────────────────────────────────────────────

const TASK_STATUSES = ["open", "done", "cancelled"] as const;

const taskUpdatableSpec: UpdatableSubjectSpec = {
  fields: {
    status: {
      async apply(tx, subjectId, value, ctx) {
        const parsed = z.enum(TASK_STATUSES).safeParse(value);
        if (!parsed.success) {
          throw new Error(
            `update_field value for task.status must be one of: ${TASK_STATUSES.join(", ")}`,
          );
        }
        // 行锁下读旧值：并发的人手编辑与本动作在行上排队，from/to 是锁内真相；
        // 软删行按不存在处理（#29 切片 2）——改一条已删除的任务比不改更糟
        const rows = await tx
          .select({ status: schema.tasks.status })
          .from(schema.tasks)
          .where(and(eq(schema.tasks.id, subjectId), isNull(schema.tasks.deletedAt)))
          .for("update")
          .limit(1);
        const task = rows[0];
        if (task === undefined) {
          throw new Error(`update_field target row does not exist: task ${subjectId}`);
        }
        // 与人手 PATCH 同裁（routes/tasks.ts）：值没变就是 no-op——不动行、
        // 不写审计。反复命中的规则不能靠 no-op 写把审计流刷成自己的转发日志
        if (task.status === parsed.data) return;
        await tx
          .update(schema.tasks)
          .set({ status: parsed.data, updatedAt: new Date() })
          .where(eq(schema.tasks.id, subjectId));
        // 与 API 写路径同一词表的 task.status_changed（from/to）；actor 带
        // automation 前缀——扫描器跳过（规则触发规则没有这条通路），活动流照常可见
        await tx.insert(schema.auditEvents).values({
          actor: `${AUTOMATION_ACTOR_PREFIX}${ctx.runId}`,
          action: "task.status_changed",
          target: subjectId,
          detail: {
            from: task.status,
            to: parsed.data,
            via: "automation",
            ruleId: ctx.ruleId,
            ruleName: ctx.ruleName,
          },
        });
      },
    },
  },
};

registerUpdatableSubject("task", taskUpdatableSpec);
