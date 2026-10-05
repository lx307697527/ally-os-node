import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Logger } from "pino";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";

/**
 * 影子账号（#25）：CRM 联系人的预建用户。老系统 `ensure-shadow-account` /
 * `security.provision_shadow_account` 的等价物——报价、订单、发票先挂在
 * contact 的邮箱上，客户来注册时认领同一个 user id。
 *
 * 与老系统的对应与差异：
 * - 老系统由 GoTrue Admin API 建 `auth.users` 行（无密码、`email_confirm: true`）
 *   再由 service-role RPC 补身份行；新系统直接写 `auth_user` + 一行密码为 null
 *   的 credential account（#22 切片 5 对老库 Google-only 用户的同款形状）：
 *   登录 401（null 密码短路），认领走密码重置。
 * - 「认领」不另设标记：老系统 `claimed_at` 是凭据存在性的缓存时间戳
 *   （FEAT-197 的判定函数 = 密码非空或持有社交身份）；新系统直接看
 *   auth_account（密码非 null 或非 credential 提供商），不冗余存列。
 *   认领动作 = `POST /api/auth/request-password-reset` → `POST
 *   /api/auth/reset-password`（better-auth 对无凭据用户当场建 account 行，
 *   源码确认；老系统的接管同样是 recovery 链接 + set-password，不是重新注册）。
 * - 邮箱归一化：trim + lowercase 后存储与查询（老系统只在匹配处 lower、边缘
 *   处 trim，存储保留原样——大小写变体是它反复踩的坑）。注册侧 better-auth
 *   自带 toLowerCase，DB 的 lower(email) 唯一索引兜底，「同一邮箱不产生
 *   重复账号」不依赖任何单一调用方的自觉。
 * - emailVerified 置 true（老系统 `email_confirm: true`）：CRM 里的邮箱来自
 *   真实往来，认领邮件本身就发往该地址，地址在认领那一刻自证；不置 true 的话
 *   认领后登录会被 403 EMAIL_NOT_VERIFIED 挡死。
 * - 幂等：同邮箱重复调用返回既有用户、一行不动（老系统唯一命中规则的
 *   first-write-wins；person/org 绑定等业务关联等 CRM 模块落地后接线）。
 */

export const shadowAccountInputSchema = z.object({
  // 先 trim + lowercase 再验格式：CRM 录入带首尾空格、大小写随意是常态，
  // 校验针对归一化后的值（与存储值一致，不存在「通过校验却换形入库」）
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email().max(320)),
  /** CRM 联系人展示名；缺省用邮箱本地部分（与存量导入的兜底规则一致） */
  name: z.string().trim().min(1).max(200).optional(),
});

export type ShadowAccountInput = z.infer<typeof shadowAccountInputSchema>;

export interface ShadowAccountResult {
  user: {
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
  };
  /** false = 邮箱已有账号（含大小写/空格变体），本次未建任何行 */
  created: boolean;
}

function displayNameOf(input: ShadowAccountInput): string {
  if (input.name !== undefined && input.name !== "") return input.name;
  return input.email.split("@")[0] ?? input.email;
}

async function findUserByNormalizedEmail(db: Db, email: string) {
  const rows = await db
    .select()
    .from(schema.authUser)
    // lower() 查询配 lower(email) 唯一索引：即使出现未归一化的历史行（迁移前
    // 数据、未知的写入路径），大小写变体也命中的是同一行，不会另建
    .where(sql`lower(${schema.authUser.email}) = ${email}`)
    .limit(1);
  return rows[0];
}

/**
 * 邮箱存在 Shadow 账号（或任何账号）就返回它；没有就建「无密码可登录」的
 * 预建账号。所有「新增潜在客户」的代码路径都调这一个函数（#25 迁移要点），
 * 不各写各的 insert。并发同一邮箱：双写撞 lower(email) 唯一索引，输家按
 * 23505 重查后返回既有行，结果与串行一致。
 */
export async function ensureShadowAccount(
  db: Db,
  input: unknown,
  deps: { logger: Logger },
): Promise<ShadowAccountResult> {
  const parsed = shadowAccountInputSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ShadowAccountInputError(
      `email: ${first?.message ?? "is invalid"}`,
    );
  }
  const email = parsed.data.email;

  const existing = await findUserByNormalizedEmail(db, email);
  if (existing !== undefined) {
    deps.logger.debug({ userId: existing.id, email }, "shadow account already exists");
    return {
      user: {
        id: existing.id,
        email: existing.email,
        name: existing.name,
        emailVerified: existing.emailVerified,
      },
      created: false,
    };
  }

  try {
    const user = await insertShadowUser(db, email, displayNameOf(parsed.data));
    deps.logger.info({ userId: user.id, email }, "shadow account provisioned");
    return { user, created: true };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // 并发双写：索引兜了唯一性，重查拿赢家
    const winner = await findUserByNormalizedEmail(db, email);
    if (winner === undefined) throw err;
    deps.logger.debug({ userId: winner.id, email }, "shadow account lost insert race");
    return {
      user: {
        id: winner.id,
        email: winner.email,
        name: winner.name,
        emailVerified: winner.emailVerified,
      },
      created: false,
    };
  }
}

async function insertShadowUser(
  db: Db,
  email: string,
  name: string,
): Promise<ShadowAccountResult["user"]> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.authUser)
      .values({ id: randomUUID(), email, name, emailVerified: true })
      .returning({
        id: schema.authUser.id,
        email: schema.authUser.email,
        name: schema.authUser.name,
        emailVerified: schema.authUser.emailVerified,
      });
    const user = inserted[0];
    if (user === undefined) throw new Error("shadow account insert returned no row");

    // credential account 形状与注册/导入一致（accountId === user.id），密码留
    // null：占住「邮箱已有 credential 身份」的形状，登录 401，认领时 better-auth
    // 的 updatePassword 原地覆盖（resetPassword 源码确认的两分支之一）。
    await tx.insert(schema.authAccount).values({
      userId: user.id,
      accountId: user.id,
      providerId: "credential",
      password: null,
    });
    return user;
  });
}

/** Postgres unique_violation（drizzle 0.45 把 PG 错误包进 DrizzleQueryError.cause）；唯一索引是并发下的真防线，竞态输家由此识别 */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (
      "code" in current &&
      (current as { code?: unknown }).code === "23505"
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** 调用方传入的邮箱等字段不合法：4xx 语义，调用方转为对客户的明确报错 */
export class ShadowAccountInputError extends Error {}
