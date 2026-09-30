import { describe, expect, it } from "vitest";
import { assertSafeKey, createS3Storage } from "./index.ts";

describe("assertSafeKey", () => {
  it("accepts normal keys", () => {
    expect(assertSafeKey("quotes/2026/abc.pdf")).toBe("quotes/2026/abc.pdf");
  });

  it.each(["", "/abs/path", "a/../b", "a//b", "./a"])("rejects %j", (key) => {
    expect(() => assertSafeKey(key)).toThrow();
  });
});

describe("createS3Storage", () => {
  it("signs URLs against a custom S3-compatible endpoint", async () => {
    const storage = createS3Storage({
      bucket: "docs",
      region: "us-east-1",
      endpoint: "http://localhost:9000",
      accessKeyId: "k",
      secretAccessKey: "s",
      forcePathStyle: true,
    });
    const url = new URL(await storage.signedGetUrl("a/b.pdf", 60));
    expect(url.origin).toBe("http://localhost:9000");
    expect(url.pathname).toBe("/docs/a/b.pdf");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
  });
});
