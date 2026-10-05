// The bell's live channel (#110 slice 2): one WebSocket per tab, subscribed to
// the signed-in user's private `user:<id>` channel. The server's push carries
// NO data — `notifications.changed` is a nudge, and the data truth is still
// the summary read (at-most-once delivery, docs/realtime.md). A reconnect's
// `resync` is the same nudge: the gap is unknown, so re-read.
//
// The 60s visible poll STAYS as the fallback (NotificationBell keeps it): a
// lost nudge, a dead socket, or a blocked upgrade must degrade to today's
// behavior, never to silence.
//
// Like every lib here, failures never throw: a failed token read is `null`
// (the client retries on its next connection attempt), and nothing here can
// reject into the bell's refresh path.
import { NOTIFICATIONS_CHANGED_EVENT, REALTIME_WS_PATH, userChannel } from "@ally/realtime";
import { RealtimeClient, type RealtimeWebSocket } from "@ally/realtime-client";
import { z } from "zod";

const tokenResponseSchema = z.object({ token: z.string().min(1) });

export interface NotificationLiveChannel {
  /** Register a change callback; returns its unsubscribe. */
  subscribe(onChange: () => void): () => void;
  /** Close the underlying connection for good (no more reconnects). */
  close(): void;
}

/** Same-origin WS address: the web tier proxies /api to the API in dev, and
 *  the load balancer routes it in production. */
export function realtimeUrl(): string {
  // globalThis.location 在 DOM lib 里非可空，但 Node 测试环境确实没有 ——
  // 用 typeof 收窄，不写可选链
  const loc: { protocol?: string; host?: string } | undefined = (
    globalThis as { location?: { protocol?: string; host?: string } }
  ).location;
  const protocol = loc?.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${loc?.host ?? ""}${REALTIME_WS_PATH}`;
}

/** The session token for the auth frame. The cookie is HttpOnly, so the SPA
 *  fetches its OWN token from /api/realtime/token; `null` = this attempt has
 *  no token and the client will try again on its next connection attempt. */
async function fetchSessionToken(fetchFn: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchFn("/api/realtime/token");
    if (!res.ok) return null;
    return tokenResponseSchema.parse(await res.json()).token;
  } catch {
    return null;
  }
}

export function createNotificationLiveChannel(opts: {
  userId: string;
  /** Defaults to the same-origin realtime path. */
  url?: string | undefined;
  fetchFn?: typeof fetch | undefined;
  /** Test seam, mirroring RealtimeClient's. */
  webSocket?: ((url: string) => RealtimeWebSocket) | undefined;
  /** Test seam: reconnect pacing, mirrored to RealtimeClient. */
  reconnectBaseDelayMs?: number | undefined;
  reconnectMaxDelayMs?: number | undefined;
}): NotificationLiveChannel {
  const listeners = new Set<() => void>();
  const ping = (): void => {
    for (const listener of listeners) listener();
  };
  const client = new RealtimeClient({
    url: opts.url ?? realtimeUrl(),
    getToken: () => fetchSessionToken(opts.fetchFn ?? fetch),
    ...(opts.webSocket !== undefined ? { webSocket: opts.webSocket } : {}),
    ...(opts.reconnectBaseDelayMs !== undefined
      ? { reconnectBaseDelayMs: opts.reconnectBaseDelayMs }
      : {}),
    ...(opts.reconnectMaxDelayMs !== undefined
      ? { reconnectMaxDelayMs: opts.reconnectMaxDelayMs }
      : {}),
  });
  client.on("message", (msg) => {
    if (msg.channel === userChannel(opts.userId) && msg.event === NOTIFICATIONS_CHANGED_EVENT) {
      ping();
    }
  });
  // resync 只在「重连成功」时是催（attempts > 0）：初次连接的 auth.ok 也带
  // 一次 resync，但铃铛挂载时本就读过 summary，那一发不是补缺口
  client.on("resync", (info) => {
    if (info.attempts > 0) ping();
  });
  client.subscribe(userChannel(opts.userId));
  client.connect();
  return {
    subscribe(onChange: () => void): () => void {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    close(): void {
      client.close();
    },
  };
}
