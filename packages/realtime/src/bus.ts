import pg from "pg";
import type { Logger } from "pino";
import {
  decodeBusEnvelope,
  encodeBusEnvelope,
  type RealtimeBusPayload,
} from "./protocol.ts";

/**
 * 实例间广播总线（#30）：发布走 pg_notify，接收靠专用连接 LISTEN。
 * 每个进程一条 LISTEN 连接；发布复用调用方给的执行器（通常是应用自己的连接池）。
 * 多个 API 实例只要连同一个数据库就能互通，不需要额外的消息中间件。
 *
 * 语义是 at-most-once：实例断线期间的 NOTIFY 会丢。客户端 SDK 在重连成功后
 * 发出 resync 事件，前端收到后重新拉一次数据即可，实时推送只负责"催"。
 */
export interface RealtimeBusDeps {
  databaseUrl: string;
  /** 发布用的查询执行器；query(text, values) 与 pg.Pool.query 兼容即可 */
  publishExecutor: { query(text: string, values?: unknown[]): Promise<unknown> };
  logger: Logger;
  instanceId: string;
  /** 收到总线上（含本实例发布的）事件时回调；解析失败的帧记日志后丢弃 */
  onMessage: (payload: RealtimeBusPayload) => void;
}

export const REALTIME_LISTEN_CHANNEL = "ally_realtime";

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RealtimeBus {
  private readonly deps: RealtimeBusDeps;
  private client: pg.Client | null;
  private running: boolean;

  constructor(deps: RealtimeBusDeps) {
    this.deps = deps;
    this.client = null;
    this.running = false;
  }

  /** 建立 LISTEN 连接；首次连接失败直接抛出（启动期快速失败），之后断线自动重连 */
  async start(): Promise<void> {
    await this.connectOnce();
    this.running = true;
    void this.maintain();
  }

  /** 广播一条事件到所有实例；payload 超限抛 MessageTooLargeError，连接故障抛原始错误 */
  async publish(payload: RealtimeBusPayload): Promise<void> {
    const encoded = encodeBusEnvelope(payload, this.deps.instanceId);
    await this.deps.publishExecutor.query("select pg_notify($1, $2)", [
      REALTIME_LISTEN_CHANNEL,
      encoded,
    ]);
  }

  async stop(): Promise<void> {
    this.running = false;
    const client = this.client;
    this.client = null;
    if (client) {
      // 关闭会触发 error/end 事件，maintain 循环随之退出
      await client.end().catch((err: unknown) => {
        this.deps.logger.warn({ err }, "error while closing realtime bus listen client");
      });
    }
  }

  private async connectOnce(): Promise<void> {
    const client = new pg.Client({ connectionString: this.deps.databaseUrl });
    try {
      const lost = new Promise<void>((resolve) => {
        client.on("error", () => { resolve(); });
        client.on("end", () => { resolve(); });
      });
      client.on("notification", (msg) => { this.handleNotifyPayload(msg.payload); });
      await client.connect();
      await client.query(`LISTEN ${REALTIME_LISTEN_CHANNEL}`);
      this.client = client;
      this.deps.logger.info({ channel: REALTIME_LISTEN_CHANNEL }, "realtime bus listening");
      // 连接断开后清掉引用；maintain 循环负责重连
      void lost.then(() => {
        if (this.client === client) this.client = null;
      });
    } catch (err) {
      // 半连接的 client 不留给 maintain，避免泄漏
      await client.end().catch((closeErr: unknown) => {
        this.deps.logger.warn({ err: closeErr }, "error while closing failed realtime bus client");
      });
      throw err;
    }
  }

  /** 等当前连接断掉再重连，指数退避 + 抖动；stop() 后退出 */
  private async maintain(): Promise<void> {
    let delay = RECONNECT_MIN_MS;
    for (;;) {
      const client = this.client;
      if (client) {
        await new Promise<void>((resolve) => {
          client.once("error", resolve);
          client.once("end", resolve);
        });
        if (this.client === client) this.client = null;
        if (!this.running) return;
        this.deps.logger.warn("realtime bus connection lost; reconnecting");
      }
      await sleep(delay + Math.random() * delay);
      if (!this.running) return;
      try {
        await this.connectOnce();
        delay = RECONNECT_MIN_MS;
      } catch (err) {
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
        this.deps.logger.warn({ err, retryInMs: delay }, "realtime bus reconnect failed");
      }
    }
  }

  /**
   * 处理一条 NOTIFY 原始 payload（也用于测试直接注入）。
   * 格式错误记日志丢弃；消费方回调抛出的异常被吞掉记日志，不影响 LISTEN 连接。
   */
  handleNotifyPayload(raw: string | undefined): void {
    if (raw === undefined) return;
    const envelope = decodeBusEnvelope(raw);
    if (!envelope) {
      this.deps.logger.warn({ bytes: raw.length }, "realtime bus dropped malformed payload");
      return;
    }
    try {
      this.deps.onMessage(envelope.payload);
    } catch (err) {
      this.deps.logger.error({ err }, "realtime bus message handler failed");
    }
  }
}
