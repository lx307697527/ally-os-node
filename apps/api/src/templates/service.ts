import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import {
  extractTemplateVariables,
  missingTemplateVariables,
  renderTemplate,
} from "@ally/templates";
import { escapeHtml, htmlToPlainText, type AuthEmailContent } from "@ally/mailer";

/**
 * 内容模板的消费侧（#225 切片 2）：认证邮件（验证 / 重置 / 邀请）的模板解析。
 *
 * 语义：按 (channel="email", templateType) 找**启用中**的模板行——行不在或已
 * 停用 → 内置文案兜底（@ally/mailer 的 render*Email 仍是初始真相，模板是
 * 覆盖）；查行失败（DB 抖动）→ 同样兜底并记 warn。这是「发送失败绝不阻塞
 * 认证流程」（老系统 auth-send-email 裁定）往前挪一步：模板面的任何故障都
 * 不允许变成认证流程的故障——可用性优先于定制。
 *
 * 变量注入与内置渲染同一道工序（BUG-285）：用户可输入的 name/email 进 HTML
 * 前转义，link 原样（转义会弄死 querystring 的 `&`），expiry 是平台常量；
 * 主题是邮件头不是 HTML，用未转义变量。正文里的缺失变量保留 `{{name}}`
 * 原样发出（@ally/templates 契约，可诊断），这里再记一条 warn 让它在日志里
 * 也可发现——预览端点是第一道眼，这里是发出前的最后一只。
 */

export const EMAIL_VERIFICATION_TEMPLATE_TYPE = "email_verification";
export const PASSWORD_RESET_TEMPLATE_TYPE = "password_reset";
export const ACCOUNT_INVITE_TEMPLATE_TYPE = "account_invite";

export interface ResolvedEmail {
  subject: string;
  html: string;
  text: string;
}

export async function resolveAuthEmail(
  db: Db,
  logger: Logger,
  templateType: string,
  content: AuthEmailContent,
  builtin: (content: AuthEmailContent) => ResolvedEmail,
): Promise<ResolvedEmail> {
  try {
    const rows = await db
      .select({
        subjectTemplate: schema.systemTemplates.subjectTemplate,
        bodyTemplate: schema.systemTemplates.bodyTemplate,
      })
      .from(schema.systemTemplates)
      .where(
        and(
          eq(schema.systemTemplates.channel, "email"),
          eq(schema.systemTemplates.templateType, templateType),
          eq(schema.systemTemplates.isActive, true),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row !== undefined) {
      // 主题（邮件头）用未转义变量；正文（HTML）里用户可输入的值转义——
      // 与内置渲染完全同一纪律，模板只是换了措辞不换工序
      const displayName = content.name.trim() !== "" ? content.name : content.to;
      const subjectVars: Record<string, string> = {
        name: displayName,
        email: content.to,
        link: content.link,
        expiry: content.expiry,
      };
      const bodyVars: Record<string, string> = {
        name: escapeHtml(displayName),
        email: escapeHtml(content.to),
        link: content.link,
        expiry: content.expiry,
      };
      const subjectTemplate = row.subjectTemplate ?? "";
      const html = renderTemplate(row.bodyTemplate, bodyVars);
      const missing = missingTemplateVariables(
        extractTemplateVariables(subjectTemplate, row.bodyTemplate),
        subjectVars,
      );
      if (missing.length > 0) {
        logger.warn(
          { templateType, missing },
          "system template has unresolved placeholders — sending as-is",
        );
      }
      return {
        subject: renderTemplate(subjectTemplate, subjectVars),
        html,
        text: htmlToPlainText(html),
      };
    }
  } catch (err) {
    logger.warn({ err, templateType }, "system template lookup failed — falling back to builtin");
  }
  return builtin(content);
}
