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

  it("delete sits behind the same key gate as put/signedGetUrl", async () => {
    const storage = createS3Storage({
      bucket: "docs",
      region: "us-east-1",
      endpoint: "http://localhost:9000",
      accessKeyId: "k",
      secretAccessKey: "s",
      forcePathStyle: true,
    });
    // #110 附件切片引入 delete（生命周期清理）：坏 key 在客户端就炸、不发请求，
    // 与 put / signedGetUrl 共用同一份 assertSafeKey 裁决
    await expect(storage.delete("a/../b")).rejects.toThrow();
  });
});
