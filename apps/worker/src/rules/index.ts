import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { Mailer } from "@ally/mailer";
import type { Db } from "@ally/db";
import type { JobDefinition } from "../jobs/index.ts";
import {
  RULES_DUE_ACTIVATION_JOB,
  dueActivationJob,
} from "./due-activation.ts";
import {
  RULES_EFFECT_DIGEST_JOB,
  runRulesEffectDigestScan,
  type EffectDigestServices,
} from "./effect-digest.ts";
import { RULES_PENDING_REMINDER_JOB, runRulesPendingReminderScan } from "./reminder.ts";

/**
 * 规则注册表域的任务登记（#233 切片 2 待办提醒 + #225 规则效果周报 + #233 定时
 * 生效前滚）。
 *
 * db/pool/mailer 由 worker 引导（index.ts）注入。定时生效的前滚内核居
 * packages/rules（随本切片下沉，docs/rules.md「接线那天内核随消费域一起下沉共享
 * 包」既定裁法的兑现），任务只做投递与提交后审计（归属裁决见 due-activation.ts）。
 */
export interface RulesJobsDeps {
  db: Db;
  /** pg_notify 发布执行器（worker 自己的连接池） */
  pool: { query(text: string, values?: unknown[]): Promise<unknown> };
  mailer: Mailer;
  /** web 端根地址（周报里的「去注册表」链接）；不配置 = 邮件不放链接 */
  webAppUrl: string | undefined;
  logger: Logger;
}

export function rulesJobs(deps: RulesJobsDeps): JobDefinition[] {
  const services = {
    db: deps.db,
    publishExecutor: deps.pool,
    instanceId: `rules-worker-${randomUUID()}`,
    logger: deps.logger,
  };
  const reminder: JobDefinition = {
    name: RULES_PENDING_REMINDER_JOB,
    cron: "0 13 * * *",
    queue: { retryLimit: 1, retryDelay: 300, expireInSeconds: 600 },
    handler: async (_data, { logger }) => {
      const summary = await runRulesPendingReminderScan({ ...services, logger });
      logger.info(summary, "rules pending reminder scan finished");
    },
  };
  const digestServices: EffectDigestServices = {
    db: deps.db,
    mailer: deps.mailer,
    webAppUrl: deps.webAppUrl,
    logger: deps.logger,
  };
  const effectDigest: JobDefinition = {
    // 每周一 14:00 UTC（美东周一上午 10 点）——周报落在「一周开头」的邮箱里，
    // 与每日锚（13:00 待办提醒 / 13:30 通知摘要）同锚错峰。worker 停机错过一个
    // 周一 → 下周一的扫描把跨越的整段一起报出来（from 是上一期的快照，数据不丢）
    name: RULES_EFFECT_DIGEST_JOB,
    cron: "0 14 * * 1",
    queue: { retryLimit: 2, retryDelay: 300, expireInSeconds: 600 },
    handler: async (_data, { logger }) => {
      const summary = await runRulesEffectDigestScan({ ...digestServices, logger });
      logger.info(summary, "rules effect digest finished");
    },
  };
  const dueActivation = dueActivationJob({ db: deps.db });
  return [reminder, effectDigest, dueActivation];
}

export { RULES_DUE_ACTIVATION_JOB, RULES_EFFECT_DIGEST_JOB };
