import { describe, expect, it } from "vitest";
import type { Logger } from "pino";
import type { Storage, StorageReader } from "@ally/storage";
import {
  defaultKeyForObject,
  migrateStorage,
  samplePaths,
  type MigrateStorageOptions,
  type MigrationTarget,
  type SourceObject,
  type StorageMigrationSource,
} from "./migrate.ts";

const noopLogger: Logger = {
  level: "silent",
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

/** 数组 → 异步可迭代,不借 async 生成器语法(仓库 require-await 家规) */
function asyncIterableOf<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () => {
      let at = 0;
      return {
        next: (): Promise<IteratorResult<T>> => {
          const value = items[at];
          at += 1;
          if (value === undefined) return Promise.resolve({ value: undefined, done: true });
          return Promise.resolve({ value, done: false });
        },
      };
    },
  };
}

/** 源假实现:桶 → (路径 → 自报大小;缺省用内容长度)。字节内容由路径确定,
 * 让 hash 校验有真东西可比。记录每次 download 供断言。 */
function makeSource(spec: Record<string, Record<string, number | undefined>>) {
  const downloads: string[] = [];
  const bytesOf = (bucket: string, path: string): Uint8Array =>
    new TextEncoder().encode(`bytes-of:${bucket}/${path}`);
  const source: StorageMigrationSource = {
    listBuckets: () => Promise.resolve(Object.keys(spec)),
    listObjects: (bucket) =>
      asyncIterableOf(
        Object.entries(spec[bucket] ?? {}).map(
          ([path, size]): SourceObject => ({
            path,
            sizeBytes: size ?? bytesOf(bucket, path).length,
          }),
        ),
      ),
    download: (bucket, path) => {
      downloads.push(`${bucket}/${path}`);
      const entries = spec[bucket];
      if (entries === undefined || !(path in entries)) {
        return Promise.reject(new Error(`no such object ${bucket}/${path}`));
      }
      return Promise.resolve(bytesOf(bucket, path));
    },
  };
  return { source, downloads };
}

/** 目标假实现:内存 Map。记录 put 供断言。setCorruptFor 让指定 key 读回
 * 坏字节,模拟落桶后内容损坏。 */
function makeTarget(initial: Record<string, Uint8Array> = {}) {
  const objects = new Map<string, Uint8Array>(Object.entries(initial));
  const puts: string[] = [];
  let corruptFor: ((key: string) => boolean) | undefined;
  const storage: Storage = {
    put: (key, body) => {
      puts.push(key);
      objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body);
      return Promise.resolve();
    },
    signedGetUrl: () => Promise.reject(new Error("not used in migration tests")),
    signedPutUrl: () => Promise.reject(new Error("not used in migration tests")),
    delete: () => Promise.reject(new Error("not used in migration tests")),
    head: (key) => {
      const bytes = objects.get(key);
      return Promise.resolve(bytes === undefined ? null : { sizeBytes: bytes.length });
    },
  };
  const reader: StorageReader = {
    get: (key) => {
      const bytes = objects.get(key);
      if (bytes === undefined) return Promise.resolve(null);
      if (corruptFor?.(key) === true) {
        const broken = bytes.slice();
        const first = broken[0];
        if (first !== undefined) broken[0] = (first + 1) % 256;
        return Promise.resolve(broken);
      }
      return Promise.resolve(bytes);
    },
    list: (prefix) =>
      asyncIterableOf([...objects.keys()].filter((key) => key.startsWith(prefix))),
  };
  const target: MigrationTarget = { storage, reader };
  return {
    target,
    puts,
    objects,
    setCorruptFor: (fn: (key: string) => boolean) => {
      corruptFor = fn;
    },
  };
}

const TWO_BUCKETS = {
  images: {
    "a.png": undefined,
    "sub/b.png": undefined,
  },
  docs: {
    "agreement.pdf": undefined,
  },
};

function run(
  overrides: Partial<MigrateStorageOptions>,
): Promise<Awaited<ReturnType<typeof migrateStorage>>> {
  const { source } = makeSource(TWO_BUCKETS);
  const { target } = makeTarget();
  return migrateStorage({
    source,
    target,
    logger: noopLogger,
    mode: "apply",
    ...overrides,
  });
}

describe("dry-run", () => {
  it("plans the copy without writing anything", async () => {
    const tgt = makeTarget();
    const report = await run({ mode: "dry-run", target: tgt.target });
    expect(report.mode).toBe("dry-run");
    expect(report.totals.sourceCount).toBe(3);
    expect(report.totals.copied).toBe(3); // 空目标:全部「将会复制」
    expect(report.totals.skipped).toBe(0);
    expect(tgt.puts).toHaveLength(0); // 一个字节都没写
    expect(report.ok).toBe(true);
  });

  it("counts already-present objects as would-skip via size match", async () => {
    const { source } = makeSource({ images: { "a.png": 5 } });
    const { target } = makeTarget({
      "images/a.png": new TextEncoder().encode("12345"),
    });
    const report = await migrateStorage({ source, target, logger: noopLogger, mode: "dry-run" });
    expect(report.totals.copied).toBe(0);
    expect(report.totals.skipped).toBe(1);
  });
});

describe("apply", () => {
  it("copies every object to <bucket>/<path>, then verifies", async () => {
    const report = await run({ mode: "apply" });
    expect(report.totals.copied).toBe(3);
    expect(report.totals.missingInTarget).toBe(0);
    expect(report.totals.hashMismatches).toBe(0);
    expect(report.totals.sampled).toBe(3); // 每桶 min(20, n)
    expect(report.ok).toBe(true);
    expect(report.totals.targetCount).toBe(3);
  });

  it("lands bytes under <bucket>/<path> at byte equality", async () => {
    const { source, downloads } = makeSource({ docs: { "agreement.pdf": undefined } });
    const tgt = makeTarget();
    await migrateStorage({ source, target: tgt.target, logger: noopLogger, mode: "apply" });
    // 下载两次是抽样校验的成本:一次复制、一次读回源侧对 hash
    expect(downloads).toEqual(["docs/agreement.pdf", "docs/agreement.pdf"]);
    expect(tgt.puts).toEqual(["docs/agreement.pdf"]);
    expect([...tgt.objects.values()][0]).toEqual(
      new TextEncoder().encode("bytes-of:docs/agreement.pdf"),
    );
  });

  it("is resumable: second run copies nothing by size, only the sample re-reads", async () => {
    const { source, downloads } = makeSource({
      images: { "a.png": undefined, "sub/b.png": undefined },
    });
    const tgt = makeTarget();
    const first = await migrateStorage({
      source,
      target: tgt.target,
      logger: noopLogger,
      mode: "apply",
    });
    expect(first.totals.copied).toBe(2);
    downloads.length = 0;

    const second = await migrateStorage({
      source,
      target: tgt.target,
      logger: noopLogger,
      mode: "apply",
    });
    expect(second.totals.copied).toBe(0);
    expect(second.totals.skipped).toBe(2);
    // 续跑不重复搬字节(copy 侧零下载);抽样校验仍要两侧各读一次
    expect(downloads).toEqual(["images/a.png", "images/sub/b.png"]);
    expect(second.ok).toBe(true);
  });

  it("re-copies when the target holds a stale object of a different size", async () => {
    const { source } = makeSource({ images: { "a.png": undefined } });
    const stale = new TextEncoder().encode("stale-bytes");
    const tgt = makeTarget({ "images/a.png": stale });
    const report = await migrateStorage({
      source,
      target: tgt.target,
      logger: noopLogger,
      mode: "apply",
    });
    expect(report.totals.copied).toBe(1);
    expect(report.totals.skipped).toBe(0);
    expect(tgt.objects.get("images/a.png")?.length).not.toBe(stale.length);
    expect(report.ok).toBe(true);
  });

  it("records download failures as download-stage errors and keeps going", async () => {
    const { source } = makeSource({ images: { "good.png": undefined, "bad.png": undefined } });
    source.download = (_bucket, path) =>
      path === "bad.png"
        ? Promise.reject(new Error("source 500"))
        : Promise.resolve(new TextEncoder().encode(`bytes-of:${path}`));
    const tgt = makeTarget();
    const report = await migrateStorage({
      source,
      target: tgt.target,
      logger: noopLogger,
      mode: "apply",
    });
    expect(report.totals.copied).toBe(1);
    expect(report.totals.errors).toBe(1); // 坏对象只在 download 阶段记一次,抽样不再重复
    expect(report.buckets[0]?.errors[0]).toMatchObject({ path: "bad.png", stage: "download" });
    expect(report.totals.sampled).toBe(1); // 已报错的对象不进抽样
    expect(report.ok).toBe(false);
  });

  it("treats unsafe keys as key-stage errors once, without aborting the batch", async () => {
    const { source } = makeSource({ images: { "ok.png": undefined, "bad//x.png": 1 } });
    const tgt = makeTarget();
    const report = await migrateStorage({
      source,
      target: tgt.target,
      logger: noopLogger,
      mode: "apply",
    });
    expect(report.totals.copied).toBe(1);
    expect(report.totals.errors).toBe(1); // 映射一次,copy 与 verify 不重复记
    expect(report.buckets[0]?.errors[0]).toMatchObject({ path: "bad//x.png", stage: "key" });
    expect(report.ok).toBe(false);
  });
});

describe("verify", () => {
  it("does not write and counts extra target objects without failing them", async () => {
    const { source } = makeSource({ images: { "a.png": undefined } });
    const tgt = makeTarget({
      // 目标字节与源一致:在对象与 hash 两个意义上都「迁移正确」
      "images/a.png": new TextEncoder().encode("bytes-of:images/a.png"),
    });
    tgt.objects.set("images/orphan.png", new TextEncoder().encode("y"));
    const report = await migrateStorage({
      source,
      target: tgt.target,
      logger: noopLogger,
      mode: "verify",
    });
    expect(report.mode).toBe("verify");
    expect(report.totals.missingInTarget).toBe(0);
    expect(report.totals.extraInTarget).toBe(1);
    expect(report.totals.copied).toBe(0);
    expect(tgt.puts).toHaveLength(0);
    expect(report.ok).toBe(true);
  });

  it("counts source objects absent from the target as missing", async () => {
    const { source } = makeSource({ images: { "a.png": undefined, "gone.png": undefined } });
    const { target } = makeTarget({ "images/a.png": new TextEncoder().encode("x") });
    const report = await migrateStorage({ source, target, logger: noopLogger, mode: "verify" });
    expect(report.totals.missingInTarget).toBe(1);
    expect(report.ok).toBe(false);
  });

  it("detects hash mismatches on the sampled objects", async () => {
    const { source } = makeSource({ images: { "a.png": undefined, "b.png": undefined } });
    const tgt = makeTarget();
    await migrateStorage({ source, target: tgt.target, logger: noopLogger, mode: "apply" });
    tgt.setCorruptFor((key) => key === "images/a.png");
    const report = await migrateStorage({
      source,
      target: tgt.target,
      logger: noopLogger,
      mode: "verify",
    });
    expect(report.totals.sampled).toBe(2);
    expect(report.buckets[0]?.hashMismatches).toEqual(["a.png"]);
    expect(report.ok).toBe(false);
  });

  it("verifies only the requested buckets when scoped", async () => {
    const { source } = makeSource({
      images: { "a.png": undefined },
      docs: { "d.pdf": undefined },
    });
    const { target } = makeTarget({ "images/a.png": new TextEncoder().encode("x") });
    const report = await migrateStorage({
      source,
      target,
      logger: noopLogger,
      mode: "verify",
      buckets: ["images"],
    });
    expect(report.buckets.map((b) => b.bucket)).toEqual(["images"]);
    expect(report.totals.sourceCount).toBe(1);
  });
});

describe("sampling", () => {
  const paths = Array.from({ length: 50 }, (_, i) => `obj-${String(i).padStart(2, "0")}.png`);

  it("is deterministic for a given seed", () => {
    expect(samplePaths(paths, 10, 1)).toEqual(samplePaths(paths, 10, 1));
  });

  it("takes min(sampleSize, n) distinct paths, sorted", () => {
    const sample = samplePaths(paths, 10, 7);
    expect(sample).toHaveLength(10);
    expect(new Set(sample).size).toBe(10);
    expect(sample.every((p) => paths.includes(p))).toBe(true);
    expect([...sample].sort()).toEqual(sample);
  });

  it("returns everything when the request reaches the population", () => {
    expect(samplePaths(["b", "a"], 100, 1)).toEqual(["a", "b"]);
  });

  it("returns nothing for zero sample size or empty input", () => {
    expect(samplePaths(paths, 0, 1)).toEqual([]);
    expect(samplePaths([], 10, 1)).toEqual([]);
  });
});

describe("bucket enumeration", () => {
  it("processes buckets in ascending order by default", async () => {
    const { source } = makeSource({ b: { "x": 1 }, a: { "y": 1 } });
    const { target } = makeTarget();
    const report = await migrateStorage({ source, target, logger: noopLogger, mode: "verify" });
    expect(report.buckets.map((b) => b.bucket)).toEqual(["a", "b"]);
  });

  it("propagates source bucket-listing failure (nothing to report on)", async () => {
    const { source } = makeSource({});
    source.listBuckets = () => Promise.reject(new Error("supabase down"));
    const { target } = makeTarget();
    await expect(
      migrateStorage({ source, target, logger: noopLogger, mode: "verify" }),
    ).rejects.toThrow("supabase down");
  });

  it("defaults the key mapping to <bucket>/<path>", () => {
    expect(defaultKeyForObject("signing-pdfs", "abc/contract.pdf")).toBe(
      "signing-pdfs/abc/contract.pdf",
    );
  });
});
