import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@ally/db";

/**
 * 配置版本台账原语（#226）——从 apps/api/config-versions 下沉（#233 定时生效
 * cron 接线切片）：规则注册表的到点前滚（applyDueRuleChanges）要在这边的事务里
 * 记账，而 worker 不跨 app 依赖。两个原语是纯 SQL 面，只依赖 @ally/db；域语义
 * （各族怎么组 snapshot/changes、草稿、回滚）仍归 apps/api 的 config-versions。
 *
 * 记账协议（调用方遵守，apps/api 侧由集成测试钉住）：
 * 1. 记账与配置行写入同事务——台账缺行比业务失败严重（版本号是回滚的寻址方式，
 *    账外变更会让「行.version = 台账最新版」的不变式断掉）。
 * 2. 先 nextConfigVersion，再写配置行（version 列一并落），再 recordConfigRevision
 *    ——配置行 UPDATE 拿到的行锁把同对象的并发记账串行化，后到者在提交后才能
 *    看到 max(version)，unique(subject_type, subject_id, version) 兜底撞车即炸。
 * 3. 无实效变更不记账（与 numbering PATCH / comment edit 同一纪律——审计和
 *    活动流都不被 no-op 刷屏）。
 */

/** 变更摘要：{ 字段: { from, to } }，顶层键；created 记账无此字段（null） */
export type ConfigChanges = Record<string, { from: unknown; to: unknown }>;

export type ConfigRevisionSource = (typeof schema.configRevisionSource.enumValues)[number];

export interface RecordConfigRevisionInput {
  subjectType: string;
  subjectId: string;
  version: number;
  actorId: string | null;
  snapshot: Record<string, unknown>;
  changes: ConfigChanges | null;
  source: ConfigRevisionSource;
}

/** (subject_type, subject_id) 内下一个版本号 = 台账当前最大版 + 1（空史 = 1） */
export async function nextConfigVersion(
  tx: Pick<Db, "select">,
  subjectType: string,
  subjectId: string,
): Promise<number> {
  const rows = await tx
    .select({ maxVersion: sql<number | null>`max(${schema.configRevisions.version})` })
    .from(schema.configRevisions)
    .where(
      and(
        eq(schema.configRevisions.subjectType, subjectType),
        eq(schema.configRevisions.subjectId, subjectId),
      ),
    );
  return (rows[0]?.maxVersion ?? 0) + 1;
}

/** 记一版。version 由调用方经 nextConfigVersion 算好传入（写配置行要用同一个值） */
export async function recordConfigRevision(
  tx: Pick<Db, "insert">,
  input: RecordConfigRevisionInput,
): Promise<void> {
  await tx.insert(schema.configRevisions).values({
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    version: input.version,
    snapshot: input.snapshot,
    changes: input.changes,
    source: input.source,
    changedById: input.actorId,
  });
}
