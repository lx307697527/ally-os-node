import { and, asc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import { recordAudit } from "../audit/audit-log.ts";
import type { Role } from "../authz/permissions.ts";
import { roleSchema } from "../authz/permissions.ts";
import { signSubject, type EsignMeaning } from "../esign/service.ts";

/**
 * 审批内核服务（#221 切片 1）。
 *
 * 与流程内核（workflow/service.ts）同一套骨架，三处裁决差异来自审批的本性：
 * - 授权不看可见性看配置：一级审批谁能做由配置里的 users/roles 裁决（#221「配置
 *   审批人（指定人员或角色）」）——角色审批人不要求恰好是单据的可见者，两扇门
 *   各管各的（单据可见性是属主域的事，配置点名是配置工作室的事）；
 * - 签名仪式在推进事务内：要求签名的级别，审批、签名、推进、审计要么全成要么
 *   全不算（Part 11 的联结签名不能落在被回滚的裁决上）；
 * - 驳回是终态：请求结束、单据回到发起人（通知落库），修改后重新提交 = 新请求
 *   ——历史逐请求可溯，不改写旧裁决（0014 触发器拒改 action 行）。
 *
 * 并发推进双保险：action 行的 (request_id, step_index) 唯一约束把同级的两个审批人
 * 串行化（输家撞 23505），UPDATE 带 current_step/status 条件的乐观并发控制守住
 * 状态迁移——两个都输的人按冲突拒绝，不覆盖别人的裁决。
 */

/** 一级审批的形状（配置保存时 zod 收口，请求提交时整份快照进 levels 列） */
export interface ApprovalLevel {
  name: string;
  /** 指定人员（uuid）与指定角色的并集是这一级的审批人集合 */
  users: string[];
  roles: Role[];
  /** 这级的「同意」是否要求电子签名（驳回不签：回到发起人是内部协作不是监管事实） */
  requireSignature: boolean;
  /** 签名含义（Part 11.50）：审批语境只有复核/批准两值 */
  signatureMeaning: Extract<EsignMeaning, "reviewed" | "approved">;
}

export const approvalLevelsSchema = z
  .array(
    z
      .object({
        name: z.string().trim().min(1).max(100),
        users: z.array(z.uuid()).max(20).default([]),
        roles: z.array(roleSchema).max(14).default([]),
        requireSignature: z.boolean().default(false),
        signatureMeaning: z.enum(["reviewed", "approved"]).default("approved"),
      })
      .refine((level) => level.users.length + level.roles.length >= 1, {
        message: "each approval level needs at least one approver (user or role)",
      })
      // 审批是员工动作：customer 不是任何审批线的合法审批人（与流程内核的员工
      // 地板同一裁决——配置直接拒，不在运行时再判一遍）
      .refine((level) => !level.roles.includes("customer"), {
        message: "customer role cannot approve",
      }),
  )
  .min(1)
  .max(10);

export function parseApprovalLevels(value: unknown): { ok: true; levels: ApprovalLevel[] } | { ok: false } {
  const parsed = approvalLevelsSchema.safeParse(value);
  return parsed.success ? { ok: true, levels: parsed.data } : { ok: false };
}

// ── 提交审批请求 ─────────────────────────────────────────────────────────────

export interface SubmitCommand {
  subjectType: string;
  subjectId: string;
  configKey: string;
  submitterId: string;
}

export type SubmitOutcome =
  | { status: "created"; requestId: string }
  | {
      status: "rejected";
      reason: "config_not_found" | "config_inactive" | "levels_invalid" | "already_pending";
      requestId?: string;
    };

/** 单据进入审批（属主域在业务动作里进程内调用；触发条件随 #233 决策表进场） */
export async function submitApprovalRequest(db: Db, cmd: SubmitCommand): Promise<SubmitOutcome> {
  const configRows = await db
    .select()
    .from(schema.approvalConfigs)
    .where(
      and(
        eq(schema.approvalConfigs.subjectType, cmd.subjectType),
        eq(schema.approvalConfigs.configKey, cmd.configKey),
      ),
    )
    .limit(1);
  const config = configRows[0];
  if (config === undefined) {
    return { status: "rejected", reason: "config_not_found" };
  }
  if (!config.active) {
    return { status: "rejected", reason: "config_inactive" };
  }
  const parsed = parseApprovalLevels(config.levels);
  if (!parsed.ok) {
    // 配置保存时已过校验；走到这里是库内数据被外力改歪，fail closed 不带病在飞
    return { status: "rejected", reason: "levels_invalid" };
  }
  const inserted = await db
    .insert(schema.approvalRequests)
    .values({
      configId: config.id,
      configKey: config.configKey,
      subjectType: cmd.subjectType,
      subjectId: cmd.subjectId,
      levels: config.levels,
      submittedById: cmd.submitterId,
    })
    // 部分唯一索引（同单同线至多一个在飞请求）撞车 = 并发双提交，输家按已存在
    // 请求返回（23505 的形状收窄见 routes/workflow-templates.ts isUniqueViolation）
    .onConflictDoNothing()
    .returning({ id: schema.approvalRequests.id });
  const row = inserted[0];
  if (row === undefined) {
    const existing = await db
      .select({ id: schema.approvalRequests.id })
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.subjectType, cmd.subjectType),
          eq(schema.approvalRequests.subjectId, cmd.subjectId),
          eq(schema.approvalRequests.configKey, cmd.configKey),
          eq(schema.approvalRequests.status, "pending"),
        ),
      )
      .limit(1);
    const pendingId = existing[0]?.id;
    if (pendingId === undefined) throw new Error("approval submit: conflict but no pending request found");
    return { status: "rejected", reason: "already_pending", requestId: pendingId };
  }
  await recordAudit(db, {
    actor: cmd.submitterId,
    action: "approval.requested",
    target: row.id,
    detail: {
      subjectType: cmd.subjectType,
      subjectId: cmd.subjectId,
      configKey: config.configKey,
      steps: parsed.levels.map((level) => level.name),
    },
  });
  return { status: "created", requestId: row.id };
}

// ── 审批裁决（同意 / 驳回）──────────────────────────────────────────────────

export interface ActCommand {
  requestId: string;
  actorId: string;
  /** 调用方（路由）从 authz 中间件取的当前角色集：角色审批人按它匹配 */
  actorRoles: readonly Role[];
  /** 签名仪式的前置门（#24 语义）：要求签名的级别必须双因素（#232 §13） */
  actorTwoFactorEnabled: boolean;
  decision: "approved" | "rejected";
  /** 审批意见（#221「谁、何时、同意或驳回、意见」的可选一环） */
  note?: string | undefined;
  /** requireSignature 级别的仪式输入：重输密码 + 幂等键；没有即 422 signature_required */
  signature?: { password: string; clientToken: string } | undefined;
}

export type ActOutcome =
  | {
      status: "applied";
      requestId: string;
      actionId: string;
      decision: "approved" | "rejected";
      requestStatus: "pending" | "approved" | "rejected";
      currentStep: number;
    }
  | {
      status: "rejected";
      reason:
        | "not_found"
        | "request_closed"
        | "not_approver"
        | "two_factor_required"
        | "signature_required"
        | "invalid_credentials"
        | "already_signed"
        | "concurrent_conflict";
    };

/** 签名仪式在事务内被拒：抛出哨兵让事务回滚（裁决行不能离开被拒的签名独活） */
class CeremonyRejected extends Error {
  readonly reason: "invalid_credentials" | "already_signed";

  constructor(reason: "invalid_credentials" | "already_signed") {
    super(`esign ceremony rejected: ${reason}`);
    this.reason = reason;
  }
}

/** CAS 抢输：事务回滚（输家的 action 行绝不能留下），按冲突拒绝 */
class ConcurrentConflict extends Error {
  constructor() {
    super("approval act lost a concurrent race");
  }
}

export async function actOnApproval(
  db: Db,
  cmd: ActCommand,
  opts: { notifyUsers?: (userIds: string[]) => Promise<void> } = {},
): Promise<ActOutcome> {
  const requestRows = await db
    .select()
    .from(schema.approvalRequests)
    .where(eq(schema.approvalRequests.id, cmd.requestId))
    .limit(1);
  const request = requestRows[0];
  if (request === undefined) {
    return { status: "rejected", reason: "not_found" };
  }
  if (request.status !== "pending") {
    return { status: "rejected", reason: "request_closed" };
  }
  const parsed = parseApprovalLevels(request.levels);
  if (!parsed.ok) {
    throw new Error(`approval request ${request.id} has invalid levels`);
  }
  const level = parsed.levels[request.currentStep];
  if (level === undefined) {
    throw new Error(`approval request ${request.id} current step out of range`);
  }
  const isApprover =
    level.users.includes(cmd.actorId) || level.roles.some((role) => cmd.actorRoles.includes(role));
  if (!isApprover) {
    return { status: "rejected", reason: "not_approver" };
  }
  const needsSignature = cmd.decision === "approved" && level.requireSignature;
  if (needsSignature && !cmd.actorTwoFactorEnabled) {
    // 2FA 门先于密码判定：未启用双因素的用户连「密码对不对」都探不到（与
    // esignatures 路由同一语义——Part 11 的签名用户必须双因素，无例外开关）
    return { status: "rejected", reason: "two_factor_required" };
  }
  if (needsSignature && cmd.signature === undefined) {
    return { status: "rejected", reason: "signature_required" };
  }

  const note = cmd.note?.trim();
  let outcome: ActOutcome;
  try {
    outcome = await db.transaction(async (tx): Promise<ActOutcome> => {
      const insertedAction = await tx
        .insert(schema.approvalActions)
        .values({
          requestId: request.id,
          stepIndex: request.currentStep,
          levelName: level.name,
          decision: cmd.decision,
          ...(note !== undefined && note !== "" ? { note } : {}),
          actorId: cmd.actorId,
        })
        // 唯一约束先于 CAS 生效：同级的两个审批人在这里被串行化，输家按冲突拒绝
        .onConflictDoNothing({ target: [schema.approvalActions.requestId, schema.approvalActions.stepIndex] })
        .returning({ id: schema.approvalActions.id });
      const action = insertedAction[0];
      if (action === undefined) {
        throw new ConcurrentConflict();
      }
      if (needsSignature && cmd.signature !== undefined) {
        // 签名仪式（#219 内核）：密码重验 + 绑定裁决行的版本与内容快照 + meaning
        // 落 esign_signatures。事务内调用（savepoint）：仪式被拒则整包回滚。
        const sign = await signSubject(
          tx,
          {
            subjectType: "approval_action",
            subjectId: action.id,
            signerId: cmd.actorId,
            meaning: level.signatureMeaning,
            password: cmd.signature.password,
            clientToken: cmd.signature.clientToken,
            signedAt: new Date(),
          },
          loadApprovalActionRecord,
        );
        if (sign.status === "rejected") {
          if (sign.reason === "record_missing") {
            throw new Error("esign ceremony: action row missing inside its own transaction");
          }
          throw new CeremonyRejected(sign.reason);
        }
      }
      // 乐观并发推进：非末级同意 = 进入下一级；末级同意或任何驳回 = 终态
      // （驳回后单据回到发起人，重新提交 = 新请求）
      const isLastStep = request.currentStep >= parsed.levels.length - 1;
      const nextStatus: "pending" | "approved" | "rejected" =
        cmd.decision === "rejected" ? "rejected" : isLastStep ? "approved" : "pending";
      const advanced = await tx
        .update(schema.approvalRequests)
        .set(
          nextStatus === "pending"
            ? { currentStep: request.currentStep + 1 }
            : { status: nextStatus, completedAt: new Date() },
        )
        .where(
          and(
            eq(schema.approvalRequests.id, request.id),
            eq(schema.approvalRequests.currentStep, request.currentStep),
            eq(schema.approvalRequests.status, "pending"),
          ),
        )
        .returning({ id: schema.approvalRequests.id });
      if (advanced[0] === undefined) {
        throw new ConcurrentConflict();
      }
      // 审计行与裁决同事务：审计失败则裁决失败（与全部业务写路径一致）。每条
      // action 一行 approval.action_recorded（#221 验收：审计可查审批人、时间、
      // 结论、签名含义），终态再加一行请求级事件。
      await recordAudit(tx, {
        actor: cmd.actorId,
        action: "approval.action_recorded",
        target: action.id,
        detail: {
          requestId: request.id,
          subjectType: request.subjectType,
          subjectId: request.subjectId,
          configKey: request.configKey,
          stepIndex: request.currentStep,
          level: level.name,
          decision: cmd.decision,
          ...(note !== undefined && note !== "" ? { note } : {}),
          ...(needsSignature ? { signatureMeaning: level.signatureMeaning } : {}),
        },
      });
      if (nextStatus !== "pending") {
        await recordAudit(tx, {
          actor: cmd.actorId,
          action: nextStatus === "approved" ? "approval.completed" : "approval.rejected",
          target: request.id,
          detail: {
            subjectType: request.subjectType,
            subjectId: request.subjectId,
            configKey: request.configKey,
            decision: cmd.decision,
            finalStep: request.currentStep,
          },
        });
        // 终态通知发起人（驳回回到发起人的「回到」是真的递到手上；#110 通知内核）
        await tx.insert(schema.notifications).values({
          userId: request.submittedById,
          eventType: nextStatus === "approved" ? "approval.completed" : "approval.rejected",
          aggregateType: "approval_request",
          aggregateId: request.id,
          payload: {
            subjectType: request.subjectType,
            subjectId: request.subjectId,
            configKey: request.configKey,
          },
        });
      }
      return {
        status: "applied",
        requestId: request.id,
        actionId: action.id,
        decision: cmd.decision,
        requestStatus: nextStatus,
        currentStep: nextStatus === "pending" ? request.currentStep + 1 : request.currentStep,
      };
    });
  } catch (err) {
    // 哨兵转拒绝结果：签名仪式被拒 / CAS 抢输都已在事务里回滚（裁决行与签名
    // 要么全成要么全不算），调用方拿到的是语义化拒绝而不是异常
    if (err instanceof CeremonyRejected) {
      return { status: "rejected", reason: err.reason };
    }
    if (err instanceof ConcurrentConflict) {
      return { status: "rejected", reason: "concurrent_conflict" };
    }
    throw err;
  }

  // 事务提交后才「催」（AppDeps.notifyUsers 的 at-most-once 合同：失败只降级轮询）
  if (outcome.status === "applied" && outcome.requestStatus !== "pending" && opts.notifyUsers !== undefined) {
    await opts.notifyUsers([request.submittedById]);
  }
  return outcome;
}

// ── 读法 ────────────────────────────────────────────────────────────────────

export interface ApprovalActionRow {
  id: string;
  stepIndex: number;
  levelName: string;
  decision: "approved" | "rejected";
  note: string | null;
  actor: { id: string; name: string };
  createdAt: Date;
  signature: { meaning: EsignMeaning; signedAt: Date } | null;
}

export interface ApprovalRequestView {
  id: string;
  configKey: string;
  configName: string;
  subjectType: string;
  subjectId: string;
  status: "pending" | "approved" | "rejected";
  currentStep: number;
  /** 当前级的名字与审批人集合（在飞时给「轮到谁」；终态为 null） */
  currentLevel: { name: string; users: string[]; roles: Role[] } | null;
  submittedBy: { id: string; name: string };
  submittedAt: Date;
  completedAt: Date | null;
  actions: ApprovalActionRow[];
}

/** 请求详情（路由过可见性门后才调；不存在返回 null，与不可见同答 404） */
export async function approvalRequestView(db: Db, requestId: string): Promise<ApprovalRequestView | null> {
  const submitter = alias(schema.authUser, "submitter");
  const requestRows = await db
    .select({
      id: schema.approvalRequests.id,
      configKey: schema.approvalRequests.configKey,
      configName: schema.approvalConfigs.name,
      subjectType: schema.approvalRequests.subjectType,
      subjectId: schema.approvalRequests.subjectId,
      levels: schema.approvalRequests.levels,
      status: schema.approvalRequests.status,
      currentStep: schema.approvalRequests.currentStep,
      submittedBy: { id: submitter.id, name: submitter.name },
      createdAt: schema.approvalRequests.createdAt,
      completedAt: schema.approvalRequests.completedAt,
    })
    .from(schema.approvalRequests)
    .innerJoin(schema.approvalConfigs, eq(schema.approvalRequests.configId, schema.approvalConfigs.id))
    .innerJoin(submitter, eq(schema.approvalRequests.submittedById, submitter.id))
    .where(eq(schema.approvalRequests.id, requestId))
    .limit(1);
  const request = requestRows[0];
  if (request === undefined) {
    return null;
  }
  const parsed = parseApprovalLevels(request.levels);
  if (!parsed.ok) {
    throw new Error(`approval request ${request.id} has invalid levels`);
  }
  const level = parsed.levels[request.currentStep];
  const actor = alias(schema.authUser, "actor");
  const actionRows = await db
    .select({
      id: schema.approvalActions.id,
      stepIndex: schema.approvalActions.stepIndex,
      levelName: schema.approvalActions.levelName,
      decision: schema.approvalActions.decision,
      note: schema.approvalActions.note,
      actor: { id: actor.id, name: actor.name },
      createdAt: schema.approvalActions.createdAt,
      signatureMeaning: schema.esignSignatures.meaning,
      signatureSignedAt: schema.esignSignatures.signedAt,
    })
    .from(schema.approvalActions)
    .innerJoin(actor, eq(schema.approvalActions.actorId, actor.id))
    .leftJoin(
      schema.esignSignatures,
      and(
        eq(schema.esignSignatures.subjectType, "approval_action"),
        eq(schema.esignSignatures.subjectId, schema.approvalActions.id),
      ),
    )
    .where(eq(schema.approvalActions.requestId, request.id))
    .orderBy(asc(schema.approvalActions.stepIndex), asc(schema.approvalActions.createdAt));
  return {
    id: request.id,
    configKey: request.configKey,
    configName: request.configName,
    subjectType: request.subjectType,
    subjectId: request.subjectId,
    status: request.status,
    currentStep: request.currentStep,
    currentLevel:
      request.status === "pending" && level !== undefined
        ? { name: level.name, users: [...level.users], roles: [...level.roles] }
        : null,
    submittedBy: request.submittedBy,
    submittedAt: request.createdAt,
    completedAt: request.completedAt,
    actions: actionRows.map((row) => ({
      id: row.id,
      stepIndex: row.stepIndex,
      levelName: row.levelName,
      decision: row.decision,
      note: row.note,
      actor: row.actor,
      createdAt: row.createdAt,
      signature:
        row.signatureMeaning !== null && row.signatureSignedAt !== null
          ? { meaning: row.signatureMeaning, signedAt: row.signatureSignedAt }
          : null,
    })),
  };
}

export interface ApprovalTodoRow {
  requestId: string;
  configKey: string;
  configName: string;
  subjectType: string;
  subjectId: string;
  stepIndex: number;
  levelName: string;
  submittedAt: Date;
}

/**
 * 「待我审批」（#232 §11 我的工作台的内核读法）：在飞请求里当前级点名我、或
 * 我的角色命中配置角色。角色匹配在内存里做——在飞请求是稀疏集（部分唯一索引
 * 保证），扫描便宜；不做单据可见性过滤：配置点名即授权，单据可见性是属主域
 * 在详情门里的事。
 */
export async function approvalTodo(
  db: Db,
  viewer: { id: string; roles: readonly Role[] },
  limit = 50,
): Promise<ApprovalTodoRow[]> {
  const rows = await db
    .select({
      requestId: schema.approvalRequests.id,
      configKey: schema.approvalRequests.configKey,
      configName: schema.approvalConfigs.name,
      subjectType: schema.approvalRequests.subjectType,
      subjectId: schema.approvalRequests.subjectId,
      levels: schema.approvalRequests.levels,
      currentStep: schema.approvalRequests.currentStep,
      createdAt: schema.approvalRequests.createdAt,
    })
    .from(schema.approvalRequests)
    .innerJoin(schema.approvalConfigs, eq(schema.approvalRequests.configId, schema.approvalConfigs.id))
    .where(eq(schema.approvalRequests.status, "pending"))
    .orderBy(asc(schema.approvalRequests.createdAt))
    .limit(limit);
  return rows.flatMap((row) => {
    const parsed = parseApprovalLevels(row.levels);
    const level = parsed.ok ? parsed.levels[row.currentStep] : undefined;
    if (level === undefined) return [];
    const mine =
      level.users.includes(viewer.id) || level.roles.some((role) => viewer.roles.includes(role));
    if (!mine) return [];
    return [
      {
        requestId: row.requestId,
        configKey: row.configKey,
        configName: row.configName,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        stepIndex: row.currentStep,
        levelName: level.name,
        submittedAt: row.createdAt,
      },
    ];
  });
}

// ── esign 接缝（approval_action 作为可签名 subject）─────────────────────────

/**
 * 签名绑定裁决行：append-only 行本身即版本（createdAt 即版本标，行永不改写），
 * 内容快照 = 行字段。生产注册在 approval/registry.ts，本函数被签名仪式与注册表
 * 共用（同一份 load，不会长出两种绑定语义）。
 */
export async function loadApprovalActionRecord(db: Pick<Db, "select">, actionId: string) {
  const rows = await db
    .select({
      id: schema.approvalActions.id,
      requestId: schema.approvalActions.requestId,
      stepIndex: schema.approvalActions.stepIndex,
      levelName: schema.approvalActions.levelName,
      decision: schema.approvalActions.decision,
      note: schema.approvalActions.note,
      actorId: schema.approvalActions.actorId,
      createdAt: schema.approvalActions.createdAt,
    })
    .from(schema.approvalActions)
    .where(eq(schema.approvalActions.id, actionId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return { recordVersion: row.createdAt.toISOString(), snapshot: { ...row } };
}

/** pg 的唯一约束冲突（23505）沿因果链找码（与 workflow-templates 路由同一形状） */
export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth++) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === "23505") return true;
    current = candidate.cause;
  }
  return false;
}
