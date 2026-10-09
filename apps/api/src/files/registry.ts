import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { Permission } from "../authz/permissions.ts";

/**
 * 文件 subject 注册表（#31 切片 1）。
 *
 * 文件内核是多态附着（files.subjectType/subjectId，与 comments/follows/esign 同一形态）：
 * 合法的 subject 类型、准入参数（类型白名单、大小与数量上限、下载 TTL）与
 * 「谁能传/谁看得到」由属主域切片在此注册裁决——text 列不用枚举，新域注册
 * 不动数据库（与 subjects/registry.ts 同一裁法）。未注册类型由路由回 400，
 * subject 不存在或调用者不可见一律 404（反探测，与评论的门同一裁定）。
 *
 * 注册表随首个消费域进场：feedback_report 是第一个——老系统 feedback 附件
 * （≤3 张图、私有桶、RLS = 本人或 admin/super_admin/ops）的直系后裔，员工读面
 * 由权限点 feedback.manage 承接（提交人恒可见自己的，不经过此点）。
 * 后续消费域（#236 签署 PDF、#169 标签图、#128 单据存档……）各自带准入参数
 * 进场注册，内核不预置任何业务的数值。
 */

/** 路由侧的调用者语境：会话用户 + authzMiddleware 算好的生效权限集 */
export interface FileCaller {
  id: string;
  permissions: ReadonlySet<Permission>;
}

/** subject 行的最小语境：存在性由 loadSubject 回答，权限由 canView/canAttach 裁决 */
export interface FileSubjectContext {
  id: string;
  /** 行属用户（提交人/创建人）：「本人」判定的基准（提交人恒可见自己的） */
  subjectUserId: string;
}

/** 事务参数统一用 Pick<Db,…>（与 approval/billing/config-versions 同一写法） */
export type FileSubjectTx = Pick<Db, "select" | "insert" | "update" | "delete">;

export interface FileSubjectDefinition {
  /** 对象 key 的命名空间前缀（不含任何用户输入：key = 前缀/subjectId/uuid） */
  keyPrefix: string;
  /** 单文件字节上限（准入按 presign 时的声明值裁决，complete 时 HEAD 实测覆写） */
  maxFileBytes: number;
  /** 每个 subject 的文件总数上限（pending + ready，含未 complete 的占位） */
  maxFilesPerSubject: number;
  /** 内容类型封闭白名单（fail closed，与评论附件同一裁决：不猜扩展名） */
  admittedContentTypes: ReadonlySet<string>;
  /** 下载签名 URL 的时效（秒）：足够一次查看，短到泄露了也很快失效 */
  urlTtlSeconds: number;
  /** subject 行是否存在（404 的数据面）；返回的语境供 canView/canAttach 裁决 */
  loadSubject(db: Db, subjectId: string): Promise<FileSubjectContext | null>;
  /** 看得到（列表/下载 URL）：不可见与不存在同回答 404，与评论的 subject 门同一裁定 */
  canView(subject: FileSubjectContext, caller: FileCaller): boolean;
  /** 传得上来（presign/complete/删除）：看得到但不是你的动词 → 403 */
  canAttach(subject: FileSubjectContext, caller: FileCaller): boolean;
  /**
   * 锁 subject 行：准许名额在锁内裁决，并发的两个 presign 不会各自数出余量
   * （与评论附件锁评论行同一裁定）。实现用 SELECT … FOR UPDATE。
   */
  lockSubject(tx: FileSubjectTx, subjectId: string): Promise<unknown>;
}

// ── feedback_report（#31 首个消费域）────────────────────────────────────────
// 数值承老系统：≤3 张图（feedback-actions 的 attachment cap）、单张 ≤5MiB、
// 签名 URL 600 秒（「Ten minutes — long enough to look, short enough to leak
// badly」）。类型白名单只收图片：证据就是截图/照片，装不下视频与文档——文档
// 走评论附件，别在这开门。
const FEEDBACK_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export const FEEDBACK_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const FEEDBACK_MAX_FILES_PER_REPORT = 3;
export const FEEDBACK_URL_TTL_SECONDS = 600;

async function loadFeedbackReport(db: Db, subjectId: string): Promise<FileSubjectContext | null> {
  const rows = await db
    .select({ id: schema.feedbackReports.id, subjectUserId: schema.feedbackReports.submittedByUserId })
    .from(schema.feedbackReports)
    .where(eq(schema.feedbackReports.id, subjectId))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : { id: row.id, subjectUserId: row.subjectUserId };
}

function canViewFeedbackReport(subject: FileSubjectContext, caller: FileCaller): boolean {
  return caller.id === subject.subjectUserId || caller.permissions.has("feedback.manage");
}

function canAttachFeedbackReport(subject: FileSubjectContext, caller: FileCaller): boolean {
  return caller.id === subject.subjectUserId;
}

const feedbackReportSubject: FileSubjectDefinition = {
  keyPrefix: "feedback-attachments",
  maxFileBytes: FEEDBACK_MAX_FILE_BYTES,
  maxFilesPerSubject: FEEDBACK_MAX_FILES_PER_REPORT,
  admittedContentTypes: FEEDBACK_IMAGE_TYPES,
  urlTtlSeconds: FEEDBACK_URL_TTL_SECONDS,
  loadSubject: loadFeedbackReport,
  canView: canViewFeedbackReport,
  canAttach: canAttachFeedbackReport,
  lockSubject: (tx, subjectId) =>
    tx
      .select({ id: schema.feedbackReports.id })
      .from(schema.feedbackReports)
      .where(eq(schema.feedbackReports.id, subjectId))
      .for("update"),
};

export const FILE_SUBJECTS: Record<string, FileSubjectDefinition> = {
  feedback_report: feedbackReportSubject,
};

/**
 * 文件 subject 门的统一入口：类型未注册返回 "unregistered"（路由回 400），行
 * 不存在返回 null（路由回 404）。返回里带上注册项本身——可见性与动词由路由持
 * 语境向 canView/canAttach 追问，路由不写任何业务的 if。
 */
export async function loadFileSubject(
  db: Db,
  subjectType: string,
  subjectId: string,
): Promise<
  { definition: FileSubjectDefinition; subject: FileSubjectContext } | null | "unregistered"
> {
  const definition = FILE_SUBJECTS[subjectType];
  if (definition === undefined) return "unregistered";
  const subject = await definition.loadSubject(db, subjectId);
  return subject === null ? null : { definition, subject };
}

/** 名额余量：pending + ready 都占坑（pending 行由清扫任务回收） */
export async function countFilesForSubject(
  db: Pick<Db, "select">,
  subjectType: string,
  subjectId: string,
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.files)
    .where(and(eq(schema.files.subjectType, subjectType), eq(schema.files.subjectId, subjectId)));
  return rows[0]?.n ?? 0;
}

/**
 * 文件名 sanity（与评论附件同一裁决）：只服务展示与下载命名（进不了对象
 * key），所以只挡真正麻烦的——空名、超长、控制字符。路径分隔符不拦：名字
 * 不会被拼进任何路径。
 */
export function sanitizeFileName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 255) return null;
  // eslint-disable-next-line no-control-regex -- 控制字符就是这里要挡的东西
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}
