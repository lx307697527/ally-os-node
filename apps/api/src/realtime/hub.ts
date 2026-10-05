import type { Logger } from "pino";
import {
  AUTH_TIMEOUT_MS,
  MAX_CLIENT_FRAME_BYTES,
  MessageTooLargeError,
  REALTIME_ERROR_CODES,
  WS_CLOSE_UNAUTHORIZED,
  clientMessageSchema,
  isPresenceChannel,
  type RealtimeBusPayload,
  type RealtimePresenceMember,
  type ServerMessage,
} from "@ally/realtime";

/**
 * 推送中枢（#30），与传输层解耦：ws.ts 负责把 WebSocket 映射成 RealtimeConnection，
 * hub 只处理帧。跨实例投递交给注入的 publish（pg_notify 总线），本实例只投给本地订阅者。
 *
 * 每个连接必须先 auth（10 秒内，否则 4401 关闭）；鉴权器由外部注入，
 * 认证体系在 #22 落地前，生产环境默认拒绝所有连接。
 */
export interface RealtimeConnection {
  readonly id: string;
  send(text: string): void;
  close(code: number, reason: string): void;
}

export type RealtimeAuthenticator = (token: string) => Promise<{ userId: string } | null>;

export interface RealtimePresenceStoreLike {
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
  heartbeat(connectionIds: string[]): Promise<void>;
  cleanup(): Promise<void>;
}

export interface RealtimeHubDeps {
  logger: Logger;
  instanceId: string;
  /** 跨实例广播（实现方应把消息交回 onBusMessage 投给所有实例的本地订阅者） */
  publish: (payload: RealtimeBusPayload) => Promise<void>;
  presence: RealtimePresenceStoreLike;
  authenticate: RealtimeAuthenticator;
  /**
   * 频道授权（#110 切片 2 起）：返回 false = 该用户不得订阅该频道，回 error
   * unauthorized，订阅表不动。缺省 = 登录即可订阅任何频道（#30 原行为）；
   * 生产接线用 user: 私人频道规则（realtime/channels.ts）。
   */
  authorize?: ((channel: string, userId: string) => boolean) | undefined;
  /** 以下均为测试可调的内部节奏 */
  authTimeoutMs?: number | undefined;
  heartbeatIntervalMs?: number | undefined;
  cleanupEveryTicks?: number | undefined;
}

interface ConnState {
  conn: RealtimeConnection;
  userId: string | null;
  channels: Set<string>;
  presenceChannels: Set<string>;
  /** 同一连接的帧严格按顺序处理，避免乱序订阅/取消订阅 */
  queue: Promise<void>;
  authTimer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_CLEANUP_EVERY_TICKS = 20;

export class RealtimeHub {
  private readonly deps: RealtimeHubDeps;
  private readonly byConn = new Map<string, ConnState>();
  private readonly byChannel = new Map<string, Set<ConnState>>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private ticks = 0;

  constructor(deps: RealtimeHubDeps) {
    this.deps = deps;
    this.startHeartbeat();
  }

  /** 传输层接受了新连接时调用；启动鉴权倒计时 */
  connect(conn: RealtimeConnection): void {
    const state: ConnState = {
      conn,
      userId: null,
      channels: new Set(),
      presenceChannels: new Set(),
      queue: Promise.resolve(),
      authTimer: null,
    };
    this.byConn.set(conn.id, state);
    state.authTimer = setTimeout(() => {
      if (state.userId !== null) return;
      this.deps.logger.info({ connectionId: conn.id }, "realtime auth timeout");
      conn.close(WS_CLOSE_UNAUTHORIZED, "auth timeout");
    }, this.deps.authTimeoutMs ?? AUTH_TIMEOUT_MS);
  }

  /** 入队一帧；由传输层保证 raw 是文本 */
  handleFrame(conn: RealtimeConnection, raw: string): void {
    const state = this.byConn.get(conn.id);
    if (!state) return;
    state.queue = state.queue
      .then(() => this.processFrame(state, raw))
      .catch((err: unknown) => {
        this.deps.logger.warn({ err, connectionId: conn.id }, "realtime frame failed");
      });
  }

  /** 连接断开：清理订阅与 presence，向频道广播离开 */
  async disconnect(conn: RealtimeConnection): Promise<void> {
    const state = this.byConn.get(conn.id);
    if (!state) return;
    this.byConn.delete(conn.id);
    if (state.authTimer) {
      clearTimeout(state.authTimer);
      state.authTimer = null;
    }
    for (const channel of state.channels) {
      this.byChannel.get(channel)?.delete(state);
    }
    // 等队列里已入队的帧处理完，避免和未完成的 join 竞争
    await state.queue.catch((err: unknown) => {
      this.deps.logger.warn({ err, connectionId: conn.id }, "realtime frame queue rejected");
    });

    try {
      await this.deps.presence.leaveAll(conn.id);
    } catch (err) {
      this.deps.logger.warn({ err, connectionId: conn.id }, "realtime presence leaveAll failed");
    }
    for (const channel of state.presenceChannels) {
      try {
        await this.deps.publish({
          type: "presence.left",
          channel,
          connectionIds: [conn.id],
        });
      } catch (err) {
        // 广播失败只是晚一点收到离开事件（presence 有 TTL 兜底），连接照常清理
        this.deps.logger.warn({ err, channel }, "realtime presence.left publish failed");
      }
    }
  }

  /** 总线（本实例或其他实例发布）送来的事件，投给本地订阅者 */
  onBusMessage(payload: RealtimeBusPayload): void {
    const subscribers = this.byChannel.get(payload.channel);
    if (!subscribers) return;
    for (const state of subscribers) {
      switch (payload.type) {
        case "message": {
          const msg: ServerMessage = {
            type: "message",
            channel: payload.channel,
            event: payload.event,
            data: payload.data,
            ...(payload.senderUserId !== undefined ? { senderUserId: payload.senderUserId } : {}),
          };
          this.send(state, msg);
          break;
        }
        case "presence.joined": {
          this.send(state, {
            type: "presence.joined",
            channel: payload.channel,
            members: payload.members,
          });
          break;
        }
        case "presence.left": {
          this.send(state, {
            type: "presence.left",
            channel: payload.channel,
            connectionIds: payload.connectionIds,
          });
          break;
        }
      }
    }
  }

  /** 停止内部定时器（进程退出时调用）；连接由传输层负责关闭 */
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async processFrame(state: ConnState, raw: string): Promise<void> {
    if (Buffer.byteLength(raw, "utf8") > MAX_CLIENT_FRAME_BYTES) {
      this.sendError(state, REALTIME_ERROR_CODES.tooLarge);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.sendError(state, REALTIME_ERROR_CODES.badFrame);
      return;
    }
    const msg = clientMessageSchema.safeParse(parsed);
    if (!msg.success) {
      this.sendError(state, REALTIME_ERROR_CODES.badFrame);
      return;
    }

    switch (msg.data.type) {
      case "auth":
        await this.handleAuth(state, msg.data.token);
        break;
      case "subscribe":
        await this.handleSubscribe(state, msg.data.channel, msg.data.presence);
        break;
      case "unsubscribe":
        await this.handleUnsubscribe(state, msg.data.channel);
        break;
      case "publish":
        await this.handlePublish(state, msg.data.channel, msg.data.event, msg.data.data);
        break;
      case "presence.get":
        await this.handlePresenceGet(state, msg.data.channel, msg.data.requestId);
        break;
      case "ping":
        this.send(state, { type: "pong" });
        break;
    }
  }

  private async handleAuth(state: ConnState, token: string): Promise<void> {
    const user = await this.deps.authenticate(token);
    if (!user) {
      this.deps.logger.info({ connectionId: state.conn.id }, "realtime auth rejected");
      state.conn.close(WS_CLOSE_UNAUTHORIZED, "unauthorized");
      return;
    }
    state.userId = user.userId;
    if (state.authTimer) {
      clearTimeout(state.authTimer);
      state.authTimer = null;
    }
    this.deps.logger.debug({ connectionId: state.conn.id, userId: user.userId }, "realtime auth ok");
    this.send(state, { type: "auth.ok", userId: user.userId });
  }

  private async handleSubscribe(
    state: ConnState,
    channel: string,
    presenceState: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (state.userId === null) {
      this.sendError(state, REALTIME_ERROR_CODES.unauthorized);
      return;
    }
    // 频道授权门先于任何订阅副作用：拒绝时订阅表与 presence 都不碰
    if (this.deps.authorize !== undefined && !this.deps.authorize(channel, state.userId)) {
      this.deps.logger.info(
        { connectionId: state.conn.id, userId: state.userId, channel },
        "realtime subscribe denied",
      );
      this.sendError(state, REALTIME_ERROR_CODES.unauthorized);
      return;
    }
    const isPresence = isPresenceChannel(channel);
    if (presenceState !== undefined && !isPresence) {
      this.sendError(state, REALTIME_ERROR_CODES.invalidChannel);
      return;
    }

    if (isPresence) {
      const member = {
        connectionId: state.conn.id,
        channelId: channel,
        instanceId: this.deps.instanceId,
        userId: state.userId,
        state: presenceState ?? {},
      };
      try {
        await this.deps.presence.join(member);
      } catch (err) {
        this.deps.logger.warn({ err, channel }, "realtime presence join failed");
        this.sendError(state, REALTIME_ERROR_CODES.publishFailed);
        return;
      }
    }

    state.channels.add(channel);
    if (isPresence) state.presenceChannels.add(channel);
    this.byChannelFor(channel).add(state);

    this.send(state, { type: "subscribed", channel });
    if (isPresence) {
      // 先给新订阅者完整名单（以数据库为准），再广播加入事件给所有人
      const members = await this.deps.presence.list(channel).catch(() => []);
      this.send(state, { type: "presence.state", channel, members });
      await this.deps.publish({
        type: "presence.joined",
        channel,
        members: [
          {
            connectionId: state.conn.id,
            userId: state.userId,
            state: presenceState ?? {},
          },
        ],
      }).catch((err: unknown) => {
        this.deps.logger.warn({ err, channel }, "realtime presence.joined publish failed");
      });
    }
  }

  private async handleUnsubscribe(state: ConnState, channel: string): Promise<void> {
    const wasPresence = state.presenceChannels.has(channel);
    state.channels.delete(channel);
    state.presenceChannels.delete(channel);
    this.byChannel.get(channel)?.delete(state);

    if (wasPresence) {
      try {
        await this.deps.presence.leave(state.conn.id, channel);
        await this.deps.publish({ type: "presence.left", channel, connectionIds: [state.conn.id] });
      } catch (err) {
        this.deps.logger.warn({ err, channel }, "realtime presence leave failed");
      }
    }
    this.send(state, { type: "unsubscribed", channel });
  }

  private async handlePublish(
    state: ConnState,
    channel: string,
    event: string,
    data: unknown,
  ): Promise<void> {
    if (state.userId === null) {
      this.sendError(state, REALTIME_ERROR_CODES.unauthorized);
      return;
    }
    if (!state.channels.has(channel)) {
      this.sendError(state, REALTIME_ERROR_CODES.notSubscribed);
      return;
    }
    try {
      await this.deps.publish({
        type: "message",
        channel,
        event,
        data,
        senderUserId: state.userId,
      });
    } catch (err) {
      if (err instanceof MessageTooLargeError) {
        this.sendError(state, REALTIME_ERROR_CODES.tooLarge);
      } else {
        this.deps.logger.warn({ err, channel, event }, "realtime publish failed");
        this.sendError(state, REALTIME_ERROR_CODES.publishFailed);
      }
    }
  }

  private async handlePresenceGet(
    state: ConnState,
    channel: string,
    requestId: string | undefined,
  ): Promise<void> {
    if (state.userId === null) {
      this.sendError(state, REALTIME_ERROR_CODES.unauthorized);
      return;
    }
    if (!state.channels.has(channel)) {
      this.sendError(state, REALTIME_ERROR_CODES.notSubscribed);
      return;
    }
    const members = await this.deps.presence.list(channel).catch(() => []);
    this.send(state, {
      type: "presence.state",
      channel,
      ...(requestId !== undefined ? { requestId } : {}),
      members,
    });
  }

  private startHeartbeat(): void {
    const interval = this.deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    const cleanupEvery = this.deps.cleanupEveryTicks ?? DEFAULT_CLEANUP_EVERY_TICKS;
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeatTick(cleanupEvery);
    }, interval);
  }

  private async heartbeatTick(cleanupEvery: number): Promise<void> {
    // 刷新本实例所有 presence 连接的 last_seen_at；周期性清理崩溃实例留下的残留
    const ids = [...this.byConn.values()]
      .filter((state) => state.presenceChannels.size > 0)
      .map((state) => state.conn.id);
    try {
      if (ids.length > 0) await this.deps.presence.heartbeat(ids);
      this.ticks += 1;
      if (this.ticks % cleanupEvery === 0) await this.deps.presence.cleanup();
    } catch (err) {
      this.deps.logger.warn({ err }, "realtime presence heartbeat failed");
    }
  }

  private byChannelFor(channel: string): Set<ConnState> {
    let set = this.byChannel.get(channel);
    if (!set) {
      set = new Set();
      this.byChannel.set(channel, set);
    }
    return set;
  }

  private send(state: ConnState, message: ServerMessage): void {
    try {
      state.conn.send(JSON.stringify(message));
    } catch (err) {
      // 发送失败说明连接已坏，传输层会触发 disconnect，这里只记日志
      this.deps.logger.debug({ err, connectionId: state.conn.id }, "realtime send failed");
    }
  }

  private sendError(state: ConnState, code: string): void {
    this.send(state, { type: "error", code });
  }
}
