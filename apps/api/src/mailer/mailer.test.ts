import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import {
  createMailer,
  escapeHtml,
  htmlToPlainText,
  LoggingMailer,
  renderVerificationEmail,
  ResendMailer,
} from "./mailer.ts";

const logger = pino({ level: "silent" });

/** 测试里替代非空断言：取不到就直接失败 */
function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("unexpected missing value in test");
  return value;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ResendMailer", () => {
  const message = {
    to: "user@example.com",
    subject: "Confirm your Ally OS account",
    html: "<p>Confirm: <a href=\"https://web.example/verify-email?token=a&b=c\">link</a></p>",
    text: "Confirm: https://web.example/verify-email?token=a&b=c",
  };

  it("posts the message to the Resend API with bearer auth and the configured from", async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(200, { id: "email-1" })));
    const mailer = new ResendMailer({ apiKey: "re_test_key", from: "Ally OS <t@example.com>", fetcher });

    await mailer.send(message);

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = must(fetcher.mock.calls[0]);
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer re_test_key");
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
      string,
      string
    >;
    expect(body).toEqual({
      from: "Ally OS <t@example.com>",
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  });

  it("throws on a non-2xx response, naming the status", async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(403, { message: "domain not verified" })));
    const mailer = new ResendMailer({ apiKey: "re_test_key", from: "t@example.com", fetcher });

    await expect(mailer.send(message)).rejects.toThrow("resend send failed: HTTP 403");
  });

  it("throws when a 2xx body is not the expected { id } shape", async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(200, { unexpected: true })));
    const mailer = new ResendMailer({ apiKey: "re_test_key", from: "t@example.com", fetcher });

    await expect(mailer.send(message)).rejects.toThrow("not the expected shape");
  });
});

describe("LoggingMailer / createMailer", () => {
  it("createMailer picks the logging mailer when no key is set", async () => {
    const logged: unknown[] = [];
    const spyLogger = pino({ level: "info" }, { write(chunk) { logged.push(JSON.parse(chunk) as unknown); } });
    const mailer = createMailer({ logger: spyLogger, resendApiKey: undefined, from: "t@example.com" });

    expect(mailer).toBeInstanceOf(LoggingMailer);
    await mailer.send({ to: "a@example.com", subject: "s", html: "<p>hi</p>", text: "hi" });

    const entry = must(logged[0]) as { msg: string; to: string; html: string };
    expect(entry.msg).toContain("RESEND_API_KEY is not configured");
    expect(entry.to).toBe("a@example.com");
    // 日志模式的价值：整封邮件（含验证链接）可从日志取回
    expect(entry.html).toBe("<p>hi</p>");
  });

  it("createMailer picks Resend when a key is set", () => {
    const mailer = createMailer({ logger, resendApiKey: "re_x", from: "t@example.com" });
    expect(mailer).toBeInstanceOf(ResendMailer);
  });
});

describe("renderVerificationEmail", () => {
  const link = "https://web.example/verify-email?token=abc&next=/login";

  it("escapes user input in the HTML body (old repo BUG-285: the name is attacker-controlled)", () => {
    const { html } = renderVerificationEmail({
      to: "victim@example.com",
      name: '<a href="http://evil.example">Free</a>',
      link,
      expiry: "24 hours",
    });
    expect(html).toContain("&lt;a href=");
    expect(html).not.toContain('<a href="http://evil.example">Free</a>');
  });

  it("keeps the link raw — escaping it would print &amp; and kill the query params", () => {
    const { html, text } = renderVerificationEmail({ to: "u@example.com", name: "Ann", link, expiry: "24 hours" });
    expect(html).toContain(`href="${link}"`);
    expect(text).toContain(link);
  });

  it("derives a plain-text part from the same HTML", () => {
    const { html, text } = renderVerificationEmail({ to: "u@example.com", name: "Ann", link, expiry: "24 hours" });
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("<p>");
    expect(text).toContain("expires in 24 hours");
    expect(html).toContain("expires in 24 hours");
  });
});

describe("escapeHtml / htmlToPlainText", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });

  it("strips tags and resolves entities", () => {
    expect(htmlToPlainText("<p>a&nbsp;b &amp; c</p>")).toBe("a b & c");
  });
});
