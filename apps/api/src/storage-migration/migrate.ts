import { createHash } from "node:crypto";
import { assertSafeKey, type Storage, type StorageReader } from "@ally/storage";
import type { Logger } from "pino";

/**
 * Supabase Storage → S3 对象迁移核心(#31,验收第 1 条:迁移后抽样校验
 * 数量与 hash)。源与目标都是注入的端口:源在 supabase-source.ts(Storage
 * REST),目标是 @ally/storage 的对象面(put/head + reader 的 get/list)。
 * 执行需要双方凭证,随切换窗口跑;本模块与它的测试不碰网络。
 */

/** 源侧一个对象:桶内路径 + 清单自报大小(拿不到时 null,只影响续跑判断) */
export interface SourceObject {
  path: string;
  sizeBytes: number | null;
}

export interface StorageMigrationSource {
  /** 全部桶名(升序由实现保证或由核心排序) */
  listBuckets(): Promise<string[]>;
  /** 递归枚举桶内全部对象(目录条目不出现),路径相对桶根 */
  listObjects(bucket: string): AsyncIterable<SourceObject>;
  /** 下载对象字节;失败原样抛 */
  download(bucket: string, path: string): Promise<Uint8Array>;
}

/**
 * 目标 = 应用侧同一套 S3:写入走 Storage(put/head),校验走 StorageReader
 * (get/list)。不引第二个客户端——迁移后的对象要能被运行中的应用读到,
 * 用同一个客户端写才是「迁移完成」的同一事实。
 */
export interface MigrationTarget {
  storage: Storage;
  reader: StorageReader;
}

export type MigrationMode = "dry-run" | "apply" | "verify";

export interface MigrationObjectError {
  bucket: string;
  path: string;
  stage: "list" | "key" | "head" | "download" | "put" | "verify";
  reason: string;
}

export interface BucketReport {
  bucket: string;
  /** 源侧枚举到的对象数 */
  sourceCount: number;
  /** 目标侧前缀下的对象数(apply/verify 模式才有意义) */
  targetCount: number;
  /** 目标有而源没有的 key 数(历史残留或先前任次失败的孤儿,只报告不处置) */
  extraInTarget: number;
  /** apply 实际复制数 / dry-run 中「将会复制」数 */
  copied: number;
  /** 目标已有且大小一致而跳过数(断点续跑的机制) */
  skipped: number;
  /** 源有而目标没有的 key 数(>0 则 ok=false) */
  missingInTarget: number;
  /** hash 抽样校验的对象数 */
  sampled: number;
  hashMismatches: string[];
  errors: MigrationObjectError[];
}

export interface MigrationReport {
  mode: MigrationMode;
  buckets: BucketReport[];
  totals: {
    sourceCount: number;
    targetCount: number;
    copied: number;
    skipped: number;
    missingInTarget: number;
    extraInTarget: number;
    sampled: number;
    hashMismatches: number;
    errors: number;
  };
  /** errors / missing / hash 不一致全零才 ok;dry-run 只看枚举错误 */
  ok: boolean;
}

export interface MigrateStorageOptions {
  source: StorageMigrationSource;
  target: MigrationTarget;
  logger: Logger;
  mode: MigrationMode;
  /** 只处理这些桶(缺省 = 源侧全部桶,升序处理) */
  buckets?: string[] | undefined;
  /** hash 抽样数量(每桶),默认 20 */
  sampleSize?: number | undefined;
  /** 抽样种子:同种子 + 同清单 = 同样本,重跑校验同一批对象,默认 1 */
  sampleSeed?: number | undefined;
  /** 源对象 → 目标 key 的映射,默认 `<桶名>/<原路径>`(桶名做首段,桶间
   * 同路径不撞;新库里存的老路径按同一规则解析,路径本身不动) */
  keyForObject?: ((bucket: string, path: string) => string) | undefined;
}

const DEFAULT_SAMPLE_SIZE = 20;
const DEFAULT_SAMPLE_SEED = 1;

export function defaultKeyForObject(bucket: string, path: string): string {
  return `${bucket}/${path}`;
}

export async function migrateStorage(opts: MigrateStorageOptions): Promise<MigrationReport> {
  const mode = opts.mode;
  const sampleSize = opts.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  const sampleSeed = opts.sampleSeed ?? DEFAULT_SAMPLE_SEED;
  const keyFor = opts.keyForObject ?? defaultKeyForObject;
  const bucketNames =
    opts.buckets !== undefined
      ? [...opts.buckets].sort()
      : (await opts.source.listBuckets()).sort();

  const buckets: BucketReport[] = [];
  for (const bucket of bucketNames) {
    buckets.push(await migrateBucket(opts, bucket, mode, sampleSize, sampleSeed, keyFor));
  }

  const totals = {
    sourceCount: sum(buckets, (b) => b.sourceCount),
    targetCount: sum(buckets, (b) => b.targetCount),
    copied: sum(buckets, (b) => b.copied),
    skipped: sum(buckets, (b) => b.skipped),
    missingInTarget: sum(buckets, (b) => b.missingInTarget),
    extraInTarget: sum(buckets, (b) => b.extraInTarget),
    sampled: sum(buckets, (b) => b.sampled),
    hashMismatches: sum(buckets, (b) => b.hashMismatches.length),
    errors: sum(buckets, (b) => b.errors.length),
  };
  const ok =
    totals.errors === 0 &&
    (mode === "dry-run" || (totals.missingInTarget === 0 && totals.hashMismatches === 0));
  return { mode, buckets, totals, ok };
}

async function migrateBucket(
  opts: MigrateStorageOptions,
  bucket: string,
  mode: MigrationMode,
  sampleSize: number,
  sampleSeed: number,
  keyFor: (bucket: string, path: string) => string,
): Promise<BucketReport> {
  const { source, target, logger } = opts;
  const report: BucketReport = {
    bucket,
    sourceCount: 0,
    targetCount: 0,
    extraInTarget: 0,
    copied: 0,
    skipped: 0,
    missingInTarget: 0,
    sampled: 0,
    hashMismatches: [],
    errors: [],
  };

  // 枚举源:发生错误就带着已枚举的部分继续(部分清单好过没有报告),
  // 错误记为 list 阶段、桶级
  const sourceObjects: SourceObject[] = [];
  try {
    for await (const obj of source.listObjects(bucket)) {
      sourceObjects.push(obj);
    }
  } catch (err) {
    report.errors.push({
      bucket,
      path: "",
      stage: "list",
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  report.sourceCount = sourceObjects.length;
  logger.info({ bucket, sourceCount: report.sourceCount }, "storage-migration: source listed");

  // key 映射一次,各阶段共用:坏 key 只记一条 key 阶段错误,不重复计数
  const keyByPath = new Map<string, string>();
  for (const obj of sourceObjects) {
    const key = safeKeyFor(report, bucket, obj.path, keyFor);
    if (key !== null) keyByPath.set(obj.path, key);
  }

  if (mode === "dry-run") {
    // 只读计划:逐对象 head,报告将会复制/跳过多少,不写任何东西
    for (const obj of sourceObjects) {
      const key = keyByPath.get(obj.path);
      if (key === undefined) continue;
      try {
        const existing = await target.storage.head(key);
        if (existing !== null && (obj.sizeBytes === null || existing.sizeBytes === obj.sizeBytes)) {
          report.skipped++;
        } else {
          report.copied++;
        }
      } catch (err) {
        report.errors.push({
          bucket,
          path: obj.path,
          stage: "head",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return report;
  }

  if (mode === "apply") {
    for (const obj of sourceObjects) {
      const key = keyByPath.get(obj.path);
      if (key === undefined) continue;
      let existing: { sizeBytes: number } | null;
      try {
        existing = await target.storage.head(key);
      } catch (err) {
        report.errors.push({
          bucket,
          path: obj.path,
          stage: "head",
          reason: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (existing !== null && (obj.sizeBytes === null || existing.sizeBytes === obj.sizeBytes)) {
        report.skipped++;
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = await source.download(bucket, obj.path);
      } catch (err) {
        report.errors.push({
          bucket,
          path: obj.path,
          stage: "download",
          reason: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      try {
        await target.storage.put(key, bytes);
      } catch (err) {
        report.errors.push({
          bucket,
          path: obj.path,
          stage: "put",
          reason: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      report.copied++;
      logger.debug({ bucket, path: obj.path, key }, "storage-migration: copied");
    }
    logger.info(
      { bucket, copied: report.copied, skipped: report.skipped, errors: report.errors.length },
      "storage-migration: copy pass done",
    );
  }

  await verifyBucket(opts, bucket, report, keyByPath, sampleSize, sampleSeed);
  return report;
}

/**
 * 数量对账 + hash 抽样(apply 收尾与 verify 模式共用):
 * - 目标按桶前缀枚举一遍 → 数量、缺失(源有目标无)、多余(目标有源无);
 * - 确定性抽样 min(sampleSize, n) 个源对象,两侧各下载一次,sha256 对比。
 */
async function verifyBucket(
  opts: MigrateStorageOptions,
  bucket: string,
  report: BucketReport,
  keyByPath: Map<string, string>,
  sampleSize: number,
  sampleSeed: number,
): Promise<void> {
  const { source, target, logger } = opts;
  const targetKeys = new Set<string>();
  try {
    for await (const key of target.reader.list(`${bucket}/`)) {
      targetKeys.add(key);
    }
  } catch (err) {
    report.errors.push({
      bucket,
      path: "",
      stage: "list",
      reason: `target list: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  report.targetCount = targetKeys.size;

  const expectedKeys = new Set<string>(keyByPath.values());
  const paths = [...keyByPath.keys()];
  for (const key of expectedKeys) {
    if (!targetKeys.has(key)) report.missingInTarget++;
  }
  for (const key of targetKeys) {
    if (!expectedKeys.has(key)) report.extraInTarget++;
  }

  // 抽样跳过本桶已报错的对象:它们的失败已经记账,再抽一次只会重复计数
  const errored = new Set(
    report.errors.filter((e) => e.bucket === bucket).map((e) => e.path),
  );
  const sampled = samplePaths(
    paths.filter((p) => !errored.has(p)),
    sampleSize,
    sampleSeed,
  );
  for (const path of sampled) {
    const key = keyByPath.get(path);
    if (key === undefined) continue; // 不可达(样本来自同一张映射),类型守卫而已
    try {
      const sourceBytes = await source.download(bucket, path);
      const targetBytes = await target.reader.get(key);
      report.sampled++;
      if (targetBytes === null) {
        // 缺失已由 missingInTarget 计数,这里不重复记
        logger.debug({ bucket, path, key }, "storage-migration: sample target missing");
        continue;
      }
      if (sha256(sourceBytes) !== sha256(targetBytes)) {
        report.hashMismatches.push(path);
      }
    } catch (err) {
      report.errors.push({
        bucket,
        path,
        stage: "verify",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  logger.info(
    {
      bucket,
      targetCount: report.targetCount,
      missing: report.missingInTarget,
      extra: report.extraInTarget,
      sampled: report.sampled,
      mismatches: report.hashMismatches.length,
    },
    "storage-migration: verify done",
  );
}

/** key 映射 + 安全闸;不合法的 key 记为 key 阶段错误并跳过(不中断全批) */
function safeKeyFor(
  report: BucketReport,
  bucket: string,
  path: string,
  keyFor: (bucket: string, path: string) => string,
): string | null {
  try {
    return assertSafeKey(keyFor(bucket, path));
  } catch (err) {
    report.errors.push({
      bucket,
      path,
      stage: "key",
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sum(buckets: BucketReport[], pick: (b: BucketReport) => number): number {
  return buckets.reduce((acc, b) => acc + pick(b), 0);
}

/**
 * 确定性抽样:mulberry32 种子流 + 逐个「按随机下标从池里 splice 出来」。
 * 同一种子、同一条升序清单永远抽出同一批——重跑校验同一批对象,报告可对照。
 * 池大于等于总量时整批直返,不做伪随机。
 */
export function samplePaths(paths: string[], sampleSize: number, seed: number): string[] {
  if (sampleSize <= 0 || paths.length === 0) return [];
  const sorted = [...paths].sort();
  if (sampleSize >= sorted.length) return sorted;
  const rand = mulberry32(seed);
  const pool = sorted;
  const picked: string[] = [];
  while (picked.length < sampleSize && pool.length > 0) {
    const at = Math.floor(rand() * pool.length);
    const [item] = pool.splice(at, 1);
    if (item !== undefined) picked.push(item);
  }
  return picked.sort();
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
