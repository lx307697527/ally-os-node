import type { Db } from "@ally/db";

/**
 * 可挂流程的 subject 注册表（#220：流程引擎是线索、商机、订单履约、偏差共用
 * 的内核，但「这个业务记录存在吗、它按什么产品类型选模板」只有属主域自己知道
 * ——与可签名注册表（esign/registry.ts）、可见性门（subjects/registry.ts）同一
 * 裁法：内核提供接缝，属主域切片注册）。
 *
 * 本切片注册表刻意为空：四个对象（线索 #227、商机 #227、订单履约 #231、偏差
 * #243）都在 phase-2+，第一个属主域进场时在此注册。机制先行不留产线——模板
 * 管理、实例推进、门槛/动作/超时全部就绪并有集成测试覆盖（测试经
 * registerWorkflowSubject 注入夹具域，与生产同一条路径），未注册类型由路由
 * 回 400。
 */

export interface WorkflowSubjectRecord {
  /** 产品类型（#220「按产品类型切换模板」的解析输入）；记录无类型维度时为 null */
  productType?: string | null;
}

export interface WorkflowSubjectSpec {
  /** 加载业务记录的类型维度；行不存在返回 null（路由回 404） */
  load: (db: Db, subjectId: string) => Promise<WorkflowSubjectRecord | null>;
}

const WORKFLOW_SUBJECTS: Record<string, WorkflowSubjectSpec> = {};

/** 属主域切片在模块装载时注册；测试用同一条接缝注入夹具域 */
export function registerWorkflowSubject(subjectType: string, spec: WorkflowSubjectSpec): void {
  WORKFLOW_SUBJECTS[subjectType] = spec;
}

export function workflowSubjectSpec(subjectType: string): WorkflowSubjectSpec | undefined {
  return WORKFLOW_SUBJECTS[subjectType];
}
