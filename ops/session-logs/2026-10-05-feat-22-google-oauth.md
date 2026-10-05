---
session_id: hand-written-22-google-oauth
branch: feat/22-google-oauth
date: 2026-10-05
reason: issue-22-slice-4
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/22-google-oauth — 2026-10-05

> 机械层本次由 agent 手写(ZCode 定时迁移会话,SessionEnd hook 未触发);
> 判断层为本次会话手写。

## 机械层(自动)

- **时间跨度**:2026-10-05 晚间(UTC+8)
- **引用的 issue**:#22(切片 4:Google OAuth 登录;老系统 FEAT-167 社交登录
  登记表 + FEAT-442 按钮面 + FEAT-068 登录页无落点)
- **PR**:feat/22-google-oauth
- **前置收尾**:无 open PR、无残留 worktree、主检出干净;#22 切片 3(密码
  重置,PR #253)今日已由上一会话合并,评论依赖序下一片即 Google OAuth;
  claim 租约成功

### 改动的文件

- `packages/config/src/index.ts`:`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
  (optional)+ 对象 superRefine both-or-none(缺一边指向缺的变量名);
  `parseEnv` 改走 refine 后的 schema
- `apps/api/src/auth/auth.ts`:`AuthDeps.googleOAuth`(成对配置才非空),
  `socialProviders.google` 按门控注册
- `apps/api/src/routes/auth-providers.ts`(新):公开 `GET /api/auth-providers`
  → `{ providers: ["google"] | [] }`;`app.ts` 挂在会话中间件之前,
  `AppDeps.socialProviders` 注入;`index.ts` 从 env 装配
- `apps/web`:`shared/lib/login-providers.ts`(新,fetch + zod,一切失败
  降级为空列表)、`Login.tsx`(挂载问一次提供商、`signIn.social` 带
  `callbackURL: returnPath` + `errorCallbackURL: "/login"`、provider 侧
  错误码进查询串原样上屏)、`auth/SignIn.tsx`(social slot:
  `default` 面 + 四色 G 标,服务器没报 google 就一个节点都不渲染)
- 测试:`config` +3(空串视为未配置、成对接受、半配置启动即拒);
  `app.test.ts` +2(providers 路由公开、密码-only 部署空列表);
  `auth.test.ts` +1 个 describe 共 3 条(授权 URL 本地构造钉住
  client_id/redirect_uri/state/response_type、未配置 404
  `PROVIDER_NOT_FOUND` 认识与不认识的提供商名同形、只开密码的部署同样 404);
  `login.test.ts` +5 条源文本属性(slot 未启用渲染空/列表是服务器的答案/
  round-trip 带住回调路径/成功不清 busy/错误码原文上屏)
- `infra/terraform/aws/`:`google_client_id`(平铺 env)+
  `google_client_secret`(tfvars → Secrets Manager → ECS 注入)，
  staging/production tfvars.example + 注释;`.env.example` 同步
- `docs/auth.md`:新增「已落地:Google OAuth 登录(切片 4)」章节、API 表
  +2 端点、后续切片清单划掉 Google OAuth
- **无 schema 改动、零 migration**(better-auth social 登录落
  `auth_account` 的 provider 行,表结构切片 1 已备好)

### 验证

- `corepack pnpm verify` 全绿(lint + typecheck + 184 tests);
  `DATABASE_URL=… pnpm test` 全绿 212/212(与 CI 同配置)
- CI 四项全绿后 squash 合并(见 PR 正文)

## 判断层(手写 —— hook 写不出这部分)

**做了什么判断,为什么:**

1. **提供商启用与否的真相源放在 API env,不放进前端构建期。** 老系统把
   `ALLY_OS_OAUTH_PROVIDERS` 烘进前端构建产物(portal 走 next.config env
   内联,staff 走 main.tsx 常量),前端和服务端各自持有一份「开了哪几家」,
   靠部署纪律保持一致。新系统加了一个公开的 `GET /api/auth-providers`:
   better-auth 归 API 所有,提供商注册表在 API env 里,登录页运行时问一次
   ——按钮和服务端永远不会有分歧。代价是登录页多一个请求(一次、失败
   静默降级),换来的是删掉一整类「按钮在、端点没配」的部署漂移。

2. **未配置 = 整个 social slot 不渲染,而不是渲染一个禁用的按钮;API 不可达
   也一样沉默。** FEAT-167 的原裁定(给必然失败的动作一个按钮 = 死链接
   同罪)在新系统的等价物是「空列表 → 空节点」。Web 侧把 zod 解析和一切
   失败模式都收敛到空列表,这个降级方向是有意的:宁可少显示一个功能,
   不猜。

3. **Google OAuth 的 e2e 测试边界划在「授权 URL 构造」,回调交换不测。**
   授权 URL 由 better-auth 本地构造(读 dist 源码确认无网络调用),集成
   测试钉住 client_id/redirect_uri/response_type/state/scope;回调交换要
   真打 Google,CI 里造假凭据只能测假象——这一段明确划给库,验收靠 staging
   用真实凭据冒烟。#22 验收第 2 条「全流程 e2e」在 Google 这一环的诚实
   上限就在这里,PR 里写明,不假装测过。

4. **半配置启动即失败(fail closed),Terraform 层不拦。** 只配
   `google_client_id` 不配 secret 是部署抄漏,这类错误在启动时炸比在用户
   点按钮时炸好得多;Terraform 不做 both-or-none 校验(留空 = 不启用是
   合法状态,refine 挪到应用层 @ally/config),两层各守各的合同:
   Terraform 管注入,应用管语义。

5. **成功路径不清 busy、错误路径回落 `/login` 并把错误码原文上屏。**
   better-auth 客户端内置 redirect 插件,`signIn.social` 的 promise 只在
   被拒时 resolve(老 supabase-js 流程同款形状)——所以 success 分支根本
   不存在,不写就是最诚实的写法。provider 侧失败(用户在 Google 取消授权、
   回调校验失败)会带着 `?error=<code>` 回 `errorCallbackURL`,登录页把它
   塞进既有的错误行原文显示——延续本仓库「服务器的拒绝逐字显示,不发明
   安抚性文案」的裁定。

6. **账号关联沿用 better-auth 默认行为,显式记录、不做定制。** 同一邮箱
   先注册密码、后点 Google,是否自动并成同一个用户——老系统(Supabase)
   按验证邮箱自动关联;better-auth 默认行为有 trustedProviders 语义。本
   切片不动它,docs 里写明「staging 真实凭据冒烟后再决定是否收紧」:这
   是安全语义,值得一条真实凭据下的观察再下裁定,而不是凭文档拍。

7. **切片边界:只渡 Google,不引入 azure/apple。** #22 评论的依赖序明确
   Google 在前;老仓库 FEAT-180 的 apple 是「买了开发者会员后前提失效」
   才加的,FEAT-167 的 azure 源于 Microsoft 不带邮箱要额外 scope——这些
   是老系统的运营史,不是本系统的需求。登记表思想保留在结构里(往
   `socialProviders` 和 SignIn 的渲染门里各加一项),但代码不为还没人要
   的提供商预付抽象。

**踩的坑:**

- better-auth 1.7.7 未配置提供商的 `POST /sign-in/social` 答 **404
  `PROVIDER_NOT_FOUND`**(大写),不是文档风格的 `oauth_provider_not_found`;
  且认识的(apple)与不认识的(`not-a-provider`)提供商名落同一个 404——
  没有单独的入参校验分支。测试按实测行为钉住,第一版按猜的写挂了两条。
- Hono 的 `app.request()` 返回类型在两个 app 的联合上会退化成
  `Response | Promise<Response>` 联合(overload 解析),测试 helper 里
  `return target.request(...)` 报类型错;`await` 一下打平即可。
- 前端回调竞态确认过一遍:`signIn.social` resolve 时 redirect 插件已经在
  跳转,续写代码没有意义;但 refusal 时必须把按钮还回来(setSocialBusy
  (false)),否则一次失败后按钮永久禁用。

**值得纳入项目的点:**

- 「读依赖 dist 源码定合同」第四次命中(PROVIDER_NOT_FOUND 码与 404 形状、
  redirect 插件、errorCallbackURL 字段),继续作为惯例。
- 「给外部系统画的测试边界 = 造假成本开始超过诚实收益的那条线」:授权
  URL 钉合同、回调交给 staging 冒烟,这个划法这次好用,后续 Stripe/Resend
  的切片可以复用同一思路。
