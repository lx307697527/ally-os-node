import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import { recordAudit } from "../audit/audit-log.ts";
import type { Role } from "../authz/permissions.ts";
import { roleSchema } from "../authz/permissions.ts";
import { signSubject, type EsignMeaning } from "../esign/service.ts";
import { approvalOutcomeHandler } from "./outcomes.ts";

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
 * 并发推进：请求行锁（FOR UPDATE）串行化同级裁决——会签/票签一级多行，「最后
 * 一张同意票推进」在锁内数票；any 模式下同级的第二个裁决人经 CAS 抢输按冲突
 * 拒绝。两类输家同答 409：不覆盖别人的裁决，同一人重复表决同答（「你已表决」
 * 与「别人先裁了」对客户端是同一个冲突面）。
 */

/** 一级审批的形状（配置保存时 zod 收口，请求提交时整份快照进 levels 列） */
export interface ApprovalLevel {
  name: string;
  /** 指定人员（uuid）与指定角色的并集是这一级的审批人集合 */
  users: string[];
  roles: Role[];
  /**
   * 级别裁决方式（#221 会签/票签）：any = 任一审批人裁决即定级（原行为，旧快照
   * 无此字段落默认）；all = 会签，当前级审批人集合全员同意才过；quorum = 票签，
   * 同意数达到 quorum 即过。驳回在任何模式下都是终态。
   */
  mode: "any" | "all" | "quorum";
  /** mode="quorum" 的通过票数（2–50）；其他模式必须缺省（zod refine 收口） */
  quorum?: number | undefined;
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
        mode: z.enum(["any", "all", "quorum"]).default("any"),
        quorum: z.number().int().min(2).max(50).optional(),
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
      })
      .refine((level) => level.mode !== "quorum" || level.quorum !== undefined, {
        message: "quorum mode needs a quorum count",
      })
      .refine((level) => level.mode === "quorum" || level.quorum === undefined, {
        message: "quorum count only applies to quorum mode",
      }),
  )
  .min(1)
  .max(10);

export function parseApprovalLevels(value: unknown): { ok: true; levels: ApprovalLevel[] } | { ok: false } {
  const parsed = approvalLevelsSchema.safeParse(value);
  return parsed.success ? { ok: true, levels: parsed.data } : { ok: false };
}

// ── 通知扇出（#221 多级通知扇出：轮到谁，谁就在铃铛里）──────────────────────

/**
 * 一组角色的持有者（uuid）：角色按 app_role 枚举过滤（与 worker 侧规则提醒同一
 * 防御——api 的 Role 词表与库内枚举是两处定义）。抽取成纯查询是为了待办扫描能
 * 按角色集去重（同名角色集只在一次扫描里问一次库）。
 */
async function resolveRoleHolders(db: Pick<Db, "select">, roles: readonly string[]): Promise<string[]> {
  const eligible = roles.filter((role): role is (typeof schema.appRole.enumValues)[number] =>
    (schema.appRole.enumValues as readonly string[]).includes(role),
  );
  if (eligible.length === 0) return [];
  const holders = await db
    .select({ id: schema.authUser.id })
    .from(schema.authUser)
    .innerJoin(schema.userRole, eq(schema.userRole.userId, schema.authUser.id))
    .where(inArray(schema.userRole.role, eligible));
  return holders.map((row) => row.id);
}

/**
 * 一级的审批人集合（uuid）：点名 users ∪ 角色持有者。
 * 集合可能为空（配置只点了一个无人持有的角色）：校验面要求 users+roles ≥ 1，
 * 但「角色无人持有」合法存在——扇出跳过，待办页同样不显示（同一事实的两面）。
 */
async function resolveAdjudicatorIds(db: Pick<Db, "select">, level: ApprovalLevel): Promise<string[]> {
  const holders = await resolveRoleHolders(db, level.roles);
  return [...new Set([...level.users, ...holders])];
}

/**
 * 一级通过所需的同意数（#221 会签/票签）：any 恒 1；quorum 按配置票数；all 按
 * **裁决时刻**的审批人集合（点名 ∪ 角色持有者，活集合——角色持有者在飞期间
 * 变化，以当下事实为准）。快照被外力改歪到 quorum 缺失时给不可能满足的天花板
 * ——fail closed：写面 refine 已保证不可能，这里是防御性兜底不是正常路径。
 */
async function requiredApprovals(db: Pick<Db, "select">, level: ApprovalLevel): Promise<number> {
  if (level.mode === "quorum") {
    return level.quorum ?? Number.MAX_SAFE_INTEGER;
  }
  if (level.mode === "all") {
    return (await resolveAdjudicatorIds(db, level)).length;
  }
  return 1;
}

/** 本级已收到的同意数（含本事务刚落的行——同一事务内可见） */
async function countLevelApprovals(
  db: Pick<Db, "select">,
  requestId: string,
  stepIndex: number,
): Promise<number> {
  const counted = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.approvalActions)
    .where(
      and(
        eq(schema.approvalActions.requestId, requestId),
        eq(schema.approvalActions.stepIndex, stepIndex),
        eq(schema.approvalActions.decision, "approved"),
      ),
    );
  return counted[0]?.n ?? 0;
}

export interface ApprovalFanoutFact {
  requestId: string;
  subjectType: string;
  subjectId: string;
  configKey: string;
  /** 配置名（事实字段：铃铛文案、邮件摘要都从它拼，不带服务端文案） */
  configName: string;
  /** 触发这一轮的动作方姓名（提交人 / 推进的审批人） */
  actorName: string;
}

/**
 * 给一级审批人各落一行 approval.pending 通知（事务内调用：通知与推进同生灭），
 * 返回实际收到的人（排除 exclude——自批线上的动作方不给自己报信，task.assigned
 * 「派给自己不发」同一裁法）。行只存事实：文案在展示层（notification-face）。
 */
async function notifyAdjudicators(db: Pick<Db, "select" | "insert">,
  fact: ApprovalFanoutFact,
  level: ApprovalLevel,
  exclude: readonly string[],
): Promise<string[]> {
  const recipients = (await resolveAdjudicatorIds(db, level)).filter((id) => !exclude.includes(id));
  if (recipients.length === 0) return [];
  await db.insert(schema.notifications).values(
    recipients.map((userId) => ({
      userId,
      eventType: "approval.pending",
      aggregateType: "approval_request",
      aggregateId: fact.requestId,
      payload: {
        subjectType: fact.subjectType,
        subjectId: fact.subjectId,
        configKey: fact.configKey,
        configName: fact.configName,
        levelName: level.name,
        actorName: fact.actorName,
        detail: `${fact.configName} · ${level.name}`,
      },
    })),
  );
  return recipients;
}

// ── 提交审批请求 ─────────────────────────────────────────────────────────────

export interface SubmitCommand {
  subjectType: string;
  subjectId: string;
  configKey: string;
  submitterId: string;
  /**
   * 请求参数（#221 切片 2）：随请求落库、给审批人看「批的到底是什么」、终审
   * 批准后交 outcome 处理器执行。形状由属主域收口（内核不解释业务参数）；
   * 带 outcome 自动化的 subject 必须带（否则批准无从执行，见 payload_required）。
   */
  payload?: unknown;
}

export type SubmitOutcome =
  | { status: "created"; requestId: string }
  | {
      status: "rejected";
      reason:
        | "config_not_found"
        | "config_inactive"
        | "levels_invalid"
        | "already_pending"
        | "payload_required";
      requestId?: string;
    };

/** 单据进入审批（属主域在业务动作里进程内调用；触发条件随 #233 决策表进场） */
export async function submitApprovalRequest(
  db: Db,
  cmd: SubmitCommand,
  opts: { notifyUsers?: (userIds: string[]) => Promise<void> } = {},
): Promise<SubmitOutcome> {
  // 带 outcome 自动化的 subject 无参数不放行：批准无从执行（通用提交端点不带
  // payload，天然被此门挡住——带自动化线的唯一提交路径是属主域自己的路由）
  if (cmd.payload === undefined && approvalOutcomeHandler(cmd.subjectType) !== undefined) {
    return { status: "rejected", reason: "payload_required" };
  }
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
      ...(cmd.payload !== undefined ? { payload: cmd.payload } : {}),
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
      ...(cmd.payload !== undefined ? { payload: cmd.payload } : {}),
    },
  });
  // 首级扇出（#221 多级通知扇出）：轮到谁审，谁就在铃铛里。发起人自己点名的
  // 级（自批线）不给自己报信；实时「催」在提交后发，失败只降级轮询。
  const firstLevel = parsed.levels[0];
  if (firstLevel !== undefined) {
    const submitterRows = await db
      .select({ name: schema.authUser.name })
      .from(schema.authUser)
      .where(eq(schema.authUser.id, cmd.submitterId))
      .limit(1);
    const nudged = await notifyAdjudicators(
      db,
      {
        requestId: row.id,
        subjectType: cmd.subjectType,
        subjectId: cmd.subjectId,
        configKey: config.configKey,
        configName: config.name,
        actorName: submitterRows[0]?.name ?? cmd.submitterId,
      },
      firstLevel,
      [cmd.submitterId],
    );
    if (nudged.length > 0 && opts.notifyUsers !== undefined) {
      await opts.notifyUsers(nudged);
    }
  }
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
    .select({ request: schema.approvalRequests, configName: schema.approvalConfigs.name })
    .from(schema.approvalRequests)
    .innerJoin(schema.approvalConfigs, eq(schema.approvalRequests.configId, schema.approvalConfigs.id))
    .where(eq(schema.approvalRequests.id, cmd.requestId))
    .limit(1);
  const row = requestRows[0];
  const request = row?.request;
  if (request === undefined || row === undefined) {
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
  // 动作方姓名（通知 payload 的事实字段）：裁决人刚通过会话门，行必然在
  const actorRows = await db
    .select({ name: schema.authUser.name })
    .from(schema.authUser)
    .where(eq(schema.authUser.id, cmd.actorId))
    .limit(1);
  const actorName = actorRows[0]?.name ?? cmd.actorId;
  const fanoutFact: ApprovalFanoutFact = {
    requestId: request.id,
    subjectType: request.subjectType,
    subjectId: request.subjectId,
    configKey: request.configKey,
    configName: row.configName,
    actorName,
  };
  // 事务内落的通知收件人：下一级审批人（推进时）——提交后统一「催」
  let nextLevelNudged: string[] = [];
  let outcome: ActOutcome;
  try {
    outcome = await db.transaction(async (tx): Promise<ActOutcome> => {
      // 请求行锁串行化同级裁决（#221 会签/票签）：一级多行之后，「最后一张同意
      // 票推进」必须在锁内数票——并发表决各数各的票，谁都不满足，级永不推进。
      // 锁内重读：外层读与拿锁之间世界可能已动——已终态按 request_closed 答
      // （晚到读终态的同答，不变式是只有一个赢家），级别漂移按并发冲突答
      // （外层的审批人/签名门是对着旧级检查的，不能拿去裁新级）。any 模式行为
      // 不变：显式排队替代了原唯一约束的隐式串行化。
      const locked = await tx
        .select({
          status: schema.approvalRequests.status,
          currentStep: schema.approvalRequests.currentStep,
        })
        .from(schema.approvalRequests)
        .where(eq(schema.approvalRequests.id, request.id))
        .for("update")
        .limit(1);
      const live = locked[0];
      if (live === undefined) {
        throw new Error(`approval request ${request.id} vanished inside its own transaction`);
      }
      if (live.status !== "pending") {
        return { status: "rejected", reason: "request_closed" };
      }
      if (live.currentStep !== request.currentStep) {
        throw new ConcurrentConflict();
      }
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
        // 一人一级一裁决：同一人对同级的第二次落行（会签里的双击/重试）在此被
        // 拒——不是并发赛输，是「你已表决」；与 CAS 抢输同答 409
        .onConflictDoNothing({
          target: [
            schema.approvalActions.requestId,
            schema.approvalActions.stepIndex,
            schema.approvalActions.actorId,
          ],
        })
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
      // 通过判定（#221 会签/票签）：同意数 ≥ 所需数才动状态；驳回在任何模式下
      // 都是终态。未凑齐的同意照常落行、落审计，请求停在本级等剩余裁决人。
      const isLastStep = request.currentStep >= parsed.levels.length - 1;
      let approvedCount = 0;
      let neededApprovals = 1;
      if (cmd.decision === "approved") {
        neededApprovals = await requiredApprovals(tx, level);
        approvedCount = await countLevelApprovals(tx, request.id, request.currentStep);
      }
      const satisfied = cmd.decision === "approved" && approvedCount >= neededApprovals;
      const nextStatus: "pending" | "approved" | "rejected" =
        cmd.decision === "rejected" ? "rejected" : satisfied ? (isLastStep ? "approved" : "pending") : "pending";
      // 推进/终态才写请求行：未凑齐本级原地不动（行锁已保证数票无竞态，CAS
      // 条件保留作纵深防御）。驳回后单据回到发起人，重新提交 = 新请求。
      if (cmd.decision === "rejected" || satisfied) {
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
      }
      // 批准即生效（#221 切片 2）：终审批准的同一事务里调用属主域 outcome 处理器
      // （角色生效、折扣放开……）——业务效果与裁决要么全成要么全不算。处理器抛错
      // = 整个裁决回滚（fail closed：批准落不下来，属主域修好数据后重裁）；驳回
      // 与中间级通过不触发；未注册 subjectType 走纯记录线。
      if (nextStatus === "approved") {
        const outcome = approvalOutcomeHandler(request.subjectType);
        if (outcome !== undefined) {
          await outcome(tx, {
            requestId: request.id,
            subjectType: request.subjectType,
            subjectId: request.subjectId,
            configKey: request.configKey,
            payload: request.payload,
            submittedById: request.submittedById,
            actorId: cmd.actorId,
          });
        }
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
          mode: level.mode,
          ...(cmd.decision === "approved"
            ? { approvedCount, neededApprovals, levelSatisfied: satisfied }
            : {}),
          ...(note !== undefined && note !== "" ? { note } : {}),
          ...(needsSignature ? { signatureMeaning: level.signatureMeaning } : {}),
        },
      });
      // 推进扇出（#221 多级通知扇出）：凑齐本级且非末级 = 轮到下一级，下一级
      // 审批人的通知与推进同一事务（推进回滚 = 通知不存在）；动作方自己不报信。
      // 未凑齐的本级不加信——剩余裁决人的 approval.pending 已在提交时落行，
      // 停滞由催办说话，不逐票刷屏
      if (cmd.decision === "approved" && satisfied && !isLastStep) {
        const nextLevel = parsed.levels[request.currentStep + 1];
        if (nextLevel === undefined) {
          throw new Error(`approval request ${request.id} next step out of range`);
        }
        nextLevelNudged = await notifyAdjudicators(tx, fanoutFact, nextLevel, [cmd.actorId]);
      }
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
        // 终态通知发起人（驳回回到发起人的「回到」是真的递到手上；#110 通知内核）。
        // payload 补事实（configName/actorName）：铃铛兜底面与邮件摘要据此说话，
        // 文案仍在展示层——终态还没有承载页（我发起的审批随 phase-2 进场），
        // 兜底面亮事件类型 + 事实，去处 null 是诚实的占位。
        await tx.insert(schema.notifications).values({
          userId: request.submittedById,
          eventType: nextStatus === "approved" ? "approval.completed" : "approval.rejected",
          aggregateType: "approval_request",
          aggregateId: request.id,
          payload: {
            subjectType: request.subjectType,
            subjectId: request.subjectId,
            configKey: request.configKey,
            configName: row.configName,
            actorName,
            detail: row.configName,
          },
        });
      }
      return {
        status: "applied",
        requestId: request.id,
        actionId: action.id,
        decision: cmd.decision,
        requestStatus: nextStatus,
        currentStep:
          cmd.decision === "approved" && satisfied && !isLastStep
            ? request.currentStep + 1
            : request.currentStep,
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

  // 事务提交后才「催」（AppDeps.notifyUsers 的 at-most-once 合同：失败只降级轮询）。
  // 终态催发起人；推进催下一级审批人（通知行已在事务里，催只是让铃铛立刻重读）。
  if (outcome.status === "applied" && opts.notifyUsers !== undefined) {
    const bell =
      outcome.requestStatus !== "pending" ? [request.submittedById] : nextLevelNudged;
    if (bell.length > 0) {
      await opts.notifyUsers(bell);
    }
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
  /** 请求参数（属主域提交时带上，如角色变更的 {action, role}）；纯记录线为 null */
  payload: unknown;
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
      payload: schema.approvalRequests.payload,
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
    payload: request.payload ?? null,
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
  /** 谁在等这一批（#221 切片 3）：裁决语境跟着待办行走，裁决人不必先过单据可见性门 */
  submittedBy: { id: string; name: string };
  submittedAt: Date;
  /** 请求参数（批的到底是什么）；纯记录线为 null——与详情读法同一字段 */
  payload: unknown;
  /** 当前级「同意」是否要签名仪式 + 含义：UI 据此先弹签名框再裁决；
   *  422 signature_required 仍是服务端底线，不是 UI 的发现路径 */
  requireSignature: boolean;
  signatureMeaning: Extract<EsignMeaning, "reviewed" | "approved">;
  /** 级别裁决方式（#221 会签/票签）：any 任一即过 / all 会签 / quorum 票签 */
  levelMode: "any" | "all" | "quorum";
  /** 本级已收到的同意数（会签/票签的进度面；any 模式在首票前恒 0） */
  approvedCount: number;
  /** 本级通过所需同意数（any=1、all=裁决时刻审批人集合、quorum=配置票数） */
  neededApprovals: number;
  /** 本人已在当前级表决（会签/票签下等同伴；再裁同答 409——UI 据此收起裁决钮） */
  viewerAlreadyActed: boolean;
}

/**
 * 「待我审批」（#232 §11 我的工作台的内核读法）：在飞请求里当前级点名我、或
 * 我的角色命中配置角色。角色匹配在内存里做——在飞请求是稀疏集（部分唯一索引
 * 保证），扫描便宜；不做单据可见性过滤：配置点名即授权，单据可见性是属主域
 * 在详情门里的事。会签/票签行带进度与本人表决态：凑没凑齐、还差谁，行自己
 * 说清楚（已表决的人不再亮裁决钮，而不是让他去撞 409 才知道）。
 */
export async function approvalTodo(
  db: Db,
  viewer: { id: string; roles: readonly Role[] },
  limit = 50,
): Promise<ApprovalTodoRow[]> {
  const submitter = alias(schema.authUser, "submitter");
  const rows = await db
    .select({
      requestId: schema.approvalRequests.id,
      configKey: schema.approvalRequests.configKey,
      configName: schema.approvalConfigs.name,
      subjectType: schema.approvalRequests.subjectType,
      subjectId: schema.approvalRequests.subjectId,
      levels: schema.approvalRequests.levels,
      payload: schema.approvalRequests.payload,
      currentStep: schema.approvalRequests.currentStep,
      submittedBy: { id: submitter.id, name: submitter.name },
      createdAt: schema.approvalRequests.createdAt,
    })
    .from(schema.approvalRequests)
    .innerJoin(schema.approvalConfigs, eq(schema.approvalRequests.configId, schema.approvalConfigs.id))
    .innerJoin(submitter, eq(schema.approvalRequests.submittedById, submitter.id))
    .where(eq(schema.approvalRequests.status, "pending"))
    .orderBy(asc(schema.approvalRequests.createdAt))
    .limit(limit);
  const pendingIds = rows.map((row) => row.requestId);
  // 本级裁决行的批量投影：同意计数与「我表决过没有」都在内存里对着当前级算
  // （在飞请求稀疏，action 行更少——一次查询，不逐行问库）
  const actionRows =
    pendingIds.length === 0
      ? []
      : await db
          .select({
            requestId: schema.approvalActions.requestId,
            stepIndex: schema.approvalActions.stepIndex,
            actorId: schema.approvalActions.actorId,
            decision: schema.approvalActions.decision,
          })
          .from(schema.approvalActions)
          .where(inArray(schema.approvalActions.requestId, pendingIds));
  const result: ApprovalTodoRow[] = [];
  // 角色集 → 持有者查询的去重缓存：待办行大量共享同一组配置角色，逐行问库是
  // 每页一次 N+1；同一调用内同名角色集只问一次库（Promise 缓存，失败原样上抛）
  const holdersCache = new Map<string, Promise<string[]>>();
  const holdersFor = (roles: readonly string[]): Promise<string[]> => {
    const key = JSON.stringify(roles);
    const cached = holdersCache.get(key);
    if (cached !== undefined) return cached;
    const pending = resolveRoleHolders(db, roles);
    holdersCache.set(key, pending);
    return pending;
  };
  for (const row of rows) {
    const parsed = parseApprovalLevels(row.levels);
    const level = parsed.ok ? parsed.levels[row.currentStep] : undefined;
    if (level === undefined) continue;
    const mine =
      level.users.includes(viewer.id) || level.roles.some((role) => viewer.roles.includes(role));
    if (!mine) continue;
    const levelActions = actionRows.filter(
      (actionRow) => actionRow.requestId === row.requestId && actionRow.stepIndex === row.currentStep,
    );
    const approvedCount = levelActions.filter((actionRow) => actionRow.decision === "approved").length;
    // 与 requiredApprovals 同一口径：all 按**裁决时刻**的审批人集合（点名 ∪
    // 角色持有者）；quorum 按配置票数；any 恒 1
    const neededApprovals =
      level.mode === "quorum"
        ? (level.quorum ?? Number.MAX_SAFE_INTEGER)
        : level.mode === "all"
          ? [...new Set([...level.users, ...(await holdersFor(level.roles))])].length
          : 1;
    result.push({
      requestId: row.requestId,
      configKey: row.configKey,
      configName: row.configName,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      stepIndex: row.currentStep,
      levelName: level.name,
      submittedBy: row.submittedBy,
      submittedAt: row.createdAt,
      payload: row.payload ?? null,
      requireSignature: level.requireSignature,
      signatureMeaning: level.signatureMeaning,
      levelMode: level.mode,
      approvedCount,
      neededApprovals,
      viewerAlreadyActed: levelActions.some((actionRow) => actionRow.actorId === viewer.id),
    });
  }
  return result;
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
