import type { Logger } from "pino";
import {
  NOTIFICATIONS_CHANGED_EVENT,
  REALTIME_LISTEN_CHANNEL,
  encodeBusEnvelope,
  userChannel,
  type RealtimeBusPayload,
} from "@ally/realtime";
import type {
  ActionResult,
  CreateTaskAction,
  NotifyAction,
  SendEmailAction,
  SendWebhookAction,
  UpdateFieldAction,
} from "@ally/automations";
import {
  AUTOMATION_ACTOR_PREFIX,
  isWebhookHostAllowed,
  isWebhookIpAllowed,
  subjectIdFromTarget,
} from "@ally/automations";
import { escapeHtml, htmlToPlainText, type Mailer } from "@ally/mailer";
import { and, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@ally/db";
import { updatableSubjectSpec, type FieldWriteTx } from "./field-registry.ts";

/**
 * 动作执行器（#224 的内核动作：建任务、发通知、发邮件）。
 *
 * 动作是内核的、实现在这里而不在 API：它们由 worker 的 automation-run 任务在
 * 重试语境里调用（#224「动作通过 pg-boss 执行」），API 不执行动作。幂等协议
 * 在 runner（已成功的动作按 action_results 跳过），本文件每个函数只管把一件事
 * 做成：建任务 + task.created 审计（actor 带 automation:<runId> 前缀——扫描器
 * 靠这个前缀防「自动化再触发自动化」的回路），发通知 + 铃铛「催」（与 API 路由
 * 同一形态：通知行是真相，推送是 at-most-once 加速器，失败只降级不回滚）。
 *
 * 任务分配通知（task.assigned）是任务内核（#113）行为的 worker 侧镜像——统一
 * 通知通道（#116）进场时并入，不复刻第二份。
 */

/** 发布用的执行器：worker 自己的连接池即可（query(text, values) 与 pg.Pool 兼容） */
export interface PublishExecutor {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export interface ActionDeps extends ActionServices {
  db: Db;
}

/** 经 pg_notify 总线发铃铛「催」；失败不抛（通知行已落库，推送只是加速器） */
async function nudgeBells(services: ActionServices, userIds: string[]): Promise<void> {
  const nudges = userIds.map(async (userId) => {
    const payload: RealtimeBusPayload = {
      type: "message",
      channel: userChannel(userId),
      event: NOTIFICATIONS_CHANGED_EVENT,
      data: {},
    };
    const encoded = encodeBusEnvelope(payload, services.instanceId);
    await services.publishExecutor.query("select pg_notify($1, $2)", [
      REALTIME_LISTEN_CHANNEL,
      encoded,
    ]);
  });
  await Promise.all(nudges).catch((err: unknown) => {
    services.logger.warn({ err, recipients: userIds.length }, "automation bell nudge failed");
  });
}

/** 动作的非 DB 依赖（发布执行器、邮件通道、日志、实例标识）——与 db 通道分开注入 */
export interface ActionServices {
  /** pg_notify 总线的发布执行器（与 packages/realtime RealtimeBus.publish 同一条 SQL） */
  publishExecutor: PublishExecutor;
  logger: Logger;
  /** 总线信封的 instanceId（跨进程广播标记来源实例，worker 启动时生成） */
  instanceId: string;
  /** 邮件通道（@ally/mailer；未配 Resend key 时是日志模式，动作照样「成功」） */
  mailer: Mailer;
  /** 出站 webhook 的 fetch 接缝（send_webhook 动作；测试注入假实现，默认全局 fetch） */
  webhookFetcher: typeof fetch;
  /**
   * DNS 解析接缝（send_webhook 的 SSRF 闸第二道：把目标主机名解析成全部地址
   * 逐个过私网检查。默认 node:dns lookup(all)；测试注入假实现）。
   */
  dnsLookup: (host: string) => Promise<{ address: string; family: number }[]>;
}

export interface ActionContext {
  ruleId: string;
  ruleName: string;
  /** create_task 的创建人快照（规则创建者；规则删了任务仍在） */
  createdById: string | null;
  runId: string;
}

/**
 * 自动化建的任务附着在规则行上（tasks.subject_type/subject_id 的又一个生产者）。
 * 一石二鸟：观测面（「这条规则 spawn 过哪些任务」走 tasks_subject_idx 读法）+
 * due 触发的防环闸（due-registry 的 task 成员不扫这类任务——「due 触发 →
 * create_task(dueInHours)」不设防会每 ≥5 分钟自增一条任务，同规则与跨规则
 * 的链式自触发一并挡住，人工建的入口不受影响）。
 */
export const AUTOMATION_TASK_SUBJECT_TYPE = "automation_rule";

export async function executeCreateTask(
  db: Pick<Db, "insert">,
  services: ActionServices,
  ctx: ActionContext,
  action: CreateTaskAction,
): Promise<ActionResult> {
  const config = action.config;
  const inserted = await db
    .insert(schema.tasks)
    .values({
      title: config.title,
      ...(config.description !== undefined ? { description: config.description } : {}),
      ...(config.assigneeId !== undefined ? { assigneeId: config.assigneeId } : {}),
      ...(config.dueInHours !== undefined
        ? { dueAt: new Date(Date.now() + config.dueInHours * 3_600_000) }
        : {}),
      createdById: ctx.createdById,
      subjectType: AUTOMATION_TASK_SUBJECT_TYPE,
      subjectId: ctx.ruleId,
    })
    .returning({ id: schema.tasks.id });
  const task = inserted[0];
  if (task === undefined) throw new Error("automation create_task returned no row");
  // 与 API 写路径同一形态的 task.created 审计；actor 带 automation 前缀：
  // 扫描器跳过这类事件（规则触发规则 = 回路）
  await db.insert(schema.auditEvents).values({
    actor: `${AUTOMATION_ACTOR_PREFIX}${ctx.runId}`,
    action: "task.created",
    target: task.id,
    detail: {
      via: "automation",
      ruleId: ctx.ruleId,
      ruleName: ctx.ruleName,
      title: config.title,
      assignee: config.assigneeId ?? null,
    },
  });
  if (config.assigneeId !== undefined) {
    await db.insert(schema.notifications).values({
      userId: config.assigneeId,
      eventType: "task.assigned",
      aggregateType: "task",
      aggregateId: task.id,
      payload: { taskTitle: config.title, actorName: ctx.ruleName },
    });
    await nudgeBells(services, [config.assigneeId]);
  }
  return { type: "create_task", status: "succeeded", ref: task.id };
}

export async function executeNotify(
  db: Pick<Db, "insert">,
  services: ActionServices,
  ctx: ActionContext,
  action: NotifyAction,
): Promise<ActionResult> {
  const config = action.config;
  const userIds = [...new Set(config.userIds)];
  await db.insert(schema.notifications).values(
    userIds.map((userId) => ({
      userId,
      eventType: "automation.notified",
      aggregateType: "automation_rule",
      aggregateId: ctx.ruleId,
      payload: {
        ruleName: ctx.ruleName,
        title: config.title,
        ...(config.body !== undefined ? { body: config.body } : {}),
      },
    })),
  );
  await nudgeBells(services, userIds);
  return { type: "notify", status: "succeeded" };
}

/** 邮件正文的 HTML 形态：作者写的是纯文本，转义后换行成 <br>，尾注署名规则 */
function renderEmailBody(body: string, ruleName: string): { html: string; text: string } {
  const html =
    `<p>${escapeHtml(body).replace(/\n/g, "<br>")}</p>` +
    `<p style="color:#6b7280;font-size:12px">` +
    `Sent automatically by the Ally OS rule &quot;${escapeHtml(ruleName)}&quot;.</p>`;
  return { html, text: htmlToPlainText(html) };
}

/**
 * send_email 动作（#224 切片 4，#116 渠道层解锁）：收件人按 id 解析账号邮箱，
 * 逐人一封（收件人之间不见地址），传输走 @ally/mailer——未配 Resend key 时是
 * 日志模式（动作照样成功，本地开发可从日志取信），与老系统「传输只是接缝、
 * 内容是调用方策略」的 comms 裁法同构，但这里没有第二套传输。
 *
 * 投递语义是 at-least-once：信是真金白银的外部副作用，丢了比重复更糟——
 * 部分收件人发送失败时动作失败进重试，已收到的重试后会再收到一封（窗口 =
 * 第一个失败点之前的收件人）；铃铛「催」的 at-most-once 与此刻意相反，便宜的
 * 加速器可以丢，付费的信不能凭空消失。发送在 runner 的动作事务内：事务回滚
 * （如 action_results 写失败）同样可能重发，同一个语义。
 *
 * 收件人被删 = 抛错进重试协议（重试耗尽终判 failed + 告警），不静默跳过——
 * 「少发一个人」必须有人看见。邮件本身不写审计、不进通知表：发送事实在
 * automation_runs 的 action_results 里（与 notify 的通知行即台账同一裁法）。
 */
export async function executeSendEmail(
  db: Pick<Db, "select">,
  services: ActionServices,
  ctx: ActionContext,
  action: SendEmailAction,
): Promise<ActionResult> {
  const config = action.config;
  const userIds = [...new Set(config.userIds)];
  const rows = await db
    .select({ id: schema.authUser.id, email: schema.authUser.email })
    .from(schema.authUser)
    .where(inArray(schema.authUser.id, userIds));
  const emailById = new Map(rows.map((row) => [row.id, row.email]));
  const missing = userIds.filter((id) => !emailById.has(id));
  if (missing.length > 0) {
    throw new Error(`send_email recipients no longer exist: ${missing.join(",")}`);
  }
  const { html, text } = renderEmailBody(config.body, ctx.ruleName);
  for (const id of userIds) {
    const to = emailById.get(id);
    if (to === undefined) throw new Error(`send_email recipient vanished mid-send: ${id}`);
    await services.mailer.send({ to, subject: config.subject, html, text });
  }
  return { type: "send_email", status: "succeeded" };
}

/** 出站 webhook 的整体超时：挂死的端点不能拴住 worker（动作在 runner 的事务里跑，行锁在等它） */
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** 失败时从响应体取错误说明的字节上界（截断后进 action_results 的 error，不整读响应） */
const WEBHOOK_MAX_RESPONSE_BYTES = 2048;
/** 进 error 的说明再截到字符级（与 mailer 的 detail.slice(0, 200) 同裁） */
const WEBHOOK_ERROR_DETAIL_CHARS = 200;

/** 有界读响应体：读到上界即停并取消流——任意第三方端点不能靠超大响应耗内存 */
async function readResponseHead(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < WEBHOOK_MAX_RESPONSE_BYTES) {
    const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
    if (done || value === undefined) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const merged = new Uint8Array(Math.min(total, WEBHOOK_MAX_RESPONSE_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= merged.byteLength) break;
    merged.set(chunk.subarray(0, merged.byteLength - offset), offset);
    offset += Math.min(chunk.byteLength, merged.byteLength - offset);
  }
  return new TextDecoder().decode(merged).replace(/\s+/g, " ").trim();
}

/**
 * send_webhook 动作（#224 切片 5）：把规则作者保存时点死的静态 JSON 负载投到
 * https 端点（通知 Slack/飞书 incoming webhook、触发外部流水线）。payload 不做
 * 模板插值——语境数据进负载是条件积木/模板切片的事，本动作只忠实投递作者写的
 * 内容；接收方区分不了来源是作者的设计（作者要带就自己在 headers/body 里带）。
 *
 * SSRF 三道闸，全部 fail closed：
 * 1. 保存时（schema）：https + 公网形状（IP 字面量过私网段检查，域名挡
 *    localhost/*.local/*.internal）；
 * 2. 执行时复查（本函数）：spec 可能早于闸的收紧、可能被手工改库——原样再判
 *    一遍 url；
 * 3. DNS 复查（本函数）：公网域名解析出私网地址（含 169.254.169.254 云元数据、
 *    RFC1918、回环）同样拒绝——「公口域名」不等于「公网目标」。已知残余：
 *    DNS rebinding（两次解析返回不同地址）不在检查范围，接出口代理时收口。
 *
 * 传输裁决：redirect: "error"（重定向能把过闸的 url 带去没过闸的目标）、
 * AbortSignal.timeout 防挂死、非 2xx = 失败进重试、失败说明只取有界头部字节
 * （错误消息进 action_results，可被规则读者看到——headers 里的密钥绝不进消息）。
 *
 * 投递语义与 send_email 同裁 at-least-once：对端已处理但响应 5xx/超时 = 重试
 * 会再投一次（重复窗口 = 第一个成功响应之前的每次投递）。不写审计、不进通知
 * 表——执行事实在 automation_runs 的 action_results。
 */
export async function executeSendWebhook(
  services: ActionServices,
  ctx: ActionContext,
  action: SendWebhookAction,
): Promise<ActionResult> {
  const config = action.config;
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new Error("send_webhook url is not a valid URL");
  }
  if (url.protocol !== "https:" || !isWebhookHostAllowed(url.hostname)) {
    throw new Error(`send_webhook url is not allowed: ${url.protocol}//${url.hostname}`);
  }
  const bareHost = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  const addresses = await services.dnsLookup(bareHost);
  const blocked = addresses.filter((entry) => !isWebhookIpAllowed(entry.address));
  if (blocked.length > 0) {
    // 地址本身可以进错误消息（运营需要知道是哪一段私网），路径与查询不带
    throw new Error(
      `send_webhook target resolves to a blocked address: ${blocked.map((entry) => entry.address).join(", ")}`,
    );
  }
  const headers = new Headers(config.headers ?? {});
  let body: string | undefined;
  if (config.body !== undefined) {
    body = JSON.stringify(config.body);
    const hasContentType = [...headers.keys()].some((name) => name.toLowerCase() === "content-type");
    if (!hasContentType) headers.set("content-type", "application/json");
  }
  services.logger.info(
    { ruleId: ctx.ruleId, runId: ctx.runId, host: url.hostname, method: config.method },
    "automation webhook send",
  );
  const response = await services.webhookFetcher(url, {
    method: config.method,
    headers,
    ...(body !== undefined ? { body } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await readResponseHead(response);
    throw new Error(`send_webhook failed: HTTP ${response.status}${detail === "" ? "" : ` ${detail.slice(0, WEBHOOK_ERROR_DETAIL_CHARS)}`}`);
  }
  // 成功不读响应体:2xx 状态即投递事实,流直接取消释放连接
  await response.body?.cancel().catch(() => undefined);
  return { type: "send_webhook", status: "succeeded" };
}

/**
 * update_field 动作（#224 切片 6）：把触发语境指向的那一行上的一个字段改成规则
 * 作者保存时点死的值。目标永远是最多一个行（触发语境的 target，subjectId 从
 * target 解析，见 subjectIdFromTarget）——自动化批量改写是另一档危险，本动作
 * 不做。每道闸都 fail loud（抛错 = 动作失败进重试，耗尽终判 failed + 告警）：
 *
 * 1. subjectType / field 必须在属主域注册的声明式白名单里（field-registry，
 *    与 due 锚点同裁：保存面看不到 worker 注册表，未注册的配置存得进、执行必败）；
 * 2. target 必须能无歧义地解析成配置 subjectType 的行 id——带别的 subject 前缀
 *    = 作者配错了对象，拒绝（改错行比不改更糟）；
 * 3. 签名锁定（#219）：有电子签名的记录一律拒改——与人手 PATCH 的 record_signed
 *    （routes/tasks.ts）同一裁决，自动化不例外。签名表 append-only、按 subject
 *    前缀查询，注册表为空的今天任务上不可能有签名（恒通过），第一个把 task
 *    注册为可签名的域进场那天这行检查即生效。
 *
 * 值的域校验与写行、审计、no-op 语义都在 field spec（field-registry.ts）——属主
 * 域的写法属主域自己写，本函数只管把闸落齐、把派发做成。执行事实（ref = 被改的
 * 行 id）在 automation_runs 的 action_results；行上的变更痕迹是域自己的审计。
 */
export async function executeUpdateField(
  tx: FieldWriteTx,
  services: ActionServices,
  ctx: ActionContext,
  action: UpdateFieldAction,
  triggerTarget: string | null,
): Promise<ActionResult> {
  const config = action.config;
  const spec = updatableSubjectSpec(config.subjectType);
  if (spec === undefined) {
    throw new Error(`update_field subject type is not registered: ${config.subjectType}`);
  }
  const field = spec.fields[config.field];
  if (field === undefined) {
    throw new Error(
      `update_field field is not registered for ${config.subjectType}: ${config.field}`,
    );
  }
  const resolved = subjectIdFromTarget(triggerTarget, config.subjectType);
  if (!resolved.ok) {
    throw new Error(`update_field cannot resolve its target row: ${resolved.reason}`);
  }
  const signed = await tx
    .select({ id: schema.esignSignatures.id })
    .from(schema.esignSignatures)
    .where(
      and(
        eq(schema.esignSignatures.subjectType, config.subjectType),
        eq(schema.esignSignatures.subjectId, resolved.subjectId),
      ),
    )
    .limit(1);
  if (signed[0] !== undefined) {
    throw new Error(
      `update_field refused: ${config.subjectType} ${resolved.subjectId} is signed — records are locked once signed`,
    );
  }
  await field.apply(tx, resolved.subjectId, config.value, {
    ruleId: ctx.ruleId,
    ruleName: ctx.ruleName,
    runId: ctx.runId,
  });
  services.logger.info(
    {
      ruleId: ctx.ruleId,
      runId: ctx.runId,
      subjectType: config.subjectType,
      field: config.field,
      subjectId: resolved.subjectId,
    },
    "automation field update",
  );
  return { type: "update_field", status: "succeeded", ref: resolved.subjectId };
}
