/**
 * 角色引导 CLI（#23）：给一个已有账号授予角色。第一台机器上没有 admin/owner 时，
 * 授权端点无人能过（R-16-6 门 + roles.assign 都要求先有角色）——鸡生蛋问题由
 * 运维在部署机上用本脚本解开，这也是撤销最后一个 owner 之后的恢复通道。
 *
 * 用法（默认 dry-run，加 --apply 才写库）：
 *
 *   node --env-file-if-exists=.env apps/api/src/scripts/grant-role.ts --email boss@example.com --role owner
 *   node --env-file-if-exists=.env apps/api/src/scripts/grant-role.ts --email boss@example.com --role owner --apply
 *
 * 退出码：0 = 已授予（或 dry-run 命中）；1 = 用户不存在；2 = 用法/环境错误。
 * 可安全重跑（幂等）。本脚本绕过 API 的 R-16-6 门，属运维动作——写审计，
 * actor 记 "cli:grant-role"。
 */
import { eq } from "drizzle-orm";
import { envSchema } from "@ally/config";
import { createDb, schema } from "@ally/db";
import pino from "pino";
import { recordAudit } from "../audit/audit-log.ts";
import { OWNER_APPROVAL_ROLES, roleSchema } from "../authz/permissions.ts";

const cliEnv = envSchema
  .pick({ DATABASE_URL: true, LOG_LEVEL: true })
  .parse(
    Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v !== "")),
  );

const logger = pino({ level: cliEnv.LOG_LEVEL }, process.stderr);

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const email = argValue("--email");
const apply = process.argv.includes("--apply");
const parsedRole = roleSchema.safeParse(argValue("--role"));

if (email === undefined || email === "" || !parsedRole.success) {
  process.stderr.write(
    "usage: node apps/api/src/scripts/grant-role.ts --email <address> --role <role> [--apply]\n" +
      `roles: ${roleSchema.options.join(", ")}\n` +
      "  default is a dry run; pass --apply to write. exit codes: 0 ok, 1 user not found, 2 usage.\n",
  );
  process.exit(2);
}
const role = parsedRole.data;

const { db, pool } = createDb(cliEnv.DATABASE_URL);
try {
  const users = await db
    .select({ id: schema.authUser.id })
    .from(schema.authUser)
    .where(eq(schema.authUser.email, email))
    .limit(1);
  const user = users[0];
  if (user === undefined) {
    logger.error({ email }, "user not found");
    process.exit(1);
  }
  if (OWNER_APPROVAL_ROLES.includes(role)) {
    logger.warn(
      { role },
      "owner-approval role: granting via CLI bypasses the R-16-6 API gate — this is an ops action, audited as such",
    );
  }
  if (apply) {
    await db.insert(schema.userRole).values({ userId: user.id, role }).onConflictDoNothing();
    await recordAudit(db, {
      actor: "cli:grant-role",
      action: "role.granted",
      target: user.id,
      detail: { role },
    });
  }
  // 报告是这条命令的主产物，走 stdout（日志走 stderr，不混流）
  process.stdout.write(`${JSON.stringify({ email, role, applied: apply }, null, 2)}\n`);
} finally {
  await pool.end();
}
