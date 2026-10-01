import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Logger } from "pino";
import { WebSocket, WebSocketServer } from "ws";
import {
  MAX_CLIENT_FRAME_BYTES,
  REALTIME_WS_PATH,
} from "@ally/realtime";
import type { RealtimeConnection, RealtimeHub } from "./hub.ts";

/**
 * 把 ws 的 WebSocket 连接接到 RealtimeHub 上。
 * 只放行 REALTIME_WS_PATH 的 upgrade 请求；帧严格按到达顺序交给 hub 处理。
 * 另有 ws 协议层 ping：一是让 ALB 的 300s 空闲超时不断开空闲连接，二是清掉半开连接。
 */
export interface AttachRealtimeWsOptions {
  hub: RealtimeHub;
  logger: Logger;
  path?: string | undefined;
  pingIntervalMs?: number | undefined;
}

export interface AttachedRealtimeWs {
  /** 停止接受新连接并关闭现有连接（进程退出时调用） */
  close(): Promise<void>;
}

interface UpgradeableServer {
  on(
    event: "upgrade",
    listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): unknown;
  off(
    event: "upgrade",
    listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): unknown;
}

const DEFAULT_PING_INTERVAL_MS = 30_000;

export function attachRealtimeWs(
  server: UpgradeableServer,
  opts: AttachRealtimeWsOptions,
): AttachedRealtimeWs {
  const path = opts.path ?? REALTIME_WS_PATH;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_FRAME_BYTES });
  // 两个 tick 内没回 pong 的连接视为死连接，直接断开触发重连
  const alive = new WeakMap<WebSocket, boolean>();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname !== path) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      alive.set(ws, true);
      ws.on("pong", () => {
        alive.set(ws, true);
      });

      const conn: RealtimeConnection = {
        id: randomUUID(),
        send: (text) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(text);
        },
        close: (code, reason) => {
          ws.close(code, reason);
        },
      };
      opts.hub.connect(conn);

      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          // 二进制帧不在协议内：空字符串会让 hub 回 bad_frame
          opts.hub.handleFrame(conn, "");
          return;
        }
        opts.hub.handleFrame(conn, toUtf8(data));
      });
      ws.on("close", () => {
        void opts.hub.disconnect(conn).catch((err: unknown) => {
          opts.logger.warn(
            { err, connectionId: conn.id },
            "realtime disconnect cleanup failed",
          );
        });
      });
      ws.on("error", (err) => {
        opts.logger.debug({ err, connectionId: conn.id }, "realtime ws error");
      });
    });
  };
  server.on("upgrade", onUpgrade);

  const pingIntervalMs = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, pingIntervalMs);

  return {
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(pingTimer);
        server.off("upgrade", onUpgrade);
        wss.close(() => { resolve(); });
      }),
  };
}

function toUtf8(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}
