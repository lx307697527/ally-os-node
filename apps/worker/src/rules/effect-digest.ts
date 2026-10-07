import { asc, desc, eq, inArray } from "drizzle-orm";
import type { Logger } from "pino";
import type { Mailer } from "@ally/mailer";
import { schema, type Db } from "@ally/db";

/**
 * 规则效果周报（#225：#232 §4.8「每周汇总给老板和销售主管」，#233 验收第 8 条）。
 *
 * registry_rules 的三个运行数据计数（trigger/exception/override）是开机以来的
 * 累计值，周报要的是「本期增量」（§4.8 原文例：「本周 8 张报价低于成本」）。
 * recordRuleOutcome 是计数器不是事件流，历史追不回来——增量由差分得出：每期
 * 落一行 run（全量计数快照 + 冻结的报告内容 + 冻结的收件人），下一期的 from
 * 就是上一行的快照。首期 from 全零，首报即「上线以来」的追账，之后每周只报
 * 新增。
 *
 * 投递语义（与通知摘要刻意不同的分寸）：
 * - 冻结后发送。发送失败 run 留在 pending，下次扫描重发同一份冻结内容而不是
 *   重算——重算会让「发过一半」的那期数据永远报不出来。at-least-once：信已出
 *   而 stamped 前崩溃 → 下周重发同一封；每周一封 × 收件人个位数，重复无害
 *   （通知摘要有行级 exactly-once 台账，这里的复杂度不值那个价）。
 * - 收件人在计算时刻冻结（owner + sales_lead 持有者去重）：本周的报告是算给
 *   「当时在场的人」的，重发名单不随角色变动漂移。
 * - 安静的一周（零活动）也发：短报本身就是「周报还活着」的心跳，收件人不必
 *   猜「是没活动还是没周报」。
 * - 没有收件人（owner 都不在）→ 不建 run、告警跳过——一条没人收的报告是假
 *   成功（与 rules-pending-reminder 的空回落同裁法），且不落快照，等收件人
 *   出现的那期把跨越的整段一起报出来，数据不丢。
 *
 * run 行不写审计：周报是报表不是业务变更（与 automations due 合成语境同裁），
 * 行本身就是台账。
 */

export const RULES_EFFECT_DIGEST_JOB = "rules-effect-digest";

export interface EffectDigestServices {
  db: Db;
  mailer: Mailer;
  logger: Logger;
  /** web 根地址，报告尾的「去注册表看」链接；不配置 = 不放链接（诚实降级，同通知摘要） */
  webAppUrl: string | undefined;
  /** 测试注入；缺省真时钟 */
  now?: () => Date;
}

export interface EffectDigestSummary {
  /** sent = 新算的一期发出；resent = 重发挂起的冻结期；skipped = 无收件人 */
  mode: "sent" | "resent" | "skipped";
  runId: string | null;
  recipients: number;
  entries: number;
}

/** 一行规则的累计计数（SQL 里按 key 排好序，渲染顺序由此确定） */
export interface RuleCountersRow {
  key: string;
  label: string;
  category: string;
  triggerCount: number;
  exceptionCount: number;
  overrideCount: number;
}

type DigestRun = typeof schema.rulesEffectDigestRuns.$inferSelect;

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("unexpected missing value in digest scan");
  return value;
}

/**
 * 差分：上一份快照 × 本期全量计数 → 报告条目（delta 非零）+ 新快照。
 * 纯函数，测试直打。规则按 key 序进来，条目顺序随入参（确定性渲染）。
 */
export function computeDigestEntries(
  previous: Record<string, [number, number, number]>,
  rules: readonly RuleCountersRow[],
): { entries: schema.RuleEffectDigestEntry[]; snapshot: Record<string, [number, number, number]> } {
  const snapshot: Record<string, [number, number, number]> = {};
  const entries: schema.RuleEffectDigestEntry[] = [];
  for (const rule of rules) {
    const from = previous[rule.key] ?? [0, 0, 0];
    const to: [number, number, number] = [rule.triggerCount, rule.exceptionCount, rule.overrideCount];
    snapshot[rule.key] = to;
    const delta: [number, number, number] = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    if (delta[0] === 0 && delta[1] === 0 && delta[2] === 0) continue;
    entries.push({
      key: rule.key,
      label: rule.label,
      category: rule.category,
      delta: { triggered: delta[0], exception: delta[1], override: delta[2] },
      totals: { triggered: to[0], exception: to[1], override: to[2] },
    });
  }
  return { entries, snapshot };
}

function formatWhen(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** 一条目里非零增量段的文案段（纯增量说话，零段不占地方） */
function deltaParts(delta: schema.RuleEffectDigestEntry["delta"]): string[] {
  const parts: string[] = [];
  if (delta.triggered !== 0) parts.push(`+${String(delta.triggered)} triggered`);
  if (delta.exception !== 0) parts.push(`+${String(delta.exception)} exception`);
  if (delta.override !== 0) parts.push(`+${String(delta.override)} override`);
  return parts;
}

/** 邮件文案（纯函数，测试直打）；英文用户可见文案（RULE-010） */
export function renderEffectDigest(input: {
  entries: readonly schema.RuleEffectDigestEntry[];
  totalRules: number;
  weekStart: Date;
  weekEnd: Date;
  webAppUrl: string | undefined;
}): { subject: string; text: string; html: string } {
  // 首期没有「上一期」，起点是纪元——照实说，别把 1970 打进收件人眼里
  const isFirstReport = input.weekStart.getTime() === 0;
  const period = isFirstReport
    ? `through ${formatWhen(input.weekEnd)} (first report — totals since launch)`
    : `${formatWhen(input.weekStart)} – ${formatWhen(input.weekEnd)}`;
  const active = input.entries.length;
  const subject =
    active === 0
      ? "Ally OS weekly rules digest: no activity"
      : `Ally OS weekly rules digest: ${String(active)} of ${String(input.totalRules)} rules active`;
  const lines = input.entries.map((entry) => {
    const parts = deltaParts(entry.delta).join(", ");
    const totals = `${String(entry.totals.triggered)} triggered / ${String(entry.totals.exception)} exception / ${String(entry.totals.override)} override`;
    return `- ${entry.label} (${entry.key}): ${parts} — totals ${totals}`;
  });
  if (active === 0) {
    lines.push(`No rule activity this period (${String(input.totalRules)} rules watched).`);
  }
  if (input.webAppUrl !== undefined) {
    lines.push(`Open the rules registry: ${input.webAppUrl}/system/rules`);
  }
  const text = `Rules registry digest for ${period}:\n\n${lines.join("\n")}\n`;
  const listHtml = input.entries
    .map((entry) => {
      const parts = deltaParts(entry.delta)
        .map((part) => `<strong>${escapeHtml(part)}</strong>`)
        .join(", ");
      const totals = `${String(entry.totals.triggered)} triggered / ${String(entry.totals.exception)} exception / ${String(entry.totals.override)} override`;
      return `<li><code>${escapeHtml(entry.key)}</code> ${escapeHtml(entry.label)}: ${parts} — totals ${escapeHtml(totals)}</li>`;
    })
    .join("");
  const quietHtml =
    active === 0
      ? `<p>No rule activity this period (${escapeHtml(String(input.totalRules))} rules watched).</p>`
      : `<ul>${listHtml}</ul>`;
  const linkHtml =
    input.webAppUrl === undefined
      ? ""
      : `<p><a href="${escapeHtml(`${input.webAppUrl}/system/rules`)}">Open the rules registry</a></p>`;
  const html = `<p>Rules registry digest for <strong>${escapeHtml(period)}</strong>:</p>${quietHtml}${linkHtml}`;
  return { subject, text, html };
}

/** 邮件行的 HTML 转义（与 @ally/mailer 的 escapeHtml 同义，包内不导出） */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** owner + sales_lead 持有者去重（§4.8「老板和销售主管」）；按邮箱排序（确定性） */
async function resolveRecipients(db: Db): Promise<{ userId: string; email: string }[]> {
  const rows = await db
    .selectDistinct({ userId: schema.authUser.id, email: schema.authUser.email })
    .from(schema.authUser)
    .innerJoin(schema.userRole, eq(schema.userRole.userId, schema.authUser.id))
    .where(inArray(schema.userRole.role, ["owner", "sales_lead"]));
  return rows
    .map((row) => ({ userId: row.userId, email: row.email }))
    .sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
}

/** 把冻结的一期发给冻结名单；任一收件人失败 = 上抛进重试（run 留 pending，见模块注释） */
async function sendRun(
  services: Pick<EffectDigestServices, "db" | "mailer" | "webAppUrl" | "now" | "logger">,
  run: Pick<DigestRun, "id" | "weekStart" | "weekEnd" | "entries" | "totalRules" | "recipients">,
): Promise<void> {
  const message = {
    ...renderEffectDigest({
      entries: run.entries,
      totalRules: run.totalRules,
      weekStart: run.weekStart,
      weekEnd: run.weekEnd,
      webAppUrl: services.webAppUrl,
    }),
  };
  const failures: { email: string; error: unknown }[] = [];
  for (const recipient of run.recipients) {
    try {
      await services.mailer.send({ to: recipient.email, ...message });
    } catch (error) {
      services.logger.error({ err: error, runId: run.id, email: recipient.email }, "rules effect digest send failed");
      failures.push({ email: recipient.email, error });
    }
  }
  if (failures.length > 0) {
    throw new Error(`rules effect digest failed for ${String(failures.length)} recipient(s)`);
  }
  // 状态迁移带 WHERE status='pending'：并发/重投下不改写已了结的行
  await services.db
    .update(schema.rulesEffectDigestRuns)
    .set({ status: "sent", sentAt: services.now?.() ?? new Date() })
    .where(eq(schema.rulesEffectDigestRuns.id, run.id));
}

/** 扫描一次：重发挂起期或计算新的一期。返回摘要供任务日志与测试断言 */
export async function runRulesEffectDigestScan(services: EffectDigestServices): Promise<EffectDigestSummary> {
  const now = services.now ?? (() => new Date());

  // 挂起的期先于一切：重发冻结内容，不重算（重算会让发过一半的那期永远报不出来）
  const pendingRows = await services.db
    .select()
    .from(schema.rulesEffectDigestRuns)
    .where(eq(schema.rulesEffectDigestRuns.status, "pending"))
    .orderBy(asc(schema.rulesEffectDigestRuns.createdAt))
    .limit(1);
  const pending = pendingRows[0];
  if (pending !== undefined) {
    if (pending.recipients.length === 0) {
      // 计算面不允许空收件人建行；真出现 = 有旁路写入，标记了结并告警，别让
      // 挂起期永久堵住新期的计算
      await services.db
        .update(schema.rulesEffectDigestRuns)
        .set({ status: "sent", sentAt: now() })
        .where(eq(schema.rulesEffectDigestRuns.id, pending.id));
      services.logger.warn({ runId: pending.id }, "pending rules effect digest has no recipients; closed without sending");
      return { mode: "skipped", runId: pending.id, recipients: 0, entries: pending.entries.length };
    }
    await sendRun(services, pending);
    return { mode: "resent", runId: pending.id, recipients: pending.recipients.length, entries: pending.entries.length };
  }

  // 没有收件人就不开工：不建 run、不落快照，跨越的时段由收件人出现后的那一期
  // 一起报出来（模块注释「数据不丢」半边）
  const recipients = await resolveRecipients(services.db);
  if (recipients.length === 0) {
    services.logger.warn("rules effect digest has no recipients (no owner or sales_lead); skipped");
    return { mode: "skipped", runId: null, recipients: 0, entries: 0 };
  }

  const previousRows = await services.db
    .select({ weekEnd: schema.rulesEffectDigestRuns.weekEnd, countersAt: schema.rulesEffectDigestRuns.countersAt })
    .from(schema.rulesEffectDigestRuns)
    .orderBy(desc(schema.rulesEffectDigestRuns.weekEnd))
    .limit(1);
  const previous = previousRows[0];
  const weekStart = previous === undefined ? new Date(0) : previous.weekEnd;
  const weekEnd = now();

  const ruleRows = await services.db
    .select({
      key: schema.registryRules.key,
      label: schema.registryRules.label,
      category: schema.registryRules.category,
      triggerCount: schema.registryRules.triggerCount,
      exceptionCount: schema.registryRules.exceptionCount,
      overrideCount: schema.registryRules.overrideCount,
    })
    .from(schema.registryRules)
    .orderBy(asc(schema.registryRules.key));
  const { entries, snapshot } = computeDigestEntries(
    previous === undefined ? {} : previous.countersAt,
    ruleRows,
  );

  const inserted = await services.db
    .insert(schema.rulesEffectDigestRuns)
    .values({
      weekStart,
      weekEnd,
      status: "pending",
      countersAt: snapshot,
      entries,
      totalRules: ruleRows.length,
      recipients,
    })
    .returning({ id: schema.rulesEffectDigestRuns.id });
  const runId = must(inserted[0]).id;

  await sendRun(services, {
    id: runId,
    weekStart,
    weekEnd,
    entries,
    totalRules: ruleRows.length,
    recipients,
  });
  return { mode: "sent", runId, recipients: recipients.length, entries: entries.length };
}
