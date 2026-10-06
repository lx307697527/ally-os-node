import * as z from "zod";

/**
 * 自定义字段内核的纯函数层（#222 切片 1）。
 *
 * #232 §4.9 v2.2 的落点：内置字段由属主域用 zod 定义（custom-fields/registry.ts），
 * 自定义字段按 custom_field_defs 的元数据行现算 zod，合成一份 JSON Schema——
 * 前端 react-jsonschema-form 渲染和服务端校验共用同一条定义，不存在两处各写一
 * 遍「必填/类型/选项」的漂移面（老系统询价向导的教训：同一组字段在前端 HTML、
 * intake-fields.ts、SQL 约束四处手工同步，靠 parity 测试防漂移）。
 *
 * 本模块不碰数据库：路由层把元数据行与注册表形状喂进来，属主域也可以在进程内
 * 直接复用（与 esign signSubject / approval submitApprovalRequest 的进程内接缝
 * 同一裁法——第一个消费域进场时不需要绕 HTTP）。
 */

/** 字段类型词表：与 packages/db 的 custom_field_type 枚举逐值对齐（DB 测试钉住） */
export const CUSTOM_FIELD_TYPES = ["text", "number", "boolean", "date", "select"] as const;

export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/** 服务层看到的字段定义最小面（drizzle 行满足此形状） */
export interface CustomFieldDefLike {
  id: string;
  fieldKey: string;
  label: string;
  fieldType: CustomFieldType;
  options: string[] | null;
  required: boolean;
  viewableBy: string[];
  editableBy: string[];
  active: boolean;
}

/** 单个字段值的 zod：类型与选项在服务端收口，不信任客户端自述的形状。
 * text 上限 10k（表单字段不是文档）；date 收 ISO 日历日（HTML date input 原值）；
 * select 收枚举（选项不在表 = 拒）。可选字段允许 null = 显式清值。 */
export function fieldValueZod(def: {
  fieldType: CustomFieldType;
  options: string[] | null;
  required: boolean;
}): z.ZodType {
  const base = (() => {
    switch (def.fieldType) {
      case "text":
        return z.string().max(10_000);
      case "number":
        return z.number();
      case "boolean":
        return z.boolean();
      case "date":
        return z.iso.date();
      case "select":
        return z.enum(def.options ?? []);
    }
  })();
  // 可选 = .nullable().optional()：值可显式置 null（清值），键可整体缺省
  // （不改既有值）——两者都不进 JSON Schema 的 required 数组，表单不强制填
  return def.required ? base : base.nullable().optional();
}

/**
 * 合成表单 schema：内置字段（属主域 zod raw shape）+ 生效自定义字段并排铺进一个
 * z.object，`z.toJSONSchema` 导出 input 侧（前端要渲染的是「提交者要填什么」）。
 * 自定义字段键与内置键重名在此炸出（属主域注册后管理员又配了同键字段是配置
 * 事故，不能悄悄覆盖内置字段）；重名的写入侧防线在字段创建路由（对照注册表）。
 */
export function composeFormSchema(
  builtin: z.ZodRawShape,
  defs: readonly CustomFieldDefLike[],
): Record<string, unknown> {
  // ZodRawShape 是只读索引签名，合并时要可写局部副本
  const shape: Record<string, z.ZodRawShape[string]> = { ...builtin };
  for (const def of defs) {
    if (def.fieldKey in shape) {
      throw new Error(`custom field key collides with builtin field: ${def.fieldKey}`);
    }
    shape[def.fieldKey] = fieldValueZod(def);
  }
  return z.toJSONSchema(z.object(shape), { io: "input" });
}

/** 角色数组语义：空数组 = 不限制（任何看得到记录的人）；非空 = 交集非空才放行。
 * 存量数据里的未知角色名按「不匹配」处理（写入侧已用 roleSchema 收口，这里是
 * 防御性的 fail closed）。 */
function roleAllowed(restricted: readonly string[], roles: readonly string[]): boolean {
  if (restricted.length === 0) return true;
  return roles.some((role) => restricted.includes(role));
}

/** 字段对这组角色是否可见（GET 过滤用——看不见的字段连「存在」都不出现在响应里） */
export function canViewField(def: CustomFieldDefLike, roles: readonly string[]): boolean {
  return roleAllowed(def.viewableBy, roles);
}

/** 字段对这组角色是否可写：可写必须同时可见——写一个看不见的字段是瞎写，
 * fail closed（viewableBy 不放行时 editableBy 再宽也不写）。 */
export function canEditField(def: CustomFieldDefLike, roles: readonly string[]): boolean {
  return canViewField(def, roles) && roleAllowed(def.editableBy, roles);
}

export interface ValueIssue {
  fieldKey: string;
  code: "unknown_field" | "not_editable" | "required" | "invalid";
  detail?: string;
}

export type ValueParseResult =
  | { ok: true; writes: { def: CustomFieldDefLike; value: unknown }[] }
  | { ok: false; issues: ValueIssue[] };

/**
 * 校验一次字段值提交（完整提交语义）：
 * - 提交的每个键必须是「对该角色可写」的生效字段（未知键、不可写键逐键报错）；
 * - 「对该角色可见」的必填字段必须出现在提交里——例外：对该角色不可见的必填
 *   字段不强制（不能要求提交者填一个看不见的字段；这类配置本身应配成可见），
 *   属主域在做整单校验时可以用管理员语境调本函数拿到全域视角；
 * - 提供了值的按字段 zod 逐个校验；可选字段缺省 = 不改既有值，显式 null = 清值。
 *
 * 返回 writes（def + 已解析的值）而不是直接写库：调用方决定事务边界（多行
 * upsert 与审计同事务）。
 */
export function parseValueSubmission(
  defs: readonly CustomFieldDefLike[],
  roles: readonly string[],
  raw: unknown,
): ValueParseResult {
  const parsed = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issues: [{ fieldKey: "", code: "invalid", detail: "values must be an object" }] };
  }
  const values = parsed.data;
  const byKey = new Map(defs.map((def) => [def.fieldKey, def]));
  const issues: ValueIssue[] = [];
  const writes: { def: CustomFieldDefLike; value: unknown }[] = [];

  for (const [key, value] of Object.entries(values)) {
    const def = byKey.get(key);
    if (!def?.active) {
      issues.push({ fieldKey: key, code: "unknown_field" });
      continue;
    }
    if (!canEditField(def, roles)) {
      issues.push({ fieldKey: key, code: "not_editable" });
      continue;
    }
    const parsedValue = fieldValueZod(def).safeParse(value);
    if (!parsedValue.success) {
      const message = parsedValue.error.issues[0]?.message;
      issues.push({
        fieldKey: key,
        code: "invalid",
        ...(message !== undefined ? { detail: message } : {}),
      });
      continue;
    }
    writes.push({ def, value: parsedValue.data });
  }

  // 必填检查只对「可见且可写」的字段强制：可见但被 editableBy 挡住的必填字段是
  // 配置矛盾（要么放开 editableBy 要么别设 required），按不可强制处理并注释在案
  for (const def of defs) {
    if (!def.required || !def.active || !canEditField(def, roles)) continue;
    if (!(def.fieldKey in values)) {
      issues.push({ fieldKey: def.fieldKey, code: "required" });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, writes };
}
