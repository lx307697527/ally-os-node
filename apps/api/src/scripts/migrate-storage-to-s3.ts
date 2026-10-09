/**
 * Supabase Storage → S3 对象迁移 CLI(#31,验收第 1 条「迁移后抽样校验数量
 * 与 hash」的执行器)。按原路径批量复制:目标 key = `<桶名>/<原路径>`,老库
 * 里的路径一个字不动。默认 dry-run(只清点与 head,不写);`--apply` 才复制,
 * 且复制完自动做数量对账 + hash 抽样;`--verify` 只校验不写。可安全重跑:
 * 目标已有同 key 且大小一致的对象即跳过(断点续跑)。
 *
 * 需要双方凭证,随切换窗口执行:
 *   源:SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY(Storage REST,service role)
 *   目标:S3_BUCKET / S3_REGION / S3_ENDPOINT / S3_ACCESS_KEY_ID /
 *         S3_SECRET_ACCESS_KEY / S3_FORCE_PATH_STYLE(@ally/config)
 *
 * 用法:
 *   node --env-file-if-exists=.env apps/api/src/scripts/migrate-storage-to-s3.ts \
 *     [--apply | --verify] [--bucket <name>] [--sample <n>] [--seed <n>]
 *
 * 退出码:0 = 报告 ok;1 = 报告 not ok(错误/缺失/hash 不一致,JSON 报告里
 * 逐条定位);2 = 用法/环境错误。报告走 stdout,日志走 stderr,不混流。
 */
import { z } from "zod";
import { envSchema } from "@ally/config";
import { createS3Storage, createS3StorageReader } from "@ally/storage";
import pino from "pino";
import { migrateStorage } from "../storage-migration/migrate.ts";
import { createSupabaseStorageSource } from "../storage-migration/supabase-source.ts";

// parseEnv 要求整套服务 env(BETTER_AUTH_SECRET…),迁移只要 S3 目标与源凭证
// ——从同一个 envSchema pick,再加本脚本私有的源侧变量,不另立 schema。
const cliEnv = envSchema
  .pick({
    S3_BUCKET: true,
    S3_REGION: true,
    S3_ENDPOINT: true,
    S3_ACCESS_KEY_ID: true,
    S3_SECRET_ACCESS_KEY: true,
    S3_FORCE_PATH_STYLE: true,
    LOG_LEVEL: true,
  })
  .extend({
    SUPABASE_URL: z.url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  })
  .parse(
    Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v !== "")),
  );

const logger = pino({ level: cliEnv.LOG_LEVEL }, process.stderr);

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const verify = args.includes("--verify");

function usageAndExit(): never {
  process.stderr.write(
    "usage: node apps/api/src/scripts/migrate-storage-to-s3.ts [--apply | --verify] " +
      "[--bucket <name>] [--sample <n>] [--seed <n>]\n" +
      "  default is a dry run; --apply copies then verifies; --verify only verifies.\n" +
      "  exit codes: 0 ok, 1 report not ok, 2 usage/env.\n",
  );
  process.exit(2);
}

if (apply && verify) usageAndExit();
if (args.includes("--help")) usageAndExit();

function intFlag(name: string): number | undefined {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const raw = args[at + 1];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    logger.error(`${name} expects a non-negative integer`);
    process.exit(2);
  }
  return parsed;
}

const bucketAt = args.indexOf("--bucket");
const bucketArg = bucketAt === -1 ? undefined : args[bucketAt + 1];
if (bucketArg === undefined || bucketArg === "") {
  if (bucketAt !== -1) {
    logger.error("--bucket expects a name");
    process.exit(2);
  }
}
const bucket = bucketArg;
const sampleSize = intFlag("--sample");
const sampleSeed = intFlag("--seed");

const s3Options = {
  bucket: cliEnv.S3_BUCKET,
  region: cliEnv.S3_REGION,
  ...(cliEnv.S3_ENDPOINT === undefined ? {} : { endpoint: cliEnv.S3_ENDPOINT }),
  ...(cliEnv.S3_ACCESS_KEY_ID === undefined || cliEnv.S3_SECRET_ACCESS_KEY === undefined
    ? {}
    : { accessKeyId: cliEnv.S3_ACCESS_KEY_ID, secretAccessKey: cliEnv.S3_SECRET_ACCESS_KEY }),
  forcePathStyle: cliEnv.S3_FORCE_PATH_STYLE,
};

const report = await migrateStorage({
  source: createSupabaseStorageSource({
    baseUrl: cliEnv.SUPABASE_URL,
    serviceRoleKey: cliEnv.SUPABASE_SERVICE_ROLE_KEY,
  }),
  target: {
    storage: createS3Storage(s3Options),
    reader: createS3StorageReader(s3Options),
  },
  logger,
  mode: apply ? "apply" : verify ? "verify" : "dry-run",
  ...(bucket === undefined ? {} : { buckets: [bucket] }),
  ...(sampleSize === undefined ? {} : { sampleSize }),
  ...(sampleSeed === undefined ? {} : { sampleSeed }),
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;
