import type { Db } from "@ally/db";
import type { Permission } from "../authz/permissions.ts";

/**
 * 配置版本注册表（#226 切片 1：配置版本台账内核）。
 *
 * 台账是通用的（subject_type 开集 text + 多态 subject_id，表结构不认识任何一族
 * 配置）；「workflow_template 的快照长什么样、回滚怎么落回列」只有各族配置域
 * 自己知道——与可编号注册表（numbering/registry.ts）、可签名注册表
 * （esign/registry.ts）同一裁法：内核提供接缝，各族在 families.ts 模块装载时
 * 注册。注册同时声明读史/回滚走的权限点：配置版本属于各族配置的一部分，回滚
 * = 改配置，不能比配置面本身更宽松（动态按族裁决，不用单一权限点一刀切）。
 *
 * applyRevision 缺省 = 该族尚无就地改写路径（workflow/approval 的内容端点在
 * #226 后续切片），回滚端点对其答 409 rollback_unsupported——宁可明确说「这族
 * 还回滚不了」，不假装成功。
 */

/** 事务内写台账/回滚用的最小连接面（调用方传 db 或 db.transaction 的 tx 都满足） */
export type ConfigRevisionTx = Pick<Db, "select" | "insert" | "update">;

export interface ConfigSubjectSpec {
  /** 展示名（配置工作室 UI 的族清单；本切片只进日志与测试断言） */
  label: string;
  /** 读史 / 回滚所需的权限点 = 各族配置面的同一权限点（见 permissions.ts） */
  configurePermission: Permission;
  /**
   * 把历史快照应用回配置行（回滚 = 前滚一个新版本）：用族自己的 zod 收口快照
   * 形状，UPDATE 内容列 + version 列，返回 false = 配置行已不存在（规则被删、
   * 模板被替换后旧行不在了……内核统一答 404）。version 由内核算好传入——
   * 「行.version = 台账最新版」的不变式在同一个 UPDATE 里维护。
   */
  applyRevision?: (
    tx: ConfigRevisionTx,
    subjectId: string,
    snapshot: Record<string, unknown>,
    version: number,
  ) => Promise<boolean>;
}

const CONFIG_SUBJECTS: Record<string, ConfigSubjectSpec> = {};

/** 配置域在模块装载时注册；测试用同一条接缝注入夹具族 */
export function registerConfigSubject(subjectType: string, spec: ConfigSubjectSpec): void {
  CONFIG_SUBJECTS[subjectType] = spec;
}

export function configSubjectSpec(subjectType: string): ConfigSubjectSpec | undefined {
  return CONFIG_SUBJECTS[subjectType];
}

/** 已注册的配置族清单（按 subjectType 稳定排序；诊断口「为什么 X 查不到版本史」） */
export function registeredConfigSubjects(): { subjectType: string; label: string }[] {
  return Object.entries(CONFIG_SUBJECTS)
    .map(([subjectType, spec]) => ({ subjectType, label: spec.label }))
    .sort((a, b) => (a.subjectType < b.subjectType ? -1 : a.subjectType > b.subjectType ? 1 : 0));
}
