import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { SessionData } from "../auth/session.ts";
import { FEEDBACK_MAX_FILES_PER_REPORT, FEEDBACK_MAX_FILE_BYTES } from "../files/registry.ts";
import { PRESIGN_TTL_SECONDS } from "./files.ts";

// 集成测试：需要真实 PostgreSQL（files 行、锁行计数、审计行）。未设 DATABASE_URL 跳过。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

// 三个用户：submitter（报告提交人）、staff（持 feedback.manage 的员工）、
// other（无任何角色与授权的第三者）
const userIds = {
  submitter: randomUUID(),
  staff: randomUUID(),
  other: randomUUID(),
} as const;

type UserName = keyof typeof userIds;

const USERS: Record<UserName, { id: string; name: string; email: string }> = {
  submitter: { id: userIds.submitter, name: "Submitter S", email: "submitter@example.com" },
  staff: { id: userIds.staff, name: "Staff F", email: "staff@example.com" },
  other: { id: userIds.other, name: "Other O", email: "other@example.com" },
};

function sessionFor(id: string, name: UserName): SessionData {
  return {
    user: {
      id,
      email: USERS[name].email,
      name: USERS[name].name,
      emailVerified: true,
      twoFactorEnabled: true,
    },
    session: { id: `s-${id}`, userId: id, expiresAt: new Date(Date.now() + 3_600_000) },
  };
}

// 内存版对象存储：键 → 字节。complete 的 HEAD 实测、删除的对象清理断言全走它
const storageObjects = new Map<string, { body: Uint8Array; contentType?: string }>();

function makeApp() {
  const { db, pool } = createDb(databaseUrl ?? "");
  const app = createApp({
    stripe: undefined,
    sendPasswordSetupEmail: async () => {},
    paypal: undefined,
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
      return Promise.resolve(sessionFor(USERS[name].id, name));
    },
    socialProviders: [],
    storage: {
      put: (key: string, body: Uint8Array | string, contentType?: string) => {
        storageObjects.set(key, {
          body: typeof body === "string" ? new TextEncoder().encode(body) : body,
          ...(contentType === undefined ? {} : { contentType }),
        });
        return Promise.resolve();
      },
      signedGetUrl: (key: string, expiresInSeconds?: number) =>
        Promise.resolve(
          `http://storage.test/get/${key}${expiresInSeconds === undefined ? "" : `?expires=${String(expiresInSeconds)}`}`,
        ),
      signedPutUrl: (key: string, contentType: string) =>
        Promise.resolve(`http://storage.test/put/${key}?type=${encodeURIComponent(contentType)}`),
      delete: (key: string) => {
        storageObjects.delete(key);
        return Promise.resolve();
      },
      head: (key: string) =>
        Promise.resolve(
          storageObjects.has(key)
            ? { sizeBytes: storageObjects.get(key)?.body.byteLength ?? 0 }
            : null,
        ),
    },
    authzStore: {
      getRoles: () => Promise.resolve([]),
      // staff 持个人附加授权 feedback.manage（与角色默认集解耦的授予路径）
      getDirectPermissions: (uid: string) =>
        Promise.resolve(uid === userIds.staff ? (["feedback.manage"] as const) : []),
      grantRole: () => Promise.reject(new Error("not used")),
      revokeRole: () => Promise.reject(new Error("not used")),
    },
    notifyUsers: async () => {},
  });
  return { app, db, pool };
}

describe.skipIf(!databaseUrl)("file kernel: presign direct upload (#31, integration)", () => {
  const { app, db, pool } = makeApp();
  let reportId: string;

  // 直接落报告行（不经过提交端点：那是 #129 套件的事）：提交人是 submitter
  async function createReport(): Promise<string> {
    const id = randomUUID();
    await db.insert(schema.feedbackReports).values({
      id,
      reportNumber: `BR-${randomUUID().slice(0, 8)}`,
      type: "bug_report",
      title: "Attachment flow test",
      description: "Body.",
      priority: "low",
      submittedByUserId: userIds.submitter,
      submitterName: USERS.submitter.name,
      submitterEmail: USERS.submitter.email,
    });
    return id;
  }

  /** 走完 presign + 模拟客户端直传（把字节放进假桶） */
  async function presignAndUpload(
    file: { name: string; type: string; body: string },
    as: UserName = "submitter",
  ): Promise<{ status: number; body: { fileId?: string; key?: string; uploadUrl?: string; code?: string } }> {
    const presign = await app.request("/api/files/presign", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": as },
      body: JSON.stringify({
        subjectType: "feedback_report",
        subjectId: reportId,
        fileName: file.name,
        contentType: file.type,
        sizeBytes: file.body.length,
      }),
    });
    const presigned = (await presign.json()) as {
      fileId?: string;
      key?: string;
      uploadUrl?: string;
      code?: string;
    };
    if (presign.status !== 201 || presigned.key === undefined) {
      return { status: presign.status, body: presigned };
    }
    // 模拟客户端拿预签名 URL 直传：字节进桶，不经 API
    storageObjects.set(presigned.key, { body: new TextEncoder().encode(file.body) });
    return { status: presign.status, body: presigned };
  }

  beforeAll(async () => {
    await runMigrations(db);
    for (const name of Object.keys(USERS) as UserName[]) {
      await db.insert(schema.authUser).values({
        id: USERS[name].id,
        name: USERS[name].name,
        email: USERS[name].email,
        emailVerified: true,
      });
    }
  });

  beforeEach(async () => {
    reportId = await createReport();
  });

  afterEach(async () => {
    // 审计行不清：表 append-only（0007 触发器），且库是共吃的——审计断言
    // 一律按 target = fileId（uuid）圈定到本套件自己的行
    await db.delete(schema.files);
    await db.delete(schema.feedbackReports);
    storageObjects.clear();
  });

  afterAll(async () => {
    for (const name of Object.keys(USERS) as UserName[]) {
      await db.delete(schema.authUser).where(eq(schema.authUser.id, USERS[name].id));
    }
    await pool.end();
  });

  it("未登录 401", async () => {
    const res = await app.request("/api/files/presign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subjectType: "feedback_report",
        subjectId: reportId,
        fileName: "a.png",
        contentType: "image/png",
        sizeBytes: 10,
      }),
    });
    expect(res.status).toBe(401);
  });

  it("presign 快乐路径：201、pending 行落账、key 无用户输入、预签名 URL 含 key", async () => {
    const res = await app.request("/api/files/presign", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "submitter" },
      body: JSON.stringify({
        subjectType: "feedback_report",
        subjectId: reportId,
        fileName: "screenshot.png",
        contentType: "image/png",
        sizeBytes: 1234,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { fileId: string; key: string; uploadUrl: string; expiresInSeconds: number };
    expect(body.key).toMatch(new RegExp(`^feedback-attachments/${reportId}/[0-9a-f-]{36}$`));
    expect(body.uploadUrl).toContain(body.key);
    expect(body.expiresInSeconds).toBe(PRESIGN_TTL_SECONDS);

    const [row] = await db.select().from(schema.files);
    expect(row?.status).toBe("pending");
    expect(row?.sizeBytes).toBe(1234);
    expect(row?.uploadedBy).toBe(userIds.submitter);
    expect(row?.readyAt).toBeNull();
  });

  it("presign 门：未注册类型 400、报告不存在 404、不可见者 404（反探测）、看得到但不能传的员工 403", async () => {
    const base = {
      subjectType: "feedback_report",
      subjectId: reportId,
      fileName: "a.png",
      contentType: "image/png",
      sizeBytes: 10,
    };
    const unregistered = await app.request("/api/files/presign", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "submitter" },
      body: JSON.stringify({ ...base, subjectType: "no_such_type" }),
    });
    expect(unregistered.status).toBe(400);

    const missing = await app.request("/api/files/presign", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "submitter" },
      body: JSON.stringify({ ...base, subjectId: randomUUID() }),
    });
    expect(missing.status).toBe(404);

    // other 看不到别人的报告：404 与不存在同回答（反探测）
    const invisible = await app.request("/api/files/presign", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "other" },
      body: JSON.stringify(base),
    });
    expect(invisible.status).toBe(404);

    // staff 持 feedback.manage 看得到报告，但上传是提交人的动词 → 403
    const staffAttach = await app.request("/api/files/presign", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "staff" },
      body: JSON.stringify(base),
    });
    expect(staffAttach.status).toBe(403);
  });

  it("presign 准入：白名单外类型 400、声明超限 400、坏文件名 400", async () => {
    const cases = [
      { fileName: "notes.txt", contentType: "text/plain", sizeBytes: 10 },
      { fileName: "huge.png", contentType: "image/png", sizeBytes: FEEDBACK_MAX_FILE_BYTES + 1 },
      { fileName: "  ", contentType: "image/png", sizeBytes: 10 },
      { fileName: "bad\u0000name.png", contentType: "image/png", sizeBytes: 10 },
    ];
    for (const file of cases) {
      const res = await app.request("/api/files/presign", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": "submitter" },
        body: JSON.stringify({
          subjectType: "feedback_report",
          subjectId: reportId,
          ...file,
        }),
      });
      expect(res.status).toBe(400);
    }
    // pending 行一个都没落
    const rows = await db.select().from(schema.files);
    expect(rows).toHaveLength(0);
  });

  it("complete：HEAD 实测覆写声明值、转 ready、落 file.added 审计；再 complete 幂等", async () => {
    const uploaded = await presignAndUpload({
      name: "shot.png",
      type: "image/png",
      body: "actual-bytes-differ-from-declared-size",
    });
    expect(uploaded.status).toBe(201);
    const fileId = uploaded.body.fileId;
    if (fileId === undefined) throw new Error("presign returned no fileId");

    const res = await app.request(`/api/files/${fileId}/complete`, {
      method: "POST",
      headers: { "x-test-user": "submitter" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { file: { status: string; sizeBytes: number; readyAt?: string } };
    expect(body.file.status).toBe("ready");
    // 台账记的是 S3 实测字节，不是 presign 时客户端声明的大小
    expect(body.file.sizeBytes).toBe("actual-bytes-differ-from-declared-size".length);
    expect(body.file.readyAt).toBeDefined();

    const audits = await db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.action, "file.added"), eq(schema.auditEvents.target, fileId)));
    expect(audits).toHaveLength(1);

    // 幂等：重试的 complete 原样回答，不再写审计
    const retry = await app.request(`/api/files/${fileId}/complete`, {
      method: "POST",
      headers: { "x-test-user": "submitter" },
    });
    expect(retry.status).toBe(200);
    const auditsAfter = await db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.action, "file.added"), eq(schema.auditEvents.target, fileId)));
    expect(auditsAfter).toHaveLength(1);
  });

  it("complete：没上传过对象 400 object_missing（行留 pending）；他人 complete 403", async () => {
    const presign = await app.request("/api/files/presign", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "submitter" },
      body: JSON.stringify({
        subjectType: "feedback_report",
        subjectId: reportId,
        fileName: "never-uploaded.png",
        contentType: "image/png",
        sizeBytes: 5,
      }),
    });
    expect(presign.status).toBe(201);
    const { fileId } = (await presign.json()) as { fileId: string };

    const missing = await app.request(`/api/files/${fileId}/complete`, {
      method: "POST",
      headers: { "x-test-user": "submitter" },
    });
    expect(missing.status).toBe(400);
    const [row] = await db.select().from(schema.files);
    expect(row?.status).toBe("pending");

    const forbidden = await app.request(`/api/files/${fileId}/complete`, {
      method: "POST",
      headers: { "x-test-user": "staff" },
    });
    expect(forbidden.status).toBe(403);
  });

  it("complete：实测字节超限拒绝记账，行留 pending 交清扫", async () => {
    // 声明合法大小拿预签名，实际直传超额字节（预签名 PUT 不绑 Content-Length）
    const presign = await app.request("/api/files/presign", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "submitter" },
      body: JSON.stringify({
        subjectType: "feedback_report",
        subjectId: reportId,
        fileName: "oversize.png",
        contentType: "image/png",
        sizeBytes: 10,
      }),
    });
    const { fileId, key } = (await presign.json()) as { fileId: string; key: string };
    storageObjects.set(key, {
      body: new Uint8Array(FEEDBACK_MAX_FILE_BYTES + 1),
    });

    const res = await app.request(`/api/files/${fileId}/complete`, {
      method: "POST",
      headers: { "x-test-user": "submitter" },
    });
    expect(res.status).toBe(400);
    const [row] = await db.select().from(schema.files);
    expect(row?.status).toBe("pending");
    expect(row?.sizeBytes).toBe(10);
  });

  it("名单额：pending 占坑，并发 presign 在锁内裁决不超 3", async () => {
    const bodies = Array.from({ length: FEEDBACK_MAX_FILES_PER_REPORT + 2 }, (_, i) => ({
      subjectType: "feedback_report",
      subjectId: reportId,
      fileName: `shot-${String(i)}.png`,
      contentType: "image/png",
      sizeBytes: 10,
    }));
    const responses = await Promise.all(
      bodies.map(async (body) =>
        app.request("/api/files/presign", {
          method: "POST",
          headers: { "content-type": "application/json", "x-test-user": "submitter" },
          body: JSON.stringify(body),
        }),
      ),
    );
    const created = responses.filter((r) => r.status === 201);
    const rejected = responses.filter((r) => r.status === 400);
    expect(created).toHaveLength(FEEDBACK_MAX_FILES_PER_REPORT);
    expect(rejected).toHaveLength(2);
    const rows = await db.select().from(schema.files);
    expect(rows).toHaveLength(FEEDBACK_MAX_FILES_PER_REPORT);
  });

  it("列表只含 ready；staff（feedback.manage）看得到、other 看不到", async () => {
    const done = await presignAndUpload({ name: "ok.png", type: "image/png", body: "x" });
    expect(done.status).toBe(201);
    const pending = await app.request("/api/files/presign", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "submitter" },
      body: JSON.stringify({
        subjectType: "feedback_report",
        subjectId: reportId,
        fileName: "pending.png",
        contentType: "image/png",
        sizeBytes: 4,
      }),
    });
    expect(pending.status).toBe(201);
    const pendingId = ((await pending.json()) as { fileId: string }).fileId;
    if (done.body.fileId === undefined) throw new Error("no fileId");
    const complete = await app.request(`/api/files/${done.body.fileId}/complete`, {
      method: "POST",
      headers: { "x-test-user": "submitter" },
    });
    expect(complete.status).toBe(200);

    const mine = await app.request(`/api/files?subjectType=feedback_report&subjectId=${reportId}`, {
      headers: { "x-test-user": "submitter" },
    });
    expect(mine.status).toBe(200);
    const mineBody = (await mine.json()) as { files: { id: string }[] };
    expect(mineBody.files.map((f) => f.id)).toEqual([done.body.fileId]);

    const staffView = await app.request(
      `/api/files?subjectType=feedback_report&subjectId=${reportId}`,
      { headers: { "x-test-user": "staff" } },
    );
    expect(staffView.status).toBe(200);

    const otherView = await app.request(
      `/api/files?subjectType=feedback_report&subjectId=${reportId}`,
      { headers: { "x-test-user": "other" } },
    );
    expect(otherView.status).toBe(404);
    expect(pendingId).toBeDefined();
  });

  it("下载 URL：ready 才有；staff 可取（签名 URL 发给有权限的人）；other 404", async () => {
    const done = await presignAndUpload({ name: "ok.png", type: "image/png", body: "xyz" });
    if (done.body.fileId === undefined) throw new Error("no fileId");
    const complete = await app.request(`/api/files/${done.body.fileId}/complete`, {
      method: "POST",
      headers: { "x-test-user": "submitter" },
    });
    expect(complete.status).toBe(200);

    const mine = await app.request(`/api/files/${done.body.fileId}/url`, {
      headers: { "x-test-user": "submitter" },
    });
    expect(mine.status).toBe(200);
    const mineBody = (await mine.json()) as { url: string; expiresInSeconds: number };
    expect(mineBody.url).toContain("storage.test/get/feedback-attachments/");
    expect(mineBody.expiresInSeconds).toBe(600);

    const staffUrl = await app.request(`/api/files/${done.body.fileId}/url`, {
      headers: { "x-test-user": "staff" },
    });
    expect(staffUrl.status).toBe(200);

    const otherUrl = await app.request(`/api/files/${done.body.fileId}/url`, {
      headers: { "x-test-user": "other" },
    });
    expect(otherUrl.status).toBe(404);

    // pending 行没有可签的对象：与不存在同回答
    const pending = await app.request("/api/files/presign", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "submitter" },
      body: JSON.stringify({
        subjectType: "feedback_report",
        subjectId: reportId,
        fileName: "pending2.png",
        contentType: "image/png",
        sizeBytes: 4,
      }),
    });
    const pendingId = ((await pending.json()) as { fileId: string }).fileId;
    const pendingUrl = await app.request(`/api/files/${pendingId}/url`, {
      headers: { "x-test-user": "submitter" },
    });
    expect(pendingUrl.status).toBe(404);
  });

  it("删除：上传人删行走删对象，staff（看得到但不能删）403；删除落 file.deleted 审计", async () => {
    const done = await presignAndUpload({ name: "bye.png", type: "image/png", body: "gone" });
    if (done.body.fileId === undefined || done.body.key === undefined) {
      throw new Error("no fileId");
    }
    const staffDelete = await app.request(`/api/files/${done.body.fileId}`, {
      method: "DELETE",
      headers: { "x-test-user": "staff" },
    });
    expect(staffDelete.status).toBe(403);

    const res = await app.request(`/api/files/${done.body.fileId}`, {
      method: "DELETE",
      headers: { "x-test-user": "submitter" },
    });
    expect(res.status).toBe(200);
    const rows = await db.select().from(schema.files);
    expect(rows).toHaveLength(0);
    expect(storageObjects.has(done.body.key)).toBe(false);
    const audits = await db
      .select()
      .from(schema.auditEvents)
      .where(
        and(eq(schema.auditEvents.action, "file.deleted"), eq(schema.auditEvents.target, done.body.fileId)),
      );
    expect(audits).toHaveLength(1);
  });
});
