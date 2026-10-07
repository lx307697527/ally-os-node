import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { SessionData } from "../auth/session.ts";
import { createAuthzStore } from "../authz/service.ts";
import { registerFormSubject } from "../custom-fields/registry.ts";

// 集成测试：需要真实 PostgreSQL（字段定义元数据、值 upsert、审计同事务）。
// 未设 DATABASE_URL 时跳过。
//
// 本文件用**独立的临时库**（每次运行新建、跑完 drop，纪律同 tasks.test.ts）：
// 值行的唯一约束、defs 的唯一键、审计行数断言都要求干净的断言面，共享库上
// 并行文件的残行会随机干扰。TRUNCATE 是本文件自己的清库通道。
//
// 表单 subject 注册表是模块级的：本文件注册夹具域（与生产同一条接缝），vitest
// 按文件隔离模块，不会泄漏到其他文件；生产注册表仍为空（消费域未进场）。
const FIXTURE_SUBJECT = "custom_fields_test_form";
registerFormSubject(FIXTURE_SUBJECT, {
  builtin: { company: z.string().min(1), headcount: z.number() },
});

const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

/** admin 持配置权限点；dave 持 finance（字段级权限的持权方）；bob 持 sales
 * （任务的 assignee 必须有非 customer 角色）；alice/carol 零角色。角色走真
 * user_role 表 + 真 authzStore（权限链端到端），不做 store 桩。 */
const USERS = {
  admin: randomUUID(),
  alice: randomUUID(),
  bob: randomUUID(),
  carol: randomUUID(),
  dave: randomUUID(),
} as const;

type UserName = keyof typeof USERS;

const USER_ROLES: Partial<Record<UserName, "admin" | "sales" | "finance">> = {
  admin: "admin",
  bob: "sales",
  dave: "finance",
};

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

function adminUrl(databaseUrl: string | undefined): string {
  if (databaseUrl === undefined) return "";
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("unexpected missing value in test");
  return value;
}

describe.skipIf(!databaseUrl)("custom field endpoints (#222 slice 1, integration)", () => {
  const dbName = `custom_fields_test_${String(Date.now())}_${String(process.pid)}`;
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
    // 任务可见性门的载体：auth_user 行先行（defs.created_by_id / 任务参与者都指向它）
    await db.insert(schema.authUser).values(
      (Object.keys(USERS) as UserName[]).map((name) => ({
        id: USERS[name],
        name: name.charAt(0).toUpperCase() + name.slice(1),
        email: `${name}@example.com`,
        emailVerified: true,
      })),
    );
    // 角色落真表：authz 上下文与任务 assignee 校验同源
    await db.insert(schema.userRole).values(
      (Object.entries(USER_ROLES) as [UserName, "admin" | "sales" | "finance"][]).map(
        ([name, role]) => ({ userId: USERS[name], role }),
      ),
    );
  });

  beforeEach(async () => {
    // 单语句 TRUNCATE：values → defs 有 FK（gotcha：单语句）；tasks/audit/notifications
    // 是本文件的断言面
    await db.execute(
      sql`truncate table ${schema.customFieldValues}, ${schema.customFieldDefs}, ${schema.tasks}, ${schema.notifications}, ${schema.auditEvents} cascade`,
    );
    nudged.length = 0;
  });

  afterAll(async () => {
    await pool.end();
    await admin.pool.query(`drop database if exists "${dbName}" with (force)`);
    await admin.pool.end();
  });

  const adminHeaders = { "x-test-user": "admin" };
  const alice = { "x-test-user": "alice" };
  const dave = { "x-test-user": "dave" };
  const jsonHeaders = { "content-type": "application/json" };

  async function createField(headers: Record<string, string>, body: Record<string, unknown>) {
    return app.request("/api/custom-fields", {
      method: "POST",
      headers: { ...jsonHeaders, ...headers },
      body: JSON.stringify(body),
    });
  }

  async function createTask(headers: Record<string, string>, assigneeId: string): Promise<string> {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { ...jsonHeaders, ...headers },
      body: JSON.stringify({ title: "跟进样品", assigneeId }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { task?: { id?: string } };
    return must(body.task?.id);
  }

  interface FieldRow {
    id: string;
    fieldKey: string;
    label: string;
    fieldType: string;
    required: boolean;
    value: unknown;
  }

  async function getSubjectFields(
    headers: Record<string, string>,
    subjectType: string,
    subjectId: string,
  ): Promise<{ status: number; fields: FieldRow[] }> {
    const res = await app.request(`/api/subjects/${subjectType}/${subjectId}/custom-fields`, {
      headers,
    });
    const json = (await res.json()) as { fields?: FieldRow[] };
    return { status: res.status, fields: json.fields ?? [] };
  }

  it("field configuration sits behind custom_fields.configure (403 for plain users)", async () => {
    const body = { subjectType: "task", fieldKey: "po_number", label: "PO 号", fieldType: "text" };
    const post = await createField(alice, body);
    expect(post.status).toBe(403);
    const list = await app.request("/api/custom-fields", { headers: alice });
    expect(list.status).toBe(403);
    const patch = await app.request(`/api/custom-fields/${randomUUID()}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...alice },
      body: JSON.stringify({ active: false }),
    });
    expect(patch.status).toBe(403);
    // 持权角色（admin 默认矩阵）放行
    const ok = await createField(adminHeaders, body);
    expect(ok.status).toBe(201);
  });

  it("create validates shape at save time: options, key format, roles, builtin collisions", async () => {
    const dupOptions = await createField(adminHeaders, {
      subjectType: FIXTURE_SUBJECT,
      fieldKey: "tier",
      label: "客户分级",
      fieldType: "select",
      options: ["a", "a"],
    });
    expect(dupOptions.status).toBe(422);
    const noOptions = await createField(adminHeaders, {
      subjectType: FIXTURE_SUBJECT,
      fieldKey: "tier",
      label: "客户分级",
      fieldType: "select",
    });
    expect(noOptions.status).toBe(422);
    const strayOptions = await createField(adminHeaders, {
      subjectType: FIXTURE_SUBJECT,
      fieldKey: "notes",
      label: "备注",
      fieldType: "text",
      options: ["a"],
    });
    expect(strayOptions.status).toBe(422);
    const badKey = await createField(adminHeaders, {
      subjectType: FIXTURE_SUBJECT,
      fieldKey: "Foo Bar",
      label: "x",
      fieldType: "text",
    });
    expect(badKey.status).toBe(400);
    const badRole = await createField(adminHeaders, {
      subjectType: FIXTURE_SUBJECT,
      fieldKey: "secret",
      label: "x",
      fieldType: "text",
      viewableBy: ["not_a_role"],
    });
    expect(badRole.status).toBe(400);
    const builtinConflict = await createField(adminHeaders, {
      subjectType: FIXTURE_SUBJECT,
      fieldKey: "company",
      label: "公司（内置同名）",
      fieldType: "text",
    });
    expect(builtinConflict.status).toBe(422);
    const conflictBody = (await builtinConflict.json()) as { error?: string };
    expect(conflictBody.error).toBe("builtin_key_conflict");

    const ok = await createField(adminHeaders, {
      subjectType: FIXTURE_SUBJECT,
      fieldKey: "tier",
      label: "客户分级",
      fieldType: "select",
      options: ["a", "b"],
    });
    expect(ok.status).toBe(201);
    const duplicate = await createField(adminHeaders, {
      subjectType: FIXTURE_SUBJECT,
      fieldKey: "tier",
      label: "客户分级",
      fieldType: "select",
      options: ["a", "b"],
    });
    expect(duplicate.status).toBe(409);
  });

  it("schema endpoint composes builtin + active custom fields into one JSON Schema", async () => {
    const missing = await app.request("/api/custom-fields/schema", { headers: alice });
    expect(missing.status).toBe(400);
    const unregistered = await app.request(
      "/api/custom-fields/schema?subjectType=no_such_form",
      { headers: alice },
    );
    expect(unregistered.status).toBe(400);

    await createField(adminHeaders, {
      subjectType: FIXTURE_SUBJECT,
      fieldKey: "annual_revenue",
      label: "年营收",
      fieldType: "number",
      required: true,
    });
    const retired = await createField(adminHeaders, {
      subjectType: FIXTURE_SUBJECT,
      fieldKey: "legacy",
      label: "旧字段",
      fieldType: "text",
    });
    expect(retired.status).toBe(201);
    const retiredBody = (await retired.json()) as { id?: string };
    const off = await app.request(`/api/custom-fields/${retiredBody.id}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ active: false }),
    });
    expect(off.status).toBe(200);

    const res = await app.request(`/api/custom-fields/schema?subjectType=${FIXTURE_SUBJECT}`, {
      headers: alice,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      schema: { properties: Record<string, unknown>; required: string[] };
      fields: { fieldKey: string }[];
    };
    // 内置字段在前、生效自定义字段在后；停用字段不出现
    expect(Object.keys(body.schema.properties).sort()).toEqual([
      "annual_revenue",
      "company",
      "headcount",
    ]);
    expect(body.schema.required.sort()).toEqual(["annual_revenue", "company", "headcount"]);
    expect(body.fields.map((field) => field.fieldKey)).toEqual(["annual_revenue"]);
  });

  it("values submission enforces required and field permissions server-side", async () => {
    const poNumber = await createField(adminHeaders, {
      subjectType: "task",
      fieldKey: "po_number",
      label: "PO 号",
      fieldType: "text",
      required: true,
    });
    expect(poNumber.status).toBe(201);
    const commission = await createField(adminHeaders, {
      subjectType: "task",
      fieldKey: "commission_rate",
      label: "佣金率",
      fieldType: "number",
      viewableBy: ["finance"],
      editableBy: ["finance"],
    });
    expect(commission.status).toBe(201);
    const stageGate = await createField(adminHeaders, {
      subjectType: "task",
      fieldKey: "stage_gate",
      label: "阶段门槛",
      fieldType: "select",
      options: ["passed", "blocked"],
    });
    expect(stageGate.status).toBe(201);

    // 任务指给 dave：可见者 = 创建人 alice + 经办人 dave——字段级权限是 subject
    // 可见性门之内的第二道门，看不见记录的人字段再宽的 editableBy 也写不了
    const taskId = await createTask(alice, USERS.dave);

    // 必填缺失：服务端拒绝（验收第 2 条）
    const missing = await app.request(`/api/subjects/task/${taskId}/custom-fields`, {
      method: "PUT",
      headers: { ...jsonHeaders, ...alice },
      body: JSON.stringify({ values: {} }),
    });
    expect(missing.status).toBe(422);
    const missingBody = (await missing.json()) as { issues?: { fieldKey: string; code: string }[] };
    expect(missingBody.issues).toContainEqual({ fieldKey: "po_number", code: "required" });

    // 越权写 finance 专属字段：整单拒绝，一个字节都不落库
    const forbidden = await app.request(`/api/subjects/task/${taskId}/custom-fields`, {
      method: "PUT",
      headers: { ...jsonHeaders, ...alice },
      body: JSON.stringify({ values: { po_number: "PO-1", commission_rate: 5 } }),
    });
    expect(forbidden.status).toBe(422);
    const forbiddenBody = (await forbidden.json()) as { issues?: { code: string }[] };
    expect(forbiddenBody.issues).toContainEqual({ fieldKey: "commission_rate", code: "not_editable" });

    // 未知键与选项外的值逐键报错
    const unknown = await app.request(`/api/subjects/task/${taskId}/custom-fields`, {
      method: "PUT",
      headers: { ...jsonHeaders, ...alice },
      body: JSON.stringify({ values: { po_number: "PO-1", ghost: 1, stage_gate: "nope" } }),
    });
    expect(unknown.status).toBe(422);
    const unknownBody = (await unknown.json()) as { issues?: { fieldKey: string; code: string }[] };
    expect(unknownBody.issues).toContainEqual({ fieldKey: "ghost", code: "unknown_field" });
    const stageIssue = unknownBody.issues?.find((issue) => issue.fieldKey === "stage_gate");
    expect(stageIssue?.code).toBe("invalid");

    // 合法提交：审计同事务落一行
    const ok = await app.request(`/api/subjects/task/${taskId}/custom-fields`, {
      method: "PUT",
      headers: { ...jsonHeaders, ...alice },
      body: JSON.stringify({ values: { po_number: "PO-1" } }),
    });
    expect(ok.status).toBe(200);
    const auditRows = await db
      .select({ action: schema.auditEvents.action, target: schema.auditEvents.target, detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "custom_fields.values_updated"));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.target).toBe(taskId);
    expect(auditRows[0]?.detail).toMatchObject({ subjectType: "task", fieldKeys: ["po_number"] });

    // 读回：alice 看不到 finance 专属字段（连存在都不出现）；stage_gate 未填 = null
    const aliceView = await getSubjectFields(alice, "task", taskId);
    expect(aliceView.status).toBe(200);
    expect(aliceView.fields.map((field) => field.fieldKey).sort()).toEqual([
      "po_number",
      "stage_gate",
    ]);
    expect(aliceView.fields.find((field) => field.fieldKey === "po_number")?.value).toBe("PO-1");

    // dave（finance）：能写能看专属字段；重复提交仍是每字段一行（upsert）
    const daveWrite = await app.request(`/api/subjects/task/${taskId}/custom-fields`, {
      method: "PUT",
      headers: { ...jsonHeaders, ...dave },
      body: JSON.stringify({ values: { po_number: "PO-1", commission_rate: 5 } }),
    });
    expect(daveWrite.status).toBe(200);
    const daveWrite2 = await app.request(`/api/subjects/task/${taskId}/custom-fields`, {
      method: "PUT",
      headers: { ...jsonHeaders, ...dave },
      body: JSON.stringify({ values: { po_number: "PO-1", commission_rate: 7 } }),
    });
    expect(daveWrite2.status).toBe(200);
    const rows = await db
      .select({ fieldKey: schema.customFieldDefs.fieldKey, value: schema.customFieldValues.value })
      .from(schema.customFieldValues)
      .innerJoin(schema.customFieldDefs, eq(schema.customFieldValues.fieldDefId, schema.customFieldDefs.id));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.fieldKey === "commission_rate")?.value).toBe(7);

    const daveView = await getSubjectFields(dave, "task", taskId);
    expect(daveView.fields.find((field) => field.fieldKey === "commission_rate")?.value).toBe(7);

    // 无关第三人：404（反探测，与任务详情同一裁定）
    const carol = await getSubjectFields({ "x-test-user": "carol" }, "task", taskId);
    expect(carol.status).toBe(404);
  });

  it("explicit null on an optional field deletes the value row instead of 500 (#222)", async () => {
    const notes = await createField(adminHeaders, {
      subjectType: "task",
      fieldKey: "notes",
      label: "备注",
      fieldType: "text",
    });
    expect(notes.status).toBe(201);
    const taskId = await createTask(alice, USERS.bob);

    async function putValues(values: Record<string, unknown>) {
      return app.request(`/api/subjects/task/${taskId}/custom-fields`, {
        method: "PUT",
        headers: { ...jsonHeaders, ...alice },
        body: JSON.stringify({ values }),
      });
    }
    async function storedRows() {
      return db.select({ fieldKey: schema.customFieldDefs.fieldKey })
        .from(schema.customFieldValues)
        .innerJoin(schema.customFieldDefs, eq(schema.customFieldValues.fieldDefId, schema.customFieldDefs.id));
    }

    // 先有值
    const set = await putValues({ notes: "first" });
    expect(set.status).toBe(200);

    // 显式 null = 清值：200、值行物理删除——行不在场 = 未填或已清（worker 的
    // custom_field 条件块依赖「行在场即有 JSON 值」的 NOT NULL 不变式），GET 读回 null
    const clear = await putValues({ notes: null });
    expect(clear.status).toBe(200);
    expect(await storedRows()).toHaveLength(0);
    const view = await getSubjectFields(alice, "task", taskId);
    expect(view.fields.find((field) => field.fieldKey === "notes")?.value).toBeNull();

    // 审计同事务：两次提交（set + clear）各一行，清值那次 detail 记 cleared 键
    const auditRows = await db
      .select({ detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "custom_fields.values_updated"));
    expect(auditRows).toHaveLength(2);
    const clearAudit = auditRows.find(
      (row) => (row.detail as { clearedFieldKeys?: string[] }).clearedFieldKeys !== undefined,
    )?.detail as { fieldKeys?: string[]; clearedFieldKeys?: string[] } | undefined;
    expect(clearAudit).toMatchObject({
      subjectType: "task",
      fieldKeys: ["notes"],
      clearedFieldKeys: ["notes"],
    });

    // 清一个从未写过值的字段：幂等 200，仍然零行
    const clearNeverSet = await putValues({ notes: null });
    expect(clearNeverSet.status).toBe(200);
    expect(await storedRows()).toHaveLength(0);

    // 清后再写：值行回来
    const reset = await putValues({ notes: "second" });
    expect(reset.status).toBe(200);
    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    const reread = await getSubjectFields(alice, "task", taskId);
    expect(reread.fields.find((field) => field.fieldKey === "notes")?.value).toBe("second");
  });

  it("explicit null on a required field is still a 422, not a clear (#222)", async () => {
    const poNumber = await createField(adminHeaders, {
      subjectType: "task",
      fieldKey: "po_number",
      label: "PO 号",
      fieldType: "text",
      required: true,
    });
    expect(poNumber.status).toBe(201);
    const taskId = await createTask(alice, USERS.bob);
    const res = await app.request(`/api/subjects/task/${taskId}/custom-fields`, {
      method: "PUT",
      headers: { ...jsonHeaders, ...alice },
      body: JSON.stringify({ values: { po_number: null } }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { issues?: { fieldKey: string; code: string }[] };
    const poIssue = body.issues?.find((issue) => issue.fieldKey === "po_number");
    expect(poIssue?.code).toBe("invalid");
  });

  it("unregistered subject types and invisible subjects get 400 / 404 on the values face", async () => {
    const unregistered = await getSubjectFields(alice, "no_such_subject", randomUUID());
    expect(unregistered.status).toBe(400);
    const invisible = await getSubjectFields(alice, "task", randomUUID());
    expect(invisible.status).toBe(404);
  });

  it("deactivating a def hides its values and rejects further writes to its key", async () => {
    const def = await createField(adminHeaders, {
      subjectType: "task",
      fieldKey: "po_number",
      label: "PO 号",
      fieldType: "text",
    });
    const defBody = (await def.json()) as { id?: string };
    const taskId = await createTask(alice, USERS.bob);
    await app.request(`/api/subjects/task/${taskId}/custom-fields`, {
      method: "PUT",
      headers: { ...jsonHeaders, ...alice },
      body: JSON.stringify({ values: { po_number: "PO-1" } }),
    });

    const off = await app.request(`/api/custom-fields/${defBody.id}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ active: false }),
    });
    expect(off.status).toBe(200);

    const aliceView = await getSubjectFields(alice, "task", taskId);
    expect(aliceView.fields).toEqual([]);
    const write = await app.request(`/api/subjects/task/${taskId}/custom-fields`, {
      method: "PUT",
      headers: { ...jsonHeaders, ...alice },
      body: JSON.stringify({ values: { po_number: "PO-2" } }),
    });
    expect(write.status).toBe(422);

    const missing = await app.request(`/api/custom-fields/${randomUUID()}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ active: false }),
    });
    expect(missing.status).toBe(404);
  });

  it("in-place content rewrite: row updated, version bumped, ledger revision + field_updated audit (#222)", async () => {
    const def = await createField(adminHeaders, {
      subjectType: "task",
      fieldKey: "po_number",
      label: "PO 号",
      fieldType: "text",
    });
    const defBody = (await def.json()) as { id?: string };
    const id = must(defBody.id);

    const res = await app.request(`/api/custom-fields/${id}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ label: "采购订单号", required: true, viewableBy: ["sales", "finance"] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      field?: { label: string; required: boolean; viewableBy: string[]; version: number };
    };
    expect(body.field?.label).toBe("采购订单号");
    expect(body.field?.required).toBe(true);
    expect(body.field?.viewableBy).toEqual(["sales", "finance"]);
    expect(body.field?.version).toBe(2);

    const history = await app.request(`/api/config-versions/custom_field_def/${id}`, {
      headers: adminHeaders,
    });
    expect(history.status).toBe(200);
    const historyBody = (await history.json()) as {
      revisions: { version: number; source: string; changes: Record<string, { from: unknown; to: unknown }> }[];
    };
    expect(historyBody.revisions).toHaveLength(2);
    expect(historyBody.revisions[0]?.version).toBe(2);
    expect(historyBody.revisions[0]?.source).toBe("updated");
    expect(historyBody.revisions[0]?.changes).toMatchObject({
      label: { from: "PO 号", to: "采购订单号" },
      required: { from: false, to: true },
      viewableBy: { from: [], to: ["sales", "finance"] },
    });

    const auditRows = await db.select({ action: schema.auditEvents.action }).from(schema.auditEvents);
    expect(auditRows.some((row) => row.action === "custom_fields.field_updated")).toBe(true);
  });

  it("PATCH validates the select-options rule against the effective type+options pair", async () => {
    const textDef = await createField(adminHeaders, {
      subjectType: "task",
      fieldKey: "po_number",
      label: "PO 号",
      fieldType: "text",
    });
    const textId = must(((await textDef.json()) as { id?: string }).id);
    const selDef = await createField(adminHeaders, {
      subjectType: "task",
      fieldKey: "tier",
      label: "客户分级",
      fieldType: "select",
      options: ["a", "b"],
    });
    const selId = must(((await selDef.json()) as { id?: string }).id);

    async function patch(id: string, body: Record<string, unknown>) {
      return app.request(`/api/custom-fields/${id}`, {
        method: "PATCH",
        headers: { ...jsonHeaders, ...adminHeaders },
        body: JSON.stringify(body),
      });
    }

    // text 字段配选项：现类型带选项 → 422
    const optionsOnText = await patch(textId, { options: ["x"] });
    expect(optionsOnText.status).toBe(422);
    // select 化但不带选项 → 422
    const selectWithoutOptions = await patch(textId, { fieldType: "select" });
    expect(selectWithoutOptions.status).toBe(422);
    // select 化带重复选项 → 422
    const selectWithDupes = await patch(textId, { fieldType: "select", options: ["a", "a"] });
    expect(selectWithDupes.status).toBe(422);
    // select 字段清掉选项 → 422（select 必须保持非空选项）
    const clearedSelect = await patch(selId, { options: null });
    expect(clearedSelect.status).toBe(422);
    // select → text 且显式 null：合法改型，行里 options 归 null
    const toText = await patch(selId, { fieldType: "text", options: null });
    expect(toText.status).toBe(200);
    const toTextBody = (await toText.json()) as { field?: { fieldType: string; options: string[] | null } };
    expect(toTextBody.field?.fieldType).toBe("text");
    expect(toTextBody.field?.options).toBeNull();
  });

  it("a no-op PATCH is idempotent: same version, no new revision, no extra audit", async () => {
    const def = await createField(adminHeaders, {
      subjectType: "task",
      fieldKey: "tier",
      label: "客户分级",
      fieldType: "select",
      options: ["a"],
      viewableBy: ["sales"],
    });
    const id = must(((await def.json()) as { id?: string }).id);

    const res = await app.request(`/api/custom-fields/${id}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({
        label: "客户分级",
        fieldType: "select",
        options: ["a"],
        required: false,
        viewableBy: ["sales"],
        editableBy: [],
        active: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { field?: { version: number } };
    expect(body.field?.version).toBe(1);

    const history = await app.request(`/api/config-versions/custom_field_def/${id}`, {
      headers: adminHeaders,
    });
    const historyBody = (await history.json()) as { revisions: unknown[] };
    expect(historyBody.revisions).toHaveLength(1);

    const auditRows = await db
      .select({ action: schema.auditEvents.action })
      .from(schema.auditEvents);
    expect(auditRows.map((row) => row.action)).toEqual(["custom_fields.field_created"]);
  });

  it("active-only flips keep their audit actions; content+active lands as one field_updated", async () => {
    const def = await createField(adminHeaders, {
      subjectType: "task",
      fieldKey: "po_number",
      label: "PO 号",
      fieldType: "text",
    });
    const id = must(((await def.json()) as { id?: string }).id);

    async function patch(body: Record<string, unknown>) {
      return app.request(`/api/custom-fields/${id}`, {
        method: "PATCH",
        headers: { ...jsonHeaders, ...adminHeaders },
        body: JSON.stringify(body),
      });
    }
    async function auditActions(): Promise<string[]> {
      const rows = await db.select({ action: schema.auditEvents.action }).from(schema.auditEvents);
      return rows.map((row) => row.action);
    }

    const off = await patch({ active: false });
    expect(off.status).toBe(200);
    expect(await auditActions()).toEqual([
      "custom_fields.field_created",
      "custom_fields.field_deactivated",
    ]);

    const relabelAndOn = await patch({ label: "采购订单号", active: true });
    expect(relabelAndOn.status).toBe(200);
    const actions = await auditActions();
    expect(actions).toContain("custom_fields.field_updated");
    expect(actions).not.toContain("custom_fields.field_activated");
    const updatedRows = await db
      .select({ detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "custom_fields.field_updated"));
    const detail = must(updatedRows[0]?.detail) as { changes?: Record<string, unknown> };
    expect(detail.changes).toMatchObject({
      label: { from: "PO 号", to: "采购订单号" },
      active: { from: false, to: true },
    });
  });

  it("content PATCH stays behind custom_fields.configure and refuses unknown body keys", async () => {
    const def = await createField(adminHeaders, {
      subjectType: "task",
      fieldKey: "po_number",
      label: "PO 号",
      fieldType: "text",
    });
    const id = must(((await def.json()) as { id?: string }).id);

    const forbidden = await app.request(`/api/custom-fields/${id}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...alice },
      body: JSON.stringify({ label: "x" }),
    });
    expect(forbidden.status).toBe(403);

    const unknownKey = await app.request(`/api/custom-fields/${id}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ fieldKey: "new_key" }),
    });
    expect(unknownKey.status).toBe(400);
  });

  it("field config list filters by subjectType", async () => {
    await createField(adminHeaders, {
      subjectType: "task",
      fieldKey: "po_number",
      label: "PO 号",
      fieldType: "text",
    });
    await createField(adminHeaders, {
      subjectType: FIXTURE_SUBJECT,
      fieldKey: "tier",
      label: "客户分级",
      fieldType: "select",
      options: ["a"],
    });
    const filtered = await app.request("/api/custom-fields?subjectType=task", {
      headers: adminHeaders,
    });
    expect(filtered.status).toBe(200);
    const body = (await filtered.json()) as { fields: { fieldKey: string }[] };
    expect(body.fields.map((field) => field.fieldKey)).toEqual(["po_number"]);
  });
});
