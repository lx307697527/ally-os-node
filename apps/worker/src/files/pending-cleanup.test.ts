import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import type { Storage } from "@ally/storage";
import { runPendingFileCleanup } from "./pending-cleanup.ts";

/**
 * pending 行保留策略的集成测试（#31 切片 1）：真实 PG 上的按年龄删除 +
 * 对象先删行后删的次序。key 随机、断言只看本套件自建的行——共库上其他运行
 * 的残留行年龄上属于「该清的」，被顺带清掉正是期望行为，不影响断言。
 */

const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

const userId = randomUUID();

describe.skipIf(!databaseUrl)("pending file cleanup (#31, integration)", () => {
  const { db, pool } = createDb(databaseUrl ?? "");
  // 内存桶：delete 可注入失败（对象删不掉 → 行留待下一轮）
  const storageObjects = new Set<string>();
  let failDeleteFor: string | null = null;
  const storage: Storage = {
    put: () => Promise.reject(new Error("not used")),
    signedGetUrl: () => Promise.reject(new Error("not used")),
    signedPutUrl: () => Promise.reject(new Error("not used")),
    delete: (key: string) => {
      if (failDeleteFor === key) return Promise.reject(new Error("delete failed"));
      storageObjects.delete(key);
      return Promise.resolve();
    },
    head: () => Promise.reject(new Error("not used")),
  };

  beforeAll(async () => {
    await runMigrations(db);
    await db.insert(schema.authUser).values({
      id: userId,
      name: "Uploader U",
      email: "uploader@example.com",
      emailVerified: true,
    });
  });

  beforeEach(() => {
    storageObjects.clear();
    failDeleteFor = null;
  });

  afterEach(async () => {
    await db.delete(schema.files);
  });

  afterAll(async () => {
    await db.delete(schema.authUser).where(eq(schema.authUser.id, userId));
    await pool.end();
  });

  async function insertPending(key: string, createdAt: Date): Promise<string> {
    const id = randomUUID();
    await db.insert(schema.files).values({
      id,
      subjectType: "feedback_report",
      subjectId: randomUUID(),
      status: "pending",
      fileName: "abandoned.png",
      contentType: "image/png",
      sizeBytes: 10,
      storageKey: key,
      uploadedBy: userId,
      createdAt,
    });
    return id;
  }

  it("过期 pending 行连同对象一起清；新鲜 pending 与 ready 行保留", async () => {
    const now = new Date();
    const staleId = await insertPending(`stale/${randomUUID()}`, new Date(now.getTime() - 25 * 3_600_000));
    const freshId = await insertPending(`fresh/${randomUUID()}`, now);
    const readyId = randomUUID();
    await db.insert(schema.files).values({
      id: readyId,
      subjectType: "feedback_report",
      subjectId: randomUUID(),
      status: "ready",
      fileName: "kept.png",
      contentType: "image/png",
      sizeBytes: 10,
      storageKey: `ready/${randomUUID()}`,
      uploadedBy: userId,
      createdAt: new Date(now.getTime() - 48 * 3_600_000),
      readyAt: new Date(now.getTime() - 47 * 3_600_000),
    });
    for (const key of await db
      .select({ key: schema.files.storageKey })
      .from(schema.files)) {
      storageObjects.add(key.key);
    }

    const result = await runPendingFileCleanup(db, storage, logger, now);
    expect(result.filesDeleted).toBeGreaterThanOrEqual(1);
    expect(result.objectsFailed).toBe(0);

    const remaining = await db.select({ id: schema.files.id }).from(schema.files);
    const remainingIds = remaining.map((r) => r.id);
    expect(remainingIds).not.toContain(staleId);
    expect(remainingIds).toContain(freshId);
    expect(remainingIds).toContain(readyId);
    expect([...storageObjects].some((k) => k.startsWith("stale/"))).toBe(false);
  });

  it("对象删不掉：行保留，留待下一轮（台账始终指向还没删掉的东西）", async () => {
    const now = new Date();
    const key = `stuck/${randomUUID()}`;
    const stuckId = await insertPending(key, new Date(now.getTime() - 25 * 3_600_000));
    storageObjects.add(key);
    failDeleteFor = key;

    const result = await runPendingFileCleanup(db, storage, logger, now);
    expect(result.objectsFailed).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(schema.files).where(eq(schema.files.id, stuckId));
    expect(row?.id).toBe(stuckId);
  });
});
