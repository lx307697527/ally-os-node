import type { Db } from "@ally/db";

/**
 * 可签名 subject 注册表（#219：Part 11 签名内核）。
 *
 * 电子签名是各业务模块共用的底座能力（#219「供各模块和审批复用」），但「什么
 * 记录可以被签、签时记录处于哪个版本」只有记录的属主域自己知道——与评论/活动
 * 的可见性门（subjects/registry.ts）同一裁法：内核提供接缝，属主域切片注册。
 *
 * 本切片注册表刻意为空：批记录、检验、偏差、放行等受监管记录都在 phase-3/4，
 * 第一个消费域（#221 审批）进场时在此注册。机制先行不留产线——签名 API、锁定
 * 检查、审计与离线同步全部就绪并有集成测试覆盖（测试经 registerSignableSubject
 * 注入夹具域，与生产同一条路径），未注册类型由路由回 400，不出现「能签但不能
 * 锁」的半开机状态。
 */

/** 被签记录在签名时刻的状态：版本标 + 内容快照（哈希绑定的输入） */
export interface SignableRecord {
  recordVersion: string;
  snapshot: Record<string, unknown>;
}

export interface SignableSubjectSpec {
  /** 加载被签记录的版本与快照；行不存在返回 null（路由回 404） */
  load: (db: Db, subjectId: string) => Promise<SignableRecord | null>;
}

const SIGNABLE_SUBJECTS: Record<string, SignableSubjectSpec> = {};

/** 属主域切片在模块装载时注册；测试用同一条接缝注入夹具域 */
export function registerSignableSubject(subjectType: string, spec: SignableSubjectSpec): void {
  SIGNABLE_SUBJECTS[subjectType] = spec;
}

export function signableSubjectSpec(subjectType: string): SignableSubjectSpec | undefined {
  return SIGNABLE_SUBJECTS[subjectType];
}
