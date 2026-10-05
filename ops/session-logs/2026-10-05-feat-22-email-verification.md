---
session_id: hand-written-22-email-verification
branch: feat/22-email-verification
date: 2026-10-05
reason: issue-22-slice-2
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/22-email-verification — 2026-10-05

> 机械层本次由 agent 手写(ZCode 定时迁移会话,SessionEnd hook 未触发);
> 判断层为本次会话手写。

## 机械层(自动)

- **时间跨度**:2026-10-05 下午(UTC+8 傍晚)
- **引用的 issue**:#22(切片 2:邮件基建 + 注册强制邮箱验证,FEAT-634)
- **PR**:feat/22-email-verification
- **前置收尾**:PR #251(#129 slice 3)发现已被合并(并发会话处理),
  清理其 worktree 与本地分支;worktree 目录残留两个空目录被进程句柄占住,
  无 git 影响,留给下次

### 改动的文件

- `apps/api/src/mailer/mailer.ts` 新增:`Mailer` 接口 + `createMailer`
  (有 key → `ResendMailer`(fetch 注入、响应 zod 校验),无 key →
  `LoggingMailer` 整封进日志);`escapeHtml`/`htmlToPlainText`/
  `renderVerificationEmail`(验证邮件模板)
- `apps/api/src/auth/auth.ts`:`emailAndPassword.requireEmailVerification =
  true`、`emailVerification`(expiresIn 24h、sendOnSignUp、
  sendVerificationEmail 回调:链接拼 `WEB_APP_URL`、发送失败 catch 记日志)
- `apps/api/src/index.ts`:mailer 接线;`apps/api/package.json` + zod
  (校验 Resend 响应用,纯依赖无 peer 纠缠,未复现上次 kysely 双实例坑)
- `packages/config/src/index.ts`:`RESEND_API_KEY`(可空)/`EMAIL_FROM`
  (默认占位)/`WEB_APP_URL`(可空);config 测试 +2 条
- `apps/web`:`shared/pages/VerifyEmail.tsx`(路由逻辑页)+
  `shared/pages/auth/VerifyEmailPanel.tsx`(展示,四态)+
  `App.tsx` 公开路由 `/verify-email`;`Login.tsx` 403 → 未验证分支 +
  `authClient.sendVerificationEmail` 重发;`SignIn.tsx` 加未验证提示区
- 测试:`mailer.test.ts` 10 条(Resend 载荷/非 2xx/2xx 异形响应/日志模式/
  转义契约)、`auth.test.ts` 重写为 11 条验证流程矩阵、`login.test.ts` +2、
  `verify-email.test.ts` 7 条(源文本属性测试,沿仓库惯例)
- Terraform:`resend_api_key` 变量 → Secrets Manager → ECS 注入,
  `email_from`/`web_app_url` 平铺 env,IAM 读授权,tfvars 示例
- `.env.example`、`docker-compose.yml`:新变量;`docs/auth.md` 切片 2 章节

## 判断层(手写 —— hook 写不出这部分)

**做了什么判断,为什么:**

1. **切片边界:邮件基建与强制验证绑在一个切片,web 端只做确认页与登录
   分支。** #22 剩余清单里「邮件基建迁入 → 邮箱验证流程」本来就是一步
   (没有基建的验证流程无法验收);密码重置虽然邮件基建顺带可支撑,
   但它是独立流程(set-password 页 + recovery 语义),留给下一切片,
   避免切片膨胀。

2. **确认链接落在控制台 `/verify-email` 页,用户点击后才调 API 的 GET
   验证端点。** Better Auth 默认把 GET 验证端点直接写进邮件——邮件扫描器
   (Outlook SafeLinks 等)预取会先于用户消耗掉一次性令牌,这是 GoTrue
   时代 token_hash 落 portal 确认页(FEAT-056 phase 15b)要解决的同一类
   问题。源文本属性测试里专门有一条「API 调用必须在 click handler 内、
   不得出现 useEffect」把「点击才发」钉进源码。

3. **重复注册返回通用响应是特性不是缺陷,不照搬 issue 里「改明确错误码」
   的备注。** #22 正文说 GoTrue 的 identities 空数组怪癖要换成明确错误码;
   实测 Better Auth 1.7.7 在 requireEmailVerification 下对已存在邮箱返回
   与成功同形的 `{ token: null, user }`(防枚举,源码
   sign-up.mjs `shouldReturnGenericDuplicateResponse`)。防枚举严格强于
   明确错误码,且与老系统 2026-09 之后的安全取向一致,保留并写进
   docs/auth.md 与集成测试。

4. **RESEND_API_KEY 可空、空值走日志模式,而不是生产必填拒绝启动。**
   与 BETTER_AUTH_SECRET 的必填裁定相反,理由:缺密钥时认证仍完整可用
   (注册落库、日志里拿链接手工验证),拒绝启动会把整个系统绑死在一个
   外部 SaaS 的开通状态上;代价(生产漏配 = 邮件静默变日志)用两道
   缓解:Terraform 侧变量已接好(tfvars 留空即可见),docs 与 PR 把
   「生产必配」写成上线清单项。部署当前整体 skipped(DEPLOY_ENABLED
   未开),合并无线上风险。

5. **Terraform 接线学 DATABASE_URL(外部值经 tfvars 进 Secrets Manager)
   而不是 BETTER_AUTH_SECRET(random_password 生成)。** Resend key 是
   外部申请的人工值,不是能生成的随机数;secret 版本永远创建、默认空串,
   应用侧 parseEnv 把空串当未设置——不用条件块,plan 零意外。

6. **发件人默认 `noreply@allyos.example` 是占位,故意不用 Resend 测试
   发件域**(onboarding@resend.dev):厂商专用默认值进配置会让「配置了
   但发往受限」的失败模式更隐蔽;.example 明确不可发送,配错了立刻在
   日志里可见。

**踩的坑:**

- eslint `require-await` 禁裸 async(仓库全量规则):Mailer 实现、spy、
  假 fetch 都得避开 async 无 await 写法;`vi.fn(() => Promise.resolve(x))`
  会把参数类型推成空元组,得写 `vi.fn<typeof fetch>(...)`。
- `@typescript-eslint/no-base-to-string` 禁 `String(init?.body)`:
  对象字面量进 String 会得 "[object Object]",改 `typeof === "string"` 收窄。
- Better Auth 的 verify-email 端点在无 `callbackURL` query 时,坏令牌
  直接 401(有 callbackURL 才走 redirect-on-error),测试断言按无回调
  路径写 401。
- `gh issue list --limit 100` 会截断老编号(上次已踩),这次直接按
  记忆索引定位 #22,没再翻车。

**值得纳入项目的点:**

- 「issue 备注的行为结论要对着实际依赖版本重验」:正文里 GoTrue 时代
  的行为裁定(明确错误码)在新依赖(Better Auth 1.7.7)下已有更强默认
  (防枚举通用响应),照搬备注反而倒退。
