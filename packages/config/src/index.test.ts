import { describe, expect, it } from "vitest";
import { parseEnv } from "./index.ts";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  S3_BUCKET: "bucket",
};

describe("parseEnv", () => {
  it("applies defaults", () => {
    const env = parseEnv(base);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe("development");
    expect(env.S3_FORCE_PATH_STYLE).toBe(false);
    expect(env.S3_ENDPOINT).toBeUndefined();
    expect(env.CORS_ORIGINS).toEqual([]);
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

  it("rejects missing required values with a readable message", () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });
});
