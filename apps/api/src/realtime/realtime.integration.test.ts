import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pino from "pino";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { RealtimeBus, type RealtimeBusPayload } from "@ally/realtime";
import { RealtimeHub, type RealtimeConnection } from "./hub.ts";
import { createPresenceStore } from "./presence.ts";
import { attachRealtimeWs } from "./ws.ts";

// 集成测试：需要真实 PostgreSQL（两个"实例"共享一个库，走 LISTEN/NOTIFY 互通）。
// 未设 DATABASE_URL 时跳过。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 测试里替代非空断言：beforeAll 没跑成功就直接失败 */
function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("unexpected missing value in test");
  return value;
}

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

interface FakeConn extends RealtimeConnection {
  sent: string[];
  frames: Record<string, unknown>[];
  closed: { code: number; reason: string }[];
}

function makeConn(id: string): FakeConn {
  const conn: FakeConn = {
    id,
    sent: [],
    frames: [],
    closed: [],
    send: (text) => {
      conn.sent.push(text);
      conn.frames.push(JSON.parse(text) as Record<string, unknown>);
    },
    close: (code, reason) => {
      conn.closed.push({ code, reason });
    },
  };
  return conn;
}

const authenticator = (token: string) =>
  Promise.resolve(token === "good" ? { userId: `user-${token}` } : null);

/**
 * 一个"API 实例"：自己的连接池 + 总线 + hub + presence store。
 * hub 与 bus 互相引用（hub.publish → bus，bus.onMessage → hub），
 * 用一个先声明再赋值的函数引用解决循环创建。
 */
async function makeInstance(): Promise<{
  hub: RealtimeHub;
  bus: RealtimeBus;
  connectFake: () => FakeConn;
  db: ReturnType<typeof createDb>["db"];
  stop: () => Promise<void>;
}> {
  const { db, pool } = createDb(databaseUrl ?? "");
  const instanceId = randomUUID();
  // bus 创建前不会有人发布；万一发生直接失败暴露问题
  let publishToBus: (payload: RealtimeBusPayload) => Promise<void> = () =>
    Promise.reject(new Error("realtime bus is not wired yet"));
  const hub = new RealtimeHub({
    logger,
    instanceId,
    publish: (payload) => publishToBus(payload),
    presence: createPresenceStore(db),
    authenticate: authenticator,
  });
  const bus = new RealtimeBus({
    databaseUrl: databaseUrl ?? "",
    publishExecutor: pool,
    logger,
    instanceId,
    onMessage: (payload) => { hub.onBusMessage(payload); },
  });
  publishToBus = (payload) => bus.publish(payload);
  await bus.start();

  return {
    hub,
    bus,
    connectFake: () => {
      const conn = makeConn(randomUUID());
      hub.connect(conn);
      return conn;
    },
    db,
    stop: async () => {
      hub.stop();
      await bus.stop();
      await pool.end();
    },
  };
}

/** 授权 + 订阅，等 subscribed 回帧（按计数，兼容同连接重订阅） */
async function authAndSubscribe(
  conn: FakeConn,
  hub: RealtimeHub,
  channel: string,
  presence?: Record<string, unknown>,
): Promise<void> {
  hub.handleFrame(conn, JSON.stringify({ type: "auth", token: "good" }));
  await waitFor(() => conn.frames.some((f) => f.type === "auth.ok"), "auth.ok");
  const subscribedCount = () =>
    conn.frames.filter((f) => f.type === "subscribed" && f.channel === channel).length;
  const before = subscribedCount();
  hub.handleFrame(
    conn,
    JSON.stringify(
      presence === undefined ? { type: "subscribe", channel } : { type: "subscribe", channel, presence },
    ),
  );
  await waitFor(() => subscribedCount() > before, "subscribed");
}

describe.skipIf(!databaseUrl)("realtime (integration)", () => {
  let a: Awaited<ReturnType<typeof makeInstance>> | undefined;
  let b: Awaited<ReturnType<typeof makeInstance>> | undefined;

  beforeAll(async () => {
    const bootstrap = createDb(databaseUrl ?? "");
    // 与其他集成测试一致：测试自己把 migration 打上去（幂等）
    await runMigrations(bootstrap.db);
    await bootstrap.pool.end();
    a = await makeInstance();
    b = await makeInstance();
  });

  afterAll(async () => {
    await a?.stop();
    await b?.stop();
  });

  it("publish on instance A reaches subscribers on both instances, including the publisher", async () => {
    const A = must(a);
    const B = must(b);
    const connA = A.connectFake();
    const connB = B.connectFake();
    const channel = `notes:${randomUUID()}`;
    await authAndSubscribe(connA, A.hub, channel);
    await authAndSubscribe(connB, B.hub, channel);

    A.hub.handleFrame(
      connA,
      JSON.stringify({ type: "publish", channel, event: "created", data: { id: 42 } }),
    );

    await waitFor(
      () =>
        connB.frames.some((f) => f.type === "message" && f.channel === channel && f.event === "created"),
      "message on instance B",
    );
    await waitFor(
      () =>
        connA.frames.some((f) => f.type === "message" && f.channel === channel && f.event === "created"),
      "self echo on instance A",
    );

    const delivered = connB.frames.find((f) => f.type === "message");
    expect(delivered).toMatchObject({
      type: "message",
      channel,
      event: "created",
      data: { id: 42 },
      senderUserId: "user-good",
    });

    await A.hub.disconnect(connA);
    await B.hub.disconnect(connB);
  });

  it("presence joins are visible across instances and cleared on disconnect", async () => {
    const A = must(a);
    const B = must(b);
    const connA = A.connectFake();
    const connB = B.connectFake();
    const channel = `presence:room-${randomUUID()}`;
    // B 先订阅并在频道上等，才能收到 A 的加入事件（at-most-once：先订阅后收事件）
    await authAndSubscribe(connB, B.hub, channel);
    await authAndSubscribe(connA, A.hub, channel, { cursor: 5 });

    await waitFor(
      () => connB.frames.some((f) => f.type === "presence.joined" && f.channel === channel),
      "presence.joined on instance B",
    );
    // 两个实例都能从共享库里查到成员（B 自己 + A）
    const storeB = createPresenceStore(B.db);
    await waitFor(async () => (await storeB.list(channel)).length === 2, "both members visible on B");
    expect(await storeB.list(channel)).toEqual(
      expect.arrayContaining([
        { connectionId: connA.id, userId: "user-good", state: { cursor: 5 } },
        { connectionId: connB.id, userId: "user-good", state: {} },
      ]),
    );

    // A 断开：离开事件广播到 B，A 的行被删除，B 还在
    await A.hub.disconnect(connA);
    await waitFor(
      () => connB.frames.some((f) => f.type === "presence.left" && f.channel === channel),
      "presence.left on instance B",
    );
    await waitFor(async () => (await storeB.list(channel)).length === 1, "connA cleared");
    expect(await storeB.list(channel)).toEqual([
      { connectionId: connB.id, userId: "user-good", state: {} },
    ]);

    await B.hub.disconnect(connB);
    await waitFor(async () => (await storeB.list(channel)).length === 0, "all cleared");
  });

  it("presence store: heartbeat refreshes TTL, expired members disappear, cleanup removes them", async () => {
    const B = must(b);
    const store = createPresenceStore(B.db);
    const channel = `presence:ttl-${randomUUID()}`;
    await store.join({ connectionId: "conn-ttl", channelId: channel, instanceId: "i", userId: "u1", state: {} });
    expect(await store.list(channel)).toHaveLength(1);

    // 手动把 last_seen_at 拨到 TTL 之外 → 不再可见
    await B.db
      .update(schema.realtimePresence)
      .set({ lastSeenAt: new Date(Date.now() - 120_000) })
      .where(eq(schema.realtimePresence.connectionId, "conn-ttl"));
    expect(await store.list(channel)).toHaveLength(0);

    // 心跳续上 → 又可见
    await store.heartbeat(["conn-ttl"]);
    expect(await store.list(channel)).toHaveLength(1);

    // 清理只删远超 TTL 的残留
    await store.cleanup();
    expect(await store.list(channel)).toHaveLength(1);
    await B.db
      .update(schema.realtimePresence)
      .set({ lastSeenAt: new Date(Date.now() - 3600_000) })
      .where(eq(schema.realtimePresence.connectionId, "conn-ttl"));
    await store.cleanup();
    expect(await store.list(channel)).toHaveLength(0);
  });
});

// ---- 真 WebSocket 端到端：两个 http server 各挂一个 hub，客户端走完整协议 ----

function toUtf8(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

class WsTestClient {
  private readonly ws: WebSocket;
  readonly frames: Record<string, unknown>[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (data) => {
      this.frames.push(JSON.parse(toUtf8(data)) as Record<string, unknown>);
    });
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => { resolve(); });
      this.ws.once("error", (err) => { reject(err); });
    });
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  close(): void {
    this.ws.close();
  }
}

async function startRealInstance(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const { db, pool } = createDb(databaseUrl ?? "");
  const instanceId = randomUUID();
  // bus 创建前不会有人发布；万一发生直接失败暴露问题
  let publishToBus: (payload: RealtimeBusPayload) => Promise<void> = () =>
    Promise.reject(new Error("realtime bus is not wired yet"));
  const hub = new RealtimeHub({
    logger,
    instanceId,
    publish: (payload) => publishToBus(payload),
    presence: createPresenceStore(db),
    authenticate: authenticator,
  });
  const bus = new RealtimeBus({
    databaseUrl: databaseUrl ?? "",
    publishExecutor: pool,
    logger,
    instanceId,
    onMessage: (payload) => { hub.onBusMessage(payload); },
  });
  publishToBus = (payload) => bus.publish(payload);
  await bus.start();

  const server = createServer();
  const attached = attachRealtimeWs(server, { hub, logger, pingIntervalMs: 60_000 });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => { resolve(); });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    url: `ws://127.0.0.1:${String(port)}/api/realtime`,
    close: async () => {
      hub.stop();
      await bus.stop();
      await attached.close();
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
      await pool.end();
    },
  };
}

describe.skipIf(!databaseUrl)("realtime websocket end-to-end", () => {
  it("delivers a publish from a client on instance A to a client on instance B over real websockets", async () => {
    const instanceA = await startRealInstance();
    const instanceB = await startRealInstance();
    const clientA = new WsTestClient(instanceA.url);
    const clientB = new WsTestClient(instanceB.url);

    try {
      await clientA.open();
      await clientB.open();
      const channel = `e2e:${randomUUID()}`;

      for (const client of [clientA, clientB]) {
        client.send({ type: "auth", token: "good" });
      }
      await waitFor(() => clientA.frames.some((f) => f.type === "auth.ok"), "A auth.ok");
      await waitFor(() => clientB.frames.some((f) => f.type === "auth.ok"), "B auth.ok");

      clientA.send({ type: "subscribe", channel });
      clientB.send({ type: "subscribe", channel });
      await waitFor(
        () => clientA.frames.some((f) => f.type === "subscribed" && f.channel === channel),
        "A subscribed",
      );
      await waitFor(
        () => clientB.frames.some((f) => f.type === "subscribed" && f.channel === channel),
        "B subscribed",
      );

      clientA.send({ type: "publish", channel, event: "changed", data: { ok: true } });

      await waitFor(
        () => clientB.frames.some((f) => f.type === "message" && f.event === "changed"),
        "message delivered to B",
      );
      const delivered = clientB.frames.find((f) => f.type === "message");
      expect(delivered).toMatchObject({
        channel,
        event: "changed",
        data: { ok: true },
        senderUserId: "user-good",
      });

      // 未订阅的频道拒绝发布
      clientA.send({ type: "publish", channel: `nope:${randomUUID()}`, event: "x", data: null });
      await waitFor(() => clientA.frames.some((f) => f.type === "error"), "error frame");
      expect(clientA.frames.find((f) => f.type === "error")).toMatchObject({ code: "not_subscribed" });
    } finally {
      clientA.close();
      clientB.close();
      await instanceA.close();
      await instanceB.close();
    }
  });
});
