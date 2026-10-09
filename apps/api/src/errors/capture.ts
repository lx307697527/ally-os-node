import { createHash } from "node:crypto";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { Logger } from "pino";

/**
 * 错误追踪内核（#28 切片 1）的捕获半边：指纹、裁剪、落库。老系统的对应物
 * （ingest-error 写 error_logs、前端 errorTracker.ts 全局捕获）在老仓库迁移
 * HEAD 上已不存在，语义按 issue #28 的迁移要点重建——指纹分组、payload 裁剪、
 * 前后端错误进同一张表。
 *
 * 遥测定位的三条裁决：
 *   1. 指纹服务端算。客户端声称的分组不可信（攻击面不说谎——公开端点的请求体
 *      谁都能填），指纹只从裁剪后的 message 首行 + 栈顶帧派生。
 *   2. 一行一次发生。聚合（count / firstSeen / lastSeen）是 fingerprint 上的
 *      查询投影（routes/error-events.ts 的 summary），不是存储形态；行数即
 *      发生次数，激增检测数行数即可。
 *   3. 遥测写失败不产生用户可见失败。ingest 与 onError 捕获的落库都 catch 后
 *      告警日志（与限流拒绝台账同一裁法：遥测不是闸门）；限流内核则相反——
 *      那是闸门，错误冒泡（#27 切片 1 的裁决 5）。
 */

/** message 裁剪上限：错误首行足够分组，完整上下文在 stack 里 */
export const ERROR_MESSAGE_MAX = 2000;
/** stack 裁剪上限：Top Frames + 重复帧折叠前的原始栈，8K 兜住绝大多数运行时 */
export const ERROR_STACK_MAX = 8000;
/** 页面/请求 URL 裁剪上限 */
export const ERROR_URL_MAX = 500;
/** User-Agent 裁剪上限：UA 是分诊线索不是存储对象 */
export const ERROR_USER_AGENT_MAX = 300;

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** 指纹用的 message 首行：多行消息（「…: cause」链）按第一行分组 */
export function firstLine(message: string): string {
  return truncate(message.split("\n")[0]?.trim() ?? "", 500);
}

/**
 * 栈顶帧：第一个含 "at " 的行。同一个错误在不同页面/构建里 message 相同、
 * 位置不同——栈顶帧把它们分开；minify 后的帧仍比裸 message 稳定。
 * 没有栈（跨域脚本只给 "Script error."、非 Error 抛出值）= 空串参与哈希。
 */
export function topStackFrame(stack: string | undefined): string {
  if (stack === undefined) return "";
  const frame = stack.split("\n").find((line) => line.includes("at "));
  return frame === undefined ? "" : frame.trim();
}

/**
 * 服务端指纹：sha256(source | 栈顶帧 | message 首行)。source 进指纹意味着
 * web 与 api 的同名错误不互相污染分组。
 */
export function computeErrorFingerprint(input: { source: string; message: string; stack?: string }): string {
  return createHash("sha256")
    .update(input.source)
    .update("\n")
    .update(topStackFrame(input.stack))
    .update("\n")
    .update(firstLine(input.message))
    .digest("hex");
}

export interface RecordErrorEventArgs {
  source: string;
  message: string;
  stack?: string | undefined;
  url?: string | undefined;
  userAgent?: string | undefined;
  requestId?: string | undefined;
  now: Date;
}

/** 裁剪并落一行错误事件。调用方负责 catch（裁决 3）——本函数只管写。 */
export async function recordErrorEvent(db: Db, args: RecordErrorEventArgs): Promise<void> {
  await db.insert(schema.errorEvents).values({
    fingerprint: computeErrorFingerprint({
      source: args.source,
      message: args.message,
      ...(args.stack === undefined ? {} : { stack: args.stack }),
    }),
    source: args.source,
    message: truncate(args.message, ERROR_MESSAGE_MAX),
    ...(args.stack === undefined ? {} : { stack: truncate(args.stack, ERROR_STACK_MAX) }),
    ...(args.url === undefined ? {} : { url: truncate(args.url, ERROR_URL_MAX) }),
    ...(args.userAgent === undefined ? {} : { userAgent: truncate(args.userAgent, ERROR_USER_AGENT_MAX) }),
    ...(args.requestId === undefined ? {} : { requestId: args.requestId }),
    createdAt: args.now,
  });
}

/**
 * 服务端 unhandled 错误的捕获入口（app.onError 调用）：落库失败只 warn——
 * 500 的响应路径上最不该再抛第二个错（裁决 3）。
 */
export async function captureServerError(
  db: Db,
  logger: Logger,
  err: Error,
  context: { requestId: string | undefined; url: string; now: Date },
): Promise<void> {
  try {
    await recordErrorEvent(db, {
      source: "api",
      message: err.message === "" ? err.name || "unknown error" : err.message,
      ...(err.stack === undefined ? {} : { stack: err.stack }),
      url: context.url,
      requestId: context.requestId,
      now: context.now,
    });
  } catch (captureErr) {
    logger.warn({ err: captureErr, requestId: context.requestId }, "error event capture failed");
  }
}
