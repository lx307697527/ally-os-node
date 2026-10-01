import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// 骨架阶段只放一张示例表，用来打通 migration → 查询 → 测试 全链路。
// 从 ally-nutra 迁移模块时，按模块把表结构加到这里（或拆成 schema/<module>.ts）。
export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  actor: text("actor"),
  action: text("action").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// 实时推送的在线状态（#30）。一条记录 = 一个连接在一个 presence 频道上的成员资格；
// 同一用户多开标签页是多个连接、多条记录。实例每 30s 心跳刷新 last_seen_at，
// 列表查询和清理都以它判断存活，实例崩溃后的残留因此自动过期。
export const realtimePresence = pgTable(
  "realtime_presence",
  {
    connectionId: text("connection_id").notNull(),
    channelId: text("channel_id").notNull(),
    instanceId: text("instance_id").notNull(),
    userId: text("user_id").notNull(),
    // 客户端订阅 presence 频道时带来的自定义状态（光标位置、正在编辑等）
    state: jsonb("state").$type<Record<string, unknown>>().notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.connectionId, t.channelId] }),
    index("realtime_presence_channel_idx").on(t.channelId),
  ],
);
