import { z } from "zod";

// 实时推送的线上协议（#30）。所有帧都是 JSON 文本：
// - 客户端 → 服务端：auth / subscribe / unsubscribe / publish / presence.get / ping
// - 服务端 → 客户端：auth.ok / subscribed / unsubscribed / message / presence.* / error / pong
// - 实例之间：走 PG LISTEN/NOTIFY，信封见 realtimeBusEnvelopeSchema
// 浏览器/Node 通用的客户端 SDK 在 @ally/realtime-client，只 import 这里的类型。

/** WebSocket 路径（服务端监听、客户端连接都用它） */
export const REALTIME_WS_PATH = "/api/realtime";

/** presence 频道的命名约定：presence: 前缀 + 频道名，如 presence:doc-42 */
export const PRESENCE_CHANNEL_PREFIX = "presence:";

/** 频道名规则：字母或数字开头，可含字母数字 : _ -，最长 128 */
export const CHANNEL_MAX_LENGTH = 128;

// PG NOTIFY 的 payload 上限是 8000 字节，留出余量自己设上限，
// 超限的发布直接报错而不是在数据库那一侧被截断。
export const MAX_NOTIFY_PAYLOAD_BYTES = 6000;

/** 单个客户端帧的上限（ws 层也会按它拒绝超长帧） */
export const MAX_CLIENT_FRAME_BYTES = 64 * 1024;

/** 连接建立后必须在这个时间内完成 auth，否则服务端以 4401 关闭 */
export const AUTH_TIMEOUT_MS = 10_000;

/** 客户端未通过鉴权时服务端的关闭码（4000-4999 为应用私有区段） */
export const WS_CLOSE_UNAUTHORIZED = 4401;

/** 服务端错误码，返回给客户端的只有这些短代码，不带内部细节 */
export const REALTIME_ERROR_CODES = {
  unauthorized: "unauthorized",
  badFrame: "bad_frame",
  invalidChannel: "invalid_channel",
  notSubscribed: "not_subscribed",
  tooLarge: "too_large",
  publishFailed: "publish_failed",
} as const;

export function isPresenceChannel(channel: string): boolean {
  return channel.startsWith(PRESENCE_CHANNEL_PREFIX);
}

/**
 * 私人频道的命名约定（#110 切片 2：通知实时推送的第一个消费方）：`user:` 前缀
 * + 用户 id，如 `user:8f3a…`。这是保留前缀：服务端只允许本人订阅自己的
 * user: 频道（hub 的 authorize 规则），其他频道暂无授权规则。
 */
export const USER_CHANNEL_PREFIX = "user:";

export function isUserChannel(channel: string): boolean {
  return channel.startsWith(USER_CHANNEL_PREFIX);
}

/** 某用户的私人频道名（通知的「催」信号发布在这里） */
export function userChannel(userId: string): string {
  return `${USER_CHANNEL_PREFIX}${userId}`;
}

/**
 * 应用级知名事件：站内通知有了新行（#110）。payload 刻意是空对象 —— 推送只
 * 负责「催」，数据一律以 summary 端点的重读为准（at-most-once，重连 resync
 * 同样只触发重拉）。
 */
export const NOTIFICATIONS_CHANGED_EVENT = "notifications.changed";

const channelBase = z
  .string()
  .min(1)
  .max(CHANNEL_MAX_LENGTH)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/, "only letters, digits, ':', '_', '-' allowed");

export const channelSchema = channelBase.refine(
  (v) => !isPresenceChannel(v) || v.length > PRESENCE_CHANNEL_PREFIX.length,
  { message: `presence channel requires a name after '${PRESENCE_CHANNEL_PREFIX}'` },
);

/** 客户端订阅 presence 频道时带来的自定义状态（光标位置、正在编辑的字段等） */
export const presenceStateSchema = z.record(z.string(), z.unknown());
export type RealtimePresenceState = z.infer<typeof presenceStateSchema>;

/** presence 成员：一个连接一条；同一用户多开是多个成员 */
export const presenceMemberSchema = z.object({
  connectionId: z.string(),
  userId: z.string(),
  state: presenceStateSchema,
});
export type RealtimePresenceMember = z.infer<typeof presenceMemberSchema>;

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth"), token: z.string().min(1).max(4096) }),
  z.object({
    type: z.literal("subscribe"),
    channel: channelSchema,
    presence: presenceStateSchema.optional(),
  }),
  z.object({ type: z.literal("unsubscribe"), channel: channelSchema }),
  z.object({
    type: z.literal("publish"),
    channel: channelSchema,
    event: z.string().min(1).max(128),
    data: z.unknown(),
  }),
  z.object({
    type: z.literal("presence.get"),
    channel: channelSchema,
    requestId: z.string().min(1).max(128).optional(),
  }),
  z.object({ type: z.literal("ping") }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth.ok"), userId: z.string() }),
  z.object({ type: z.literal("subscribed"), channel: z.string() }),
  z.object({ type: z.literal("unsubscribed"), channel: z.string() }),
  z.object({
    type: z.literal("message"),
    channel: z.string(),
    event: z.string(),
    data: z.unknown(),
    senderUserId: z.string().optional(),
  }),
  z.object({
    type: z.literal("presence.state"),
    channel: z.string(),
    requestId: z.string().optional(),
    members: z.array(presenceMemberSchema),
  }),
  z.object({
    type: z.literal("presence.joined"),
    channel: z.string(),
    members: z.array(presenceMemberSchema),
  }),
  z.object({
    type: z.literal("presence.left"),
    channel: z.string(),
    connectionIds: z.array(z.string()),
  }),
  z.object({ type: z.literal("error"), code: z.string(), requestId: z.string().optional() }),
  z.object({ type: z.literal("pong") }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

// ---- 实例间总线信封（PG NOTIFY payload）----

export const realtimeBusPayloadSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    channel: z.string(),
    event: z.string(),
    data: z.unknown(),
    senderUserId: z.string().optional(),
  }),
  z.object({
    type: z.literal("presence.joined"),
    channel: z.string(),
    members: z.array(presenceMemberSchema),
  }),
  z.object({
    type: z.literal("presence.left"),
    channel: z.string(),
    connectionIds: z.array(z.string()),
  }),
]);
export type RealtimeBusPayload = z.infer<typeof realtimeBusPayloadSchema>;

export const realtimeBusEnvelopeSchema = z.object({
  v: z.literal(1),
  instanceId: z.string(),
  payload: realtimeBusPayloadSchema,
});
export type RealtimeBusEnvelope = z.infer<typeof realtimeBusEnvelopeSchema>;

/** payload 超过 NOTIFY 上限时抛出；调用方应转成 too_large 错误回给客户端 */
export class MessageTooLargeError extends Error {
  readonly sizeBytes: number;

  constructor(sizeBytes: number) {
    super(`realtime bus payload is ${String(sizeBytes)} bytes, limit is ${String(MAX_NOTIFY_PAYLOAD_BYTES)}`);
    this.name = "MessageTooLargeError";
    this.sizeBytes = sizeBytes;
  }
}

export function encodeBusEnvelope(payload: RealtimeBusPayload, instanceId: string): string {
  const raw = JSON.stringify({ v: 1, instanceId, payload } satisfies RealtimeBusEnvelope);
  const size = Buffer.byteLength(raw, "utf8");
  if (size > MAX_NOTIFY_PAYLOAD_BYTES) throw new MessageTooLargeError(size);
  return raw;
}

/** 解析其他实例发来的 NOTIFY payload；格式不对返回 null（记日志后丢弃） */
export function decodeBusEnvelope(raw: string): RealtimeBusEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = realtimeBusEnvelopeSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
