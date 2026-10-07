import type { Db } from "@ally/db";
import type { z } from "zod";
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
 * applyRevision 缺省 = 该族尚无就地改写路径（夹具、未来新族未接前），回滚端点
 * 对其答 409 rollback_unsupported——宁可明确说「这族还不能」，不假装成功。
 */

/** 事务内写台账/回滚/草稿用的最小连接面（调用方传 db 或 db.transaction 的 tx 都满足） */
export type ConfigRevisionTx = Pick<Db, "select" | "insert" | "update" | "delete">;

/**
 * 族内逐主体的写面拒绝（#233 引入）：族的 configurePermission 之外，某些族还有
 * 「逐行」的改权裁决（规则注册表的谁能改 = 按规则的角色数组，owner 恒可）。回滚
 * 与发布 = 改那行配置，逐主体的门必须与 PATCH 面同扇——与「关注者集合 ⊆ 可见者
 * 集合」在关注与投递两端各查一次同一裁法：同一裁决在两个写面各自强制，不靠
 * 调用方自觉。形状与 permissionFailure 的 403 同构（code 自定义，如 role_required）。
 */
export interface SubjectWriteDenial {
  error: "forbidden";
  code: string;
  [key: string]: unknown;
}

export interface ConfigSubjectSpec {
  /** 展示名（配置工作室 UI 的族清单；本切片只进日志与测试断言） */
  label: string;
  /** 读史 / 回滚所需的权限点 = 各族配置面的同一权限点（见 permissions.ts） */
  configurePermission: Permission;
  /**
   * 逐主体写面门（回滚 / 草稿保存与发布路由在族权限点之后调用；缺省 = 该族只有
   * 族级权限点）。返回 undefined = 放行。
   */
  authorizeWrite?: (ctx: {
    db: Pick<ConfigRevisionTx, "select">;
    authz: { roles: readonly string[]; permissions: ReadonlySet<Permission> };
    subjectId: string;
  }) => Promise<SubjectWriteDenial | undefined>;
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
  /**
   * 草稿内容契约（#226 切片 2：draft → publish）。形状 = 该族快照的同一形状
   * （用户可编辑内容），但校验强度对齐各族配置面的**业务**校验（不只 JSONB
   * 结构）——草稿存进去的必须是「发布后能直接生效」的内容，发布面不做比保存
   * 面更弱的第二次放行。缺省 = 该族没有草稿面（registry_rule 刻意不带：定时
   * 生效是它的「先试后上」，见 #233），草稿与发布端点对它答 409
   * publish_unsupported，与回滚的 rollback_unsupported 同一裁法：宁可明说
   * 「这族还不能」，不假装成功。
   */
  draftContentSchema?: z.ZodType<Record<string, unknown>>;
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
