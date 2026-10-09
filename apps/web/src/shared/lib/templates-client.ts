// The content templates' data access (#225 template config face): the reads
// (list, one template with its version history), the writes (create, update,
// rollback) and the preview. A config page is a primary surface, not a
// degrading widget — the adapter reports the failure mode instead of
// flattening it (numbering-client.ts same discipline), so "why is the table
// empty" always has an answer in words.
//
//   { ok: true, data }                        — the call worked
//   { ok: false, reason: "forbidden" }        — 403: no templates.configure
//   { ok: false, reason: "unavailable" }      — network/5xx/unparseable body
// and the writes add the specific rejections the kernel speaks: an
// unregistered channel, a subject the channel does not allow (or requires),
// a duplicate (channel, template_type) row (409), a missing template, a
// missing version. Response bodies are zod-parsed because API responses are
// external input as far as this bundle is concerned.
import { z } from "zod";

const templateRowSchema = z.object({
  id: z.string(),
  channel: z.string(),
  templateType: z.string(),
  subjectTemplate: z.string().nullable(),
  bodyTemplate: z.string(),
  isActive: z.boolean(),
  version: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const templateVersionSchema = z.object({
  version: z.number().int().positive(),
  subjectTemplate: z.string().nullable(),
  bodyTemplate: z.string(),
  changedById: z.string().nullable(),
  changedAt: z.string(),
});

const channelOptionSchema = z.object({ channel: z.string(), label: z.string() });

const listSchema = z.object({
  channels: z.array(channelOptionSchema),
  templates: z.array(templateRowSchema),
});
const detailSchema = z.object({ template: templateRowSchema, versions: z.array(templateVersionSchema) });
const createdSchema = z.object({ id: z.string() });
const updatedSchema = z.object({ template: templateRowSchema, updated: z.boolean() });
const previewSchema = z.object({
  subject: z.string().nullable(),
  body: z.string(),
  referencedVariables: z.array(z.string()),
  missingVariables: z.array(z.string()),
});

export type TemplateRow = z.infer<typeof templateRowSchema>;
export type TemplateVersion = z.infer<typeof templateVersionSchema>;
export type TemplateChannelOption = z.infer<typeof channelOptionSchema>;
export type TemplatePreview = z.infer<typeof previewSchema>;

export type TemplateReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "forbidden" | "unavailable" };

export type CreateTemplateFailure =
  | "forbidden"
  | "unknown_channel"
  | "subject_required"
  | "subject_not_allowed"
  | "exists"
  | "invalid"
  | "unavailable";
export type UpdateTemplateFailure =
  | "forbidden"
  | "not_found"
  | "subject_required"
  | "subject_not_allowed"
  | "invalid"
  | "unavailable";
export type RollbackTemplateFailure =
  | "forbidden"
  | "not_found"
  | "version_not_found"
  | "invalid"
  | "unavailable";
export type PreviewTemplateFailure = "forbidden" | "invalid" | "unavailable";

export interface CreateTemplateInput {
  channel: string;
  templateType: string;
  subjectTemplate: string | null;
  bodyTemplate: string;
}

/** PATCH 收完整内容对象(subject + body + 开关一口气交齐)——服务端 strict,
 *  客户端类型从形状上就不给「只发一个字段」的部分更新:模板是给人读的
 *  整封信,拼半封信发出去比多打一次字危险。 */
export interface UpdateTemplateInput {
  subjectTemplate: string | null;
  bodyTemplate: string;
  isActive: boolean;
}

export interface PreviewTemplateInput {
  subjectTemplate: string | null;
  bodyTemplate: string;
  vars: Record<string, string>;
}

async function readJson<T>(
  fetchFn: typeof fetch,
  schema: z.ZodType<T>,
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: T | null; error: string | null }> {
  try {
    const res = await fetchFn(url, init);
    const raw: unknown = await res.json().catch(() => null);
    const parsed = schema.safeParse(raw);
    return {
      status: res.status,
      body: parsed.success ? parsed.data : null,
      error:
        typeof raw === "object" && raw !== null && "error" in raw
          ? String(raw.error)
          : null,
    };
  } catch {
    return { status: 0, body: null, error: null };
  }
}

function postInit(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export interface TemplatesAdapters {
  list(): Promise<
    | { ok: true; data: { channels: TemplateChannelOption[]; templates: TemplateRow[] } }
    | { ok: false; reason: "forbidden" | "unavailable" }
  >;
  detail(
    id: string,
  ): Promise<
    | { ok: true; data: { template: TemplateRow; versions: TemplateVersion[] } }
    | { ok: false; reason: "forbidden" | "not_found" | "unavailable" }
  >;
  create(
    input: CreateTemplateInput,
  ): Promise<{ ok: true; data: { id: string } } | { ok: false; reason: CreateTemplateFailure }>;
  update(
    id: string,
    input: UpdateTemplateInput,
  ): Promise<
    | { ok: true; data: { template: TemplateRow; updated: boolean } }
    | { ok: false; reason: UpdateTemplateFailure }
  >;
  rollback(
    id: string,
    version: number,
  ): Promise<
    | { ok: true; data: { template: TemplateRow } }
    | { ok: false; reason: RollbackTemplateFailure }
  >;
  preview(
    input: PreviewTemplateInput,
  ): Promise<{ ok: true; data: TemplatePreview } | { ok: false; reason: PreviewTemplateFailure }>;
}

export function createTemplatesAdapters(fetchFn: typeof fetch = fetch): TemplatesAdapters {
  return {
    async list() {
      const res = await readJson(fetchFn, listSchema, "/api/templates");
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status !== 200 || res.body === null) {
        return { ok: false as const, reason: "unavailable" as const };
      }
      return { ok: true as const, data: res.body };
    },

    async detail(id) {
      const res = await readJson(fetchFn, detailSchema, `/api/templates/${encodeURIComponent(id)}`);
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status === 404) return { ok: false as const, reason: "not_found" as const };
      if (res.status !== 200 || res.body === null) {
        return { ok: false as const, reason: "unavailable" as const };
      }
      return { ok: true as const, data: res.body };
    },

    async create(input) {
      const res = await readJson(fetchFn, createdSchema, "/api/templates", postInit(input));
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status === 409) return { ok: false as const, reason: "exists" as const };
      if (res.status === 400 && res.error === "unknown_channel") {
        return { ok: false as const, reason: "unknown_channel" as const };
      }
      if (res.status === 400 && res.error === "subject_required") {
        return { ok: false as const, reason: "subject_required" as const };
      }
      if (res.status === 400 && res.error === "subject_not_allowed") {
        return { ok: false as const, reason: "subject_not_allowed" as const };
      }
      if (res.status === 201 && res.body !== null) {
        return { ok: true as const, data: res.body };
      }
      return { ok: false as const, reason: res.status === 400 ? ("invalid" as const) : ("unavailable" as const) };
    },

    async update(id, input) {
      const res = await readJson(
        fetchFn,
        updatedSchema,
        `/api/templates/${encodeURIComponent(id)}`,
        { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
      );
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status === 404) return { ok: false as const, reason: "not_found" as const };
      if (res.status === 400 && res.error === "subject_required") {
        return { ok: false as const, reason: "subject_required" as const };
      }
      if (res.status === 400 && res.error === "subject_not_allowed") {
        return { ok: false as const, reason: "subject_not_allowed" as const };
      }
      if (res.status === 200 && res.body !== null) {
        return { ok: true as const, data: res.body };
      }
      return { ok: false as const, reason: res.status === 400 ? ("invalid" as const) : ("unavailable" as const) };
    },

    async rollback(id, version) {
      const res = await readJson(
        fetchFn,
        z.object({ template: templateRowSchema }),
        `/api/templates/${encodeURIComponent(id)}/rollback`,
        postInit({ version }),
      );
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status === 404 && res.error === "version_not_found") {
        return { ok: false as const, reason: "version_not_found" as const };
      }
      if (res.status === 404) return { ok: false as const, reason: "not_found" as const };
      if (res.status === 200 && res.body !== null) {
        return { ok: true as const, data: res.body };
      }
      return { ok: false as const, reason: res.status === 400 ? ("invalid" as const) : ("unavailable" as const) };
    },

    async preview(input) {
      const res = await readJson(fetchFn, previewSchema, "/api/templates/preview", postInit(input));
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status === 200 && res.body !== null) {
        return { ok: true as const, data: res.body };
      }
      return { ok: false as const, reason: res.status === 400 ? ("invalid" as const) : ("unavailable" as const) };
    },
  };
}

// ── channel 形状镜像(表单字段开关,不是校验)──────────────────────────────
// 镜像 packages/templates/src/template.ts 的注册表(EMAIL subjectRequired,
// numbering-client.ts 镜像日期枚举同一先例:服务端注册表是唯一权威,这份
// 拷贝只决定表单画哪个输入框)。列表端点交回的是 {channel,label},不含
// subjectRequired——为这一个布尔改 API 不值得。没上表的 channel 默认显示
// 主题框:多画一个框最多换来一句清楚的 400,少画会凭空拼出半封信。
const CHANNEL_SUBJECT_REQUIRED: Readonly<Record<string, boolean>> = { email: true };

export function channelWantsSubject(channel: string): boolean {
  return CHANNEL_SUBJECT_REQUIRED[channel] ?? true;
}

// ── 已知消费方的提示(页面的注释,不是校验)────────────────────────────────
// 模板类型是开集,这里的映射只覆盖本仓库今天真实消费的三封认证邮件
// (templates/service.ts 的 resolveAuthEmail);没上表的类型照配——消费方
// 进场时把它加进这张表是文档工作,不是门槛。变量表同样:四个变量是
// resolveAuthEmail 注入的全部,name/email 进 HTML 正文前转义、link 永不
// 转义(转义弄死 querystring 的 &),主题用未转义变量。
export interface KnownTemplateTypeInfo {
  label: string;
  usedBy: string;
  variables: readonly string[];
}

export const KNOWN_TEMPLATE_TYPES: Readonly<Record<string, KnownTemplateTypeInfo>> = {
  email_verification: {
    label: "Email verification",
    usedBy: "the verify-your-address email new accounts receive",
    variables: ["name", "email", "link", "expiry"],
  },
  password_reset: {
    label: "Password reset",
    usedBy: "the reset-link email (also the invite path for passwordless accounts)",
    variables: ["name", "email", "link", "expiry"],
  },
  account_invite: {
    label: "Account invite",
    usedBy: "the invitation email for accounts created without a password",
    variables: ["name", "email", "link", "expiry"],
  },
};

/** 拼模板类型的显示名:已知类型给人话,未知类型原样(开集不做假枚举)。 */
export function templateTypeLabel(templateType: string): string {
  return KNOWN_TEMPLATE_TYPES[templateType]?.label ?? templateType;
}

/** 预览样例值的默认:已知变量给人话样例,未知变量空串起手(照实填)。 */
export function sampleVariableValue(name: string): string {
  if (name === "name") return "Alex Chen";
  if (name === "email") return "alex@example.com";
  if (name === "link") return "https://app.example.com/action?token=demo";
  if (name === "expiry") return "30 minutes";
  return "";
}
