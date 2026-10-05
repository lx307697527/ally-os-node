import type { Db } from "@ally/db";
import { schema } from "@ally/db";

/**
 * 平台审计写入器（#29）。对应老系统的两层：老-老系统用数据库触发器逐表写审计
 * （176 个，新设计已抛弃），上一代内核 core.emit_event() 由业务 RPC 在同一事务里
 * 显式调用——本模块取后者的形态：应用层显式写入，一次业务变更一行审计。
 *
 * 层次裁决（#29 迁移要点「触发器 vs 应用层」）：新系统所有写路径都收敛在 API，
 * 应用层审计能记录「谁、做了什么、对哪条记录」且不依赖逐表接线；数据库侧只保留
 * 一条不可协商的底线——表 append-only（0007 触发器，#232「审计日志不可删除」）。
 * 将来 Part 11 监管表（批记录等）进场时逐表评估「触发器兜底人工写路径」，评估
 * 记录在 docs/audit.md，不在本文件里预置。
 *
 * 动作词表：`domain.object.verb`（role.granted / role.revoked；状态变更类在
 * detail 里带 from/to）。词表是开集，随业务域增长；完整约定见 docs/audit.md。
 *
 * 失败语义：写入失败原样抛出——审计丢失比业务失败严重，宁可让业务操作失败回滚，
 * 不做「记不上就算了」的静默降级。
 */
export interface AuditEntry {
  /** 发起方：用户 id；无用户上下文的运维动作用 `cli:<script>` 前缀 */
  actor: string | null;
  /** 动作，`domain.object.verb` 词表（开集） */
  action: string;
  /** 被操作方的 id（用户或业务记录） */
  target?: string | null;
  /** 变更细节：授予/撤销了什么、状态从哪到哪（from/to）、审批裁决等 */
  detail?: Record<string, unknown> | null;
}

export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(schema.auditEvents).values({
    actor: entry.actor,
    action: entry.action,
    target: entry.target ?? null,
    detail: entry.detail ?? null,
  });
}
