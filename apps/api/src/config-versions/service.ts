import { and, desc, eq, sql } from "drizzle-orm";
import { schema } from "@ally/db";
import { configSubjectSpec, type ConfigRevisionTx } from "./registry.ts";

/**
 * 配置版本台账服务（#226 切片 1）。
 *
 * 记账协议（各配置面遵守，测试钉住）：
 * 1. 记账与配置行写入同事务——台账缺行比业务失败严重（版本号是回滚的寻址方式，
 *    账外变更会让「行.version = 台账最新版」的不变式断掉）。
 * 2. 先 nextConfigVersion，再写配置行（version 列一并落），再 recordConfigRevision
 *    ——配置行 UPDATE 拿到的行锁把同对象的并发记账串行化，后到者在提交后才能
 *    看到 max(version)，unique(subject_type, subject_id, version) 兜底撞车即炸。
 * 3. 无实效变更不记账（与 numbering PATCH / comment edit 同一纪律——审计和
 *    活动流都不被 no-op 刷屏）。
 *
 * 快照语义：snapshot 只含用户可编辑内容（不含 id/时间戳/审计元数据），是回滚的
 * 唯一事实来源；changes 是顶层字段摘要（与审计 detail 的 from/to 同形），嵌套
 * 路径级差异由 diffSnapshots 从两份快照现算，不入库。
 */

/** 变更摘要：{ 字段: { from, to } }，顶层键；created 记账无此字段（null） */
export type ConfigChanges = Record<string, { from: unknown; to: unknown }>;

export type ConfigRevisionSource = (typeof schema.configRevisionSource.enumValues)[number];

export interface RecordConfigRevisionInput {
  subjectType: string;
  subjectId: string;
  version: number;
  actorId: string | null;
  snapshot: Record<string, unknown>;
  changes: ConfigChanges | null;
  source: ConfigRevisionSource;
}

/** (subject_type, subject_id) 内下一个版本号 = 台账当前最大版 + 1（空史 = 1） */
export async function nextConfigVersion(
  tx: Pick<ConfigRevisionTx, "select">,
  subjectType: string,
  subjectId: string,
): Promise<number> {
  const rows = await tx
    .select({ maxVersion: sql<number | null>`max(${schema.configRevisions.version})` })
    .from(schema.configRevisions)
    .where(
      and(
        eq(schema.configRevisions.subjectType, subjectType),
        eq(schema.configRevisions.subjectId, subjectId),
      ),
    );
  return (rows[0]?.maxVersion ?? 0) + 1;
}

/** 记一版。version 由调用方经 nextConfigVersion 算好传入（写配置行要用同一个值） */
export async function recordConfigRevision(
  tx: Pick<ConfigRevisionTx, "insert">,
  input: RecordConfigRevisionInput,
): Promise<void> {
  await tx.insert(schema.configRevisions).values({
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    version: input.version,
    snapshot: input.snapshot,
    changes: input.changes,
    source: input.source,
    changedById: input.actorId,
  });
}

export interface ConfigRevisionRow {
  version: number;
  source: ConfigRevisionSource;
  snapshot: Record<string, unknown>;
  changes: ConfigChanges | null;
  changedById: string | null;
  createdAt: Date;
}

export async function listConfigRevisions(
  db: Pick<ConfigRevisionTx, "select">,
  subjectType: string,
  subjectId: string,
): Promise<ConfigRevisionRow[]> {
  const rows = await db
    .select({
      version: schema.configRevisions.version,
      source: schema.configRevisions.source,
      snapshot: schema.configRevisions.snapshot,
      changes: schema.configRevisions.changes,
      changedById: schema.configRevisions.changedById,
      createdAt: schema.configRevisions.createdAt,
    })
    .from(schema.configRevisions)
    .where(
      and(
        eq(schema.configRevisions.subjectType, subjectType),
        eq(schema.configRevisions.subjectId, subjectId),
      ),
    )
    .orderBy(desc(schema.configRevisions.version));
  return rows;
}

export async function getConfigRevision(
  db: Pick<ConfigRevisionTx, "select">,
  subjectType: string,
  subjectId: string,
  version: number,
): Promise<ConfigRevisionRow | undefined> {
  const rows = await db
    .select({
      version: schema.configRevisions.version,
      source: schema.configRevisions.source,
      snapshot: schema.configRevisions.snapshot,
      changes: schema.configRevisions.changes,
      changedById: schema.configRevisions.changedById,
      createdAt: schema.configRevisions.createdAt,
    })
    .from(schema.configRevisions)
    .where(
      and(
        eq(schema.configRevisions.subjectType, subjectType),
        eq(schema.configRevisions.subjectId, subjectId),
        eq(schema.configRevisions.version, version),
      ),
    )
    .limit(1);
  return rows[0];
}

// ── 回滚 ────────────────────────────────────────────────────────────────────
// 回滚不是改写历史：把目标版本的快照应用回配置行，同时在台账上**追加**一个
// source='rolled_back' 的新版本（内容 = 目标快照）。历史行一行不动（append-only
// 触发器兜底），「配置在什么时候被谁滚回过」本身就是版本史的一部分。

export class RollbackUnsupportedError extends Error {
  constructor(subjectType: string) {
    super(`config-versions: subject "${subjectType}" has no in-place content path to roll back`);
    this.name = "RollbackUnsupportedError";
  }
}

export class ConfigRevisionNotFoundError extends Error {
  constructor(subjectType: string, subjectId: string, version: number) {
    super(`config-versions: revision v${version} of ${subjectType}/${subjectId} not found`);
    this.name = "ConfigRevisionNotFoundError";
  }
}

export class ConfigSubjectNotFoundError extends Error {
  constructor(subjectType: string, subjectId: string) {
    super(`config-versions: subject row ${subjectType}/${subjectId} no longer exists`);
    this.name = "ConfigSubjectNotFoundError";
  }
}

/** 目标版本内容与现状完全一致：回滚是 no-op，明确拒绝而不是记一版假变更 */
export class RollbackNoChangeError extends Error {
  constructor(subjectType: string, subjectId: string, version: number) {
    super(`config-versions: ${subjectType}/${subjectId} already carries v${version} content`);
    this.name = "RollbackNoChangeError";
  }
}

export interface RollbackResult {
  /** 回滚前台账最新版（变更摘要的基准） */
  fromVersion: number;
  /** 被恢复的历史版本号 */
  restoredVersion: number;
  /** 回滚产生的新版本号（source = rolled_back） */
  newVersion: number;
  changes: ConfigChanges;
}

/**
 * 回滚到 toVersion。要求该族已注册且带 applyRevision（见 registry.ts）；
 * 版本内容与现状一致时抛 RollbackNoChangeError（调用方答 409）。
 * 在调用方的事务里执行：applyRevision + 记账要么一起提交，要么一起回滚。
 */
export async function rollbackConfig(
  tx: ConfigRevisionTx,
  input: { subjectType: string; subjectId: string; toVersion: number; actorId: string | null },
): Promise<RollbackResult> {
  const spec = configSubjectSpec(input.subjectType);
  if (spec?.applyRevision === undefined) {
    throw new RollbackUnsupportedError(input.subjectType);
  }
  const target = await getConfigRevision(tx, input.subjectType, input.subjectId, input.toVersion);
  if (target === undefined) {
    throw new ConfigRevisionNotFoundError(input.subjectType, input.subjectId, input.toVersion);
  }
  const history = await listConfigRevisions(tx, input.subjectType, input.subjectId);
  // target 命中则史非空，latest 必存在；这层守卫是给「未来代码绕过协议删史」的
  const latest = history[0];
  if (latest === undefined) {
    throw new ConfigRevisionNotFoundError(input.subjectType, input.subjectId, input.toVersion);
  }
  if (jsonEqual(latest.snapshot, target.snapshot)) {
    throw new RollbackNoChangeError(input.subjectType, input.subjectId, input.toVersion);
  }
  const newVersion = await nextConfigVersion(tx, input.subjectType, input.subjectId);
  const applied = await spec.applyRevision(tx, input.subjectId, target.snapshot, newVersion);
  if (!applied) {
    throw new ConfigSubjectNotFoundError(input.subjectType, input.subjectId);
  }
  const changes = topLevelChanges(latest.snapshot, target.snapshot);
  await recordConfigRevision(tx, {
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    version: newVersion,
    actorId: input.actorId,
    snapshot: target.snapshot,
    changes,
    source: "rolled_back",
  });
  return {
    fromVersion: latest.version,
    restoredVersion: target.version,
    newVersion,
    changes,
  };
}

// ── 快照差异 ────────────────────────────────────────────────────────────────
// 读面 diff 端点用：任意两版快照的路径级差异（点分路径；嵌套对象递归展开，
// 数组与标量整体比较——配置快照里数组是有序整体，逐项对位是给列表 UI 的语义，
// 不归差异引擎管）。

export interface PathChange {
  path: string;
  from: unknown;
  to: unknown;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return aKeys.length === bKeys.length && aKeys.every((k) => k in b && jsonEqual(a[k], b[k]));
  }
  return false;
}

/** 顶层字段摘要（记账 changes 的形状；嵌套差异折叠成整棵子树的 from/to） */
export function topLevelChanges(
  from: Record<string, unknown>,
  to: Record<string, unknown>,
): ConfigChanges {
  const changes: ConfigChanges = {};
  for (const key of Object.keys(from)) {
    if (!jsonEqual(from[key], to[key])) {
      changes[key] = { from: from[key] ?? null, to: to[key] ?? null };
    }
  }
  for (const key of Object.keys(to)) {
    if (!(key in from)) {
      changes[key] = { from: null, to: to[key] ?? null };
    }
  }
  return changes;
}

/** 任意两版快照的路径级差异（diff 端点；路径按字典序稳定输出） */
export function diffSnapshots(
  from: Record<string, unknown>,
  to: Record<string, unknown>,
): PathChange[] {
  const out: PathChange[] = [];
  walkDiff(from, to, "", out);
  return out;
}

function walkDiff(from: unknown, to: unknown, prefix: string, out: PathChange[]): void {
  if (isPlainObject(from) && isPlainObject(to)) {
    const keys = new Set([...Object.keys(from), ...Object.keys(to)]);
    for (const key of [...keys].sort()) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      const inFrom = key in from;
      const inTo = key in to;
      if (inFrom && inTo) {
        walkDiff(from[key], to[key], path, out);
      } else if (inFrom) {
        out.push({ path, from: from[key] ?? null, to: null });
      } else {
        out.push({ path, from: null, to: to[key] ?? null });
      }
    }
    return;
  }
  if (!jsonEqual(from, to)) {
    out.push({ path: prefix === "" ? "$" : prefix, from: from ?? null, to: to ?? null });
  }
}
