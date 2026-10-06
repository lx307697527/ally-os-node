import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@ally/db";
import { configSubjectSpec, type ConfigRevisionTx } from "./registry.ts";
import {
  ConfigRevisionNotFoundError,
  ConfigSubjectNotFoundError,
  jsonEqual,
  listConfigRevisions,
  nextConfigVersion,
  recordConfigRevision,
  topLevelChanges,
  type ConfigChanges,
} from "./service.ts";

/**
 * 配置草稿服务（#226 切片 2：draft → publish）。
 *
 * 「先在测试环境试，再一键发布到生产」（#232 §4.4）在单库部署里落成配置对象
 * 上的草稿层：草稿存独立 overlay 表（config_drafts），活配置的读路径在发布前
 * 看不见它——「试」不碰生产行为是结构性保证，不靠读侧自觉过滤。发布 = 把草稿
 * 内容经该族的 applyRevision 接缝（与回滚同一条「快照落列」契约）前滚成一个
 * source='published' 的新版本：台账记版 + 配置行同事务更新，发布本身就是版本
 * 史的一部分，之后照常可 diff 可回滚。
 *
 * 草稿不是版本：一对象至多一份，再存即整份替换，versions 只属于台账。保存时
 * 记下当时的台账最新版（baseVersion），发布时行版不符 = 草稿过期（草稿是在旧
 * 现状上写的，发布会把期间的线上变更悄悄盖掉），409 拒绝——重存（在新现状之上
 * 重写草稿）后再发是唯一路径，无「盲发」。
 */

export interface ConfigDraftRow {
  subjectType: string;
  subjectId: string;
  content: Record<string, unknown>;
  baseVersion: number;
  note: string | null;
  createdById: string | null;
  updatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 该族没有内容改写路径（未注册 draftContentSchema/applyRevision），草稿面不开放 */
export class DraftUnsupportedError extends Error {
  constructor(subjectType: string) {
    super(`config-drafts: subject "${subjectType}" has no in-place content path to draft`);
    this.name = "DraftUnsupportedError";
  }
}

export class ConfigDraftNotFoundError extends Error {
  constructor(subjectType: string, subjectId: string) {
    super(`config-drafts: no draft for ${subjectType}/${subjectId}`);
    this.name = "ConfigDraftNotFoundError";
  }
}

/** 草稿保存时台账最新版与发布时不一致：草稿过期，重存后再发 */
export class DraftStaleError extends Error {
  readonly draftBaseVersion: number;
  readonly currentVersion: number;
  constructor(
    subjectType: string,
    subjectId: string,
    draftBaseVersion: number,
    currentVersion: number,
  ) {
    super(
      `config-drafts: draft of ${subjectType}/${subjectId} is based on v${draftBaseVersion}, current is v${currentVersion}`,
    );
    this.name = "DraftStaleError";
    this.draftBaseVersion = draftBaseVersion;
    this.currentVersion = currentVersion;
  }
}

/** 草稿内容与现状完全一致：发布是 no-op，明确拒绝而不是记一版假变更 */
export class PublishNoChangeError extends Error {
  constructor(subjectType: string, subjectId: string) {
    super(`config-drafts: draft of ${subjectType}/${subjectId} matches current content`);
    this.name = "PublishNoChangeError";
  }
}

export const draftSaveBody = z
  .object({
    content: z.record(z.string(), z.unknown()),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const publishBody = z
  .object({
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/** 草稿内容未过该族契约（消息数组来自 zod issues，路由答 400 带明细） */
export class DraftContentInvalidError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`config-drafts: draft content rejected by family contract: ${issues.join("; ")}`);
    this.name = "DraftContentInvalidError";
    this.issues = issues;
  }
}

/**
 * 保存（整体替换）一份草稿。内容必须过该族草稿契约（与配置面同强度的业务
 * 校验，不是只查 JSONB 形状）；baseVersion 由服务端取保存时刻的台账最新版，
 * 客户端不可指定——过期判断只有一个事实来源。要求对象已有台账史（创建即 v1
 * 是写入侧纪律，无史 = 对象不存在），草稿不先于配置对象存在。
 */
export async function saveConfigDraft(
  tx: ConfigRevisionTx,
  input: {
    subjectType: string;
    subjectId: string;
    content: Record<string, unknown>;
    note: string | undefined;
    actorId: string;
  },
): Promise<ConfigDraftRow> {
  const spec = configSubjectSpec(input.subjectType);
  if (spec?.draftContentSchema === undefined || spec.applyRevision === undefined) {
    throw new DraftUnsupportedError(input.subjectType);
  }
  const history = await listConfigRevisions(tx, input.subjectType, input.subjectId);
  const latest = history[0];
  if (latest === undefined) {
    throw new ConfigSubjectNotFoundError(input.subjectType, input.subjectId);
  }
  const parsed = spec.draftContentSchema.safeParse(input.content);
  if (!parsed.success) {
    throw new DraftContentInvalidError(parsed.error.issues.map((issue) => issue.message));
  }
  const rows = await tx
    .insert(schema.configDrafts)
    .values({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      content: parsed.data,
      baseVersion: latest.version,
      note: input.note ?? null,
      createdById: input.actorId,
      updatedById: input.actorId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [schema.configDrafts.subjectType, schema.configDrafts.subjectId],
      set: {
        content: parsed.data,
        baseVersion: latest.version,
        note: input.note ?? null,
        updatedById: input.actorId,
        updatedAt: new Date(),
      },
    })
    .returning({
      subjectType: schema.configDrafts.subjectType,
      subjectId: schema.configDrafts.subjectId,
      content: schema.configDrafts.content,
      baseVersion: schema.configDrafts.baseVersion,
      note: schema.configDrafts.note,
      createdById: schema.configDrafts.createdById,
      updatedById: schema.configDrafts.updatedById,
      createdAt: schema.configDrafts.createdAt,
      updatedAt: schema.configDrafts.updatedAt,
    });
  const row = rows[0];
  if (row === undefined) throw new Error("config draft upsert returned no row");
  return row;
}

export async function getConfigDraft(
  db: Pick<ConfigRevisionTx, "select">,
  subjectType: string,
  subjectId: string,
): Promise<ConfigDraftRow | undefined> {
  const rows = await db
    .select({
      subjectType: schema.configDrafts.subjectType,
      subjectId: schema.configDrafts.subjectId,
      content: schema.configDrafts.content,
      baseVersion: schema.configDrafts.baseVersion,
      note: schema.configDrafts.note,
      createdById: schema.configDrafts.createdById,
      updatedById: schema.configDrafts.updatedById,
      createdAt: schema.configDrafts.createdAt,
      updatedAt: schema.configDrafts.updatedAt,
    })
    .from(schema.configDrafts)
    .where(
      and(
        eq(schema.configDrafts.subjectType, subjectType),
        eq(schema.configDrafts.subjectId, subjectId),
      ),
    )
    .limit(1);
  return rows[0];
}

/** 丢弃草稿。返回 false = 本来就没有草稿（路由答 404，幂等丢弃不装成功） */
export async function deleteConfigDraft(
  db: Pick<ConfigRevisionTx, "select" | "delete">,
  subjectType: string,
  subjectId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(schema.configDrafts)
    .where(
      and(
        eq(schema.configDrafts.subjectType, subjectType),
        eq(schema.configDrafts.subjectId, subjectId),
      ),
    )
    .returning({ id: schema.configDrafts.id });
  return deleted.length > 0;
}

export interface PublishDraftResult {
  /** 发布前台账最新版（变更摘要的基准、草稿的 baseVersion 应与之相等） */
  fromVersion: number;
  /** 发布产生的新版本号（source = published） */
  publishedVersion: number;
  changes: ConfigChanges;
  /** 草稿意图说明（发布审计随档——审计是「谁改了什么、为什么」的最后落点） */
  note: string | null;
}

/**
 * 一键发布：草稿内容 → 生效版本。整段在调用方事务里：applyRevision + 记账 +
 * 删草稿要么一起提交，要么一起回滚。草稿行 FOR UPDATE 锁住——并发发布与并发
 * 保存都在这一行上串行化，输者要么看到草稿已没（404），要么在发布提交后把它
 * 的保存当新草稿写入，绝不会删掉别人刚存的草稿内容。
 *
 * 线上并发改动的竞态由台账唯一索引兜底：发布与 PATCH 同时在飞时，后到者算出
 * 同一个版本号撞 23505 fail loud（与台账切片 1 同一裁决）——路由把 23505 转
 * 409 publish_conflict，绝不静默盖掉别人的线上变更。
 */
export async function publishConfigDraft(
  tx: ConfigRevisionTx,
  input: { subjectType: string; subjectId: string; actorId: string | null },
): Promise<PublishDraftResult> {
  const spec = configSubjectSpec(input.subjectType);
  if (spec?.applyRevision === undefined) {
    throw new DraftUnsupportedError(input.subjectType);
  }
  const draftRows = await tx
    .select({
      content: schema.configDrafts.content,
      baseVersion: schema.configDrafts.baseVersion,
      note: schema.configDrafts.note,
    })
    .from(schema.configDrafts)
    .where(
      and(
        eq(schema.configDrafts.subjectType, input.subjectType),
        eq(schema.configDrafts.subjectId, input.subjectId),
      ),
    )
    .for("update")
    .limit(1);
  const draft = draftRows[0];
  if (draft === undefined) {
    throw new ConfigDraftNotFoundError(input.subjectType, input.subjectId);
  }
  const history = await listConfigRevisions(tx, input.subjectType, input.subjectId);
  const latest = history[0];
  if (latest === undefined) {
    // 草稿存在而台账无史：保存面要求有史才能存，走到这里是账被绕过动过——当场炸
    throw new ConfigRevisionNotFoundError(input.subjectType, input.subjectId, draft.baseVersion);
  }
  if (draft.baseVersion !== latest.version) {
    throw new DraftStaleError(input.subjectType, input.subjectId, draft.baseVersion, latest.version);
  }
  if (jsonEqual(latest.snapshot, draft.content)) {
    throw new PublishNoChangeError(input.subjectType, input.subjectId);
  }
  const newVersion = await nextConfigVersion(tx, input.subjectType, input.subjectId);
  const applied = await spec.applyRevision(tx, input.subjectId, draft.content, newVersion);
  if (!applied) {
    throw new ConfigSubjectNotFoundError(input.subjectType, input.subjectId);
  }
  const changes = topLevelChanges(latest.snapshot, draft.content);
  await recordConfigRevision(tx, {
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    version: newVersion,
    actorId: input.actorId,
    snapshot: draft.content,
    changes,
    source: "published",
  });
  await tx.delete(schema.configDrafts).where(
    and(
      eq(schema.configDrafts.subjectType, input.subjectType),
      eq(schema.configDrafts.subjectId, input.subjectId),
    ),
  );
  return { fromVersion: latest.version, publishedVersion: newVersion, changes, note: draft.note };
}

/**
 * 草稿读面（GET 草稿端点的内核）：草稿 + 是否过期 + 相对当前生效内容的顶层
 * 变更摘要。过期时摘要照样现算——「草稿想改什么、现状已经变成什么样」正是
 * 过期草稿重新决策（重存还是丢弃）要看的画面。
 */
export async function describeConfigDraft(
  db: Pick<ConfigRevisionTx, "select">,
  subjectType: string,
  subjectId: string,
): Promise<
  | {
      draft: ConfigDraftRow;
      stale: boolean;
      changes: ConfigChanges;
    }
  | undefined
> {
  const draft = await getConfigDraft(db, subjectType, subjectId);
  if (draft === undefined) return undefined;
  const rows = await db
    .select({
      version: schema.configRevisions.version,
      snapshot: schema.configRevisions.snapshot,
    })
    .from(schema.configRevisions)
    .where(
      and(
        eq(schema.configRevisions.subjectType, subjectType),
        eq(schema.configRevisions.subjectId, subjectId),
      ),
    )
    .orderBy(desc(schema.configRevisions.version))
    .limit(1);
  const latest = rows[0];
  if (latest === undefined) return undefined;
  return {
    draft,
    stale: draft.baseVersion !== latest.version,
    changes: topLevelChanges(latest.snapshot, draft.content),
  };
}
