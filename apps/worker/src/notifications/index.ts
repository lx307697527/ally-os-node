import type { Logger } from "pino";
import type { Mailer } from "@ally/mailer";
import type { Db } from "@ally/db";
import type { JobDefinition } from "../jobs/index.ts";
import {
  DIGEST_ITEM_CAP,
  NOTIFICATIONS_DIGEST_JOB,
  runNotificationsDigestScan,
  type DigestServices,
} from "./digest.ts";

/**
 * 通知域的任务登记（#116 渠道层）：每日一封「未读通知摘要」邮件。
 *
 * db / mailer 由 worker 引导（index.ts）注入——邮件基建沉在 @ally/mailer，
 * 与 automations 内核下沉同一裁法（worker 不跨 app 依赖）。
 *
 * cron 每日 13:30 UTC（美东上午 9:30）——与规则待办提醒（13:00）同锚错峰：
 * 摘要落进「早上一上班的邮箱」，又和待办扫描错开半点。重试 1 次足够：投递
 * 台账（digest_sent_at）让重试只补失败者，明天的扫描本身就是兜底（与
 * rules-pending-reminder 同一裁法）。
 */
export interface NotificationsJobsDeps {
  db: Db;
  mailer: Mailer;
  /** web 端根地址（摘要里的「去应用」链接）；不配置 = 邮件不放链接 */
  webAppUrl: string | undefined;
  logger: Logger;
}

export function notificationsJobs(deps: NotificationsJobsDeps): JobDefinition[] {
  const services: DigestServices = {
    db: deps.db,
    mailer: deps.mailer,
    webAppUrl: deps.webAppUrl,
    logger: deps.logger,
  };
  const digest: JobDefinition = {
    name: NOTIFICATIONS_DIGEST_JOB,
    cron: "30 13 * * *",
    queue: { retryLimit: 1, retryDelay: 300, expireInSeconds: 600 },
    handler: async (_data, { logger }) => {
      const delivered = await runNotificationsDigestScan({ ...services, logger });
      logger.info(
        { users: delivered.size, items: [...delivered.values()].reduce((a, b) => a + b, 0) },
        "notification digest scan finished",
      );
    },
  };
  return [digest];
}

export { DIGEST_ITEM_CAP, NOTIFICATIONS_DIGEST_JOB };
