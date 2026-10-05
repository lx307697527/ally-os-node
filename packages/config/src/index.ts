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

  // Better Auth 的会话签名密钥（#22）。漏配或太弱都不许启动：会话 cookie 防篡改全靠它。
  BETTER_AUTH_SECRET: z.string().min(32),
  // Better Auth 的对外基准地址（生产必填，回调/重定向要基于确定域名）；
  // 本地留空 = 从请求推导
  BETTER_AUTH_URL: z.url().optional(),

  // 邮件发送（#22 邮件基建切片）：Resend API key。留空 = 开发模式，邮件内容
  // （含验证链接）整封打进日志不发真信；生产必须配置，否则验证邮件发不出去。
  RESEND_API_KEY: z.string().min(1).optional(),
  // 发件人。Resend 只认已验证域名，本地默认值发不出去也无所谓（走日志模式）；
  // 生产由环境注入真实域名。
  EMAIL_FROM: z.string().min(3).default("Ally OS <noreply@allyos.example>"),
  // 后台控制台的对外地址（#22）：验证邮件里的链接落到它身上（/verify-email?token=…），
  // 由前端页面代用户确认，避免邮件扫描器预取直接消耗掉 API 的 GET 验证端点。
  // 留空 = 退回 Better Auth 自己的 API 链接（能验证但会被扫描器预取，生产必须配置）。
  WEB_APP_URL: z.url().optional(),

  // Google OAuth 登录（#22）。两者必须成对出现：只配一个说明部署抄错了配置，
  // 启动即失败（fail closed），不带病跑到 OAuth 回调时才炸。都缺 = 不启用，
  // 登录页也不渲染 Google 按钮（老系统 FEAT-167 裁定：给没配置的提供商一个
  // 按钮，等于提供一个必然失败的动作，和死链接同罪）。
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),

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

// Google OAuth 成对校验（#22）：z.object 层面做不了跨字段的 both-or-none，
// 挂在对象 refine 上——缺一边就指向缺的那个变量名，报错可直接照着补配置。
const envSchemaWithPairs = envSchema.superRefine((env, ctx) => {
  const hasId = env.GOOGLE_CLIENT_ID !== undefined;
  const hasSecret = env.GOOGLE_CLIENT_SECRET !== undefined;
  if (hasId === hasSecret) return;
  ctx.addIssue({
    code: "custom",
    path: [hasId ? "GOOGLE_CLIENT_SECRET" : "GOOGLE_CLIENT_ID"],
    message: "Google OAuth needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET set together (or neither, to disable it)",
  });
});

export function parseEnv(source: Record<string, string | undefined>): Env {
  // 空字符串视为未设置，便于在 .env 里留空可选项
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v !== ""),
  );
  const result = envSchemaWithPairs.safeParse(cleaned);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${details}`);
  }
  return result.data;
}
