import { describe, expect, it } from "vitest";
import { parseEnv } from "./index.ts";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  S3_BUCKET: "bucket",
  BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
};

describe("parseEnv", () => {
  it("applies defaults", () => {
    const env = parseEnv(base);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe("development");
    expect(env.S3_FORCE_PATH_STYLE).toBe(false);
    expect(env.S3_ENDPOINT).toBeUndefined();
    expect(env.CORS_ORIGINS).toEqual([]);
    // 邮件基建（#22）：key 缺省 = 日志模式；发件人有默认值
    expect(env.RESEND_API_KEY).toBeUndefined();
    expect(env.WEB_APP_URL).toBeUndefined();
    expect(env.EMAIL_FROM).toContain("<");
  });

  it("accepts the email-sending variables when set (#22)", () => {
    const env = parseEnv({
      ...base,
      RESEND_API_KEY: "re_123",
      WEB_APP_URL: "https://os.example.com",
      EMAIL_FROM: "Ally OS <noreply@example.com>",
    });
    expect(env.RESEND_API_KEY).toBe("re_123");
    expect(env.WEB_APP_URL).toBe("https://os.example.com");
    expect(env.EMAIL_FROM).toBe("Ally OS <noreply@example.com>");
  });

  it("rejects a malformed web app url", () => {
    expect(() => parseEnv({ ...base, WEB_APP_URL: "not-a-url" })).toThrow(/WEB_APP_URL/);
  });

  it("treats empty strings as unset", () => {
    const env = parseEnv({ ...base, S3_ENDPOINT: "", PORT: "" });
    expect(env.S3_ENDPOINT).toBeUndefined();
    expect(env.PORT).toBe(3000);
  });

  it("splits CORS origins", () => {
    const env = parseEnv({ ...base, CORS_ORIGINS: "https://a.com, https://b.com" });
    expect(env.CORS_ORIGINS).toEqual(["https://a.com", "https://b.com"]);
  });

  it("accepts an optional slack webhook url", () => {
    const unset = parseEnv(base);
    expect(unset.SLACK_WEBHOOK_URL).toBeUndefined();

    const set = parseEnv({ ...base, SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/X" });
    expect(set.SLACK_WEBHOOK_URL).toBe("https://hooks.slack.com/services/T/B/X");
  });

  it("rejects a malformed slack webhook url", () => {
    expect(() => parseEnv({ ...base, SLACK_WEBHOOK_URL: "not-a-url" })).toThrow(/SLACK_WEBHOOK_URL/);
  });

  it("rejects missing required values with a readable message", () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it("rejects a missing or too-short better-auth secret", () => {
    expect(() => parseEnv({ ...base, BETTER_AUTH_SECRET: undefined })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => parseEnv({ ...base, BETTER_AUTH_SECRET: "short" })).toThrow(/BETTER_AUTH_SECRET/);
  });
});
