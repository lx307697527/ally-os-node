import { and, eq, gte, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { DueDirection } from "@ally/automations";
import { schema, type Db } from "@ally/db";
import { AUTOMATION_TASK_SUBJECT_TYPE } from "./actions.ts";

/**
 * due 触发的 subject 注册表（#224 切片 2）。
 *
 * 「记录上的日期字段到达锚点 ± 偏移」的触发（预约前 N 小时、会后 24 小时）
 * 只有记录的属主域自己知道去哪张表、哪个日期列找到期时刻——与可签名 subject
 * （esign/registry.ts）、评论/活动可见性门（subjects/registry.ts）同一裁法：
 * 内核提供接缝，属主域切片注册。到期扫描器对未注册的 subjectType / 未声明的
 * anchorField 一律跳过并告警（fail closed）——配置写得出、机制不装跑，不会
 * 出现「扫了但不该扫的表」。
 *
 * 第一个成员是 task（锚点 dueAt）：任务内核（#113）的行今天就在，到期提醒是
 * 到期触发的最小真实消费面。预约/会议（#207）进场时注册自己的成员。
 */

export interface DueRow {
  /** subject 行 id——落 automation_runs.source_event_id，即 (rule, 行) 一次性的去重键 */
  id: string;
  /** 条件求值看到的世界（dueEventContext 的 detail）：JSON 安全的行投影 */
  detail: Record<string, unknown>;
}

export interface DueLoadArgs {
  anchorField: string;
  direction: DueDirection;
  offsetMinutes: number;
  /** 到期时刻带 [from, to]（锚点 ± 偏移落在这个带的行该跑了） */
  from: Date;
  to: Date;
}

export interface DueSubjectSpec {
  /** 可作锚点的日期字段（声明式白名单；扫描器先查这张表再取数） */
  anchorFields: readonly string[];
  loadDueRows(db: Db, args: DueLoadArgs): Promise<DueRow[]>;
}

const DUE_SUBJECTS: Record<string, DueSubjectSpec> = {};

/** 属主域切片在模块装载时注册；测试用同一条接缝注入夹具 subject */
export function registerDueSubject(subjectType: string, spec: DueSubjectSpec): void {
  DUE_SUBJECTS[subjectType] = spec;
}

export function dueSubjectSpec(subjectType: string): DueSubjectSpec | undefined {
  return DUE_SUBJECTS[subjectType];
}

// ── 第一个成员：task（锚点 dueAt）────────────────────────────────────────────
//
// 两个属主域裁决都在这条查询里：
// - 只扫 open 任务——done/cancelled 的任务没有「快到期」可言；
// - 排除自动化自己建的任务（subject_type = automation_rule，见 actions.ts）：
//   「due 触发 → create_task(dueInHours)」若不设防，子任务到期再触发同一规则，
//   每 ≥5 分钟自增一条任务——锚点侧一闸挡住同规则与跨规则的链式自触发，
//   人工建的链条入口保持开放。

/** task 行的条件语境投影：JSON 安全（时间出 ISO 字符串），字段名跟 API 读写一致 */
interface TaskDueRow {
  id: string;
  title: string;
  status: string;
  assigneeId: string | null;
  dueAt: Date | null;
  subjectType: string | null;
  subjectId: string | null;
}

const taskDueSpec: DueSubjectSpec = {
  anchorFields: ["dueAt"],
  async loadDueRows(db, args) {
    // 锚点 ± 偏移落在扫描带内：before 用减、after 用加，SQL 侧过滤（不整表拉回）
    const offsetSql =
      args.direction === "before"
        ? sql`${schema.tasks.dueAt} - make_interval(mins => ${args.offsetMinutes}::int)`
        : sql`${schema.tasks.dueAt} + make_interval(mins => ${args.offsetMinutes}::int)`;
    const rows: TaskDueRow[] = await db
      .select({
        id: schema.tasks.id,
        title: schema.tasks.title,
        status: schema.tasks.status,
        assigneeId: schema.tasks.assigneeId,
        dueAt: schema.tasks.dueAt,
        subjectType: schema.tasks.subjectType,
        subjectId: schema.tasks.subjectId,
      })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.status, "open"),
          or(
            isNull(schema.tasks.subjectType),
            ne(schema.tasks.subjectType, AUTOMATION_TASK_SUBJECT_TYPE),
          ),
          gte(offsetSql, args.from),
          lte(offsetSql, args.to),
        ),
      );
    // 带过滤（锚点 ± interval BETWEEN）在 SQL 侧排除了 due_at null 的行；类型上
    // 列仍可空，这里防御式跳过而非断言
    return rows.flatMap((row) =>
      row.dueAt === null
        ? []
        : [
            {
              id: row.id,
              detail: {
                title: row.title,
                status: row.status,
                assigneeId: row.assigneeId,
                dueAt: row.dueAt.toISOString(),
                subjectType: row.subjectType,
                subjectId: row.subjectId,
              },
            },
          ],
    );
  },
};

registerDueSubject("task", taskDueSpec);
