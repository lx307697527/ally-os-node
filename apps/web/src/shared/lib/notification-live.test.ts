// The live channel's contract (#110 slice 2): one socket per channel object,
// subscribed to the signed-in user's private channel; the notifications.changed
// nudge and the reconnect resync both fire the registered callbacks; anything
// else on the wire changes nothing. Token reads fail soft (null → the client
// retries), and close() is final.
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATIONS_CHANGED_EVENT, userChannel } from "@ally/realtime";
import type { RealtimeWebSocket } from "@ally/realtime-client";
import { createNotificationLiveChannel, realtimeUrl } from "./notification-live.ts";

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

  openConn(): void {
    this.emit("open", { data: null });
  }

  drop(): void {
    this.emit("close", { data: null, code: 1006 });
  }

  serverSend(frame: unknown): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  frames(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  private emit(type: string, ev: FakeEvent): void {
    for (const cb of this.listeners.get(type) ?? []) {
      (cb as (ev: FakeEvent) => void)(ev);
    }
  }
}

const USER = "8f3a0000-0000-4000-8000-000000000001";

/** 测试里替代非空断言：拿不到就直接失败 */
function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("unexpected missing value in test");
  return value;
}

function stubFetch(stub: { ok: boolean; body: unknown }): typeof fetch {
  return (): Promise<Response> => {
    const body = stub.ok ? JSON.stringify(stub.body) : "nope";
    return Promise.resolve(new Response(body, { status: stub.ok ? 200 : 500 }));
  };
}

function makeLive(opts?: { token?: string | null; tokenOk?: boolean }) {
  FakeWebSocket.made = [];
  const pings: number[] = [];
  const live = createNotificationLiveChannel({
    userId: USER,
    url: "ws://api.test/api/realtime",
    fetchFn: stubFetch({ ok: opts?.tokenOk ?? true, body: { token: opts?.token ?? "tok" } }),
    webSocket: () => new FakeWebSocket(),
    reconnectBaseDelayMs: 1,
    reconnectMaxDelayMs: 5,
  });
  const unsubscribe = live.subscribe(() => {
    pings.push(pings.length + 1);
  });
  return { live, pings, unsubscribe };
}

afterEach(() => {
  FakeWebSocket.made = [];
});

describe("notification live channel (#110 slice 2)", () => {
  it("subscribes to the user's private channel with the fetched session token", async () => {
    makeLive({ token: "sess-tok" });
    const ws = must(FakeWebSocket.made[0]);
    ws.openConn();
    // auth 帧带上端点取回的令牌（token 读走 fetch，等微任务链走完）
    await vi.waitFor(() => {
      expect(ws.frames().some((f) => f.type === "auth" && f.token === "sess-tok")).toBe(true);
    });
    // auth.ok 之后客户端自动重放订阅
    ws.serverSend({ type: "auth.ok", userId: USER });
    await vi.waitFor(() => {
      expect(
        ws.frames().some((f) => f.type === "subscribe" && f.channel === userChannel(USER)),
      ).toBe(true);
    });
  });

  it("fires the callbacks on notifications.changed — and on nothing else", () => {
    const { pings } = makeLive();
    const ws = must(FakeWebSocket.made[0]);
    ws.openConn();
    ws.serverSend({ type: "auth.ok", userId: USER });
    expect(pings).toEqual([]);

    ws.serverSend({
      type: "message",
      channel: userChannel(USER),
      event: NOTIFICATIONS_CHANGED_EVENT,
      data: {},
    });
    expect(pings).toHaveLength(1);

    // 别人的频道 / 别的事件都不是催
    ws.serverSend({
      type: "message",
      channel: userChannel("someone-else"),
      event: NOTIFICATIONS_CHANGED_EVENT,
      data: {},
    });
    ws.serverSend({ type: "message", channel: userChannel(USER), event: "something.else", data: {} });
    expect(pings).toHaveLength(1);
  });

  it("resync after a real reconnect is a nudge — the gap is unknown", async () => {
    const { pings } = makeLive();
    const first = must(FakeWebSocket.made[0]);
    first.openConn();
    first.serverSend({ type: "auth.ok", userId: USER });
    // 初次连接的 resync（attempts=0）不是催：挂载读刚发生过
    expect(pings).toEqual([]);

    // 断线 → 指数退避重连（测试把节奏调到毫秒级）→ 新 socket 重新 auth
    first.drop();
    await vi.waitFor(() => {
      expect(FakeWebSocket.made.length).toBeGreaterThan(1);
    });
    const second = must(FakeWebSocket.made[1]);
    second.openConn();
    second.serverSend({ type: "auth.ok", userId: USER });
    await vi.waitFor(() => {
      expect(pings).toHaveLength(1);
    });
    // 重连后订阅被自动恢复
    expect(
      second.frames().some((f) => f.type === "subscribe" && f.channel === userChannel(USER)),
    ).toBe(true);
  });

  it("a failed token read is soft: the client errors, the channel stays alive for the retry", async () => {
    const { pings } = makeLive({ tokenOk: false });
    const ws = must(FakeWebSocket.made[0]);
    ws.openConn();
    // getToken 拿到 null → 客户端自己关连接走重连，回调从未被误触
    await vi.waitFor(() => {
      expect(ws.closed).toHaveLength(1);
    });
    expect(pings).toEqual([]);
    expect(ws.frames().every((f) => f.type !== "auth")).toBe(true);
  });

  it("subscribe returns its unsubscribe; close() is the end of the channel", () => {
    const { live, pings, unsubscribe } = makeLive();
    const ws = must(FakeWebSocket.made[0]);
    ws.openConn();
    ws.serverSend({ type: "auth.ok", userId: USER });
    unsubscribe();
    ws.serverSend({
      type: "message",
      channel: userChannel(USER),
      event: NOTIFICATIONS_CHANGED_EVENT,
      data: {},
    });
    expect(pings).toEqual([]);

    live.close();
    // close 后客户端不再重连（userClosed），工装里没有新连接
    expect(FakeWebSocket.made).toHaveLength(1);
  });

  it("realtimeUrl derives the same-origin WS address", () => {
    expect(realtimeUrl()).toContain("/api/realtime");
  });
});
