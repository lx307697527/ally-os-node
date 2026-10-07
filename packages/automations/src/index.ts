import { z } from "zod";

/**
 * 自动化规则引擎的形状与纯求值（#224 切片 1，#232 §4.4「自动化规则」行）。
 *
 * 规则模型借鉴 Odoo：触发（新建、字段变化、进入阶段 → 本切片统一为「审计事件
 * action 精确命中」，域事件由各域写审计时产生）→ 过滤条件（对事件语境的点路径
 * 断言）→ 动作（建任务、发通知、发邮件、出站 webhook、改字段；其余动作类型随所属域
 * 切片进场）。本包零依赖
 * （只有 zod）：API 的规则 CRUD 用同一份 schema 做保存时校验，worker 的扫描/
 * 执行用同一份 schema 做运行时解析——两端不会长出两套形状。
 *
 * 条件求值 fail closed：路径解析不到（detail 缺键、穿过非对象）一律不满足，
 * 只有 `exists` 显式表达「必须有/必须没有」。语境的根只有事件行自己的四列
 * （action/target/actor/detail），不外溢。
 */

/**
 * 触发（#224 切片 2 起为判别联合，`kind` 区分）：
 * - `event`：审计事件 action 精确命中（如 task.created、workflow.state_changed）
 *   ——事件扫描器（automation-scan）消费；
 * - `due`：记录上的日期字段到达锚点 ± 偏移（「预约前 N 小时」，Odoo 的
 *   based-on-date-field 触发）——到期扫描器（automation-due-scan）消费，锚点
 *   必须是注册过的 due subject 及其声明过的日期字段（worker 侧注册表裁决，
 *   未注册 = 规则永不触发并告警，fail closed）。
 *
 * 两种触发写进同一张 automation_rules 表（trigger 是 jsonb），执行日志、动作、
 * 条件、重试协议完全共用——差别只在「谁发现它该跑了」。
 */
export const eventTriggerSpecSchema = z.object({
  kind: z.literal("event"),
  action: z.string().trim().min(1).max(200),
});
export type EventTriggerSpec = z.infer<typeof eventTriggerSpecSchema>;

export const DUE_DIRECTIONS = ["before", "after"] as const;
export type DueDirection = (typeof DUE_DIRECTIONS)[number];

/** 偏移下界 5 分钟（更细的粒度是秒级调度的事，不是分钟级扫描器的事）；上界 90 天 */
export const DUE_OFFSET_MINUTES_MIN = 5;
export const DUE_OFFSET_MINUTES_MAX = 129_600;

export const dueTriggerSpecSchema = z.object({
  kind: z.literal("due"),
  subjectType: z.string().trim().min(1).max(100),
  anchorField: z.string().trim().min(1).max(100),
  direction: z.enum(DUE_DIRECTIONS),
  offsetMinutes: z.number().int().min(DUE_OFFSET_MINUTES_MIN).max(DUE_OFFSET_MINUTES_MAX),
});
export type DueTriggerSpec = z.infer<typeof dueTriggerSpecSchema>;

export const triggerSpecSchema = z.discriminatedUnion("kind", [
  eventTriggerSpecSchema,
  dueTriggerSpecSchema,
]);
export type TriggerSpec = z.infer<typeof triggerSpecSchema>;

export const CONDITION_OPS = ["eq", "ne", "in", "exists"] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

/**
 * 条件：对事件语境的点路径断言。value 的形状随 op 收口——eq/ne 任意 JSON 值
 * （可 null）、in 非空数组、exists 布尔。路径解析不到时 eq/ne/in 一律不满足。
 */
export const conditionSpecSchema = z
  .object({
    path: z.string().trim().min(1).max(200),
    op: z.enum(CONDITION_OPS),
    value: z.unknown().optional(),
  })
  .refine(
    (c) =>
      c.op === "eq" || c.op === "ne"
        ? "value" in c
        : c.op === "in"
          ? Array.isArray(c.value) && c.value.length > 0 && c.value.length <= 100
          : typeof c.value === "boolean",
    { message: "value is required by op (eq/ne: any JSON value, in: 1..100 items, exists: boolean)" },
  );
export type ConditionSpec = z.infer<typeof conditionSpecSchema>;

export const createTaskActionSchema = z.object({
  type: z.literal("create_task"),
  config: z.object({
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().max(5000).optional(),
    assigneeId: z.uuid().optional(),
    /** 相对触发时刻的到期小时数（1h ~ 90d）；不填 = 无到期 */
    dueInHours: z.number().int().min(1).max(2160).optional(),
  }),
});
export type CreateTaskAction = z.infer<typeof createTaskActionSchema>;

export const notifyActionSchema = z.object({
  type: z.literal("notify"),
  config: z.object({
    /** 收件人白名单在保存时点死（uuid 列表）——按角色圈人的展开随 RBAC 消费切片进场 */
    userIds: z.array(z.uuid()).min(1).max(50),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().max(1000).optional(),
  }),
});
export type NotifyAction = z.infer<typeof notifyActionSchema>;

export const sendEmailActionSchema = z.object({
  type: z.literal("send_email"),
  config: z.object({
    /**
     * 收件人是站内用户（保存时点死的 uuid 列表，发送时按 id 解析账号邮箱）。
     * 自动化无人值守地发信，不给规则作者任意外部地址的入口——对外邮件是属主域
     * 写路径与 #237 营销邮件审批面的事。收件人被删 = 动作失败进重试/告警，
     * 不静默跳过（与 notify 收件人的 FK 约束同一裁法）。
     */
    userIds: z.array(z.uuid()).min(1).max(50),
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(5000),
  }),
});
export type SendEmailAction = z.infer<typeof sendEmailActionSchema>;

export const WEBHOOK_METHODS = ["POST", "PUT", "PATCH"] as const;
export type WebhookMethod = (typeof WEBHOOK_METHODS)[number];

/** RFC 7230 token:冒号、空白、控制字符进不了名字,头部注入从形状上就没门 */
const WEBHOOK_HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;

/**
 * 出站 webhook 动作：自动化把一个静态 JSON 负载投到规则作者指定的 https 端点
 * （通知 Slack/飞书 incoming webhook、触发外部系统流水线）。url 的闸在保存与
 * 执行两道都落（执行时另加 DNS 解析逐地址复查，见 worker executeSendWebhook）：
 * 自动化无人值守地发请求，端点绝不能是内网——worker 所在网络里 169.254.169.254
 * （云元数据）、数据库、内部服务都在私网段上，一个「触发 → webhook」规则就是
 * 一条把这些服务当靶子的通路，fail closed。
 */
export const sendWebhookActionSchema = z.object({
  type: z.literal("send_webhook"),
  config: z.object({
    url: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .refine(
        (raw) => {
          let url: URL;
          try {
            url = new URL(raw);
          } catch {
            return false;
          }
          return url.protocol === "https:" && isWebhookHostAllowed(url.hostname);
        },
        {
          message:
            "url must be an https URL on a public host — loopback, private, link-local, and *.local/*.internal hosts are refused",
        },
      ),
    method: z.enum(WEBHOOK_METHODS).default("POST"),
    headers: z
      .record(
        z.string().regex(WEBHOOK_HEADER_NAME_RE),
        z
          .string()
          .max(1024)
          .refine((value) => !/[\r\n\0]/.test(value), {
            message: "header value must not contain CR, LF, or NUL",
          }),
      )
      .refine((headers) => Object.keys(headers).length <= 10, {
        message: "at most 10 headers",
      })
      .optional(),
    body: z.unknown().optional(),
  }),
});
export type SendWebhookAction = z.infer<typeof sendWebhookActionSchema>;

/** 解析点分 IPv4；不是合法四段地址返回 null */
function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return [bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0];
}

/** 解析 IPv6 字面量（含 :: 缩写与尾嵌 IPv4）为 16 字节；解析不了返回 null */
function parseIpv6(host: string): Uint8Array | null {
  let text = host;
  // 尾嵌 IPv4（如 ::ffff:1.2.3.4）：换成等价的两个 16 位组再走统一解析
  const lastColon = text.lastIndexOf(":");
  if (lastColon >= 0 && text.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4(text.slice(lastColon + 1));
    if (v4 === null) return null;
    const hi = (v4[0] << 8) | v4[1];
    const lo = (v4[2] << 8) | v4[3];
    text = `${text.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const tail = halves.length === 2 ? (halves[1] === "" ? [] : (halves[1] ?? "").split(":")) : [];
  const groups = [...head, ...tail];
  if (groups.length > 8) return null;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
  }
  const fill = 8 - groups.length;
  if (halves.length === 2 ? fill < 0 : fill !== 0) return null;
  const words: number[] = [
    ...head.map((group) => parseInt(group, 16)),
    ...Array.from({ length: halves.length === 2 ? fill : 0 }, () => 0),
    ...tail.map((group) => parseInt(group, 16)),
  ];
  const bytes = new Uint8Array(16);
  for (const [index, word] of words.entries()) {
    bytes[index * 2] = word >> 8;
    bytes[index * 2 + 1] = word & 0xff;
  }
  return bytes;
}

function isBlockedIpv4(bytes: [number, number, number, number]): boolean {
  const [a, b] = bytes;
  // 0/8 本网络、10/8、100.64/10 CGNAT、127/8 回环、169.254/16 链路本地
  // （含 169.254.169.254 云元数据）、172.16/12、192.168/16、198.18/15 基准测试
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function isBlockedIpv6(bytes: Uint8Array): boolean {
  const allZero = bytes.every((byte) => byte === 0);
  // :: 未指定、::1 回环、fc00::/7 ULA、fe80::/10 链路本地
  if (allZero || (bytes[15] === 1 && allZeroExceptLast(bytes))) return true;
  const first = bytes[0] ?? 0;
  if (first === 0xfc || first === 0xfd) return true;
  if (first === 0xfe && (bytes[1] ?? 0) >= 0x80 && (bytes[1] ?? 0) <= 0xbf) return true;
  // ::ffff:0:0/96 IPv4 映射地址：内嵌的 v4 才是真实目标
  const mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) {
    return isBlockedIpv4([bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0]);
  }
  return false;
}

function allZeroExceptLast(bytes: Uint8Array): boolean {
  return bytes.slice(0, 15).every((byte) => byte === 0);
}

/**
 * 解析后的地址是否可作出站 webhook 目标：只放行公网。worker 的 DNS 复查逐地址
 * 过这道闸——域名是公口的，解析出一条私网地址就是一条私网通路。解析不了的
 * 字符串不是地址，拒绝。
 */
export function isWebhookIpAllowed(address: string): boolean {
  const v4 = parseIpv4(address);
  if (v4 !== null) return !isBlockedIpv4(v4);
  const v6 = parseIpv6(address);
  if (v6 !== null) return !isBlockedIpv6(v6);
  return false;
}

/**
 * URL hostname（WHATWG URL 对 IPv6 字面量保留方括号、对 IPv4 形状做规范化，
 * 十六进制/八进制变体到不了这里）是否可作出站 webhook 目标：IP 字面量按地址
 * 闸判，域名挡掉 localhost 家族与 *.local/*.internal 后放行——解析成私网地址
 * 的公网域名由执行时的 DNS 复查挡，保存面只做无网络判定的形状闸。
 */
export function isWebhookHostAllowed(hostname: string): boolean {
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;
  const v4 = parseIpv4(host);
  if (v4 !== null) return !isBlockedIpv4(v4);
  if (host.includes(":")) {
    const v6 = parseIpv6(host);
    return v6 !== null && !isBlockedIpv6(v6);
  }
  return true;
}

/**
 * 改字段动作（#224 切片 6）：把触发语境指向的那条记录上的一个字段改成规则作者
 * 保存时点死的值。目标永远是最多一个行（触发语境的 target），不是查询——自动
 * 化批量改写是另一档危险，本动作不做。值是静态 JSON（无模板插值，与
 * send_webhook 的 payload 同裁）。
 *
 * 「哪张表的哪些字段容许自动化改」是属主域的裁决，与 due 锚点同一裁法：worker
 * 侧 field-registry 声明式白名单（第一个成员 task.status），本包只收形状——保存
 * 面验形状、运行时验注册：未注册的 subjectType/field 存得进但执行必败并告警，
 * fail closed（docs/automations.md 的 due 未注册锚点同一条裁决）。
 */
export const updateFieldActionSchema = z.object({
  type: z.literal("update_field"),
  config: z
    .object({
      subjectType: z.string().trim().min(1).max(100),
      field: z.string().trim().min(1).max(100),
      /** 目标值：保存时点死的静态 JSON；显式 null 允许（是否可空由域裁决） */
      value: z.unknown().optional(),
    })
    .refine((config) => "value" in config, { message: "value is required" }),
});
export type UpdateFieldAction = z.infer<typeof updateFieldActionSchema>;

/**
 * 从触发语境的 target 解析出 subject 行 id：event 触发的审计 target 是裸行 id，
 * due 触发的合成 target（dueEventContext）是 `subjectType:subjectId`。target 带
 * 前缀而前缀对不上配置的 subjectType = 规则作者配错了对象，拒绝——改错行比不
 * 改更糟，这里宁可 fail loud。
 */
export function subjectIdFromTarget(
  target: string | null,
  subjectType: string,
): { ok: true; subjectId: string } | { ok: false; reason: string } {
  if (target === null || target === "") {
    return { ok: false, reason: "trigger event has no target" };
  }
  const prefix = `${subjectType}:`;
  if (target.startsWith(prefix)) {
    const subjectId = target.slice(prefix.length);
    return subjectId === ""
      ? { ok: false, reason: `target prefix ${subjectType}: has no id after it` }
      : { ok: true, subjectId };
  }
  if (target.includes(":")) {
    return { ok: false, reason: `target belongs to a different subject than ${subjectType}` };
  }
  return { ok: true, subjectId: target };
}

export const actionSpecSchema = z.discriminatedUnion("type", [
  createTaskActionSchema,
  notifyActionSchema,
  sendEmailActionSchema,
  sendWebhookActionSchema,
  updateFieldActionSchema,
]);
export type ActionSpec = z.infer<typeof actionSpecSchema>;

/** 一条规则的动作序列：至少一个，至多十个（防手滑配出连锁轰炸） */
export const ruleSpecSchema = z.object({
  trigger: triggerSpecSchema,
  conditions: z.array(conditionSpecSchema).max(20).default([]),
  actions: z.array(actionSpecSchema).min(1).max(10),
});
export type RuleSpec = z.infer<typeof ruleSpecSchema>;

/** 事件语境：审计事件行的投影，条件与动作唯一能看到的世界 */
export interface AutomationEventContext {
  action: string;
  target: string | null;
  actor: string | null;
  detail: Record<string, unknown> | null;
}

/** 自动化自身的写路径带 automation:<runId> 前缀 actor——扫描器靠它防自触发回路 */
export const AUTOMATION_ACTOR_PREFIX = "automation:";

export function eventMatchesTrigger(trigger: TriggerSpec, event: { action: string }): boolean {
  return trigger.kind === "event" && event.action === trigger.action;
}

/**
 * due 触发合成的事件语境：条件求值看到的形状与审计事件完全一致（同一份
 * resolvePath/evaluateConditions），但语境是扫描器从注册的 subject 行投影出来
 * 的，不写审计——「到期时刻到了」不是一次业务变更（docs/audit.md 的纪律），
 * 执行日志在 automation_runs。
 */
export function dueEventContext(args: {
  subjectType: string;
  subjectId: string;
  detail: Record<string, unknown>;
}): AutomationEventContext {
  return {
    action: `${args.subjectType}.due`,
    target: `${args.subjectType}:${args.subjectId}`,
    actor: null,
    detail: args.detail,
  };
}

/** 点路径取值：只允许穿过普通对象；数组下标、原型链、__proto__ 一律到不了 */
export function resolvePath(ctx: AutomationEventContext, path: string): unknown {
  const segments = path.split(".");
  const [root, ...rest] = segments;
  if (root === undefined) return undefined;
  let current: unknown;
  if (root === "action") current = ctx.action;
  else if (root === "target") current = ctx.target;
  else if (root === "actor") current = ctx.actor;
  else if (root === "detail") current = ctx.detail;
  else return undefined;
  for (const segment of rest) {
    if (typeof current !== "object" || current === null) return undefined;
    if (segment === "__proto__" || segment === "constructor" || segment === "prototype") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export interface ConditionOutcome {
  path: string;
  op: ConditionOp;
  passed: boolean;
}

export interface ConditionEvaluation {
  passed: boolean;
  outcomes: ConditionOutcome[];
}

/** 全部条件都满足才放行（AND）；空条件集恒真 */
export function evaluateConditions(
  conditions: ConditionSpec[],
  ctx: AutomationEventContext,
): ConditionEvaluation {
  const outcomes: ConditionOutcome[] = conditions.map((condition) => {
    const resolved = resolvePath(ctx, condition.path);
    let passed: boolean;
    if (condition.op === "exists") {
      passed = resolved !== undefined === condition.value;
    } else if (condition.op === "eq") {
      passed = resolved === condition.value;
    } else if (condition.op === "ne") {
      passed = resolved !== condition.value && resolved !== undefined;
    } else {
      passed =
        Array.isArray(condition.value) &&
        resolved !== undefined &&
        condition.value.some((item) => item === resolved);
    }
    return { path: condition.path, op: condition.op, passed };
  });
  return { passed: outcomes.every((o) => o.passed), outcomes };
}

/** 运行结果里的动作行（worker 落库形状，api 的 runs 读法原样展示） */
export interface ActionResult {
  type: ActionSpec["type"];
  status: "succeeded" | "failed";
  /** create_task 落任务的 id，便于从运行记录跳到产物 */
  ref?: string | undefined;
  error?: string | undefined;
}
