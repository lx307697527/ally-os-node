import { z } from "zod";

// 所有服务共用的环境变量定义。启动时校验一次，缺失或格式错误直接退出，
// 不让错误配置拖到运行中才暴露。
const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z.url(),

  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().min(1).default("us-east-1"),
  // 留空 = AWS S3；填写 = 任意 S3 兼容存储（MinIO / 阿里云 OSS / 腾讯云 COS）
  S3_ENDPOINT: z.url().optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: booleanFromString,

  CORS_ORIGINS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  // Slack incoming webhook：worker 任务最终失败时发告警；留空 = 只记日志不推送
  SLACK_WEBHOOK_URL: z.url().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  // 空字符串视为未设置，便于在 .env 里留空可选项
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v !== ""),
  );
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${details}`);
  }
  return result.data;
}
