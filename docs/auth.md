# 认证与账号体系（#22）

替代 Supabase Auth（GoTrue）的自建认证：**Better Auth** + Drizzle(PG)，
邮箱密码登录，HttpOnly Cookie 会话。本页记录已落地的部分与后续切片的边界。

## 已落地：邮件基建 + 注册强制邮箱验证（#22 切片 2）

老系统依据：FEAT-634（2026-09-21 owner 裁定注册强制确认邮箱）+
`supabase/functions/auth-send-email`（Send Email Hook，发送失败永远 200 不阻塞流程）+
`otp_expiry = 86400`（24h，FEAT-056 phase 15b）。

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 邮件发送器 | `apps/api/src/mailer/mailer.ts` | `Mailer` 接口注入。key 已配置 → `ResendMailer`（HTTP API，响应 zod 校验）；留空 → `LoggingMailer`（整封邮件进日志，本地开发从日志拿验证链接） |
| 验证邮件模板 | 同上 `renderVerificationEmail` | 内置一份（DB 模板表是 #131）；姓名/邮箱进 HTML 前转义（老仓库 BUG-285 教训：姓名是攻击者可控的钓鱼通道），链接不转义（转义会把 `&` 变 `&amp;` 弄死链接） |
| 强制验证 | `apps/api/src/auth/auth.ts` | `requireEmailVerification: true` + `sendOnSignUp`：注册响应 `token: null` 不建会话；未验证登录 403 `EMAIL_NOT_VERIFIED` |
| 确认链接 | 控制台 `/verify-email?token=…` | `WEB_APP_URL` 拼接。用户点击后前端才调 GET 验证端点——邮件扫描器预取只拿到静态页，消耗不了令牌（老系统 token_hash 落 portal 确认页的同款思路） |
| 令牌有效期 | 24h（`emailVerification.expiresIn = 86400`） | 对齐老系统 `otp_expiry` |
| 前端 | `apps/web` `/verify-email` + 登录页未验证分支 | 确认页四态（ready/verifying/verified/failed）；登录收到 403 → 出「重发确认邮件」，成功提示不承诺地址存在（防枚举端点） |
| 环境变量 | `@ally/config` | `RESEND_API_KEY`（可空）、`EMAIL_FROM`（默认占位发件人）、`WEB_APP_URL`（可空 = 退回 API 链接；生产必须配置） |
| Terraform | `infra/terraform/aws/` | `resend_api_key` 变量 → Secrets Manager `${name}/resend-api-key` → ECS 注入；`email_from` / `web_app_url` 平铺 env。生产不配 key 时验证邮件只进日志——上线清单必查项 |

关键行为（Better Auth 1.7.7 实测）：

- 注册返回 200 + `{ token: null, user }`，**没有会话 cookie**；确认前登录 403。
- 重复注册同邮箱返回与成功**同形**的通用响应（防枚举），不发第二封邮件；
  老 issue 里「GoTrue identities 空数组怪癖改明确错误码」不照搬——通用响应
  是比明确错误码更强的防枚举。
- `POST /api/auth/send-verification-email` 对存在/不存在的地址都答 200。
- 发送失败只记日志、注册照常完成（老 hook「永远 200」裁定的新系统等价物：
  邮件可以重发，卡死的注册没法接受）。

验证流程矩阵（`apps/api/src/auth/auth.test.ts`，11 条集成测试）：
注册落库未验证+恰发一封 → 未验证 403（code `EMAIL_NOT_VERIFIED`）→ 确认后
`email_verified` 翻转、登录 / `/api/me` / 登出全链路 → 篡改令牌不翻转 →
重复注册同形响应且不重发 → Resend 故障不阻塞注册 → 重发端点存在/不存在同答 200。

## 已落地：credential login（#22 切片 1）

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 认证核心 | `apps/api/src/auth/auth.ts` | `createAuth`：Better Auth 实例（drizzleAdapter、emailAndPassword、uuid id）；`createSessionResolver`：HTTP 会话解析；`createSessionTokenVerifier`：给 WS 等非 cookie 通道校验令牌 |
| 会话中间件 | `apps/api/src/auth/session.ts` | `/api/*`（除 `/api/auth/*`）统一鉴权，业务代码 `c.get("user")` 拿当前用户，不接触令牌 |
| 挂载 | `apps/api/src/app.ts` | `/api/auth/*` 走 Better Auth handler；其余 `/api/*` 先过会话中间件；`GET /api/me` 返回当前用户 |
| 数据表 | `packages/db/src/schema.ts` | `auth_user` / `auth_session` / `auth_account` / `auth_verification`（Better Auth 核心模型，uuid 主键，snake_case 列名） |
| 环境变量 | `@ally/config` | `BETTER_AUTH_SECRET`（≥32 字符，缺失拒绝启动，生产由 Terraform 生成并经 Secrets Manager 注入）；`BETTER_AUTH_URL`（对外基准地址，可留空 = 从请求推导；公有域名定下来后接入 Terraform） |
| realtime 鉴权 | `apps/api/src/realtime/auth.ts` | WS auth 帧改为校验 Better Auth 会话令牌（见 `docs/realtime.md`） |

## 关键决策

- **id 用 uuid 且由我们生成**（`advanced.database.generateId`）。老系统的业务表
  全部挂在同值 uuid 的用户主键上；后续数据迁移按原 `auth.users.id` 导入，
  外键不需要全表改写。
- **会话 12h 不活动超时**，对齐老系统 `config.toml [auth.sessions]
  inactivity_timeout = 12h`（FEAT-019）：`expiresIn = 12h`，活跃访问按
  `updateAge = 1h` 节流续期；不活动跨过 12h 会话即死。老系统刻意不设绝对
  timebox，这里同样不设。
- **会话存自家 PG**，不进 localStorage / 不自管 JWT。cookie HttpOnly +
  SameSite=Lax，签名密钥即 `BETTER_AUTH_SECRET`。
- **account 模型预留多身份**：credential 登录是一行 `provider_id =
  "credential"` 的 account（`password` 列存哈希）；Google OAuth（后续切片）
  是新 provider 行，不动用户主记录。
- **生产没有接线校验器就拒绝**：realtime 在生产环境若没有会话校验器则拒绝
  所有连接（fail closed），开发/测试保留 `dev:<userId>` 直通便于本地联调。

## API（Better Auth 端点，挂载在 `/api/auth/*`）

| 端点 | 说明 |
| --- | --- |
| `POST /api/auth/sign-up/email` | `{ email, password, name }` 注册；落库为未验证、发确认邮件、不建会话（切片 2 起，FEAT-634） |
| `POST /api/auth/sign-in/email` | 邮箱密码登录（未验证 403）；`Set-Cookie: better-auth.session_token=…` |
| `GET /api/auth/verify-email?token=…` | 邮箱确认（前端确认页在用户点击后调用；直接 GET 亦有效） |
| `POST /api/auth/send-verification-email` | 重发确认邮件；对存在/不存在地址同答 200（防枚举） |
| `POST /api/auth/sign-out` | 登出，服务端吊销会话 |
| `GET /api/me` | 当前登录用户（业务路由，经会话中间件） |

## #22 后续切片（本切片不含）

- 密码重置流程（老系统：recovery 令牌 + set-password 页，24h 有效；邮件基建
  本切片已就位，直接可用）
- Google OAuth 登录（老系统经 Supabase OAuth，hd 只是 courtesy、真正校验靠
  员工域检查；新系统直接用 Better Auth 的 Google provider）
- 存量密码哈希导入：老库是 bcrypt（`$2a$`/`$2b$`，pgcrypto cost 10），
  Better Auth 默认 scrypt——导入切片需配置 `emailAndPassword.password.verify`
  兼容 bcrypt，用户无需重置密码
- 员工开通/邀请（对应老系统 staff-invite / portal-invite 的语义，含
  shadow account #25）、管理员建用户（管理员建的账号可带已验证邮箱，
  不走注册确认）
- 登录后按角色/权限的界面门禁：RBAC 在 #23，2FA 在 #24
