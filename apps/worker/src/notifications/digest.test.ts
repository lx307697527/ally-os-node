import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import type { Mailer, MailMessage } from "@ally/mailer";
import { notificationsJobs } from "./index.ts";
import {
  DIGEST_ITEM_CAP,
  NOTIFICATIONS_DIGEST_JOB,
  renderDigest,
  runNotificationsDigestScan,
  type DigestServices,
} from "./digest.ts";

/**
 * 纯渲染测试不碰库；集成测试需要真实 PostgreSQL（两表 join + 行级盖章）。
 * 未设 DATABASE_URL 时集成部分跳过。独立临时库（每次运行新建、跑完 drop）。
 * 清库纪律：notifications / notification_preferences 无被引用者，beforeEach 单独清。
 */

const databaseUrl = process.env.DATABASE_URL;
const logger = pino({ level: "silent" });

/** 记录型假 mailer：sendful = 记录每次发送；failFor 名单里的收件人抛错 */
function fakeMailer(options: { failFor?: string[] } = {}): { mailer: Mailer; sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    mailer: {
      send(message) {
        if (options.failFor?.includes(message.to)) {
          return Promise.reject(new Error(`simulated send failure for ${message.to}`));
        }
        sent.push(message);
        return Promise.resolve();
      },
    },
  };
}

describe("digest email rendering (#116, unit)", () => {
  const base = { eventType: "task.assigned", when: "2026-10-07 01:30 UTC" };

  it("单数/复数的主题与总数文案", () => {
    expect(renderDigest([{ ...base, detail: null }], 1, undefined).subject).toBe(
      "Ally OS digest: 1 unread notification",
    );
    expect(renderDigest([{ ...base, detail: null }], 3, undefined).subject).toBe(
      "Ally OS digest: 3 unread notifications",
    );
  });

  it("detail 取 payload 事实字段；没有就只亮事件类型", () => {
    expect(renderDigest([{ ...base, detail: "Feed the lab" }], 1, undefined).text).toContain(
      "- task.assigned — Feed the lab (2026-10-07 01:30 UTC)",
    );
    expect(renderDigest([{ ...base, detail: null }], 1, undefined).text).toContain(
      "- task.assigned (2026-10-07 01:30 UTC)",
    );
  });

  it("收款告警的事实行原样进摘要（#193 剩余③）：类型 + detail + 时刻，不另养一套文案", () => {
    const detail =
      "A stripe payment of USD 1,500.00 (ref pi_x) for invoice INV-0301 arrived but could not be " +
      "recorded: the invoice is still a draft (finance has not confirmed it). " +
      "The provider will keep retrying — no money is booked until this is resolved.";
    const rendered = renderDigest([{ eventType: "payment.unbookable", detail, when: "2026-10-08 05:30 UTC" }], 1, undefined);
    expect(rendered.text).toContain(`- payment.unbookable — ${detail} (2026-10-08 05:30 UTC)`);
  });

  it("webAppUrl 配了给链接，没配诚实降级不放死链", () => {
    const linked = renderDigest([{ ...base, detail: null }], 1, "https://os.example.com");
    expect(linked.text).toContain("Open Ally OS: https://os.example.com/overview");
    expect(linked.html).toContain('href="https://os.example.com/overview"');
    const bare = renderDigest([{ ...base, detail: null }], 1, undefined);
    expect(bare.text).not.toContain("http");
    expect(bare.html).not.toContain("<a ");
  });

  it("总数大于列出数时报「还有 N 条」占位", () => {
    const items = Array.from({ length: 3 }, () => ({ ...base, detail: null }));
    const mail = renderDigest(items, 10, undefined);
    expect(mail.text).toContain("… and 7 more — open the app to see everything.");
    expect(mail.html).toContain("… and 7 more");
  });

  it("HTML 对 detail 里的尖括号转义", () => {
    const mail = renderDigest([{ ...base, detail: "<script>alert(1)</script>" }], 1, undefined);
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
  });
});

describe.skipIf(!databaseUrl)("notification digest scan (#116, integration)", () => {
  const dbName = `notify_digest_test_${String(Date.now())}_${String(process.pid)}`;
  const admin = createDb(adminUrl(databaseUrl));
  const scopedUrl =
    databaseUrl === undefined
      ? ""
      : (() => {
          const url = new URL(databaseUrl);
          url.pathname = `/${dbName}`;
          return url.toString();
        })();
  const { db, pool } = createDb(scopedUrl);
  pool.on("error", () => {});
  admin.pool.on("error", () => {});

  const digester = randomUUID();
  const silent = randomUUID();
  const digesterEmail = "digest@example.com";
  const silentEmail = "silent@example.com";

  function adminUrl(url: string | undefined): string {
    if (url === undefined) return "";
    const parsed = new URL(url);
    parsed.pathname = "/postgres";
    return parsed.toString();
  }

  function servicesWith(mailer: Mailer): DigestServices {
    return { db, mailer, webAppUrl: "https://os.example.com", logger };
  }

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("unreachable: suite is skipped without DATABASE_URL");
    await admin.pool.query(`create database "${dbName}"`);
    await runMigrations(db);
    await db.insert(schema.authUser).values([
      { id: digester, name: "D", email: digesterEmail, emailVerified: true },
      { id: silent, name: "S", email: silentEmail, emailVerified: true },
    ]);
  });

  afterEach(async () => {
    await db.delete(schema.notifications);
    await db.delete(schema.notificationPreferences);
  });

  afterAll(async () => {
    // 先关业务池再 drop：有活连接时 drop database 会失败（与 rules.test.ts 同序）
    await pool.end();
    await admin.pool.query(`drop database if exists "${dbName}"`);
    await admin.pool.end();
  });

  async function insertUnread(
    userId: string,
    over: Partial<{ isRead: boolean; eventType: string; payload: Record<string, unknown> }> = {},
  ): Promise<string> {
    const rows = await db
      .insert(schema.notifications)
      .values({ userId, eventType: "task.assigned", payload: { taskTitle: `T-${randomUUID().slice(0, 8)}` }, ...over })
      .returning({ id: schema.notifications.id });
    const id = rows[0]?.id;
    if (id === undefined) throw new Error("insert failed");
    return id;
  }

  async function stampedCount(): Promise<number> {
    const rows = await db
      .select({ digestSentAt: schema.notifications.digestSentAt })
      .from(schema.notifications);
    return rows.filter((row) => row.digestSentAt !== null).length;
  }

  it("只给 opt-in 用户发：开摘要的人收一封汇总，没开的人一封不发", async () => {
    await db.insert(schema.notificationPreferences).values({ userId: digester, emailDigest: true });
    await insertUnread(digester);
    await insertUnread(digester, { eventType: "comment.mentioned" });
    await insertUnread(silent);
    await insertUnread(silent);

    const { mailer, sent } = fakeMailer();
    const delivered = await runNotificationsDigestScan(servicesWith(mailer));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(digesterEmail);
    expect(sent[0]?.subject).toBe("Ally OS digest: 2 unread notifications");
    expect(sent[0]?.text).toContain("comment.mentioned");
    expect(delivered.get(digester)).toBe(2);
    expect(delivered.has(silent)).toBe(false);
  });

  it("盖章 exactly-once：发过的行不再进第二封；已读行从头就不进", async () => {
    await db.insert(schema.notificationPreferences).values({ userId: digester, emailDigest: true });
    const first = await insertUnread(digester);
    await insertUnread(digester, { isRead: true });

    const { mailer, sent } = fakeMailer();
    await runNotificationsDigestScan(servicesWith(mailer));
    expect(sent[0]?.subject).toBe("Ally OS digest: 1 unread notification");
    const firstRow = await db
      .select({ digestSentAt: schema.notifications.digestSentAt })
      .from(schema.notifications)
      .where(eq(schema.notifications.id, first));
    expect(firstRow[0]?.digestSentAt).toBeInstanceOf(Date);

    await insertUnread(digester);
    const second = fakeMailer();
    await runNotificationsDigestScan(servicesWith(second.mailer));
    expect(second.sent[0]?.subject).toBe("Ally OS digest: 1 unread notification");
  });

  it("封顶：总数照报、只列最旧 CAP 条、只给列出的盖章，下次带余下的", async () => {
    await db.insert(schema.notificationPreferences).values({ userId: digester, emailDigest: true });
    for (let i = 0; i < DIGEST_ITEM_CAP + 5; i++) {
      await insertUnread(digester);
    }
    const { mailer, sent } = fakeMailer();
    await runNotificationsDigestScan(servicesWith(mailer));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toBe(`Ally OS digest: ${String(DIGEST_ITEM_CAP + 5)} unread notifications`);
    expect(sent[0]?.text).toContain("… and 5 more");
    expect(await stampedCount()).toBe(DIGEST_ITEM_CAP);

    const second = fakeMailer();
    await runNotificationsDigestScan(servicesWith(second.mailer));
    expect(second.sent[0]?.subject).toBe("Ally OS digest: 5 unread notifications");
    expect(await stampedCount()).toBe(DIGEST_ITEM_CAP + 5);
  });

  it("按人隔离失败：一人的信炸了不拦别人，上抛后重试只补失败者", async () => {
    await db.insert(schema.notificationPreferences).values([
      { userId: digester, emailDigest: true },
      { userId: silent, emailDigest: true },
    ]);
    await insertUnread(digester);
    await insertUnread(silent);

    const failing = fakeMailer({ failFor: [silentEmail] });
    await expect(runNotificationsDigestScan(servicesWith(failing.mailer))).rejects.toThrow(
      /notification digest failed for 1 user/,
    );
    expect(failing.sent).toHaveLength(1);
    expect(failing.sent[0]?.to).toBe(digesterEmail);
    expect(await stampedCount()).toBe(1);

    const retry = fakeMailer();
    const delivered = await runNotificationsDigestScan(servicesWith(retry.mailer));
    expect(retry.sent).toHaveLength(1);
    expect(retry.sent[0]?.to).toBe(silentEmail);
    expect(delivered.get(silent)).toBe(1);
    expect(delivered.has(digester)).toBe(false);
  });

  it("任务登记：notifications-digest 挂每日 cron", () => {
    const jobs = notificationsJobs({
      db,
      mailer: fakeMailer().mailer,
      webAppUrl: undefined,
      logger,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe(NOTIFICATIONS_DIGEST_JOB);
    expect(jobs[0]?.cron).toBe("30 13 * * *");
  });
});
