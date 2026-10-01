# 认证与账号体系（#22）

替代 Supabase Auth（GoTrue）的自建认证：**Better Auth** + Drizzle(PG)，
邮箱密码登录，HttpOnly Cookie 会话。本页记录已落地的部分与后续切片的边界。

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
| `POST /api/auth/sign-up/email` | `{ email, password, name }` 注册（当前未强制邮箱验证，见下） |
| `POST /api/auth/sign-in/email` | 邮箱密码登录，`Set-Cookie: better-auth.session_token=…` |
| `POST /api/auth/sign-out` | 登出，服务端吊销会话 |
| `GET /api/me` | 当前登录用户（业务路由，经会话中间件） |

## #22 后续切片（本切片不含）

- 邮箱验证与注册流程打磨（依赖邮件发送基建迁入：模板、Resend、
  always-200 的 send-email hook 对应物）
- 密码重置流程（老系统：recovery 令牌 + set-password 页，24h 有效）
- Google OAuth 登录（老系统经 Supabase OAuth，hd 只是 courtesy、真正校验靠
  员工域检查；新系统直接用 Better Auth 的 Google provider）
- 存量密码哈希导入：老库是 bcrypt（`$2a$`/`$2b$`，pgcrypto cost 10），
  Better Auth 默认 scrypt——导入切片需配置 `emailAndPassword.password.verify`
  兼容 bcrypt，用户无需重置密码
- 员工开通/邀请（对应老系统 staff-invite / portal-invite 的语义，含
  shadow account #25）、管理员建用户
- 登录后按角色/权限的界面门禁：RBAC 在 #23，2FA 在 #24
