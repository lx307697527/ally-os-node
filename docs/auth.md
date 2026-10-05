# 认证与账号体系（#22）

替代 Supabase Auth（GoTrue）的自建认证：**Better Auth** + Drizzle(PG)，
邮箱密码登录，HttpOnly Cookie 会话。本页记录已落地的部分与后续切片的边界。

## 已落地：存量 bcrypt 哈希导入（#22 切片 5）

老用户从老系统(Supabase GoTrue)带原密码迁入,无需重置——对应 #22 验收
第 1 条「老用户用原密码能登录」。老库 `auth.users.encrypted_password` 是
bcrypt(GoTrue / pgcrypto `gen_salt('bf', 10)`,$2a$ / $2b$,cost 10),
Better Auth 默认是自家 scrypt,不兼容则导入即等于强制全员重置。

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 密码校验分派 | `apps/api/src/auth/legacy-password.ts` | `emailAndPassword.password.verify` 按哈希格式分派:bcrypt 前缀($2a$/$2b$/$2y$)→ bcrypt 比对;其余(better-auth scrypt)→ 显式回落 `better-auth/crypto` 的 `verifyPassword`。**提供 verify 即完全替换默认实现**(better-auth create-context 源码确认),所以 scrypt 分支必须自己回落 |
| 坏哈希语义 | 同上 | 库层对非法哈希是抛错(=500);导入数据不完美是常态,坏哈希按「密码对不上」答 false → 401,登录路径永不因坏行 500 |
| 新哈希格式 | 不改 | `hash` 不覆写:注册/重置仍产 scrypt;导入的 bcrypt 在用户改密/重置时自然迁移,**不做登录时重哈希**(热路径多一次写库,复杂度大于收益;bcrypt cost 10 并未破损) |
| 导入核心 | `apps/api/src/auth/legacy-import.ts` | `importLegacyUsers(db, rows, { logger, apply })`:逐行 zod 校验(GoTrue 字段名)→ 冲突判定 → 行级事务写入。dry-run 与 apply 走同一条决定路径,dry-run 结论不失真 |
| 幂等与冲突 | 同上 | 同 id 重跑 = 只补缺失/为空的 credential 密码(全满足则 skipped);同 email 异 id = 报错不合并(那条新系统记录可能已持有会话/外键,合并是数据损失风险,要人裁决);密码非 bcrypt 格式 = 报错 fail closed(老库只应产 $2a$/$2b$,别的格式说明导出有问题) |
| OAuth-only 用户 | 同上 | 老库 `encrypted_password` 为空(Google-only 用户)→ 照常导入,credential 密码留空:登录等同「密码不对」401(better-auth 对 null 密码短路),用户走重置流程或 Google 登录 |
| account 形状 | 同上 | `providerId: "credential"`、`accountId: user.id`——better-auth 登录路径按 `accountId === user.id` 找 account(sign-in 源码确认),导入必须同形状 |
| 邮箱验证状态 | 同上 | 取 `email_confirmed_at`(兼容老字段 `confirmed_at`):未确认的导入为未验证,登录 403 走重发确认——与 FEAT-634 新系统策略一致 |
| CLI | `apps/api/src/scripts/import-legacy-users.ts` | `node --env-file-if-exists=.env apps/api/src/scripts/import-legacy-users.ts <export.json> [--apply]`;默认 dry-run,`--apply` 才写库;报告 JSON 走 stdout、日志走 stderr;退出码 0/1(坏行)/2(用法·IO);可安全重跑。导出 SQL 见文件头注释(`copy (select …) to stdout with (format json)`) |
| env | `@ally/config` | 零新变量。CLI 从 `envSchema.pick({ DATABASE_URL, LOG_LEVEL })` 取值——不要求整套服务 env,也不另立 schema |

关键行为(集成测试钉住,`legacy-import.test.ts` 11 条 + `legacy-password.test.ts` 5 条):

- 导入后用**原密码**登录 200、`/api/me` 拿到原 uuid 用户;错密码 401。
- 原 uuid 保留(老系统业务表外键全挂在它上面,#22 裁定不重排)、展示名取
  `raw_user_meta_data.name`(缺则 `full_name`,再缺邮箱本地部分)、
  `created_at` 忠实迁移。
- 未确认邮箱 → 导入为未验证,登录 403 `EMAIL_NOT_VERIFIED`(密码先验、
  验证门后拦)。
- 密码重置后该用户变 scrypt、旧 bcrypt 失效——两种格式共存一张表,迁移随
  改密自然完成。

## 已落地：影子账号——CRM 联系人预建用户（#25，身份侧切片）

老系统依据:`ensure-shadow-account` / `security.provision_shadow_account`
(service-role RPC)——CRM 录入的每个邮箱预建一个无密码账号,报价、订单、
发票先挂在它上面,客户来注册时认领同一个 user id。CRM 业务模块(#227/#235)
落地前,先把身份侧能力立住:所有「新增潜在客户」的代码路径以后都调
**同一个服务函数**,不各写各的 insert。

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 预建服务 | `apps/api/src/auth/shadow-account.ts` | `ensureShadowAccount(db, { email, name? }, { logger })`:同邮箱已存在(含大小写/空格变体)→ 返回既有行、一行不动(first-write-wins);不存在 → 建 `auth_user`(emailVerified=true,展示名缺省用邮箱本地部分)+ 一行密码为 null 的 credential account(与存量导入的 Google-only 用户同形状) |
| 邮箱归一化 | 服务内 trim+lowercase,`auth_user` 唯一索引改在 `lower(email)` 上(migration 0003) | 老系统只在匹配处 lower、边缘处 trim,存储保留原样,大小写变体是它反复踩的坑;新系统把「同一邮箱不产生重复账号」升级为 DB 结构不变式,不依赖写侧自觉。注册侧 better-auth 自带 toLowerCase,写入全部小写,索引重建无风险 |
| 认领 | 不另设流程/标记 | 老系统接管 = recovery 链接 + set-password(`mark_portal_identity_claimed` 的 `claimed_at` 只是凭据存在性的缓存);新系统 `claimed` = credential 密码非 null 或存在非 credential account,现成可查。认领动作 = `POST /api/auth/request-password-reset` → `POST /api/auth/reset-password`:better-auth 对无凭据用户当场建/覆盖 credential(resetPassword 源码两分支确认,切片 3 已为此预留「开号语义」) |
| 认领前行为 | 同上 | 登录 401(null 密码短路);注册表单对影子邮箱 422 `USER_ALREADY_EXISTS`——与老系统一致(接管不走重新注册,反枚举同源);建号永远静默不发信,邀请/重发才发 |
| emailVerified=true | 服务内 | CRM 邮箱来自真实往来,认领邮件本身就发往该地址,地址在认领一刻自证(老系统 `email_confirm: true`);不置 true,认领后登录会被 403 EMAIL_NOT_VERIFIED 挡死 |

本切片不含(CRM 模块落地后接线):调用方接线(#227/#235 新建联系人时调用
服务)、同公司品牌/报价/订单的门户可见范围(R-02-6,等业务表)、
`portal_binding_requests` 排队语义(等账户绑定模型)。

## 已落地：Google OAuth 登录（#22 切片 4）

老系统依据：FEAT-167 社交登录（提供商登记表是纯决策层 + 「本部署开了哪几家」
是部署配置 + 未配置的提供商渲染空——给必然失败的动作一个按钮，和死链接同罪）
+ FEAT-442（社交按钮用 `default` 面，不与密码表单的主按钮争主次）+ FEAT-068
（登录页不指定落点，回落到根路径由索引路由决定）。按 #22 依赖序只渡 Google
一家；azure/apple 有人要了再进（登记表思路在新系统等价于「往
`socialProviders`/按钮渲染门里各加一项」）。

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 提供商注册 | `apps/api/src/auth/auth.ts` | `socialProviders.google`，由 `googleOAuth` 依赖门控：env 成对配置才注册；未注册时 `POST /sign-in/social` 答 404 `PROVIDER_NOT_FOUND`（Better Auth 1.7.7 实测，认识的/不认识的提供商名同一个 404，无单独校验分支） |
| 环境变量 | `@ally/config` | `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`：both-or-none（对象 superRefine，缺一边指向缺的那个变量名）——半配置在启动即失败（fail closed），不拖到 OAuth 回调才炸 |
| 提供商列表端点 | `apps/api/src/routes/auth-providers.ts` | `GET /api/auth-providers`（公开，先于会话中间件）：`{ providers: ["google"] }`。老系统把这件事放前端构建期 env；新系统改为运行时问服务器——提供商真相源是 API（它 owns better-auth），前端不再带第二份部署配置 |
| 登录页 | `apps/web` `shared/lib/login-providers.ts` + `Login.tsx` | 挂载时问一次；zod 校验响应体（外部输入）；API 不可达/响应坏 → 空列表 = 不渲染按钮（降级即沉默，不猜） |
| Google 按钮 | `apps/web` `auth/SignIn.tsx` | `default` 面 + 四色 G 标（老 portal 同款），在密码表单之下；仅当服务器报告 google 时渲染；成功路径不清 busy——浏览器已经在去 Google 的路上 |
| 回调与落点 | Better Auth 托管 | 授权 URL 由 `POST /api/auth/sign-in/social` 本地构造（不联网）；回调交换在 `{baseURL}/api/auth/callback/google`（需要真实凭据，属库路径）；成功回落 `callbackURL`（= RequireAuth 记住的路径，FEAT-068）；provider 侧失败回落 `errorCallbackURL` `/login?error=…`，登录页把错误码原文显示，不翻译 |
| Terraform | `infra/terraform/aws/` | `google_client_id`（平铺 env）+ `google_client_secret`（tfvars → Secrets Manager `${name}/google-client-secret` → ECS 注入）；两者留空 = 不启用。上线清单：Google Cloud Console 回调地址填 `<控制台域名>/api/auth/callback/google` |

关键行为（Better Auth 1.7.7 实测 / 集成测试钉住）：

- 配置了凭据时，`POST /api/auth/sign-in/social { provider: "google", callbackURL: "/" }`
  返回 200 `{ url, redirect: true }`，url 为 accounts.google.com 授权页，
  带我们的 `client_id`、`redirect_uri=…/api/auth/callback/google`、`response_type=code`
  与 `state`；客户端内置 redirect 插件据此跳转浏览器。
- 未配置（或密码-only 部署）时同一请求 404 `PROVIDER_NOT_FOUND`——按钮不会
  渲染，直接打端点也拿不到授权 URL。
- Google 回传的邮箱视为已验证（`emailVerified` 取 provider 声明）；
  `requireEmailVerification` 只约束密码路径。
- 账号关联（同一邮箱先注册密码、后用 Google 登录）走 Better Auth 默认的
  account linking 行为，本切片不改默认、不做定制；待 staging 用真实凭据
  冒烟后再决定是否收紧。

## 已落地：密码重置（#22 切片 3）

老系统依据：`resetPasswordForEmail` + GoTrue recovery 模板（`auth-send-email` 里
`RESET_LINK_EXPIRY = "24 hours"`，即 `otp_expiry=86400`）+ FEAT-566 的两条纪律
（链接必须落回发起方应用；成功态不得泄露账号存在性）。

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 请求重置 | `apps/api/src/auth/auth.ts` `sendResetPassword` | `POST /api/auth/request-password-reset`：存在/不存在地址同答 200 同形响应（better-auth 内置时序仿真，反枚举）；重置令牌 24h（`resetPasswordTokenExpiresIn`，对齐老系统 86400） |
| 重置邮件 | `apps/api/src/mailer/mailer.ts` `renderPasswordResetEmail` | 与验证邮件同款纪律：姓名转义（BUG-285）、链接原样、text 从 html 推导；正文同时覆盖「是你本人」与「不是你」两种情形（不预设请求者） |
| 设新密码 | `POST /api/auth/reset-password` | `{ token, newPassword }`；令牌一次性（重放 400）；**改密码即吊销该用户全部会话**（`revokeSessionsOnPasswordReset`） |
| 重置链接 | 控制台 `/reset-password?token=…` | `WEB_APP_URL` 拼接。用户点击填表后才提交——邮件扫描器预取只拿到静态页，消耗不了一次性令牌（与确认邮件同款裁定）；`WEB_APP_URL` 未配置时退回 better-auth 的 GET 回调链接（能重置，但生产必须配置） |
| 前端 | `apps/web` `/forgot-password` + `/reset-password` | 请求页成功态措辞不承诺「邮件已发出」（FEAT-566 AC-3）；设新密码页四态，失败态给回 `/forgot-password` 的路；登录页挂「Forgot your password?」入口 |

关键行为（Better Auth 1.7.7 实测）：

- `POST /api/auth/request-password-reset` 对未知地址也答 200
  `{ status: true, message: "If this email exists…" }`，不发信（反枚举）。
- 邮件发送失败只记日志、请求照常答 200（老 hook「永远 200」裁定；
  没收到就再要一封）。
- `POST /api/auth/reset-password` 对没有 credential account 的用户会**创建**
  account 行（portal 式 set-password 语义），有则更新哈希。

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
| `POST /api/auth/request-password-reset` | 请求重置邮件；对存在/不存在地址同答 200 同形响应（反枚举）；发信失败不阻塞 |
| `POST /api/auth/reset-password` | `{ token, newPassword }` 设新密码；令牌一次性、24h；吊销该用户全部会话 |
| `POST /api/auth/sign-out` | 登出，服务端吊销会话 |
| `POST /api/auth/sign-in/social` | 社交登录入口（切片 4 起）：`{ provider: "google", callbackURL, errorCallbackURL }` → `{ url, redirect: true }`；未配置的提供商 404 |
| `GET /api/auth-providers` | 本部署启用的社交提供商列表（公开；登录页据此渲染按钮） |
| `GET /api/me` | 当前登录用户（业务路由，经会话中间件） |

## #22 后续切片（本切片不含）

- 员工开通/邀请（对应老系统 staff-invite / portal-invite 的语义，含
  shadow account #25）、管理员建用户（管理员建的账号可带已验证邮箱，
  不走注册确认）
- 登录后按角色/权限的界面门禁：RBAC 在 #23，2FA 在 #24
