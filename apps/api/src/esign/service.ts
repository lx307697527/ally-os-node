import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import { recordAudit } from "../audit/audit-log.ts";
import { verifyLegacyPassword } from "../auth/legacy-password.ts";
import type { SignableRecord } from "./registry.ts";

/**
 * 电子签名服务（#219：Part 11 底座）。
 *
 * 服务端在签名仪式上替监管者核四件事（#232 §13）：
 * 1. 是本人——会话之外**重新输入密码**（Part 11.200 签名仪式重认证；口令校验
 *    复用 better-auth 的同一套哈希分派，导入的 bcrypt 老哈希同样能签）；
 * 2. 是双因素用户——twoFactorEnabled 的门在路由层（与 #24 强制门同一语义）；
 * 3. 签的是什么——版本标 + 内容快照哈希绑定到被签记录的具体版本（Part 11.70
 *    签名与记录的联结）；
 * 4. 之后不可改——签名行 append-only（0012 触发器），属主记录的修改路径经
 *    isSubjectSigned 拒绝（409 record_signed）。
 */

export type EsignMeaning = "performed" | "reviewed" | "approved";

/**
 * 规范化 JSON：键全序递归排序、丢弃 undefined——同一份记录内容无论字段顺序如何
 * 都得到同一哈希，签名绑定的是内容不是序列化的偶然形态。
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry) => entry[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** 签名绑定：subject 身份 + 版本标 + 内容快照的 SHA-256（hex） */
export function signatureHash(input: {
  subjectType: string;
  subjectId: string;
  version: string;
  record: Record<string, unknown>;
}): string {
  return createHash("sha256")
    .update(canonicalJson(input))
    .digest("hex");
}

/**
 * 签名仪式的密码重验（Part 11.200）：会话证明「登录着」，密码证明「是本人」。
 * 查 credential account 的哈希走 verifyLegacyPassword 的格式分派——签名与登录
 * 用同一套口令真相，不出现「能登录不能签」的第二套哈希语义。
 */
export async function verifySignerPassword(
  db: Pick<Db, "select">,
  userId: string,
  password: string,
): Promise<boolean> {
  const rows = await db
    .select({ password: schema.authAccount.password })
    .from(schema.authAccount)
    .where(
      and(eq(schema.authAccount.userId, userId), eq(schema.authAccount.providerId, "credential")),
    )
    .limit(1);
  const hash = rows[0]?.password;
  if (hash === null || hash === undefined) return false;
  return verifyLegacyPassword({ hash, password });
}

/**
 * 签名锁定检查：该 subject 上是否存在任何签名。属主记录的每个修改路径（PATCH/
 * DELETE/状态流转）在写之前调它——签过即拒（409 record_signed），更正走新记录
 * 或变更流程（#219 正文原句）。没有任何签名时它是一次廉价的存在性查询。
 */
export async function isSubjectSigned(
  db: Pick<Db, "select">,
  subjectType: string,
  subjectId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: schema.esignSignatures.id })
    .from(schema.esignSignatures)
    .where(
      and(eq(schema.esignSignatures.subjectType, subjectType), eq(schema.esignSignatures.subjectId, subjectId)),
    )
    .limit(1);
  return rows[0] !== undefined;
}

export interface SignCommand {
  subjectType: string;
  subjectId: string;
  signerId: string;
  meaning: EsignMeaning;
  /** 签名仪式重输的密码（明文只在本请求内存在，不落库不落日志） */
  password: string;
  /** 签名端生成的幂等键：离线补同步的重放按它去重返回同一行 */
  clientToken: string;
  /**
   * 有效签名时刻：在线签名 = 服务端现在；离线补同步 = 客户端保留的原签名时间
   * （#219 验收第 4 条），未来时刻的拒绝在路由层（时钟偏移容差）。
   */
  signedAt: Date;
}

export type SignOutcome =
  | { status: "created"; signatureId: string }
  | { status: "replayed"; signatureId: string }
  | { status: "rejected"; reason: "invalid_credentials" | "already_signed" | "record_missing" };

/**
 * 签名的事务核心：密码重验 → 幂等重放检查 → 重复签名检查 → 落签名行 + 审计行
 * （同一事务，审计失败则签名失败——与全部业务写路径同一失败语义）。
 *
 * loadRecord 由调用方从可签名注册表取来（esign/registry.ts）；它返回的版本与
 * 快照在此刻定格成 recordHash，之后属主记录怎么演进都不改写这份绑定。
 */
export async function signSubject(
  db: Db,
  cmd: SignCommand,
  loadRecord: (db: Db, subjectId: string) => Promise<SignableRecord | null>,
): Promise<SignOutcome> {
  const record = await loadRecord(db, cmd.subjectId);
  if (record === null) {
    return { status: "rejected", reason: "record_missing" };
  }
  if (!(await verifySignerPassword(db, cmd.signerId, cmd.password))) {
    return { status: "rejected", reason: "invalid_credentials" };
  }
  // 幂等重放先于重复签名判定：同一个 clientToken = 同一次签名仪式的再次提交
  // （离线补同步的弱网重试、多端排队上传），按原行幂等返回，不落第二行审计。
  // token 在但字段对不上属客户端缺陷（令牌串用），按重复签名冲突拒绝。
  const replayRows = await db
    .select({
      id: schema.esignSignatures.id,
      subjectType: schema.esignSignatures.subjectType,
      subjectId: schema.esignSignatures.subjectId,
      signerId: schema.esignSignatures.signerId,
      meaning: schema.esignSignatures.meaning,
    })
    .from(schema.esignSignatures)
    .where(eq(schema.esignSignatures.clientToken, cmd.clientToken))
    .limit(1);
  const replay = replayRows[0];
  if (replay !== undefined) {
    if (
      replay.subjectType === cmd.subjectType &&
      replay.subjectId === cmd.subjectId &&
      replay.signerId === cmd.signerId &&
      replay.meaning === cmd.meaning
    ) {
      return { status: "replayed", signatureId: replay.id };
    }
    return { status: "rejected", reason: "already_signed" };
  }
  const dupRows = await db
    .select({ id: schema.esignSignatures.id })
    .from(schema.esignSignatures)
    .where(
      and(
        eq(schema.esignSignatures.subjectType, cmd.subjectType),
        eq(schema.esignSignatures.subjectId, cmd.subjectId),
        eq(schema.esignSignatures.signerId, cmd.signerId),
        eq(schema.esignSignatures.meaning, cmd.meaning),
      ),
    )
    .limit(1);
  if (dupRows[0] !== undefined) {
    return { status: "rejected", reason: "already_signed" };
  }
  const receivedAt = new Date();
  const hash = signatureHash({
    subjectType: cmd.subjectType,
    subjectId: cmd.subjectId,
    version: record.recordVersion,
    record: record.snapshot,
  });
  const outcome = await db.transaction(async (tx): Promise<SignOutcome> => {
    const inserted = await tx
      .insert(schema.esignSignatures)
      .values({
        subjectType: cmd.subjectType,
        subjectId: cmd.subjectId,
        signerId: cmd.signerId,
        meaning: cmd.meaning,
        recordVersion: record.recordVersion,
        recordHash: hash,
        signedAt: cmd.signedAt,
        receivedAt,
        clientToken: cmd.clientToken,
      })
      // clientToken 撞唯一约束 = 离线补同步的重放（弱网重试、多端排队上传）：
      // 不算签名失败，返回已存在的原行（200 幂等），不重复落审计
      .onConflictDoNothing({ target: schema.esignSignatures.clientToken })
      .returning({ id: schema.esignSignatures.id });
    const row = inserted[0];
    if (row !== undefined) {
      // 审计行按 docs/audit.md 多态子对象约定带 subject 引用（target = 签名行 id，
      // detail.subjectType/subjectId 指被签记录）——签名自动进该对象的活动流时间线
      await recordAudit(tx, {
        actor: cmd.signerId,
        action: "esignature.created",
        target: row.id,
        detail: {
          subjectType: cmd.subjectType,
          subjectId: cmd.subjectId,
          meaning: cmd.meaning,
          recordVersion: record.recordVersion,
          recordHash: hash,
          signedAt: cmd.signedAt.toISOString(),
          receivedAt: receivedAt.toISOString(),
        },
      });
      return { status: "created", signatureId: row.id };
    }
    const existing = await tx
      .select({ id: schema.esignSignatures.id })
      .from(schema.esignSignatures)
      .where(eq(schema.esignSignatures.clientToken, cmd.clientToken))
      .limit(1);
    const id = existing[0]?.id;
    if (id === undefined) throw new Error("esign replay: clientToken conflict but no row found");
    return { status: "replayed", signatureId: id };
  });
  return outcome;
}
