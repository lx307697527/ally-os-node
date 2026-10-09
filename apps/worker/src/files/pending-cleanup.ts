import { lt, and, eq } from "drizzle-orm";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { Storage } from "@ally/storage";
import type { Logger } from "pino";

/**
 * 预签名直传的 pending 行清扫（#31 切片 1）。
 *
 * 直传的生命周期反转（先记账后落桶）引入了老系统没有的死态：客户端拿了
 * presign 但永远没传（关了页面、网络断了、上传失败放弃）——pending 行留在
 * 账上，占着每个 subject 的文件名额（≤3），没人 complete 就永远是占位。
 *
 * 裁决：行按年龄删（24 小时——上传是分钟级动作，一天是给慢网络的宽限），
 * 对象尽力删、先行于行删（行删了 storageKey 就无从查起；对象删失败时行留
 * 待下一轮重试，台账永远指向还没删掉的东西）。清行前不问 complete 有没有
 * 晚到：预签名 5 分钟过期，24 小时后才轮到清扫，「还在传」不存在。
 */

/** pending 行保留：上传是分钟级动作，1 天 = 足够保守的死线 */
const PENDING_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface PendingFileCleanupResult {
  filesDeleted: number;
  objectsDeleted: number;
  objectsFailed: number;
}

export async function runPendingFileCleanup(
  db: Db,
  storage: Storage,
  logger: Logger,
  now: Date,
): Promise<PendingFileCleanupResult> {
  const cutoff = new Date(now.getTime() - PENDING_RETENTION_MS);
  const stale = await db
    .select({ id: schema.files.id, storageKey: schema.files.storageKey })
    .from(schema.files)
    .where(and(eq(schema.files.status, "pending"), lt(schema.files.createdAt, cutoff)));

  let objectsDeleted = 0;
  let objectsFailed = 0;
  const deletable: string[] = [];
  for (const row of stale) {
    try {
      // S3 的 DeleteObject 对不存在的对象同样答成功：complete 前的 pending 行
      // 本来就可能没有对象，删是幂等的
      await storage.delete(row.storageKey);
      objectsDeleted += 1;
      deletable.push(row.id);
    } catch (err) {
      objectsFailed += 1;
      logger.warn({ err, key: row.storageKey }, "stale pending file object delete failed");
    }
  }
  let filesDeleted = 0;
  for (const id of deletable) {
    const deleted = await db
      .delete(schema.files)
      .where(and(eq(schema.files.id, id), eq(schema.files.status, "pending")))
      .returning({ id: schema.files.id });
    filesDeleted += deleted.length;
  }
  return { filesDeleted, objectsDeleted, objectsFailed };
}
