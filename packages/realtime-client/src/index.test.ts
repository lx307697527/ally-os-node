import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeClient, type RealtimeWebSocket } from "./index.ts";

interface FakeEvent { data: unknown; code?: number | undefined; reason?: string | undefined }
type Listener = (ev: never) => void;

class FakeWebSocket implements RealtimeWebSocket {
  static made: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readonly closed: { code: number | undefined; reason: string | undefined }[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor() {
    FakeWebSocket.made.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
  }

  addEventListener(type: "open" | "message" | "close" | "error", cb: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  // ---- 测试辅助（模拟服务端与网络）----
  openConn(): void {
    this.emit("open", { data: null });
  }

  serverSend(frame: unknown): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  drop(): void {
    this.emit("close", { data: null, code: 1006 });
  }

  frames(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  lastFrame(): Record<string, unknown> {
    const raw = this.sent[this.sent.length - 1];
    return JSON.parse(raw ?? "{}") as Record<string, unknown>;
  }

  private emit(type: string, ev: FakeEvent): void {
    for (const cb of this.listeners.get(type) ?? []) {
      (cb as (ev: FakeEvent) => void)(ev);
    }
  }
}

function makeFactory(): (url: string) => RealtimeWebSocket {
  FakeWebSocket.made = [];
  return () => new FakeWebSocket();
}

/** 测试里替代非空断言：拿不到就直接失败 */
function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("unexpected missing value in test");
  return value;
}

function makeClient(factory: (url: string) => RealtimeWebSocket, token: string): RealtimeClient {
  return new RealtimeClient({
    url: "ws://api.test/api/realtime",
    getToken: () => Promise.resolve(token),
    webSocket: factory,
    reconnectBaseDelayMs: 10,
    reconnectMaxDelayMs: 50,
    heartbeatIntervalMs: 1_000_000, // 默认不参与心跳，除非测试显式调小
  });
}

/** 鉴权是异步的（每次尝试重新取令牌）：等 auth 帧真正发出 */
async function waitAuthFrame(ws: FakeWebSocket): Promise<void> {
  await vi.waitFor(() => {
    expect(ws.lastFrame().type).toBe("auth");
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RealtimeClient", () => {
  it("authenticates, subscribes, and keeps a presence roster", async () => {
    const client = makeClient(makeFactory(), "tok-1");
    client.subscribe("notes:1");
    client.subscribe("presence:doc", { cursor: 2 });
    const events: string[] = [];
    client.on("status", (s) => {
      events.push(s);
    });

    client.connect();
    const ws = must(FakeWebSocket.made[0]);
    ws.openConn();
    await waitAuthFrame(ws);
    expect(ws.lastFrame()).toEqual({ type: "auth", token: "tok-1" });

    ws.serverSend({ type: "auth.ok", userId: "u1" });
    const frames = ws.frames();
    expect(frames).toContainEqual({ type: "subscribe", channel: "notes:1" });
    expect(frames).toContainEqual({
      type: "subscribe",
      channel: "presence:doc",
      presence: { cursor: 2 },
    });
    expect(events).toContain("open");

    ws.serverSend({
      type: "presence.state",
      channel: "presence:doc",
      members: [
        { connectionId: "c1", userId: "u1", state: { cursor: 0 } },
        { connectionId: "c2", userId: "u2", state: {} },
      ],
    });
    expect(client.getPresenceSnapshot("presence:doc")).toHaveLength(2);

    ws.serverSend({
      type: "presence.joined",
      channel: "presence:doc",
      members: [{ connectionId: "c3", userId: "u3", state: {} }],
    });
    ws.serverSend({
      type: "presence.left",
      channel: "presence:doc",
      connectionIds: ["c1"],
    });
    const roster = client.getPresenceSnapshot("presence:doc");
    expect(roster.map((m) => m.connectionId).sort()).toEqual(["c2", "c3"]);

    // 消息事件带发送者
    const got: Record<string, unknown>[] = [];
    client.on("message", (m) => {
      got.push({ ...m });
    });
    ws.serverSend({
      type: "message",
      channel: "notes:1",
      event: "created",
      data: { id: 7 },
      senderUserId: "u2",
    });
    expect(got[0]).toEqual({
      channel: "notes:1",
      event: "created",
      data: { id: 7 },
      senderUserId: "u2",
    });

    client.close();
  });

  it("reconnects after a drop, replays auth + subscriptions, and emits resync", async () => {
    const client = makeClient(makeFactory(), "tok-1");
    let resyncs = 0;
    client.on("resync", () => {
      resyncs += 1;
    });
    client.subscribe("notes:1");
    client.connect();

    const first = must(FakeWebSocket.made[0]);
    first.openConn();
    await waitAuthFrame(first);
    first.serverSend({ type: "auth.ok", userId: "u1" });
    expect(resyncs).toBe(1);

    first.drop();
    expect(client.getPresenceSnapshot("notes:1")).toEqual([]); // 未订阅 presence，无缓存
    await vi.advanceTimersByTimeAsync(200);

    const second = must(FakeWebSocket.made[1]);
    second.openConn();
    await waitAuthFrame(second);
    expect(second.lastFrame()).toEqual({ type: "auth", token: "tok-1" });
    second.serverSend({ type: "auth.ok", userId: "u1" });

    const frames = second.frames();
    expect(frames).toContainEqual({ type: "subscribe", channel: "notes:1" });
    expect(resyncs).toBe(2);

    client.close();
  });

  it("retries when no token is available and succeeds once a token shows up", async () => {
    let token: string | null = null;
    const client = new RealtimeClient({
      url: "ws://api.test/api/realtime",
      getToken: () => Promise.resolve(token),
      webSocket: makeFactory(),
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 50,
    });
    const errors: (string | undefined)[] = [];
    client.on("error", (e) => {
      errors.push(e.code);
    });

    client.connect();
    let ws = must(FakeWebSocket.made[0]);
    ws.openConn();
    await vi.waitFor(() => {
      expect(errors).toContain("no_token");
    });
    expect(ws.closed.length).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(200);
    token = "late-token";
    ws = must(FakeWebSocket.made[FakeWebSocket.made.length - 1]);
    ws.openConn();
    await waitAuthFrame(ws);
    expect(ws.lastFrame()).toEqual({ type: "auth", token: "late-token" });

    client.close();
  });

  it("does not reconnect after close()", async () => {
    const client = makeClient(makeFactory(), "tok-1");
    client.connect();
    const ws = must(FakeWebSocket.made[0]);
    ws.openConn();
    ws.serverSend({ type: "auth.ok", userId: "u1" });

    client.close();
    ws.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.made).toHaveLength(1);
  });

  it("pings while open and force-closes dead connections", async () => {
    const client = new RealtimeClient({
      url: "ws://api.test/api/realtime",
      getToken: () => Promise.resolve("tok"),
      webSocket: makeFactory(),
      heartbeatIntervalMs: 10,
    });
    client.connect();
    const ws = must(FakeWebSocket.made[0]);
    ws.openConn();
    await waitAuthFrame(ws);
    ws.serverSend({ type: "auth.ok", userId: "u1" });
    ws.sent.length = 0;

    await vi.advanceTimersByTimeAsync(10);
    expect(ws.frames()).toContainEqual({ type: "ping" });

    // 两个周期没有任何消息（服务端没回 pong）→ 主动断开走重连
    await vi.advanceTimersByTimeAsync(21);
    expect(ws.closed[ws.closed.length - 1]?.code).toBe(4000);

    client.close();
  });

  it("publishes only when open and rejects presence requests on drop", async () => {
    const client = makeClient(makeFactory(), "tok-1");
    expect(() => { client.publish("notes:1", "x", {}); }).toThrow(/not connected/);

    client.connect();
    const ws = must(FakeWebSocket.made[0]);
    ws.openConn();
    await waitAuthFrame(ws);
    ws.serverSend({ type: "auth.ok", userId: "u1" });
    client.publish("notes:1", "created", { id: 1 });
    expect(ws.frames()).toContainEqual({ type: "publish", channel: "notes:1", event: "created", data: { id: 1 } });

    const pending = client.requestPresence("presence:doc");
    ws.drop();
    await expect(pending).rejects.toThrow(/connection lost/);

    client.close();
  });

  it("correlates requestPresence replies by requestId", async () => {
    const client = makeClient(makeFactory(), "tok-1");
    client.connect();
    const ws = must(FakeWebSocket.made[0]);
    ws.openConn();
    await waitAuthFrame(ws);
    ws.serverSend({ type: "auth.ok", userId: "u1" });

    const pending = client.requestPresence("presence:room");
    const frame = ws.lastFrame();
    expect(frame.type).toBe("presence.get");
    const requestId = String(frame.requestId);
    expect(requestId).not.toBe("");

    ws.serverSend({ type: "presence.state", channel: "presence:room", requestId, members: [
      { connectionId: "c1", userId: "u1", state: {} },
    ] });
    await expect(pending).resolves.toEqual([{ connectionId: "c1", userId: "u1", state: {} }]);

    client.close();
  });

  it("stops resubscribing removed channels", async () => {
    const client = makeClient(makeFactory(), "tok-1");
    client.subscribe("notes:1");
    client.subscribe("notes:2");
    client.connect();
    const ws = must(FakeWebSocket.made[0]);
    ws.openConn();
    await waitAuthFrame(ws);
    ws.serverSend({ type: "auth.ok", userId: "u1" });
    expect(ws.frames().filter((f) => f.type === "subscribe")).toHaveLength(2);

    client.unsubscribe("notes:1");
    ws.drop();
    await vi.advanceTimersByTimeAsync(200);

    const second = must(FakeWebSocket.made[1]);
    second.openConn();
    second.serverSend({ type: "auth.ok", userId: "u1" });
    const subs = second.frames().filter((f) => f.type === "subscribe");
    expect(subs).toEqual([{ type: "subscribe", channel: "notes:2" }]);

    client.close();
  });
});
