import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// 骨架阶段只放一张示例表，用来打通 migration → 查询 → 测试 全链路。
// 从 ally-nutra 迁移模块时，按模块把表结构加到这里（或拆成 schema/<module>.ts）。
export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  actor: text("actor"),
  action: text("action").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
