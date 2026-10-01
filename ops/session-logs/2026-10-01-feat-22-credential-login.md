---
session_id: hand-written-22-credential-login
branch: feat/22-credential-login
date: 2026-10-01
reason: issue-22-slice-1
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/22-credential-login — 2026-10-01

> 机械层本次由 agent 手写(ZCode 定时迁移会话,SessionEnd hook 未触发);
> 判断层为本次会话手写。

## 机械层(自动)

- **时间跨度**:2026-10-01 上午(UTC+8 下午)
- **引用的 issue**:#22(切片 1:credential login);顺带关闭 #30 的
  「连接鉴权换成 #22 的真实会话校验」一条
- **PR**:feat/22-credential-login

### 改动的文件

- `packages/db/`:schema.ts 加 Better Auth 四表(auth_user / auth_session /
  auth_account / auth_verification,uuid 主键),migration `0002`;package.json
  加 kysely devDep(见判断层第 2 条)
- `packages/config/`:envSchema 加 `BETTER_AUTH_SECRET`(必填,≥32)与
  `BETTER_AUTH_URL`(可选)
- `apps/api/src/auth/`:新增 auth.ts(createAuth / createSessionResolver /
  createSessionTokenVerifier)、session.ts(会话中间件 + 业务侧会话类型)
- `apps/api/src/app.ts`:挂载 `/api/auth/*`、`/api/*` 会话中间件、`GET /api/me`;
  `routes/me.ts` 新增
- `apps/api/src/realtime/auth.ts`:鉴权器接注入式会话校验器,`dev:` 令牌仅限非生产
- `apps/api/src/index.ts`:better-auth + realtime 校验器接线
- `infra/terraform/aws/`:random_password + Secrets Manager 托管 auth secret,
  ECS secrets 与 IAM 读取授权接线
- `.env.example`、`docker-compose.yml`:新变量示例与本地容器值
- `docs/auth.md` 新增;`docs/realtime.md` 鉴权章节与验收状态更新
- 测试:app.test.ts(会话中间件单测 4 条)、auth.test.ts(真 PG 集成 6 条)、
  realtime/auth.test.ts(升级为 5 条)、config 测试补 secret 校验

## 判断层(手写 —— hook 写不出这部分)

**做了什么判断,为什么:**

1. **选题从 #110 改为 #22。** 按选题规则 phase-1 按编号应取最低 open 的
   #22;且 #30 的验收里明确有一条「连接鉴权换成 #22 的真实会话校验」在等它,
   #22 是整个 phase-1 的关键路径。已先 claim #110 后发现列表被 100 条截断、
   #22 其实还开着,释放 #110 租约后改 claim #22。
2. **pnpm 双实例坑:better-auth 硬依赖 kysely,drizzle-orm 对 kysely 有
   optional peer。** 装 better-auth 后 apps/api 图里出现 kysely → drizzle-orm
   解析出第二个实例(带 kysely 变体),与 @ally/db 的纯 pg 变体类型不兼容,
   连没动过的 realtime 集成测试都红了。修复:给 packages/db 加 kysely
   devDep,让两边 peer 上下文一致合并为单实例。这个坑对后续任何引入
   better-auth 的包(apps/web 的 client 不受影响,服务端都会踩)都成立。
3. **BETTER_AUTH_SECRET 设为必填而不是可选。** 会话 cookie 防篡改全靠它,
   弱密钥/漏配的失败模式是静默的,不适合「留空只记日志」。敢必填的前提:
   deploy 流程的 staging/production job 目前是 skipped(DEPLOY_ENABLED 未开),
   合并后不会有「线上起不来」;Terraform 侧用 random_password 生成并托管,
   启用部署时零手工步骤。
4. **WS 鉴权保持 auth 帧协议不变,校验器做注入。** 浏览器读不到 HttpOnly
   cookie,但 WS auth 帧携带的令牌可以是登录后由客户端持有的会话令牌;
   服务端只查 auth_session 裸 token(取 `.` 前段),不引入对 cookie 名/签名
   形状的依赖。`dev:<userId>` 直通保留在非生产,老测试与本地联调不破坏。
5. **注册端点本切片保持开放且不强制邮箱验证。** 老系统现状(ally-os 仓库,
   非 issue 正文里指向的更老 ally-nutra)是 2026-09 起才开邮箱确认,且邮件
   基建(模板/Resend)尚未迁入;先让注册可用(集成测试也靠它造用户),
   验证流程随邮件基建切片补。
6. **会话策略对齐老系统裁决而不是 Better Auth 默认。** 12h 不活动超时是
   老仓库有编号的安全裁定(FEAT-019),映射为 expiresIn=12h + updateAge=1h
   (活跃续期、不活动跨 12h 即死);绝对 timebox 老系统刻意不启用,这里同样不设。

**值得纳入项目的点:**

- 「issue 正文引用的老实现可能指向更老的仓库」——本次调研发现 #22 正文里的
  `useAuth.tsx`/`profiles`/`admin-post-login-routing.md` 在 ally-os 里已不存在
  (那是 ally-nutra 的东西),实际是 `core.users`+`core.user_roles` 三表模型。
  后续 issue 迁移时要以仓库现状为准,正文只当索引。
- 给「跨包类型打架」类失败先查 `readlink node_modules/<pkg>` 再动手,
  pnpm 双实例一眼定位。

**坑:**

- `gh issue list --limit 100` 按创建时间倒序,老编号 issue(#22–#105)会被
  截断看不到——选题时差点漏掉真正的最小编号。
- Better Auth 未设 baseURL 会在启动时 warn(origin 从请求推导);本切片加了
  可选 `BETTER_AUTH_URL`,公有域名定下来后应接入 Terraform server_environment。
