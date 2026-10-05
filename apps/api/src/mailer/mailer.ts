import type { Logger } from "pino";
import { z } from "zod";

/**
 * 邮件发送基建（#22 邮件基建切片）。
 *
 * 与老系统的对应：老系统是 Supabase Auth 的 Send Email Hook
 * （`supabase/functions/auth-send-email`，GoTrue 回调 + Svix 签名校验 + Resend）；
 * 新系统没有 GoTrue，Better Auth 的验证邮件回调直接拿 {@link Mailer} 发信。
 * 老系统「发信失败绝不阻塞登录/注册流程」的裁定在这里以同样方式落地：
 * 回调方 catch 所有发送失败、只记日志（见 auth.ts 的 sendVerificationEmail）。
 *
 * - key 已配置 → Resend HTTP API（fetch 注入以便测试；响应用 zod 校验）。
 * - key 未配置 → 日志模式：整封邮件（含验证链接）打进日志不发真信，
 *   本地开发与测试靠它拿链接。
 */

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  /** 纯文本备替；调用方从 html 推导，两份内容永不打架 */
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export interface MailerDeps {
  logger: Logger;
  /** Resend API key；留空 = 日志模式 */
  resendApiKey: string | undefined;
  /** 发件人，形如 `Ally OS <noreply@example.com>` */
  from: string;
  /** 注入 fetch（测试用假实现）；缺省 = 全局 fetch */
  fetcher?: typeof fetch;
}

const RESEND_API_URL = "https://api.resend.com/emails";

// Resend 2xx 响应体：{ "id": "…" }。第三方 API 响应按仓库规则用 zod 校验——
// 形状不对等于没发出去，调用方需要知道。
const resendResponseSchema = z.object({ id: z.string() });

export function createMailer(deps: MailerDeps): Mailer {
  if (deps.resendApiKey === undefined) {
    return new LoggingMailer(deps.logger);
  }
  return new ResendMailer({
    apiKey: deps.resendApiKey,
    from: deps.from,
    fetcher: deps.fetcher ?? fetch,
  });
}

export class LoggingMailer implements Mailer {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async send(message: MailMessage): Promise<void> {
    this.logger.info(
      { to: message.to, subject: message.subject, html: message.html },
      "mail not sent: RESEND_API_KEY is not configured (dev mode) — full message in this log entry",
    );
    await Promise.resolve();
  }
}

export class ResendMailer implements Mailer {
  private readonly apiKey: string;
  private readonly from: string;
  private readonly fetcher: typeof fetch;

  constructor(options: { apiKey: string; from: string; fetcher: typeof fetch }) {
    this.apiKey = options.apiKey;
    this.from = options.from;
    this.fetcher = options.fetcher;
  }

  async send(message: MailMessage): Promise<void> {
    const response = await this.fetcher(RESEND_API_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });
    if (!response.ok) {
      // 响应体可能带 Resend 的错误说明：只进日志通道（抛错的 message），
      // 不进返回值——这个错误由调用方记日志，不回给客户端。
      const detail = await response.text().catch(() => "");
      throw new Error(`resend send failed: HTTP ${response.status}${detail.slice(0, 200)}`);
    }
    const parsed = resendResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new Error("resend send failed: 2xx response body is not the expected shape");
    }
  }
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * HTML 转义，老系统 BUG-285 的教训：凡是用户可输入的值（姓名、邮箱）进 HTML
 * 正文前必须转义——否则注册表单的姓名字段就是一条从我们自家域名发出的
 * 钓鱼邮件通道。主题是邮件头不是 HTML 文档，不转义（合法姓名里的 `&`
 * 转义后用户会看到字面 `&amp;`）。
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ENTITIES[ch] ?? ch);
}

/**
 * 粗但够用的 HTML → 纯文本，给 Resend 的 text 备替。模板只有一份 HTML，
 * text 从它推导，改措辞永远两份同步（老系统 auth-send-email 同款做法）。
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface AuthEmailContent {
  /** 收件人 */
  to: string;
  /** 用户可输入的名字（HTML 里转义）；空则用邮箱兜底 */
  name: string;
  /** 完整的验证链接（href 原样输出，不转义——转义会把 & 变 &amp; 弄死链接） */
  link: string;
  /** 链接有效期的文案，如 "24 hours" */
  expiry: string;
}

/** 账号验证邮件的正文。DB 模板表是 #131（邮件模板管理）的事，这里先内置一份。 */
export function renderVerificationEmail(content: AuthEmailContent): {
  subject: string;
  html: string;
  text: string;
} {
  const name = content.name.trim() !== "" ? escapeHtml(content.name) : escapeHtml(content.to);
  const html =
    `<p>Hi ${name},</p>` +
    `<p>Confirm your email address to activate your Ally OS account:</p>` +
    `<p><a href="${content.link}">Confirm my email</a></p>` +
    `<p>Or paste this link into your browser:<br>${content.link}</p>` +
    `<p>This link expires in ${content.expiry}. If you didn't sign up, ` +
    `you can ignore this email.</p>`;
  return {
    subject: "Confirm your Ally OS account",
    html,
    text: htmlToPlainText(html),
  };
}

/**
 * 密码重置邮件的正文(#22 密码重置切片;老系统 recovery 模板的对应物)。
 * 与验证邮件同款纪律:姓名转义(BUG-285),链接原样,text 从 html 推导。
 * 措辞不预设请求者身份——任何人都能对任意地址发起重置(响应反枚举),
 * 正文要同时覆盖「是你本人」与「不是你」两种情形。
 */
export function renderPasswordResetEmail(content: AuthEmailContent): {
  subject: string;
  html: string;
  text: string;
} {
  const name = content.name.trim() !== "" ? escapeHtml(content.name) : escapeHtml(content.to);
  const html =
    `<p>Hi ${name},</p>` +
    `<p>A password reset was requested for your Ally OS account. ` +
    `Open the link below to choose a new password:</p>` +
    `<p><a href="${content.link}">Choose a new password</a></p>` +
    `<p>Or paste this link into your browser:<br>${content.link}</p>` +
    `<p>This link expires in ${content.expiry} and can be used once. ` +
    `If you didn't request a password reset, you can ignore this email — ` +
    `your current password keeps working.</p>`;
  return {
    subject: "Reset your Ally OS password",
    html,
    text: htmlToPlainText(html),
  };
}
