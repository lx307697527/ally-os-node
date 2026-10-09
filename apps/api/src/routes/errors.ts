import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "@ally/db";
import type { Logger } from "pino";
import type { AppEnv } from "../auth/session.ts";
import {
  ERROR_URL_MAX,
  recordErrorEvent,
} from "../errors/capture.ts";
import {
  clientIpFromHeaders,
  consumeRateLimit,
  recordRateLimitDenial,
  windowStartFor,
} from "../security/rate-limit.ts";

/**
 * 前端错误上报端点（#28 切片 1）：浏览器全局捕获（web 侧 error-reporter）的
 * 公开接收面。挂在会话中间件之前——报错最常见的时刻恰恰是会话不在/刚断的
 * 时刻，登录门会把最重要的样本挡在门外。
 *
 * 限流复用 #27 切片 1 的 PG 内核（本仓库第一个非认证消费域）：`errors.ingest`
 * 10 次/分钟/IP，对齐老 errorTracker 的客户端 10/min 节流——服务端节流才是
 * 真节流，客户端的只是礼貌。不可归因不计数（同 #27 裁决 1：正常部署拓扑下
 * 来源头总在，出现即部署头配置断了，不该由 429 来暴露）。
 *
 * 落库失败仍答 202（capture.ts 裁决 3）：上报方是浏览器，5xx 换不来任何补救，
 * 只会换来重试放大事故；遥测 sink 不制造用户可见失败面。响应体恒为
 * { ok: true }——上报方不读它，测试与监控读状态码。
 */

/** 阈值是代码常量（#27 同一裁法）：第一个要调的消费域把它抬进配置面 */
export const ERROR_INGEST_RATE_LIMIT = { action: "errors.ingest", limit: 10, windowMs: 60_000 } as const;

const ingestSchema = z.object({
  message: z.string().min(1).max(2000),
  stack: z.string().max(8000).optional(),
  // SPA 的 location.href：分诊线索不是安全边界，收得宽但裁得狠
  url: z.string().max(ERROR_URL_MAX).optional(),
});

export function errorIngestRoutes(deps: { db: Db; logger: Logger }): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/api/errors", async (c) => {
    const identifier = clientIpFromHeaders(c.req.raw.headers);
    if (identifier !== undefined) {
      const now = new Date();
      const windowStart = windowStartFor(now.getTime(), ERROR_INGEST_RATE_LIMIT.windowMs);
      const outcome = await consumeRateLimit(deps.db, {
        identifierType: "ip",
        identifier,
        action: ERROR_INGEST_RATE_LIMIT.action,
        windowStart,
        limit: ERROR_INGEST_RATE_LIMIT.limit,
        now,
      });
      if (!outcome.allowed) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((windowStart.getTime() + ERROR_INGEST_RATE_LIMIT.windowMs - now.getTime()) / 1000),
        );
        try {
          await recordRateLimitDenial(deps.db, {
            identifierType: "ip",
            identifier,
            action: ERROR_INGEST_RATE_LIMIT.action,
            windowStart,
            countAtDenial: outcome.count,
            limitValue: ERROR_INGEST_RATE_LIMIT.limit,
            requestId: c.get("requestId"),
            now,
          });
        } catch {
          // 台账写失败不改判（#27 裁决 4）：429 的权威在计数器
        }
        return c.json({ error: "rate_limited" }, 429, { "retry-after": String(retryAfterSeconds) });
      }
    }

    const parsed = ingestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }

    try {
      await recordErrorEvent(deps.db, {
        source: "web",
        message: parsed.data.message,
        ...(parsed.data.stack === undefined ? {} : { stack: parsed.data.stack }),
        ...(parsed.data.url === undefined ? {} : { url: parsed.data.url }),
        userAgent: c.req.header("user-agent"),
        requestId: c.get("requestId"),
        now: new Date(),
      });
    } catch (err) {
      // 遥测写失败不产生用户可见失败（capture.ts 裁决 3）：上报方是浏览器，
      // 5xx 换不来任何补救，只会换来重试放大事故。warn 留诊断入口。
      deps.logger.warn({ err, requestId: c.get("requestId") }, "error event ingest failed");
    }
    return c.json({ ok: true }, 202);
  });

  return app;
}
