import { describe, expect, it } from "vitest";
import { assertSafeKey, createS3Storage, createS3StorageReader, validateStoragePrefix } from "./index.ts";

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

  it("head sits behind the same key gate as delete", async () => {
    const storage = createS3Storage({
      bucket: "docs",
      region: "us-east-1",
      endpoint: "http://localhost:9000",
      accessKeyId: "k",
      secretAccessKey: "s",
      forcePathStyle: true,
    });
    // #31 文件内核引入 head（complete 端点的实测字节数）：坏 key 同样在客户端
    // 就炸，不发请求
    await expect(storage.head("a/../b")).rejects.toThrow();
  });
});

describe("createS3StorageReader", () => {
  const opts = {
    bucket: "docs",
    region: "us-east-1",
    endpoint: "http://localhost:9000",
    accessKeyId: "k",
    secretAccessKey: "s",
    forcePathStyle: true,
  };

  it("get sits behind the same key gate as put/head", async () => {
    const reader = createS3StorageReader(opts);
    // #31 迁移脚本引入 get(hash 抽样要读回字节):坏 key 在客户端就炸
    await expect(reader.get("a//b")).rejects.toThrow();
  });

  it("list rejects absolute prefixes client-side", async () => {
    const reader = createS3StorageReader(opts);
    await expect(reader.list("/abs")[Symbol.asyncIterator]().next()).rejects.toThrow();
  });

  it("list rejects traversal segments client-side", async () => {
    const reader = createS3StorageReader(opts);
    await expect(reader.list("a/../b")[Symbol.asyncIterator]().next()).rejects.toThrow();
    // 尾部斜杠(「目录」形态)放行与否在 validateStoragePrefix 的用例里钉
  });
});

describe("validateStoragePrefix", () => {
  it("allows normal prefixes including trailing slash", () => {
    expect(validateStoragePrefix("feedback/")).toBe("feedback/");
    expect(validateStoragePrefix("a/b/c")).toBe("a/b/c");
  });

  it.each(["", "/abs", "a/../b", "./a"])("rejects %j", (prefix) => {
    expect(() => validateStoragePrefix(prefix)).toThrow();
  });
});
