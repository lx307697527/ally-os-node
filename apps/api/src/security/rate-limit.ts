import type { MiddlewareHandler } from "hono";
import { sql } from "drizzle-orm";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { Logger } from "pino";
import type { AppEnv } from "../auth/session.ts";

/**
 * PG 限流内核（#27 切片 1）：公开写面的固定窗口计数，计数与判定的原子性由
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING` 一条语句承担——同窗口并发写
 * 撞计数行主键串行化，两个 API 实例共享同一张表，不存在「各读各的 19」。
 *
 * 与老系统（ally-os FEAT-019 phase 3）的对应与差异见 schema.ts 两张表的注释
 * 与 docs/abuse-prevention.md。三条老裁决原样继承：
 *   1. 来源头信任规则：cf-connecting-ip → x-forwarded-for 的**最后一个**元素
 *      （每个代理把自己的对端**追加**在尾部，头部是客户端可自填的）；都没有 =
 *      不可归因 → 不计数（fail open，老 platform.consume_rate_limit 对 null
 *      标识的原裁决：数不了就别拦——共享「unknown」桶等于给同一出口背后的
 *      无辜者造一个人为的拒绝面）。
 *   2. 标识值原样存储、截断 100 字符：IPv6/host:port/链式头都可能是合法来源，
 *      归一化等真实样本；紧急路径上最不该发生的是格式解析抛错。
 *   3. 限流器错误不静默吞：这里选择让异常冒泡（中间件外层 onError 兜成 500）
 *      ——认证端点本来就依赖同一数据库，限流器不制造新的可用性悬崖，装作
 *      「没限制住」才是谎报。
 *
 * 限制值是代码常量（与审批催办 24h 节奏同一裁法）：第一个要调的消费域把它
 * 抬进配置面，不预先发明一层。
 */

/** 标识截断上限：老 request_client_ip 的 PII/数据最小化边界 */
const IDENTIFIER_MAX_LENGTH = 100;

/**
 * 从请求头提取可归因的来源标识。永不抛错：损坏的头返回 undefined，
 * 限流器不能成为它要保护的端点的新的故障注入点。
 */
export function clientIpFromHeaders(headers: Headers): string | undefined {
  const cf = normalizeIdentifier(headers.get("cf-connecting-ip"));
  if (cf !== undefined) return cf;
  // x-forwarded-for 取最后一个元素：每跳代理把收到的对端追加在尾部，
  // 尾部是最近一跳可信代理写下的真实对端；头部是客户端自选自填的
  const xff = headers.get("x-forwarded-for");
  if (xff === null) return undefined;
  const parts = xff.split(",");
  const last = parts[parts.length - 1];
  if (last === undefined) return undefined;
  return normalizeIdentifier(last);
}

function normalizeIdentifier(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  return trimmed.slice(0, IDENTIFIER_MAX_LENGTH);
}

/**
 * 固定窗口桶起点：按 epoch 对齐（老系统 date_bin 的语义）。纯函数，
 * 与 consumed 时刻无关的桶起点让「窗口内第几个请求」有确定答案。
 */
export function windowStartFor(nowMs: number, windowMs: number): Date {
  return new Date(Math.floor(nowMs / windowMs) * windowMs);
}

export interface ConsumeRateLimitArgs {
  identifierType: string;
  identifier: string;
  action: string;
  windowStart: Date;
  limit: number;
  now: Date;
}

export interface ConsumeRateLimitResult {
  allowed: boolean;
  /** 递增后的窗口计数；拒绝时 > limit（拒绝照计数，见模块头注释） */
  count: number;
}

/**
 * 原子计数并判定。递增与判定同一条语句，并发调用者不可能同时看到
 * 「count = limit」并各自放行——这是验收第 1 条（多实例准确）的结构保证。
 */
export async function consumeRateLimit(db: Db, args: ConsumeRateLimitArgs): Promise<ConsumeRateLimitResult> {
  const rows = await db
    .insert(schema.rateLimitCounters)
    .values({
      identifierType: args.identifierType,
      identifier: args.identifier,
      action: args.action,
      windowStart: args.windowStart,
      requestCount: 1,
      updatedAt: args.now,
    })
    .onConflictDoUpdate({
      target: [
        schema.rateLimitCounters.identifierType,
        schema.rateLimitCounters.identifier,
        schema.rateLimitCounters.action,
        schema.rateLimitCounters.windowStart,
      ],
      set: { requestCount: sql`${schema.rateLimitCounters.requestCount} + 1`, updatedAt: args.now },
    })
    .returning({ requestCount: schema.rateLimitCounters.requestCount });
  const row = rows[0];
  if (row === undefined) {
    // RETURNING 空在 PG upsert 语义下不可达（insert 或 update 必返回一行）；
    // 到这里说明数据库行为在契约外，fail loud 让 onError 兜住
    throw new Error("rate limit upsert returned no row");
  }
  return { allowed: row.requestCount <= args.limit, count: row.requestCount };
}

/**
 * 拒绝台账（rate_limit_denials）：app 层限流器才可能有的持久拒绝记录——
 * 老系统的拒绝记录随业务事务回滚蒸发，只剩一条 warning。写失败只告警不
 * 改判：台账是安全遥测不是闸门，429 的权威在计数器，「台账写不进就放行」
 * 是把遥测错当闸门的倒置。fire-and-forget 由调用方决定（中间件里 await，
 * 不留未观测的悬浮 promise）。
 */
export async function recordRateLimitDenial(
  db: Db,
  entry: {
    identifierType: string;
    identifier: string;
    action: string;
    windowStart: Date;
    countAtDenial: number;
    limitValue: number;
    requestId: string | undefined;
    now: Date;
  },
): Promise<void> {
  await db.insert(schema.rateLimitDenials).values({
    identifierType: entry.identifierType,
    identifier: entry.identifier,
    action: entry.action,
    windowStart: entry.windowStart,
    countAtDenial: entry.countAtDenial,
    limitValue: entry.limitValue,
    // 列可空、字段 optional：exactOptionalPropertyTypes 下显式三态
    ...(entry.requestId === undefined ? {} : { requestId: entry.requestId }),
  });
}

// ── 公开认证面的规则册 ────────────────────────────────────────────────────
// 公开写面今天的全集 = 认证端点（登录/注册/重置是字面意义的「表单接口」，
// 也是凭据填充与邮件轰炸的标准靶面）；Stripe/PayPal webhook 有各自的签名
// 认证、来源是服务商基础设施（按 IP 限流只会拦到它们自己），不在此册。
// 询价等公开表单域（#207/#227）进场时挂同一中间件、注册自己的规则行。
export interface RateLimitRule {
  /** 稳定动作名：计数行的 key，也是台账与日志里的名字 */
  action: string;
  /** 窗口内允许的请求数；超出即拒 */
  limit: number;
  /** 固定窗口长度（毫秒） */
  windowMs: number;
  /** /api/auth 之下的子路径前缀；认证面的规则按前缀命中 */
  pathPrefix: string;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * 阈值取「人不会撞线、脚本会」的量级：30 次/5 分钟的登录是办公室共享出口
 * 的上班高峰也够用的量（每人每天登录一次）；10 次/小时的注册/重置对单个
 * 来源足够完成「忘密码 + 换邮箱」的全部正当事。2FA 验证单独收紧：TOTP
 * 六位码的暴力空间经不起 300/5min 的背底限制，10 次/5 分钟对反复看错
 * 时段的真人绰绰有余，对猜码者是不可用的节奏。
 */
export const AUTH_RATE_LIMIT_RULES: readonly RateLimitRule[] = [
  { action: "auth.sign-in", limit: 30, windowMs: 5 * MINUTE_MS, pathPrefix: "/api/auth/sign-in" },
  { action: "auth.sign-up", limit: 10, windowMs: HOUR_MS, pathPrefix: "/api/auth/sign-up" },
  {
    action: "auth.password-reset",
    limit: 10,
    windowMs: HOUR_MS,
    pathPrefix: "/api/auth/request-password-reset",
  },
  { action: "auth.password-reset", limit: 10, windowMs: HOUR_MS, pathPrefix: "/api/auth/reset-password" },
  { action: "auth.two-factor", limit: 10, windowMs: 5 * MINUTE_MS, pathPrefix: "/api/auth/two-factor" },
];

/** 认证面背底限制：规则册没点名的 /api/auth/* POST 一律在此限内 */
const AUTH_BACKSTOP_RULE: RateLimitRule = {
  action: "auth.other",
  limit: 300,
  windowMs: 5 * MINUTE_MS,
  pathPrefix: "/api/auth/",
};

/**
 * 把请求路径解析成限流规则。只限写动词（POST）：认证面的 GET 是令牌消费
 * （验证邮件回调、OAuth 回调）与状态读（get-session），令牌本身长随机、
 * 不是可暴力面。规则册按序首个前缀命中生效；没有命中且是 POST → 背底。
 */
export function resolveAuthRateLimitRule(method: string, pathname: string): RateLimitRule | undefined {
  if (method !== "POST" || !pathname.startsWith(AUTH_BACKSTOP_RULE.pathPrefix)) {
    return undefined;
  }
  for (const rule of AUTH_RATE_LIMIT_RULES) {
    if (pathname.startsWith(rule.pathPrefix)) return rule;
  }
  return AUTH_BACKSTOP_RULE;
}

/**
 * 认证面限流中间件：挂会话门之前（/api/auth/* 本来就在会话中间件之前）。
 * 放行 = next()；拒绝 = 429 + Retry-After，响应体只有动作无关的
 * rate_limited——拒绝面不向攻击者确认「这个动作存在且被限」，具体策略
 * 在 docs/abuse-prevention.md 与代码注释里。
 */
export function authRateLimitMiddleware(deps: { db: Db; logger: Logger }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const rule = resolveAuthRateLimitRule(c.req.method, new URL(c.req.url).pathname);
    if (rule === undefined) {
      await next();
      return undefined;
    }
    const identifier = clientIpFromHeaders(c.req.raw.headers);
    // 不可归因 → 不计数（模块头裁决 1）；只留 debug 供部署诊断——正常拓扑下
    // 代理总留 XFF，这条路径出现说明部署头配置断了，但断配置不该由 429 来暴露
    if (identifier === undefined) {
      deps.logger.debug({ requestId: c.get("requestId") }, "rate limit skipped: no attributable client ip");
      await next();
      return undefined;
    }
    const now = new Date();
    const windowStart = windowStartFor(now.getTime(), rule.windowMs);
    const outcome = await consumeRateLimit(deps.db, {
      identifierType: "ip",
      identifier,
      action: rule.action,
      windowStart,
      limit: rule.limit,
      now,
    });
    if (outcome.allowed) {
      await next();
      return undefined;
    }
    const retryAfterSeconds = Math.max(1, Math.ceil((windowStart.getTime() + rule.windowMs - now.getTime()) / 1000));
    deps.logger.warn(
      {
        requestId: c.get("requestId"),
        action: rule.action,
        identifierType: "ip",
        identifier,
        count: outcome.count,
        limit: rule.limit,
      },
      "rate_limit_denied",
    );
    try {
      await recordRateLimitDenial(deps.db, {
        identifierType: "ip",
        identifier,
        action: rule.action,
        windowStart,
        countAtDenial: outcome.count,
        limitValue: rule.limit,
        requestId: c.get("requestId"),
        now,
      });
    } catch (err) {
      deps.logger.warn({ err, requestId: c.get("requestId") }, "rate limit denial record failed");
    }
    return c.json({ error: "rate_limited" }, 429, { "retry-after": String(retryAfterSeconds) });
  };
}
