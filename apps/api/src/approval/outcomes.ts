import type { Db } from "@ally/db";

/**
 * 审批结果自动化注册表（#221 切片 2）——「批准即生效」的属主域接缝。
 *
 * 审批内核本身只裁决不执行：某条线批准之后业务效果是什么（角色生效、折扣放开、
 * 采购单放行）只有属主域知道。域切片在模块装载时按 subjectType 注册处理器，内核
 * 在终审批准的同一事务里调用它（docs/approval.md：批准即生效——业务效果与终审
 * 裁决要么全成要么全不算，不存在「批了但没生效」的中间态）。驳回、中间级通过
 * 都不触发；未注册 subjectType 的批准走纯记录线（只落裁决与审计）。
 *
 * 与 subjects/registry.ts、esign/registry.ts、workflow/registry.ts 同一裁法：内核
 * 提供接缝，属主域切片注册；本表初始为空，第一个成员是 R-16-6 的 user_role
 * （authz/role-approval.ts）。
 */

/** 终审批准时处理器拿到的语境：请求身份 + 提交时刻快照的参数 */
export interface ApprovalOutcomeContext {
  requestId: string;
  subjectType: string;
  subjectId: string;
  configKey: string;
  /** 提交时刻随请求落库的参数（如 {action, role}）；纯记录线为 null */
  payload: unknown;
  /** 发起人（驳回回到的人；审计语境里标注「谁提的」） */
  submittedById: string;
  /** 终审批准人（业务效果因他而生效，审计 actor 记他） */
  actorId: string;
}

/**
 * 事务句柄：终审事务内的连接（drizzle PgTransaction 的结构子集）。与 esign 的
 * signSubject 同一收窄——拿到的 db 与终审共享事务，处理器内的写随裁决一起提交
 * 或一起回滚。
 */
export type ApprovalOutcomeTx = Pick<Db, "select" | "insert" | "update" | "delete">;

export type ApprovalOutcomeHandler = (tx: ApprovalOutcomeTx, ctx: ApprovalOutcomeContext) => Promise<void>;

const OUTCOME_HANDLERS: Record<string, ApprovalOutcomeHandler> = {};

/** 属主域切片在模块装载时注册；测试用同一条接缝注入夹具域 */
export function registerApprovalOutcome(subjectType: string, handler: ApprovalOutcomeHandler): void {
  OUTCOME_HANDLERS[subjectType] = handler;
}

export function approvalOutcomeHandler(subjectType: string): ApprovalOutcomeHandler | undefined {
  return OUTCOME_HANDLERS[subjectType];
}
