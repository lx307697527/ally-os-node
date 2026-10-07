import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { SessionData } from "../auth/session.ts";
import { createAuthzStore } from "../authz/service.ts";

// 集成测试：需要真实 PostgreSQL（台账读写、恢复事务、audit.read 权限点走真实
// authz）。未设 DATABASE_URL 时跳过。
//
// 本文件用**独立的临时库**（样板：routes/audit-events.test.ts）——断言台账与
// 审计的精确行数，共享库上其他文件的清理会随机干扰。临时库整体生灭。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

/** owner/admin 持 audit.read；alice 是行属（sales）；carol 纯 customer */
const USERS = {
  owner: randomUUID(),
  alice: randomUUID(),
  carol: randomUUID(),
} as const;

type UserName = keyof typeof USERS;

function sessionFor(userId: string, name: string): SessionData {
  const displayName = name.charAt(0).toUpperCase() + name.slice(1);
  return {
    user: {
      id: userId,
      email: `${name}@example.com`,
      name: displayName,
      emailVerified: true,
      twoFactorEnabled: true,
    },
    session: { id: `s-${userId}`, userId, expiresAt: new Date(Date.now() + 3_600_000) },
  };
}

describe.skipIf(!databaseUrl)("deleted records route (#29 slice 2, integration)", () => {
  const dbName = `deleted_records_test_${String(Date.now())}_${String(process.pid)}`;
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
  // 并行套件 drop … with (force) 的 57P01 会炸掉整个 vitest 进程（样板护栏）
  pool.on("error", () => {});
  admin.pool.on("error", () => {});

  const nudged: string[][] = [];

  const app = createApp({
    logger,
    db,
    corsOrigins: ["http://localhost:5173"],
    checkDatabase: async () => {
      await pool.query("select 1");
    },
    authHandler: () => Promise.reject(new Error("auth handler should not be called")),
    resolveSession: (headers) => {
      const who = headers.get("x-test-user");
      if (who === null || !(who in USERS)) return Promise.resolve(null);
      const name = who as UserName;
      return Promise.resolve(sessionFor(USERS[name], name));
    },
    socialProviders: [],
    storage: {
      put: () => Promise.reject(new Error("storage not used in this suite")),
      signedGetUrl: () => Promise.reject(new Error("storage not used in this suite")),
      signedPutUrl: () => Promise.reject(new Error("storage not used in this suite")),
      delete: () => Promise.reject(new Error("storage not used in this suite")),
    },
    // 真实 authzStore：audit.read 门走角色加载（stub 恒空 = 谁都 403）
    authzStore: createAuthzStore(db),
    notifyUsers: (userIds) => {
      nudged.push([...userIds]);
      return Promise.resolve();
    },
  });

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("unreachable: suite is skipped without DATABASE_URL");
    await admin.pool.query(`create database "${dbName}"`);
    await runMigrations(db);
    await db.insert(schema.authUser).values([
      { id: USERS.owner, name: "Owner", email: "owner@example.com", emailVerified: true },
      { id: USERS.alice, name: "Alice", email: "alice@example.com", emailVerified: true },
      { id: USERS.carol, name: "Carol", email: "carol@example.com", emailVerified: true },
    ]);
    await db.insert(schema.userRole).values([
      { userId: USERS.owner, role: "owner" },
      { userId: USERS.alice, role: "sales" },
      { userId: USERS.carol, role: "customer" },
    ]);
  });

  beforeEach(async () => {
    // 整库是本文件的：共享面表每条测试前清空（audit_events append-only，TRUNCATE
    // 是唯一清库通道——本文件自己的临时库，不与并行文件互相干扰）
    await db.execute(sql`truncate table ${schema.tasks}`);
    await db.execute(sql`truncate table ${schema.deletedRecords}`);
    await db.execute(sql`truncate table ${schema.auditEvents}`);
    nudged.length = 0;
  });

  afterAll(async () => {
    await pool.end();
    await admin.pool.query(`drop database if exists "${dbName}" with (force)`);
    await admin.pool.end();
  });

  const owner = { "x-test-user": "owner" };
  const alice = { "x-test-user": "alice" };

  async function createTaskByApi(title: string): Promise<string> {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", ...alice },
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { task: { id: string } };
    return json.task.id;
  }

  async function deleteTaskByApi(taskId: string): Promise<void> {
    const res = await app.request(`/api/tasks/${taskId}`, { method: "DELETE", headers: alice });
    expect(res.status).toBe(200);
  }

  interface LedgerRow {
    id: string;
    subjectType: string;
    subjectId: string;
    title: string;
    snapshot: Record<string, unknown>;
    deletedBy: { id: string; name: string } | null;
    deletedAt: string;
    restoredBy: { id: string; name: string } | null;
    restoredAt: string | null;
  }

  it("验收第 2 条：删除的任务在台账里可见（谁删的/什么时候/快照），行属 403、无权限 403", async () => {
    const taskId = await createTaskByApi("台账可见");
    await deleteTaskByApi(taskId);

    // 行属（sales）没有 audit.read：删除记录页与审计日志同门
    const asAlice = await app.request("/api/deleted-records", { headers: alice });
    expect(asAlice.status).toBe(403);

    const res = await app.request("/api/deleted-records", { headers: owner });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { records: LedgerRow[]; total: number };
    expect(json.total).toBe(1);
    const row = json.records[0];
    expect(row?.subjectType).toBe("task");
    expect(row?.subjectId).toBe(taskId);
    expect(row?.title).toBe("台账可见");
    expect(row?.deletedBy?.name).toBe("Alice");
    expect(row?.restoredAt).toBeNull();
    // 快照原样：删除时刻的行投影
    expect(row?.snapshot.title).toBe("台账可见");
    expect(row?.snapshot.id).toBe(taskId);
  });

  it("恢复端到端：任务回到一切读面，台账原地补 restored_*，审计 task.restored", async () => {
    const taskId = await createTaskByApi("恢复往返");
    await deleteTaskByApi(taskId);
    expect(
      (await app.request(`/api/tasks/${taskId}`, { headers: alice })).status,
    ).toBe(404);

    const ledgerRows = await db.select().from(schema.deletedRecords);
    const ledgerId = ledgerRows[0]?.id;
    expect(ledgerId).toBeTruthy();

    const res = await app.request(`/api/deleted-records/${ledgerId}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json", ...owner },
      body: JSON.stringify({ reason: "deleted by mistake" }),
    });
    expect(res.status).toBe(200);
    const { record } = (await res.json()) as { record: LedgerRow };
    expect(record.restoredAt).not.toBeNull();
    expect(record.restoredBy?.name).toBe("Owner");

    // 任务回到一切读面：详情 200、创建人列表可见
    const detail = await app.request(`/api/tasks/${taskId}`, { headers: alice });
    expect(detail.status).toBe(200);
    const list = await app.request("/api/tasks?scope=created", { headers: alice });
    const listJson = (await list.json()) as { tasks: { id: string }[] };
    expect(listJson.tasks.map((t) => t.id)).toContain(taskId);

    // 审计两行一个圈：task.deleted + task.restored（target = 任务行 id，
    // 恢复后记录的时间线能看到完整圈；reason/台账引用在 detail）
    const audits = await db
      .select({ action: schema.auditEvents.action, detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "task.restored"));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail).toMatchObject({ title: "恢复往返", reason: "deleted by mistake" });

    // 台账行不随恢复消失：原地补 restored_*，删除史保留
    const after = await db.select().from(schema.deletedRecords);
    expect(after).toHaveLength(1);
    expect(after[0]?.restoredAt).not.toBeNull();
    expect(after[0]?.restoredBy).toBe(USERS.owner);

    // 再恢复：已在飞的删除没有了，409 restored_already
    const again = await app.request(`/api/deleted-records/${ledgerId}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json", ...owner },
      body: JSON.stringify({}),
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error?: string }).error).toBe("restored_already");
  });

  it("fail closed：未注册类型 restore_unsupported、行已不在 subject_missing、未知台账行 404", async () => {
    // 未注册类型：台账行存得进（历史上存在过的域），恢复必拒
    await db.insert(schema.deletedRecords).values({
      subjectType: "gadget",
      subjectId: randomUUID(),
      title: "不可恢复的东西",
      snapshot: {},
      deletedBy: null,
    });
    const rows = await db.select().from(schema.deletedRecords);
    const unregistered = rows[0]?.id;
    expect(unregistered).toBeTruthy();
    const res = await app.request(`/api/deleted-records/${unregistered}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json", ...owner },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe("restore_unsupported");

    // 行已不在（物理清除过的 subject）：恢复不伪造成功
    const ghostId = randomUUID();
    await db.insert(schema.deletedRecords).values({
      subjectType: "task",
      subjectId: ghostId,
      title: "幽灵任务",
      snapshot: {},
      deletedBy: null,
    });
    const ghost = await app.request(`/api/deleted-records/${ghostId}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json", ...owner },
      body: JSON.stringify({}),
    });
    // 台账行身份是自己的 uuid；上面直接以 subjectId 当路径参数找不到行 → 404
    expect(ghost.status).toBe(404);
    const ghostRows = await db
      .select()
      .from(schema.deletedRecords)
      .where(eq(schema.deletedRecords.subjectId, ghostId));
    const ghostLedgerId = ghostRows[0]?.id;
    expect(ghostLedgerId).toBeTruthy();
    const ghostRestore = await app.request(`/api/deleted-records/${ghostLedgerId}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json", ...owner },
      body: JSON.stringify({}),
    });
    expect(ghostRestore.status).toBe(409);
    expect(((await ghostRestore.json()) as { error?: string }).error).toBe("subject_missing");

    // 未知台账行：404
    const missing = await app.request(`/api/deleted-records/${randomUUID()}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json", ...owner },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(404);
  });

  it("恢复后再删 = 第二条台账行：历史不覆写，(subject, 在飞) 唯一", async () => {
    const taskId = await createTaskByApi("两圈历史");
    await deleteTaskByApi(taskId);
    const first = await db.select().from(schema.deletedRecords);
    const firstId = first[0]?.id;
    expect(firstId).toBeTruthy();
    expect(
      (
        await app.request(`/api/deleted-records/${firstId}/restore`, {
          method: "POST",
          headers: { "content-type": "application/json", ...owner },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(200);

    await deleteTaskByApi(taskId);
    const ledger = await db.select().from(schema.deletedRecords);
    expect(ledger).toHaveLength(2);
    const active = ledger.filter((row) => row.restoredAt === null);
    expect(active).toHaveLength(1);
    expect(active[0]?.subjectId).toBe(taskId);
    // 列表按删除时刻新在前
    const list = await app.request("/api/deleted-records", { headers: owner });
    const listJson = (await list.json()) as { records: LedgerRow[]; total: number };
    expect(listJson.total).toBe(2);
    expect(listJson.records[0]?.restoredAt).toBeNull();
    expect(listJson.records[1]?.restoredAt).not.toBeNull();
  });
});

/** 同一实例上连 maintenance 库（postgres）用的管理连接串 */
function adminUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl) return ""; // 套件被跳过时不会被用到
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}
