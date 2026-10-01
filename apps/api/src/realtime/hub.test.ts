import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MessageTooLargeError,
  type RealtimeBusPayload,
  type RealtimePresenceMember,
} from "@ally/realtime";
import { RealtimeHub, type RealtimeConnection, type RealtimePresenceStoreLike } from "./hub.ts";

const logger = pino({ level: "silent" });

interface FakeConn extends RealtimeConnection {
  sent: string[];
  closed: { code: number; reason: string }[];
}

function makeConn(id: string): FakeConn {
  const sent: string[] = [];
  const closed: { code: number; reason: string }[] = [];
  return {
    id,
    sent,
    closed,
    send: (text) => {
      sent.push(text);
    },
    close: (code, reason) => {
      closed.push({ code, reason });
    },
  };
}

function makePresenceStore(): RealtimePresenceStoreLike & {
  joins: { connectionId: string; channelId: string; userId: string; state: Record<string, unknown> }[];
  leaves: string[];
  leaveAlls: string[];
  heartbeats: string[][];
  cleanups: number;
  listResult: RealtimePresenceMember[];
} {
  const store = {
    joins: [] as { connectionId: string; channelId: string; userId: string; state: Record<string, unknown> }[],
    leaves: [] as string[],
    leaveAlls: [] as string[],
    heartbeats: [] as string[][],
    cleanups: 0,
    listResult: [] as RealtimePresenceMember[],
    join(member: {
      connectionId: string;
      channelId: string;
      instanceId: string;
      userId: string;
      state: Record<string, unknown>;
    }): Promise<void> {
      store.joins.push(member);
      return Promise.resolve();
    },
    leave(connectionId: string): Promise<void> {
      store.leaves.push(connectionId);
      return Promise.resolve();
    },
    leaveAll(connectionId: string): Promise<void> {
      store.leaveAlls.push(connectionId);
      return Promise.resolve();
    },
    list(): Promise<RealtimePresenceMember[]> {
      return Promise.resolve(store.listResult);
    },
    heartbeat(connectionIds: string[]): Promise<void> {
      store.heartbeats.push(connectionIds);
      return Promise.resolve();
    },
    cleanup(): Promise<void> {
      store.cleanups += 1;
      return Promise.resolve();
    },
  };
  return store;
}

function makeHub(overrides?: {
  authenticate?: (token: string) => Promise<{ userId: string } | null>;
  presence?: RealtimePresenceStoreLike;
  publish?: (payload: RealtimeBusPayload) => Promise<void>;
  authTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  cleanupEveryTicks?: number;
}) {
  const published: RealtimeBusPayload[] = [];
  const hub = new RealtimeHub({
    logger,
    instanceId: "instance-a",
    publish:
      overrides?.publish ??
      ((payload) => {
        published.push(payload);
        return Promise.resolve();
      }),
    presence: overrides?.presence ?? makePresenceStore(),
    authenticate:
      overrides?.authenticate ??
      ((token) => Promise.resolve(token === "good" ? { userId: `user-${token}` } : null)),
    ...(overrides?.authTimeoutMs !== undefined ? { authTimeoutMs: overrides.authTimeoutMs } : {}),
    ...(overrides?.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: overrides.heartbeatIntervalMs }
      : {}),
    ...(overrides?.cleanupEveryTicks !== undefined
      ? { cleanupEveryTicks: overrides.cleanupEveryTicks }
      : {}),
  });
  return { hub, published };
}

function framesOf(conn: FakeConn): Record<string, unknown>[] {
  return conn.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

/** 测试里替代非空断言：拿不到就直接失败 */
function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("unexpected missing value in test");
  return value;
}

function lastSent(conn: FakeConn): Record<string, unknown> {
  const raw = conn.sent[conn.sent.length - 1];
  return JSON.parse(raw ?? "{}") as Record<string, unknown>;
}

async function authAndSubscribe(
  hub: RealtimeHub,
  conn: FakeConn,
  channel: string,
  presence?: Record<string, unknown>,
): Promise<void> {
  // 按"该频道的 subscribed 帧数量增加"等待，历史帧里可能已有旧的 subscribed
  const subscribedCount = () =>
    framesOf(conn).filter((f) => f.type === "subscribed" && f.channel === channel).length;

  hub.handleFrame(conn, JSON.stringify({ type: "auth", token: "good" }));
  await vi.waitFor(() => {
    expect(framesOf(conn).some((f) => f.type === "auth.ok")).toBe(true);
  });
  const before = subscribedCount();
  hub.handleFrame(
    conn,
    JSON.stringify(
      presence === undefined ? { type: "subscribe", channel } : { type: "subscribe", channel, presence },
    ),
  );
  await vi.waitFor(() => {
    expect(subscribedCount()).toBeGreaterThan(before);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RealtimeHub auth", () => {
  it("closes the connection with 4401 when auth does not arrive in time", async () => {
    const { hub } = makeHub({ authTimeoutMs: 1_000 });
    const conn = makeConn("c1");
    hub.connect(conn);

    await vi.advanceTimersByTimeAsync(1_001);
    expect(conn.closed).toEqual([{ code: 4401, reason: "auth timeout" }]);
  });

  it("rejects a bad token with 4401", async () => {
    const { hub } = makeHub({ authTimeoutMs: 1_000 });
    const conn = makeConn("c1");
    hub.connect(conn);
    hub.handleFrame(conn, JSON.stringify({ type: "auth", token: "bad" }));

    await vi.waitFor(() => {
      expect(conn.closed).toEqual([{ code: 4401, reason: "unauthorized" }]);
    });
  });

  it("sends auth.ok on success and stops the timeout", async () => {
    const { hub } = makeHub({ authTimeoutMs: 1_000 });
    const conn = makeConn("c1");
    hub.connect(conn);
    hub.handleFrame(conn, JSON.stringify({ type: "auth", token: "good" }));

    await vi.waitFor(() => {
      expect(lastSent(conn)).toMatchObject({ type: "auth.ok", userId: "user-good" });
    });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(conn.closed).toHaveLength(0);
  });
});

describe("RealtimeHub frames", () => {
  it("replies bad_frame to malformed json and unknown shapes", async () => {
    const { hub } = makeHub();
    const conn = makeConn("c1");
    hub.connect(conn);
    hub.handleFrame(conn, "not json");
    await vi.waitFor(() => { expect(lastSent(conn).code).toBe("bad_frame"); });

    hub.handleFrame(conn, JSON.stringify({ type: "nope" }));
    await vi.waitFor(() => {
      const lastTwo = conn.sent.slice(-1);
      expect(JSON.parse(lastTwo[0] ?? "{}")).toMatchObject({ type: "error", code: "bad_frame" });
    });
  });

  it("requires auth before subscribe", async () => {
    const { hub } = makeHub();
    const conn = makeConn("c1");
    hub.connect(conn);
    hub.handleFrame(conn, JSON.stringify({ type: "subscribe", channel: "notes:1" }));

    await vi.waitFor(() => { expect(lastSent(conn).code).toBe("unauthorized"); });
  });

  it("echoes pong for ping", async () => {
    const { hub } = makeHub();
    const conn = makeConn("c1");
    hub.connect(conn);
    hub.handleFrame(conn, JSON.stringify({ type: "ping" }));

    await vi.waitFor(() => { expect(lastSent(conn).type).toBe("pong"); });
  });
});

describe("RealtimeHub subscribe/publish", () => {
  it("subscribes, publishes with sender attribution, and delivers via onBusMessage", async () => {
    const { hub, published } = makeHub();
    const alice = makeConn("a");
    const bob = makeConn("b");
    hub.connect(alice);
    hub.connect(bob);
    await authAndSubscribe(hub, alice, "notes:42");
    await authAndSubscribe(hub, bob, "notes:42");

    hub.handleFrame(alice, JSON.stringify({ type: "publish", channel: "notes:42", event: "created", data: { id: 7 } }));
    await vi.waitFor(() => { expect(published).toHaveLength(1); });

    expect(published[0]).toMatchObject({
      type: "message",
      channel: "notes:42",
      event: "created",
      data: { id: 7 },
      senderUserId: "user-good",
    });

    hub.onBusMessage(must(published[0]));
    for (const conn of [alice, bob]) {
      await vi.waitFor(() => {
        expect(lastSent(conn)).toMatchObject({
          type: "message",
          channel: "notes:42",
          event: "created",
          senderUserId: "user-good",
        });
      });
    }
  });

  it("rejects publish to a channel the connection is not subscribed to", async () => {
    const { hub, published } = makeHub();
    const conn = makeConn("a");
    hub.connect(conn);
    await authAndSubscribe(hub, conn, "notes:1");

    hub.handleFrame(conn, JSON.stringify({ type: "publish", channel: "notes:other", event: "x", data: null }));
    await vi.waitFor(() => { expect(lastSent(conn).code).toBe("not_subscribed"); });
    expect(published).toHaveLength(0);
  });

  it("maps MessageTooLargeError to too_large and other failures to publish_failed", async () => {
    const tooLarge = makeHub({
      publish: () => Promise.reject(new MessageTooLargeError(9999)),
    });
    const failed = makeHub({
      publish: () => Promise.reject(new Error("db down")),
    });

    const expectedCode = (hub: RealtimeHub): "too_large" | "publish_failed" =>
      hub === tooLarge.hub ? "too_large" : "publish_failed";

    for (const { hub } of [tooLarge, failed]) {
      const conn = makeConn("a");
      hub.connect(conn);
      await authAndSubscribe(hub, conn, "notes:1");
      hub.handleFrame(conn, JSON.stringify({ type: "publish", channel: "notes:1", event: "x", data: null }));
      await vi.waitFor(() => {
        expect(lastSent(conn).code).toBe(expectedCode(hub));
      });
    }
  });

  it("refuses presence payload on non-presence channels", async () => {
    const { hub } = makeHub();
    const conn = makeConn("a");
    hub.connect(conn);
    hub.handleFrame(conn, JSON.stringify({ type: "auth", token: "good" }));
    await vi.waitFor(() => { expect(lastSent(conn).type).toBe("auth.ok"); });

    hub.handleFrame(conn, JSON.stringify({ type: "subscribe", channel: "notes:1", presence: { x: 1 } }));
    await vi.waitFor(() => { expect(lastSent(conn).code).toBe("invalid_channel"); });
  });
});

describe("RealtimeHub presence", () => {
  it("joins the store, sends the full roster, and broadcasts the join", async () => {
    const store = makePresenceStore();
    store.listResult = [{ connectionId: "a", userId: "user-good", state: {} }];
    const { hub, published } = makeHub({ presence: store });
    const conn = makeConn("a");
    hub.connect(conn);
    await authAndSubscribe(hub, conn, "presence:doc-1", { cursor: 3 });

    expect(store.joins).toEqual([
      {
        connectionId: "a",
        channelId: "presence:doc-1",
        instanceId: "instance-a",
        userId: "user-good",
        state: { cursor: 3 },
      },
    ]);
    const sent = conn.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
    expect(sent).toContainEqual({
      type: "subscribed",
      channel: "presence:doc-1",
    });
    expect(sent).toContainEqual({
      type: "presence.state",
      channel: "presence:doc-1",
      members: [{ connectionId: "a", userId: "user-good", state: {} }],
    });
    expect(published).toEqual([
      {
        type: "presence.joined",
        channel: "presence:doc-1",
        members: [{ connectionId: "a", userId: "user-good", state: { cursor: 3 } }],
      },
    ]);
  });

  it("answers presence.get with the roster and echoes requestId", async () => {
    const store = makePresenceStore();
    store.listResult = [{ connectionId: "x", userId: "u", state: { a: 1 } }];
    const { hub } = makeHub({ presence: store });
    const conn = makeConn("a");
    hub.connect(conn);
    await authAndSubscribe(hub, conn, "presence:room");

    hub.handleFrame(
      conn,
      JSON.stringify({ type: "presence.get", channel: "presence:room", requestId: "rq-9" }),
    );
    await vi.waitFor(() => {
      expect(lastSent(conn)).toEqual({
        type: "presence.state",
        channel: "presence:room",
        requestId: "rq-9",
        members: [{ connectionId: "x", userId: "u", state: { a: 1 } }],
      });
    });
  });

  it("cleans up presence and broadcasts leave on unsubscribe and disconnect", async () => {
    const store = makePresenceStore();
    const { hub, published } = makeHub({ presence: store });
    const conn = makeConn("a");
    hub.connect(conn);
    await authAndSubscribe(hub, conn, "presence:room");

    hub.handleFrame(conn, JSON.stringify({ type: "unsubscribe", channel: "presence:room" }));
    await vi.waitFor(() => { expect(lastSent(conn).type).toBe("unsubscribed"); });
    expect(store.leaves).toEqual(["a"]);
    expect(published.at(-1)).toMatchObject({ type: "presence.left", connectionIds: ["a"] });

    // 重新订阅后再断开：leaveAll + 每个频道一条 presence.left
    await authAndSubscribe(hub, conn, "presence:room");
    await hub.disconnect(conn);
    expect(store.leaveAlls).toEqual(["a"]);
    expect(published.at(-1)).toMatchObject({
      type: "presence.left",
      channel: "presence:room",
      connectionIds: ["a"],
    });

    // 断开后不再收到总线消息
    const sentBefore = conn.sent.length;
    hub.onBusMessage({ type: "message", channel: "presence:room", event: "x", data: null });
    expect(conn.sent).toHaveLength(sentBefore);
  });
});

describe("RealtimeHub heartbeat", () => {
  it("heartbeats connections with presence subscriptions and periodically cleans up", async () => {
    const store = makePresenceStore();
    const { hub } = makeHub({
      presence: store,
      authTimeoutMs: 60_000,
      heartbeatIntervalMs: 10,
      cleanupEveryTicks: 3,
    });
    const conn = makeConn("a");
    hub.connect(conn);
    // 不用 vi.waitFor：它会在假时钟下推进时间，把 10ms 的心跳 interval 也点着；
    // advanceTimersByTimeAsync(1) 只冲刷微任务队列，不动 interval
    hub.handleFrame(conn, JSON.stringify({ type: "auth", token: "good" }));
    await vi.advanceTimersByTimeAsync(1);
    hub.handleFrame(conn, JSON.stringify({ type: "subscribe", channel: "presence:room" }));
    await vi.advanceTimersByTimeAsync(1);

    await vi.advanceTimersByTimeAsync(10);
    expect(store.heartbeats).toEqual([["a"]]);
    expect(store.cleanups).toBe(0);

    await vi.advanceTimersByTimeAsync(20);
    expect(store.cleanups).toBe(1);

    // 没有 presence 订阅的连接不参与心跳
    const plain = makeConn("b");
    hub.connect(plain);
    hub.handleFrame(plain, JSON.stringify({ type: "auth", token: "good" }));
    await vi.advanceTimersByTimeAsync(1);
    hub.handleFrame(plain, JSON.stringify({ type: "subscribe", channel: "notes:1" }));
    await vi.advanceTimersByTimeAsync(1);
    store.heartbeats.length = 0;
    await vi.advanceTimersByTimeAsync(10);
    expect(store.heartbeats).toEqual([["a"]]);

    hub.stop();
  });
});
