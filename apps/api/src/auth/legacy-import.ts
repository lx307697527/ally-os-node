import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import { isBcryptHash } from "./legacy-password.ts";

/**
 * 存量用户导入（#22 切片 5）：老库 `auth.users`（Supabase GoTrue）→ 新系统的
 * `auth_user` + `auth_account`。用户 id 保留原 uuid（老系统业务表全部外键挂
 * 在它上面，#22 裁定不重排主键）；credential account 的形状与 better-auth
 * 注册时写入的一致（`providerId: "credential"`、`accountId: user.id`——登录
 * 路径按这个形状找 account，见 better-auth sign-in 源码）。
 *
 * 输入是运维从老库导出的 JSON（字段名对齐 GoTrue 表结构，导出后不必改名）：
 *
 * ```sql
 * copy (
 *   select id, email, encrypted_password, email_confirmed_at, confirmed_at,
 *          created_at, updated_at, last_sign_in_at, raw_user_meta_data
 *   from auth.users
 *   order by created_at
 * ) to stdout with (format json);
 * ```
 *
 * 行为（逐行，行间互不影响，可安全重跑）：
 * - 默认 dry-run（apply: false）：跑同一条决定路径（含冲突查询），不写库。
 * - 同 id 已存在 → 幂等重跑：不重建用户，只补缺失/为空的 credential 密码。
 * - 同 email 已存在但 id 不同 → 报错跳过。不静默合并：那条新系统记录可能
 *   已经持有会话 / 外键，合并是数据损失风险，要人来裁决。
 * - `encrypted_password` 为空（老系统 Google-only 用户）→ 导入用户，account
 *   密码留空：登录行为等同「密码不对」（better-auth 对 null 密码直接 401），
 *   用户走重置流程或 Google 登录。
 * - `encrypted_password` 非 bcrypt 格式 → 报错跳过（fail closed）：老库只应
 *   产出 $2a$/$2b$，别的格式说明导出有问题，宁可停下让人看。
 * - 邮箱验证状态取 `email_confirmed_at`（老字段名 `confirmed_at` 兼容）：
 *   未确认的导入为未验证，登录被 403 挡住、走重发确认流程——与 FEAT-634 的
 *   新系统策略一致。
 */

/** 老库 auth.users 单行（GoTrue 字段名；timestamptz 以 JSON 序列化形式给出） */
export const legacyUserRowSchema = z.object({
  id: z.uuid(),
  email: z.string().trim().toLowerCase().min(3),
  encrypted_password: z.string().nullish(),
  email_confirmed_at: z.string().nullish(),
  confirmed_at: z.string().nullish(),
  created_at: z.string(),
  updated_at: z.string().nullish(),
  last_sign_in_at: z.string().nullish(),
  raw_user_meta_data: z.record(z.string(), z.unknown()).nullish(),
});

export type LegacyUserRow = z.infer<typeof legacyUserRowSchema>;

export interface LegacyImportRowIssue {
  /** 输入数组里的下标，报错定位用 */
  index: number;
  email: string | null;
  reason: string;
}

export interface LegacyImportReport {
  total: number;
  /** 发生过至少一次写入（或 dry-run 下将会写入）的行数 */
  imported: number;
  /** 完全无需改动的行数（幂等重跑时的常态） */
  skipped: number;
  errors: LegacyImportRowIssue[];
  dryRun: boolean;
}

export interface LegacyImportOptions {
  logger: Logger;
  /** false = dry-run：完整走校验与冲突检测，不写库 */
  apply: boolean;
}

/** 单行转换后的待写数据（dry-run 与正式写入共用同一个决定路径） */
interface ResolvedRow {
  index: number;
  email: string;
  id: string;
  name: string;
  emailVerified: boolean;
  createdAt: Date | null;
  password: string | null;
}

/** 行内数据问题：携带定位信息，进报告，不中断整批 */
class RowError extends Error {
  readonly issue: LegacyImportRowIssue;

  constructor(issue: LegacyImportRowIssue) {
    super(issue.reason);
    this.issue = issue;
  }
}

function parseTimestamp(
  index: number,
  email: string,
  field: string,
  raw: string | null | undefined,
): Date | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new RowError({
      index,
      email,
      reason: `${field} is not a parseable timestamp: ${JSON.stringify(raw)}`,
    });
  }
  return date;
}

function rowEmailOf(raw: unknown): string | null {
  if (raw !== null && typeof raw === "object" && "email" in raw && typeof raw.email === "string") {
    return raw.email;
  }
  return null;
}

function resolveRow(index: number, raw: unknown): ResolvedRow {
  const parsed = legacyUserRowSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new RowError({
      index,
      email: rowEmailOf(raw),
      reason: `schema: ${first?.path.join(".") ?? "<row>"} ${first?.message ?? "is invalid"}`,
    });
  }
  const row = parsed.data;
  const email = row.email;

  // 老库只产 bcrypt（GoTrue / pgcrypto cost 10）；别的格式 = 导出有问题，停下
  const passwordRaw = row.encrypted_password?.trim() ?? "";
  if (passwordRaw !== "" && !isBcryptHash(passwordRaw)) {
    throw new RowError({
      index,
      email,
      reason: `unsupported password format (expected legacy bcrypt $2a$/$2b$, got ${passwordRaw.slice(0, 7)}…)`,
    });
  }

  // 展示名：GoTrue 惯例放 raw_user_meta_data.name / full_name；都没有就用邮箱
  // 本地部分兜底（后台界面 name 非空约束）
  const meta = row.raw_user_meta_data ?? {};
  const metaName = [meta.name, meta.full_name].find(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );
  const name = metaName?.trim() ?? email.split("@")[0] ?? email;

  const emailVerified =
    parseTimestamp(index, email, "email_confirmed_at", row.email_confirmed_at) !== null ||
    parseTimestamp(index, email, "confirmed_at", row.confirmed_at) !== null;

  return {
    index,
    email,
    id: row.id,
    name,
    emailVerified,
    createdAt: parseTimestamp(index, email, "created_at", row.created_at),
    password: passwordRaw === "" ? null : passwordRaw,
  };
}

async function findUserById(db: Db, id: string) {
  const rows = await db.select().from(schema.authUser).where(eq(schema.authUser.id, id)).limit(1);
  return rows[0];
}

async function findUserByEmail(db: Db, email: string) {
  const rows = await db.select().from(schema.authUser).where(eq(schema.authUser.email, email)).limit(1);
  return rows[0];
}

function assertNoConflict(row: ResolvedRow, byId: unknown, byEmail: { id: string } | undefined): void {
  if (byId !== undefined && byEmail === undefined) {
    throw new RowError({
      index: row.index,
      email: row.email,
      reason: "id already exists with a different email — manual reconciliation needed",
    });
  }
  if (byEmail !== undefined && byEmail.id !== row.id) {
    throw new RowError({
      index: row.index,
      email: row.email,
      reason: `email already exists under a different user id (${byEmail.id}) — not merging`,
    });
  }
}

/**
 * 一行的完整决定路径：冲突检测、要写什么、（apply 时）写。
 * apply=false 与 true 走同一套查询与判定，只差写入，dry-run 结论不会失真。
 */
async function importRow(db: Db, row: ResolvedRow, apply: boolean, logger: Logger): Promise<"imported" | "skipped"> {
  const byId = await findUserById(db, row.id);
  const byEmail = await findUserByEmail(db, row.email);
  assertNoConflict(row, byId, byEmail);

  const userExists = byId !== undefined;

  if (!apply) {
    if (!userExists) return "imported";
    const accounts = await db
      .select()
      .from(schema.authAccount)
      .where(and(eq(schema.authAccount.userId, row.id), eq(schema.authAccount.providerId, "credential")))
      .limit(1);
    const account = accounts[0];
    if (account === undefined || (account.password === null && row.password !== null)) return "imported";
    return "skipped";
  }

  const wrote = await db.transaction(async (tx): Promise<boolean> => {
    let changed = false;

    if (!userExists) {
      await tx.insert(schema.authUser).values({
        id: row.id,
        email: row.email,
        name: row.name,
        emailVerified: row.emailVerified,
        ...(row.createdAt === null ? {} : { createdAt: row.createdAt }),
      });
      changed = true;
    }

    // credential account：与 better-auth 注册写入的形状一致。已存在且已有密码
    // → 幂等跳过；存在但密码为空（此前导入的 OAuth-only 用户）→ 补密码。
    const accounts = await tx
      .select()
      .from(schema.authAccount)
      .where(and(eq(schema.authAccount.userId, row.id), eq(schema.authAccount.providerId, "credential")))
      .limit(1);
    const account = accounts[0];
    if (account === undefined) {
      await tx.insert(schema.authAccount).values({
        userId: row.id,
        accountId: row.id,
        providerId: "credential",
        password: row.password,
      });
      changed = true;
    } else if (account.password === null && row.password !== null) {
      await tx
        .update(schema.authAccount)
        .set({ password: row.password, updatedAt: new Date() })
        .where(eq(schema.authAccount.id, account.id));
      changed = true;
    }
    return changed;
  });

  if (!wrote) {
    logger.debug({ userId: row.id }, "legacy user already fully imported");
  }
  return wrote ? "imported" : "skipped";
}

export async function importLegacyUsers(
  db: Db,
  rows: readonly unknown[],
  options: LegacyImportOptions,
): Promise<LegacyImportReport> {
  const report: LegacyImportReport = {
    total: rows.length,
    imported: 0,
    skipped: 0,
    errors: [],
    dryRun: !options.apply,
  };

  for (const [index, raw] of rows.entries()) {
    try {
      const row = resolveRow(index, raw);
      const outcome = await importRow(db, row, options.apply, options.logger);
      if (outcome === "imported") report.imported += 1;
    } catch (err) {
      if (err instanceof RowError) {
        report.errors.push(err.issue);
      } else {
        // 非数据类故障（连接断、约束未建）：报出来并停批，不要装作只是坏行
        options.logger.error({ err, index }, "legacy import aborted by unexpected failure");
        report.errors.push({
          index,
          email: rowEmailOf(raw),
          reason: `unexpected failure: ${err instanceof Error ? err.message : String(err)}`,
        });
        break;
      }
    }
  }
  report.skipped = report.total - report.imported - report.errors.length;
  return report;
}
