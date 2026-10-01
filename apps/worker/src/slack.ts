// Slack incoming webhook 告警器。只依赖一个 URL + fetch，不引入 Slack SDK ——
// 告警就是发一条文本消息，失败告警路径本身必须尽可能简单可靠。

/** fetch 的最小结构切片；全局 fetch 天然满足，测试注入也不用碰 DOM/undici 类型 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export interface SlackAlerter {
  /** 发一条文本消息；未配置 webhook 时是不发请求的空操作 */
  send(text: string): Promise<void>;
}

export interface SlackAlerterOptions {
  /** 来自 env 的 SLACK_WEBHOOK_URL；不填 = 未配置告警（显式 | undefined 以兼容 exactOptionalPropertyTypes） */
  webhookUrl?: string | undefined;
  /** 测试注入用；默认全局 fetch */
  fetchImpl?: FetchLike | undefined;
}

export function createSlackAlerter(options: SlackAlerterOptions): SlackAlerter {
  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
  return {
    async send(text: string): Promise<void> {
      if (!options.webhookUrl) return;
      const response = await fetchImpl(options.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        throw new Error(`slack webhook responded ${String(response.status)}`);
      }
    },
  };
}

/** 组装任务失败告警的 Slack 消息文本（纯函数，便于测试） */
export function formatJobFailure(failure: {
  job: string;
  jobId: string;
  attempt: number;
  retryLimit: number;
  error: string;
}): string {
  const willRetry = failure.attempt <= failure.retryLimit;
  const outcome = willRetry
    ? `will retry (attempt ${String(failure.attempt)}/${String(failure.retryLimit)})`
    : "gave up after all retries";
  return [
    `:rotating_light: *Ally OS job failed* — \`${failure.job}\``,
    `\`${outcome}\``,
    `jobId: \`${failure.jobId}\``,
    "```",
    failure.error,
    "```",
  ].join("\n");
}
