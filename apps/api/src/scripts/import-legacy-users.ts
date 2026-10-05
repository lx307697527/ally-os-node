/**
 * 存量用户导入 CLI（#22 切片 5）：把老库 `auth.users`（Supabase GoTrue）的
 * JSON 导出导入新系统，用户带原 bcrypt 密码直接可登录，无需重置。
 *
 * 用法（默认 dry-run，加 --apply 才写库）：
 *
 *   node --env-file-if-exists=.env apps/api/src/scripts/import-legacy-users.ts <export.json>
 *   node --env-file-if-exists=.env apps/api/src/scripts/import-legacy-users.ts <export.json> --apply
 *
 * 导出（在老库 Supabase PG 上执行，字段名即 GoTrue 表结构）：
 *
 *   copy (
 *     select id, email, encrypted_password, email_confirmed_at, confirmed_at,
 *            created_at, updated_at, last_sign_in_at, raw_user_meta_data
 *     from auth.users
 *     order by created_at
 *   ) to stdout with (format json);
 *
 * 退出码：0 = 全部行处理成功（含跳过）；1 = 有坏行（报告里逐条列原因）；
 * 2 = 用法/IO/环境错误。可安全重跑（幂等）。
 */
import { readFileSync } from "node:fs";
import { envSchema } from "@ally/config";
import { createDb } from "@ally/db";
import pino from "pino";
import { importLegacyUsers } from "../auth/legacy-import.ts";

// parseEnv 要求整套服务 env（S3_BUCKET、BETTER_AUTH_SECRET…），导入只需要
// 数据库与日志级别——从同一个 envSchema pick，别在这里另立 schema。
const cliEnv = envSchema
  .pick({ DATABASE_URL: true, LOG_LEVEL: true })
  .parse(
    Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v !== "")),
  );

const logger = pino({ level: cliEnv.LOG_LEVEL }, process.stderr);

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const file = args.find((a) => a !== "--apply");

if (file === undefined || file === "") {
  process.stderr.write(
    "usage: node apps/api/src/scripts/import-legacy-users.ts <export.json> [--apply]\n" +
      "  default is a dry run; pass --apply to write. exit codes: 0 ok, 1 bad rows, 2 usage/io.\n",
  );
  process.exit(2);
}

let parsed: unknown;
try {
  parsed = JSON.parse(readFileSync(file, "utf8"));
} catch (err) {
  logger.error({ err }, `cannot read export file ${file}`);
  process.exit(2);
}

if (!Array.isArray(parsed)) {
  logger.error("export must be a JSON array of auth.users rows (copy … with (format json))");
  process.exit(2);
}

const { db, pool } = createDb(cliEnv.DATABASE_URL);
try {
  const report = await importLegacyUsers(db, parsed, { logger, apply });
  // 报告是这条命令的主产物,单独走 stdout（日志走 stderr,不混流）
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.errors.length > 0) {
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
