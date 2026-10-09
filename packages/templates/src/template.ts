import { z } from "zod";

/**
 * 统一模板内核（#225 切片 2：配置工作室的模板配置面）。
 *
 * 与老系统的对应：老系统邮件模板在 `comms.email_templates` +
 * `comms.email_template_versions`（DB 表 + `{{var}}` 占位符，渲染在调用方），
 * 渲染函数 `_shared/email_shells.ts` 的 renderPlaceholders；PDF 是代码渲染器
 * + 常量配置（新系统由 @ally/pdf + pdf_template_config 承担，#128）。这里
 * 沉的是两套共有的**语义内核**：占位符契约、变量提取、channel 注册表——
 * 存储与端点在 apps/api（apps/api/src/templates/），消费方接缝是
 * `resolveAuthEmail`（邮件先行；短信随其基建进场后注册 channel 即用）。
 *
 * 占位符契约（老系统 renderPlaceholders 同一纪律）：`{{ name }}` 形式，名字
 * 仅 [A-Za-z0-9_]，两侧空白容忍。**变量缺失时保留 `{{name}}` 原样**——
 * 可诊断的显性失败：错字变量在发出的信里肉眼可见，而不是被静默替换成空串
 * （预览端点把 missingVariables 报出来，同一契约的第二只眼）。
 */

const PLACEHOLDER_SOURCE = "\\{\\{\\s*([A-Za-z0-9_]+)\\s*\\}\\}";

/** 渲染：缺变量的占位符保留原样，值为空串照常替换（老系统同语义） */
export function renderTemplate(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(new RegExp(PLACEHOLDER_SOURCE, "g"), (match, name: string) => {
    return vars[name] ?? match;
  });
}

/** 模板（主题 + 正文）引用的全部变量名，按首次出现去重——预览与编辑器的「要填什么」数据源 */
export function extractTemplateVariables(...parts: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const part of parts) {
    for (const match of part.matchAll(new RegExp(PLACEHOLDER_SOURCE, "g"))) {
      const name = match[1];
      if (name !== undefined) seen.add(name);
    }
  }
  return [...seen];
}

/** referenced 里 vars 没给的字段：预览端点的 missingVariables，发送前最后一道显性提示 */
export function missingTemplateVariables(
  referenced: readonly string[],
  vars: Readonly<Record<string, string>>,
): string[] {
  return referenced.filter((name) => vars[name] === undefined);
}

// ── channel 注册表 ──────────────────────────────────────────────────────────
// channel 是开集，但**不是任意字符串都能配**：注册是「我真的会按这个 channel
// 消费模板」的承诺（numbering/registry.ts 同一裁法——配一条永远没人读的模板
// 是死配置，fail closed）。email 由本包注册（邮件基建 @ally/mailer 是平台
// 设施，不是业务域）；短信等 channel 随各自基建进场注册。

export interface TemplateChannelSpec {
  /** 管理界面的展示名 */
  label: string;
  /** 该 channel 的模板是否带主题行（email 要、短信不要） */
  subjectRequired: boolean;
}

const channels = new Map<string, TemplateChannelSpec>();

export function registerTemplateChannel(channel: string, spec: TemplateChannelSpec): void {
  channels.set(channel, spec);
}

export function templateChannelSpec(channel: string): TemplateChannelSpec | undefined {
  return channels.get(channel);
}

/** 已注册 channel 清单（管理界面的下拉数据源，numbering subjects 端点同裁） */
export function templateChannels(): { channel: string; label: string }[] {
  return [...channels.entries()]
    .map(([channel, spec]) => ({ channel, label: spec.label }))
    .sort((a, b) => a.channel.localeCompare(b.channel));
}

registerTemplateChannel("email", { label: "Email", subjectRequired: true });

// ── 输入校验 ────────────────────────────────────────────────────────────────
// 模板类型是开集（account_invite / password_reset / …，消费方各自声明），
// 但形状收窄：小写标识符，别让「Welcome!」「密码重置」混进枚举语义的字段。

export const templateChannelSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_-]{0,31}$/);

export const templateTypeSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_.-]{0,63}$/);

export const templateSubjectSchema = z.string().trim().min(1).max(500);

/** 模板正文上限 200KB：HTML 邮件模板的现实上界，防的是误贴整个网页资源不是正常使用 */
export const templateBodySchema = z.string().min(1).max(200_000);

/**
 * 内容对 channel 的合法性：`unknown_channel` / `subject_required` /
 * `subject_not_allowed` 之一，合法返回 null。POST/PATCH/预览三个面共用——
 * 校验只有一个权威，回答才不会漂。
 */
export function templateContentError(
  channel: string,
  content: { subjectTemplate: string | null; bodyTemplate: string },
): string | null {
  const spec = templateChannelSpec(channel);
  if (spec === undefined) return "unknown_channel";
  if (spec.subjectRequired && (content.subjectTemplate === null || content.subjectTemplate === "")) {
    return "subject_required";
  }
  if (!spec.subjectRequired && content.subjectTemplate !== null) {
    return "subject_not_allowed";
  }
  return null;
}

export const templateVarsSchema = z.record(z.string(), z.string());
