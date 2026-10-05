---
session_id: hand-written-22-password-reset
branch: feat/22-password-reset
date: 2026-10-05
reason: issue-22-slice-3
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/22-password-reset — 2026-10-05

> 机械层本次由 agent 手写(ZCode 定时迁移会话,SessionEnd hook 未触发);
> 判断层为本次会话手写。

## 机械层(自动)

- **时间跨度**:2026-10-05 晚间(UTC+8)
- **引用的 issue**:#22(切片 3:密码重置;老系统 resetPasswordForEmail +
  recovery 模板 + auth-send-email `RESET_LINK_EXPIRY="24 hours"`)
- **PR**:feat/22-password-reset
- **前置收尾**:无 open PR、无残留 worktree、主检出干净(HEAD = #252),
  第 0 步空转通过;按记忆序选题 #22 密码重置切片,claim 租约成功

### 改动的文件

- `apps/api/src/auth/auth.ts`:`emailAndPassword` 加
  `sendResetPassword`(链接拼 `WEB_APP_URL` 落控制台 `/reset-password`,
  发送失败 catch 记日志不阻塞)、`resetPasswordTokenExpiresIn = 24h`
  (对齐老系统 otp_expiry=86400)、`revokeSessionsOnPasswordReset = true`
- `apps/api/src/mailer/mailer.ts`:`renderPasswordResetEmail`(与验证邮件
  同款纪律:姓名转义/链接原样/text 从 html 推导;正文覆盖「是你/不是你」)
- `apps/web`:`shared/pages/ForgotPassword.tsx` + `auth/ForgotPasswordPanel.tsx`
  (请求页,成功态措辞不承诺邮件已发出)、`shared/pages/ResetPassword.tsx` +
  `auth/ResetPasswordPanel.tsx`(设新密码页四态,失败态回 `/forgot-password`);
  `SignIn.tsx` 挂「Forgot your password?」链接(头注释同步更新);
  `App.tsx` 两条公开路由
- 测试:`auth.test.ts` +5 条集成(known/unknown 同形响应+不重发、全链路
  换密码+旧密码失效+令牌不可重放、改密码吊销既有会话、坏令牌 400、
  Resend 故障不阻塞)、`mailer.test.ts` +2 条渲染契约、
  `reset-password.test.ts` 13 条源文本属性测试(点击才发/无令牌不发请求/
  反枚举措辞/公开路由)
- `docs/auth.md`:新增「已落地:密码重置(切片 3)」章节、API 表 +2 端点、
  后续切片清单划掉密码重置

## 判断层(手写 —— hook 写不出这部分)

**做了什么判断,为什么:**

1. **复用 better-auth 内置的 `verification` 表存重置令牌,零 schema 改动、
   零 migration。** 重置令牌在 better-auth 里就是 `reset-password:<token>`
   形状的 verification value(`consumeVerificationValue` 原子消费),与邮箱
   验证令牌同表不同前缀。没有动 `packages/db/src/schema.ts`——没有 schema
   改动就不该有 migration 产物,这是本切片 PR 干净的最重要前提。

2. **「改密码即吊销全部会话」显式打开(`revokeSessionsOnPasswordReset`),
   不交给默认值。** better-auth 默认**不**吊销;老系统 GoTrue 在密码变更后
   吊销 refresh token。安全语义上重置密码的理由就是「旧凭据可能已泄露」,
   留着旧会话等于重置只防了一半。集成测试专门有一条:重置后旧会话 cookie
   打 `/api/me` 必须 401。

3. **重置链接与验证邮件同款「落控制台页、点击才提交」裁定,并且这次连
   better-auth 的 GET `/reset-password/:token` 回调都不用。** 该 GET 端点是
   邮件扫描器预取就能触发的 redirect(带 token 跳 callbackURL);让邮件链接
   直接落静态控制台页、令牌留在 URL 里由用户点击后经 POST 提交,预取天然
   无害。切片 2 的验证邮件已经用同一招,两条流程的源文本属性测试都把
   「不得出现 useEffect / 调用必须在 click handler 内」钉死。

4. **反枚举语义全部交给 better-auth 内置行为,不自己包一层。** 实读
   password.mjs 源码确认:未知地址会做假令牌生成 + 假 verification 查询的
   时序仿真后返回与存在地址逐字相同的响应。切片 2 已有同款裁定(重复注册
   通用响应),这次沿用了同一测试断言形状(known/unknown 响应体 toEqual)。
   请求页成功态措辞沿用老仓库 FEAT-566 AC-3 的「If that address belongs
   to…」——不承诺邮件已发出,因为响应本身不证明 anything。

5. **重置令牌有效期取 24h 而不是 better-auth 默认的 1h。** 老系统
   `otp_expiry=86400`(auth-send-email 注释援引 2026-09-08 设定的 hosted
   值,`RESET_LINK_EXPIRY="24 hours"`)是对齐目标;迁移原则是行为对齐老
   系统,除非老系统本身是错的。验证令牌切片 2 已取 24h,这里同值,常量
   分开命名(不合并成一个 `TOKEN_TTL`),因为两者语义无关,未来分开调。

6. **portal 语义白捡:reset-password 对无 credential account 的用户会建
   account 行。** 读源码发现 better-auth 的重置端点在没有 credential
   account 时直接 `createAccount`——正好是老系统 portal 邀请「set-password
   开号」的等价物。本切片没为它写专门测试(没有造无 account 用户的路径,
   员工邀请切片会需要),但记进 docs/auth.md,给后续切片指路。

**踩的坑:**

- better-auth 1.7.7 的注册端点路径是 `/request-password-reset`,**没有**
  旧文档里的 `/forget-password` 别名(dist 里 grep 无 `createAuthEndpoint(
  "/forget-password")`;rate-limiter 的特殊规则里两个路径都列着,容易误判
  为两者都存在)。客户端方法名对应是 `requestPasswordReset`。
- eslint `no-confusing-void-expression` 拦住了 `(e) => setEmail(...)` 的
  箭头简写(void 返回),SignIn.tsx 的旧代码全是大括号写法,新面板照抄
  即可;`no-unnecessary-type-assertion` 拦掉了测试里一个多余的 `as unknown`。
- rate-limiter 对 `/request-password-reset` 有 60s/3 次的特殊规则,一度
  担心集成测试连发被限流;确认 better-auth 的限流默认只在 production
  开启(NODE_ENV 判定,vitest 是 test)后放下,现有测试矩阵也佐证。

**值得纳入项目的点:**

- 「读依赖 dist 源码定合同」在这个仓库已经三次命中(sing-up 通用响应、
  rate-limiter 路径表、reset-password 建 account 行),比查文档快且准;
  值得作为惯例保持。
- 「安全相关默认值显式写出来」:`revokeSessionsOnPasswordReset` 这种
  依赖默认值的静默安全行为,宁可一行配置 + 一条测试,不赌上游默认不变。
