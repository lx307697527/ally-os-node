import type { RealtimePresenceMember } from "@ally/realtime";

/**
 * 实时推送的浏览器 / Node 客户端（#30）。零运行时依赖；
 * 服务端协议见 @ally/realtime 的 protocol.ts。
 *
 * - 连上后自动 auth（每次尝试都重新取令牌，令牌过期刷新后重连即可）
 * - 断线自动重连：指数退避 + 抖动；重连成功后自动重发全部订阅（含 presence 状态）
 *   并发出一次 "resync"，前端在此时重新拉取数据补齐断线期间漏掉的事件
 * - 心跳 ping 保活（对齐 ALB 300s 空闲超时），两个周期无任何消息视为死连接主动断开
 * - 本地维护 presence 名单缓存，事件驱动更新，也可随时 requestPresence 强刷
 *
 * 实时推送是 at-most-once：断线期间的事件不会补发，"resync 后重新拉取"是唯一可靠的同步方式。
 */

/** 与 WHATWG WebSocket 对齐的最小接口（Node ≥ 22 / 浏览器都原生满足；测试可注入假实现） */
export interface RealtimeWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "error", cb: () => void): void;
  addEventListener(type: "message", cb: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", cb: (ev: { code?: number | undefined }) => void): void;
}

export type RealtimeClientStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface RealtimeClientOptions {
  /** 服务端 WebSocket 地址，如 wss://api.example.com/api/realtime */
  url: string;
  /** 每次连接尝试时取一次令牌；返回 null 时不鉴权直接重试 */
  getToken: () => string | null | Promise<string | null>;
  /** 默认 new globalThis.WebSocket(url)；测试注入假实现 */
  webSocket?: ((url: string) => RealtimeWebSocket) | undefined;
  reconnectBaseDelayMs?: number | undefined;
  reconnectMaxDelayMs?: number | undefined;
  heartbeatIntervalMs?: number | undefined;
  /** requestPresence 的超时 */
  requestTimeoutMs?: number | undefined;
}

export interface RealtimeClientEvents {
  status: (status: RealtimeClientStatus) => void;
  message: (msg: {
    channel: string;
    event: string;
    data: unknown;
    senderUserId?: string | undefined;
  }) => void;
  "presence.state": (p: { channel: string; members: RealtimePresenceMember[] }) => void;
  "presence.joined": (p: { channel: string; members: RealtimePresenceMember[] }) => void;
  "presence.left": (p: { channel: string; connectionIds: string[] }) => void;
  /** 重连成功且订阅已恢复；attempts 是本次重连前失败的尝试次数。在这里重新拉取数据 */
  resync: (info: { attempts: number }) => void;
  error: (e: { code?: string | undefined }) => void;
}

type Handler = (arg: never) => void;

/** 服务端发的帧理论上都是 string 字段；兜底把 unknown 安全转成 string */
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 15_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

interface PendingPresence {
  resolve: (members: RealtimePresenceMember[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RealtimeClient {
  private readonly opts: Required<
    Pick<RealtimeClientOptions, "url" | "getToken"> & {
      reconnectBaseDelayMs: number;
      reconnectMaxDelayMs: number;
      heartbeatIntervalMs: number;
      requestTimeoutMs: number;
    }
  >;
  private readonly newSocket: (url: string) => RealtimeWebSocket;

  private ws: RealtimeWebSocket | null = null;
  private status: RealtimeClientStatus = "closed";
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivity = 0;
  private userClosed = false;
  private nextRequestId = 1;

  /** 等待鉴权确认；重连时每次都要重新走 auth */
  private authPending = false;
  private readonly subscriptions = new Map<string, Record<string, unknown> | undefined>();
  private readonly presenceRoster = new Map<string, Map<string, RealtimePresenceMember>>();
  private readonly pendingPresence = new Map<string, PendingPresence>();
  private readonly handlers = new Map<keyof RealtimeClientEvents, Set<Handler>>();

  constructor(opts: RealtimeClientOptions) {
    this.opts = {
      url: opts.url,
      getToken: opts.getToken,
      reconnectBaseDelayMs: opts.reconnectBaseDelayMs ?? DEFAULT_BASE_DELAY_MS,
      reconnectMaxDelayMs: opts.reconnectMaxDelayMs ?? DEFAULT_MAX_DELAY_MS,
      heartbeatIntervalMs: opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS,
      requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    };
    this.newSocket =
      opts.webSocket ??
      ((url) => {
        const ws = new WebSocket(url);
        return ws;
      });
  }

  /** 开始连接并永久保活（直到 close()）。重复调用无副作用 */
  connect(): void {
    if (this.userClosed || this.ws !== null) return;
    this.setStatus("connecting");
    this.open();
  }

  /** 永久关闭：不再重连，清掉全部定时器 */
  close(): void {
    this.userClosed = true;
    this.clearTimers();
    this.failPendingPresence(new Error("client closed"));
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.close(1000, "client closed");
    }
    this.setStatus("closed");
  }

  on<K extends keyof RealtimeClientEvents>(event: K, cb: RealtimeClientEvents[K]): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  subscribe(channel: string, presence?: Record<string, unknown>): void {
    this.subscriptions.set(channel, presence);
    if (this.status === "open") {
      this.sendSubscribe(channel, presence);
    }
  }

  unsubscribe(channel: string): void {
    this.subscriptions.delete(channel);
    this.presenceRoster.delete(channel);
    if (this.status === "open") {
      this.sendSafe({ type: "unsubscribe", channel });
    }
  }

  publish(channel: string, event: string, data: unknown): void {
    if (this.status !== "open") {
      throw new Error("realtime client is not connected; publish after the connection is open");
    }
    this.sendSafe({ type: "publish", channel, event, data });
  }

  /** 当前 presence 缓存（事件驱动维护，重连 resync 后可能短暂过期） */
  getPresenceSnapshot(channel: string): RealtimePresenceMember[] {
    return [...(this.presenceRoster.get(channel)?.values() ?? [])];
  }

  /** 向服务端要一次完整名单，Promise 按 requestId 关联，超时或断线时 reject */
  requestPresence(channel: string): Promise<RealtimePresenceMember[]> {
    const requestId = `rq-${String(this.nextRequestId++)}`;
    const promise = new Promise<RealtimePresenceMember[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPresence.delete(requestId);
        reject(new Error(`presence request ${requestId} timed out`));
      }, this.opts.requestTimeoutMs);
      this.pendingPresence.set(requestId, { resolve, reject, timer });
    });
    this.sendSafe({ type: "presence.get", channel, requestId });
    return promise;
  }

  private open(): void {
    const ws = this.newSocket(this.opts.url);
    this.ws = ws;
    this.authPending = false;

    ws.addEventListener("open", () => {
      void this.authenticate();
    });
    ws.addEventListener("message", (ev) => {
      this.lastActivity = Date.now();
      this.onFrame(ev.data);
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      this.failPendingPresence(new Error("connection lost"));
      if (this.userClosed) return;
      // 鉴权失败/超时也走同一条重连路径：下一次尝试会重新取令牌
      this.setStatus("reconnecting");
      this.scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      // close 事件紧随其后，统一在 close 里处理
    });
  }

  private async authenticate(): Promise<void> {
    if (this.authPending) return;
    this.authPending = true;
    const token = await this.opts.getToken();
    const ws = this.ws;
    if (!ws) return; // 连接在取令牌期间断了
    if (token === null) {
      this.authPending = false;
      this.emit("error", { code: "no_token" });
      ws.close(3000, "no token");
      return;
    }
    this.sendSafe({ type: "auth", token });
  }

  private scheduleReconnect(): void {
    const base = Math.min(
      this.opts.reconnectBaseDelayMs * 2 ** this.attempt,
      this.opts.reconnectMaxDelayMs,
    );
    const delay = base + Math.random() * Math.min(base, 1_000);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.userClosed) this.open();
    }, delay);
  }

  private onFrame(data: unknown): void {
    if (typeof data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const msg = parsed as Record<string, unknown>;
    switch (msg.type) {
      case "auth.ok": {
        const attempts = this.attempt;
        this.authPending = false;
        this.attempt = 0;
        this.setStatus("open");
        this.startHeartbeat();
        // 重连后恢复全部订阅（含 presence 状态），然后让业务层补数据
        for (const [channel, presence] of this.subscriptions) {
          this.sendSubscribe(channel, presence);
        }
        this.emit("resync", { attempts });
        break;
      }
      case "message": {
        this.emit("message", {
          channel: asString(msg.channel),
          event: asString(msg.event),
          data: msg.data,
          ...(typeof msg.senderUserId === "string" ? { senderUserId: msg.senderUserId } : {}),
        });
        break;
      }
      case "presence.state": {
        const channel = asString(msg.channel);
        const members = this.toMembers(msg.members);
        const roster = this.rosterFor(channel);
        roster.clear();
        for (const member of members) roster.set(member.connectionId, member);
        this.emit("presence.state", { channel, members });
        this.resolvePending(asString(msg.requestId), members);
        break;
      }
      case "presence.joined": {
        const channel = asString(msg.channel);
        const roster = this.rosterFor(channel);
        const members = this.toMembers(msg.members);
        for (const member of members) roster.set(member.connectionId, member);
        this.emit("presence.joined", { channel, members });
        break;
      }
      case "presence.left": {
        const channel = asString(msg.channel);
        const roster = this.rosterFor(channel);
        const ids = Array.isArray(msg.connectionIds) ? msg.connectionIds.filter((id): id is string => typeof id === "string") : [];
        for (const id of ids) roster.delete(id);
        this.emit("presence.left", { channel, connectionIds: ids });
        break;
      }
      case "error": {
        this.emit("error", {
          ...(typeof msg.code === "string" ? { code: msg.code } : {}),
        });
        break;
      }
      case "pong":
      case "subscribed":
      case "unsubscribed":
      case "auth":
      case "ping":
        break;
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.lastActivity = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastActivity > this.opts.heartbeatIntervalMs * 2) {
        // 半开连接：主动断开走重连
        this.ws?.close(4000, "heartbeat timeout");
        return;
      }
      this.sendSafe({ type: "ping" });
    }, this.opts.heartbeatIntervalMs);
  }

  private sendSubscribe(channel: string, presence: Record<string, unknown> | undefined): void {
    this.sendSafe(
      presence === undefined
        ? { type: "subscribe", channel }
        : { type: "subscribe", channel, presence },
    );
  }

  private sendSafe(frame: Record<string, unknown>): void {
    const ws = this.ws;
    // 不检查 status：auth 帧本身要在 "connecting" 阶段发出；连接断开时 ws 已置空
    if (!ws) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // 发送失败由 close 事件接管重连
    }
  }

  private resolvePending(requestId: string, members: RealtimePresenceMember[]): void {
    if (requestId === "") return;
    const pending = this.pendingPresence.get(requestId);
    if (!pending) return;
    this.pendingPresence.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(members);
  }

  private failPendingPresence(err: Error): void {
    for (const pending of this.pendingPresence.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingPresence.clear();
  }

  private rosterFor(channel: string): Map<string, RealtimePresenceMember> {
    let roster = this.presenceRoster.get(channel);
    if (!roster) {
      roster = new Map();
      this.presenceRoster.set(channel, roster);
    }
    return roster;
  }

  private toMembers(value: unknown): RealtimePresenceMember[] {
    if (!Array.isArray(value)) return [];
    const members: RealtimePresenceMember[] = [];
    for (const item of value) {
      if (typeof item !== "object" || item === null) continue;
      const m = item as Record<string, unknown>;
      if (typeof m.connectionId !== "string" || typeof m.userId !== "string") continue;
      members.push({
        connectionId: m.connectionId,
        userId: m.userId,
        state: typeof m.state === "object" && m.state !== null ? (m.state as Record<string, unknown>) : {},
      });
    }
    return members;
  }

  private setStatus(status: RealtimeClientStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit("status", status);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private emit<K extends keyof RealtimeClientEvents>(
    event: K,
    payload: Parameters<RealtimeClientEvents[K]>[0],
  ): void {
    for (const handler of this.handlers.get(event) ?? []) {
      // (arg: never) => void 对任何单参回调都可赋值（never 是底类型）
      (handler as (p: Parameters<RealtimeClientEvents[K]>[0]) => void)(payload);
    }
  }
}
