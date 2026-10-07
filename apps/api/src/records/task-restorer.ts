import { and, eq, isNotNull } from "drizzle-orm";
import { schema } from "@ally/db";

import { registerRestorer } from "./deleted-records.ts";

/**
 * task 的恢复器（#29 切片 2）：任务内核（#113）把 "task" 注册为第一个可恢复
 * subject。恢复 = 原子地清软删列（WHERE deleted_at is not null 收口并发的恢复
 * 与直删），评论/关注/自定义字段值原地未动，行回来即整体回来；恢复不伪造历史
 * ——审计 task.restored 由恢复路由统一落行，本文件只回答「怎么救」。
 *
 * 注册在模块装载时发生（app.ts 的 side-effect import，与 approval/billing 的
 * registry 接线同一形态）——任何请求发生之前。
 */
registerRestorer("task", async (tx, taskId) => {
  const rows = await tx
    .update(schema.tasks)
    .set({ deletedAt: null, deletedBy: null })
    .where(and(eq(schema.tasks.id, taskId), isNotNull(schema.tasks.deletedAt)))
    .returning({ id: schema.tasks.id, title: schema.tasks.title });
  const row = rows[0];
  if (row === undefined) return null;
  return { action: "task.restored", detail: { title: row.title } };
});
