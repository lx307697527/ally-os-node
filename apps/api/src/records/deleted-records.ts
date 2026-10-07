import type { Db } from "@ally/db";
import { schema } from "@ally/db";

/**
 * 删除记录内核（#29 切片 2：删除记录 + 快照 + 恢复）。
 *
 * 对应 issue 迁移要点「删除操作统一改为软删除 + 快照」与老系统 /admin/deleted-records
 * 页面的意图（老-老系统用触发器逐表抄行，新设计已抛弃该形态）。本模块只提供两件
 * 机制，删除的**语义**归属主域：
 *
 * 1. `recordDeletion` —— 快照进台账的唯一写入口，删除动词的业务事务显式调用
 *    （与 recordAudit 同一写纪律：失败则业务失败，快照缺了比删除失败更糟）。
 * 2. 恢复器注册表 —— 「怎么把一行救回来」只有属主域知道（task = 清软删列）。
 *    未注册类型的台账行存得进、恢复必拒（409 restore_unsupported，fail closed，
 *    与 due 锚点/可写字段的注册表同一裁法）：删得掉的恢复不回来，比删不掉更糟。
 *
 * 查看与恢复的 HTTP 面（routes/deleted-records.ts）在 `audit.read` 权限点后——
 * 与审计日志同一批读者（owner/admin）：恢复是「把全公司可见性已关闭的行重新
 * 打开」的合规面动词，不随第一个消费域给普通行属开 Trash 入口（那是有真实
 * 需求时属主域自己的面，门自己配）。
 */

/** 台账一行 = 一次删除的事实；由删除动词在业务事务里调用 */
export interface DeletionEntry {
  /** 被删对象的多态类型（如 "task"），与 subjects/registry.ts、评论同词表 */
  subjectType: string;
  subjectId: string;
  /** 删除时刻的展示标题：台账列表的主读法 */
  title: string;
  /** 删除时刻的全行快照（JSON 安全投影——时间出 ISO 字符串） */
  snapshot: Record<string, unknown>;
  /** 删除人；系统行为可用 `system:` 前缀之外 null（与审计 actor 同语义） */
  deletedBy: string | null;
}

// 与 recordAudit 同形：调用方常在事务回调里记账，PgTransaction 满足同一 insert 接口
export async function recordDeletion(
  db: Pick<Db, "insert">,
  entry: DeletionEntry,
): Promise<void> {
  await db.insert(schema.deletedRecords).values({
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    title: entry.title,
    snapshot: entry.snapshot,
    deletedBy: entry.deletedBy,
  });
}

/** 恢复成功的语义产物：审计动词与细节由属主域给出（词表是 domain.object.verb） */
export interface RestoreOutcome {
  action: string;
  detail: Record<string, unknown>;
}

/**
 * 恢复器：把软删行救回来（如 task = 清 deleted_at/deleted_by）。返回 null = 行已
 * 不在可恢复态（被物理清除或从未存在）——409 subject_missing，恢复不伪造成功。
 * 在调用方的恢复事务里执行，行级竞争（并发恢复/直删）由 UPDATE 的 WHERE 收口。
 */
export type Restorer = (
  tx: Parameters<Db["transaction"]>[0] extends (tx: infer T) => unknown ? T : never,
  subjectId: string,
) => Promise<RestoreOutcome | null>;

const RESTORERS: Record<string, Restorer> = {};

/** 属主域切片在模块装载时注册；测试用同一条接缝注入夹具恢复器 */
export function registerRestorer(subjectType: string, restorer: Restorer): void {
  RESTORERS[subjectType] = restorer;
}

export function restorerFor(subjectType: string): Restorer | undefined {
  return RESTORERS[subjectType];
}
