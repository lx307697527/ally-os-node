import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@ally/db";
import { z } from "zod";
import { roleSchema } from "../authz/permissions.ts";
import { registerConditionBlock } from "../workflow/blocks.ts";
import { SUBJECT_LOADERS } from "../subjects/registry.ts";
import { registerSignableSubject } from "../esign/registry.ts";
import { loadApprovalActionRecord } from "./service.ts";

/**
 * 审批内核的接缝注册（#221 切片 1）——三个消费方向在模块装载时接线：
 *
 * 1. **工作流门槛积木 `approval.passed`**（#220 blocks 注册表的第一批成员）：
 *    「审批可作为流程状态机的进入门槛」（#221 要点）——流程流转引用本积木并带
 *    `{ key }` 指明审批线，门槛 = 该单据上这条线存在一条 approved 请求。未提交
 *    或被驳回都不过门（fail closed：驳回后重新提交拿到新的 approved 才放行）。
 * 2. **可签名 subject `approval_action`**（esign 注册表的第一个生产成员，#219
 *    预告的「第一个消费域」）：要求签名的级别，签名仪式经 esign 内核把 Part 11
 *    签名落在裁决行上。版本标 = 行的 createdAt（append-only，行即版本）。
 * 3. **可见性门 `approval_action`**（subjects/registry 的同一扇）：审批的参与者
 *    ——发起人、点名的审批人、已裁决的人、配置角色的现任持有者——看得到裁决
 *    行与签名墙；单据本身的可见性仍由属主域裁决，两扇门各说各的话。
 */

/** 门槛积木的 config 形状：引用哪条审批线（模板保存只校验积木名，config 在此收口） */
const gateConfigSchema = z.object({ key: z.string().trim().min(1).max(64) });

registerConditionBlock("approval.passed", async (ctx) => {
  const cfg = gateConfigSchema.safeParse(ctx.config);
  if (!cfg.success) {
    // config 形状不对 = 配置错误，门不过（422 gate_failed 带积木名），不炸 500
    return false;
  }
  const rows = await ctx.db
    .select({ id: schema.approvalRequests.id })
    .from(schema.approvalRequests)
    .where(
      and(
        eq(schema.approvalRequests.subjectType, ctx.subjectType),
        eq(schema.approvalRequests.subjectId, ctx.subjectId),
        eq(schema.approvalRequests.configKey, cfg.data.key),
        eq(schema.approvalRequests.status, "approved"),
      ),
    )
    .limit(1);
  return rows[0] !== undefined;
});

/**
 * 裁决行的语境：参与者集合（发起人 + 各级点名人 + 已裁决人 + 配置角色的现任
 * 持有者）与展示名。角色持有者是查询时刻的快照——角色是会变的，可见性跟着
 * 现任走（离任者不再看得见新的裁决，历史签名墙按签名时的记录仍在）。
 */
SUBJECT_LOADERS.approval_action = async (db, subjectId) => {
  const rows = await db
    .select({
      id: schema.approvalActions.id,
      requestId: schema.approvalActions.requestId,
      stepIndex: schema.approvalActions.stepIndex,
      levelName: schema.approvalActions.levelName,
      configName: schema.approvalConfigs.name,
      submittedById: schema.approvalRequests.submittedById,
      levels: schema.approvalRequests.levels,
    })
    .from(schema.approvalActions)
    .innerJoin(schema.approvalRequests, eq(schema.approvalActions.requestId, schema.approvalRequests.id))
    .innerJoin(schema.approvalConfigs, eq(schema.approvalRequests.configId, schema.approvalConfigs.id))
    .where(eq(schema.approvalActions.id, subjectId))
    .limit(1);
  const action = rows[0];
  if (action === undefined) return null;

  const viewerIds = new Set<string>([action.submittedById]);
  let roleNames: string[] = [];
  const levelsShape = z
    .array(z.object({ users: z.array(z.string()).default([]), roles: z.array(z.string()).default([]) }))
    .min(1)
    .safeParse(action.levels);
  if (levelsShape.success) {
    for (const level of levelsShape.data) {
      for (const userId of level.users) viewerIds.add(userId);
    }
    roleNames = [...new Set(levelsShape.data.flatMap((level) => level.roles))];
  }
  // levels 被外力改歪时 shape 解析失败：跳过展开，仅发起人与已裁决人可见（fail closed）
  const validRoles = roleNames.flatMap((name) => {
    const parsed = roleSchema.safeParse(name);
    return parsed.success ? [parsed.data] : [];
  });
  if (validRoles.length > 0) {
    const holders = await db
      .select({ userId: schema.userRole.userId })
      .from(schema.userRole)
      .where(inArray(schema.userRole.role, validRoles));
    for (const holder of holders) viewerIds.add(holder.userId);
  }
  const acted = await db
    .select({ actorId: schema.approvalActions.actorId })
    .from(schema.approvalActions)
    .where(eq(schema.approvalActions.requestId, action.requestId));
  for (const row of acted) viewerIds.add(row.actorId);

  const people = await db
    .select({ id: schema.authUser.id, name: schema.authUser.name })
    .from(schema.authUser)
    .where(inArray(schema.authUser.id, [...viewerIds]));
  return {
    id: action.id,
    title: `${action.configName} · step ${action.stepIndex + 1}`,
    viewers: people.map((person) => ({ id: person.id, name: person.name })),
  };
};

registerSignableSubject("approval_action", {
  load: loadApprovalActionRecord,
});
