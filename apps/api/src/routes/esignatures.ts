import { and, asc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { AppEnv } from "../auth/session.ts";
import { signableSubjectSpec } from "../esign/registry.ts";
import { signSubject } from "../esign/service.ts";
import { loadVisibleSubject } from "../subjects/registry.ts";

/**
 * 电子签名端点（#219：Part 11 底座）。
 *
 * POST /api/esignatures —— 签名仪式：会话之外重新输密码 + 必须已启用 2FA
 * （#232 §13「签名时重新输入密码…签名用户双因素」）。被签 subject 过两扇门：
 * 可见性门（subjects/registry.ts，看得到才签得到——不存在与不可见同答 404，
 * 反探测）与可签名注册表（esign/registry.ts，属主域逐个注册，未注册 400）。
 *
 * GET /api/esignatures?subjectType=&subjectId= —— 记录上的签名墙：姓名、时间、
 * 含义、记录版本（Part 11.50 签名展示），可见者可读。
 *
 * 离线补同步走同一个 POST：客户端带上签名时生成的 clientToken 与原签名时刻
 * signedAt（#219 验收第 4 条「服务端记录与离线时一致」）；重放按 clientToken
 * 幂等返回同一行，未来时刻拒绝（允许 5 分钟设备时钟偏移）。
 */

// 离线设备的时钟漂移容差：signedAt 只拒绝「明显在未来」
const SIGNED_AT_SKEW_MS = 5 * 60 * 1000;

const meaningSchema = z.enum(["performed", "reviewed", "approved"]);

const signBody = z.object({
  subjectType: z.string().trim().min(1).max(64),
  subjectId: z.uuid(),
  meaning: meaningSchema,
  password: z.string().min(1).max(200),
  clientToken: z.uuid(),
  signedAt: z.iso.datetime().optional(),
});

const subjectQuery = z.object({
  subjectType: z.string().trim().min(1).max(64),
  subjectId: z.uuid(),
});

export function esignaturesRoutes(deps: { db: Db }) {
  const app = new Hono<AppEnv>();

  app.post("/api/esignatures", async (c) => {
    const parsed = signBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const body = parsed.data;
    // 2FA 门先于一切业务判定：未启用双因素的用户连「记录存在与否」都不该探到
    // （#24 强制门管住登录后的常规路由，签名仪式在这里再收一道—— Part 11 的
    // 签名用户必须双因素，无例外开关）
    const me = c.get("user");
    if (!me.twoFactorEnabled) {
      return c.json({ error: "forbidden", code: "two_factor_required" }, 403);
    }
    // 可见性门：类型未注册 400（两扇门各有各的话要说），不可见/不存在 404
    const visible = await loadVisibleSubject(deps.db, body.subjectType, body.subjectId, me.id);
    if (visible === "unregistered") {
      return c.json({ error: "invalid_subject" }, 400);
    }
    if (visible === null) {
      return c.json({ error: "not_found" }, 404);
    }
    // 可签名注册表：属主域没注册的类型不可签（本切片注册表为空，首个消费域进场
    // 时注册——机制先行不留产线，见 esign/registry.ts）
    const spec = signableSubjectSpec(body.subjectType);
    if (spec === undefined) {
      return c.json({ error: "subject_not_signable" }, 400);
    }
    let signedAt = new Date();
    if (body.signedAt !== undefined) {
      const offline = new Date(body.signedAt);
      // 设备时钟漂移容差：只拒绝明显在未来（5 分钟），离线多久都收——原签名
      // 时间是事实，联网晚不是它的错
      if (offline.getTime() > Date.now() + SIGNED_AT_SKEW_MS) {
        return c.json({ error: "invalid_request", code: "signed_at_future" }, 400);
      }
      signedAt = offline;
    }
    const outcome = await signSubject(
      deps.db,
      {
        subjectType: body.subjectType,
        subjectId: body.subjectId,
        signerId: me.id,
        meaning: body.meaning,
        password: body.password,
        clientToken: body.clientToken,
        signedAt,
      },
      spec.load,
    );
    if (outcome.status === "rejected") {
      switch (outcome.reason) {
        case "invalid_credentials":
          return c.json({ error: "invalid_credentials" }, 401);
        case "already_signed":
          return c.json({ error: "already_signed" }, 409);
        case "record_missing":
          return c.json({ error: "not_found" }, 404);
      }
    }
    const signature = await selectSignatureView(deps.db, outcome.signatureId);
    if (signature === null) throw new Error("esignature row missing right after write");
    return c.json({ signature, replayed: outcome.status === "replayed" }, outcome.status === "replayed" ? 200 : 201);
  });

  app.get("/api/esignatures", async (c) => {
    const parsed = subjectQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const me = c.get("user").id;
    const visible = await loadVisibleSubject(deps.db, parsed.data.subjectType, parsed.data.subjectId, me);
    if (visible === "unregistered") {
      return c.json({ error: "invalid_subject" }, 400);
    }
    if (visible === null) {
      return c.json({ error: "not_found" }, 404);
    }
    const signer = alias(schema.authUser, "signer");
    const rows = await deps.db
      .select({
        id: schema.esignSignatures.id,
        subjectType: schema.esignSignatures.subjectType,
        subjectId: schema.esignSignatures.subjectId,
        meaning: schema.esignSignatures.meaning,
        recordVersion: schema.esignSignatures.recordVersion,
        recordHash: schema.esignSignatures.recordHash,
        signedAt: schema.esignSignatures.signedAt,
        receivedAt: schema.esignSignatures.receivedAt,
        signer: { id: signer.id, name: signer.name },
      })
      .from(schema.esignSignatures)
      .innerJoin(signer, eq(schema.esignSignatures.signerId, signer.id))
      .where(
        // 可见性门已过，这里按 subject 前缀取全墙；签名时间正序 = 签署过程的自然读法
        and(
          eq(schema.esignSignatures.subjectType, parsed.data.subjectType),
          eq(schema.esignSignatures.subjectId, parsed.data.subjectId),
        ),
      )
      .orderBy(asc(schema.esignSignatures.signedAt), asc(schema.esignSignatures.id));
    return c.json({ signatures: rows });
  });

  return app;
}

/** 签名行读法（写后回读与 GET 共用同一投影） */
async function selectSignatureView(db: Db, id: string) {
  const signer = alias(schema.authUser, "signer");
  const rows = await db
    .select({
      id: schema.esignSignatures.id,
      subjectType: schema.esignSignatures.subjectType,
      subjectId: schema.esignSignatures.subjectId,
      meaning: schema.esignSignatures.meaning,
      recordVersion: schema.esignSignatures.recordVersion,
      recordHash: schema.esignSignatures.recordHash,
      signedAt: schema.esignSignatures.signedAt,
      receivedAt: schema.esignSignatures.receivedAt,
      signer: { id: signer.id, name: signer.name },
    })
    .from(schema.esignSignatures)
    .innerJoin(signer, eq(schema.esignSignatures.signerId, signer.id))
    .where(eq(schema.esignSignatures.id, id))
    .limit(1);
  return rows[0] ?? null;
}
