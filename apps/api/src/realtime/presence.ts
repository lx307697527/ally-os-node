import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { schema, type Db } from "@ally/db";
import type { RealtimePresenceMember } from "@ally/realtime";

/**
 * 在线状态的持久化（#30）。落在 PG 里而不是各实例内存：
 * 实例崩溃不会留下幽灵成员（超过 TTL 自动不可见、可清理），
 * 任何实例都能回答"这个频道现在谁在线"，多实例之间天然一致。
 */
export interface RealtimePresenceStore {
  join(member: {
    connectionId: string;
    channelId: string;
    instanceId: string;
    userId: string;
    state: Record<string, unknown>;
  }): Promise<void>;
  leave(connectionId: string, channelId: string): Promise<void>;
  leaveAll(connectionId: string): Promise<void>;
  list(channelId: string): Promise<RealtimePresenceMember[]>;
  /** 心跳：批量刷新连接的 last_seen_at */
  heartbeat(connectionIds: string[]): Promise<void>;
  /** 清理早已过期的行（实例崩溃留下的），由 hub 周期调用 */
  cleanup(): Promise<void>;
}

// 心跳默认 30s 一次，超过这个 TTL 没续上的成员视为离线；
// 清理阈值要远大于 TTL，正常在线的连接绝不会被清。
export const PRESENCE_TTL_SECONDS = 90;
const CLEANUP_AFTER_SECONDS = 15 * 60;

export function createPresenceStore(db: Db): RealtimePresenceStore {
  const presence = schema.realtimePresence;

  return {
    async join(member) {
      const now = new Date();
      await db
        .insert(presence)
        .values({
          connectionId: member.connectionId,
          channelId: member.channelId,
          instanceId: member.instanceId,
          userId: member.userId,
          state: member.state,
          joinedAt: now,
          lastSeenAt: now,
        })
        // 同一连接重新订阅（如更新自己的 presence 状态）时覆盖
        .onConflictDoUpdate({
          target: [presence.connectionId, presence.channelId],
          set: { userId: member.userId, state: member.state, lastSeenAt: now, joinedAt: now },
        });
    },

    async leave(connectionId, channelId) {
      await db
        .delete(presence)
        .where(and(eq(presence.connectionId, connectionId), eq(presence.channelId, channelId)));
    },

    async leaveAll(connectionId) {
      await db.delete(presence).where(eq(presence.connectionId, connectionId));
    },

    async list(channelId) {
      const rows = await db
        .select({
          connectionId: presence.connectionId,
          userId: presence.userId,
          state: presence.state,
        })
        .from(presence)
        .where(
          and(
            eq(presence.channelId, channelId),
            gtWithinTtl(),
          ),
        );
      return rows;
    },

    async heartbeat(connectionIds) {
      if (connectionIds.length === 0) return;
      await db
        .update(presence)
        .set({ lastSeenAt: new Date() })
        .where(inArray(presence.connectionId, connectionIds));
    },

    async cleanup() {
      await db
        .delete(presence)
        .where(lt(presence.lastSeenAt, sql`now() - make_interval(secs => ${CLEANUP_AFTER_SECONDS})`));
    },
  };
}

function gtWithinTtl() {
  return sql`${schema.realtimePresence.lastSeenAt} > now() - make_interval(secs => ${PRESENCE_TTL_SECONDS})`;
}
