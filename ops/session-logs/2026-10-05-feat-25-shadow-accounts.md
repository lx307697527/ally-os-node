---
session_id: hand-written-25-shadow-accounts
branch: feat/25-shadow-accounts
date: 2026-10-05
reason: issue-25-slice-1
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/25-shadow-accounts — 2026-10-05

> 机械层本次由 agent 手写(ZCode 定时迁移会话,SessionEnd hook 未触发);
> 判断层为本次会话手写。

## 机械层(自动)

- **时间跨度**:2026-10-05 午后~晚间(UTC+8)
- **引用的 issue**:#25(影子账号:CRM 联系人预建用户账号;#232 §1.5
  「CRM 联系人预建账号,客户注册后看到历史报价和订单」)
- **PR**:feat/25-shadow-accounts

### 前置收尾(第 0 步)

- 上次会话遗留的 open PR #255(#22 切片 5,存量 bcrypt 导入)CI 首轮
  server Docker job 两次失败,均为 runner 网络抖动(corepack 下载 pnpm
  卡死 43 分钟被 cancel;拉 `docker/dockerfile:1` 前端镜像截断 EOF),
  代码零改动,重跑四项全绿后 squash 合并,#22 已评论成果。
- worktree 清理:删 `22-bcrypt-hash-import`(Windows `Filename too long`
  + 目录被残留 bash 进程占用,杀进程后 rmdir);删 `129-version-check`
  (issue #129 已关闭,目录被上次会话遗留的两个 `vite preview` 进程
  占用,杀掉后清空)。主检出干净,无并发会话 WIP。

### 本切片改动的文件

- `packages/db/src/schema.ts`:`auth_user` 邮箱唯一索引从裸 `email` 改为
  `lower(email)`(函数式唯一索引,索引名不变)
- `packages/db/migrations/0003_conscious_mandarin.sql`(新,diff = DROP
  INDEX + CREATE UNIQUE INDEX … ON lower("email"))+ meta 快照
- `apps/api/src/auth/shadow-account.ts`(新):`shadowAccountInputSchema`
  (trim+lowercase 后 pipe `z.email()` 校验)、`ensureShadowAccount`
  (幂等预建:existing → 原行返回;missing → 事务写 user + null 密码
  credential account;并发 23505 → 沿 cause 链识别、重查返回赢家)、
  `ShadowAccountInputError`
- `apps/api/src/auth/shadow-account.test.ts`(新):9 条集成测试
- `docs/auth.md`:新增「已落地:影子账号(#25,身份侧切片)」章节
- **无新依赖、无新 env**

### 验证

- `corepack pnpm verify` 全绿;`DATABASE_URL=postgres://ally:ally@
  localhost:5432/ally corepack pnpm test` 全绿 **237/237**(存量 228 +
  新增 9)

## 判断层(手写 —— hook 写不出这部分)

**做了什么判断,为什么:**

1. **选题:#25 而非编号更小的 #23。** 选题规则是 phase-1 按编号升序,但
   #22 剩余项全是运维步骤(切换日导入、staging OAuth 冒烟),其代码工作
   已拆到 #25/#23/#24;#22 切片 4 评论(今天上午)记录的依赖序是 #25 →
   #23 → #24,且 #25 直接消费切片 3 特意预留的「无凭据用户 reset 开号」
   语义和切片 5 的账号形状——趁原语新鲜先渡,#23 RBAC 是正交大块。
   老系统调研(Explore 子代理,只读)确认:老实现 =
   GoTrue Admin API 建号(无密码、email_confirm)+ service-role RPC 补
   身份行 + recovery 链接接管,`claimed_at` 只是凭据存在性的缓存。

2. **切片边界:只做身份侧能力,不开 HTTP 面。** #25 验收第 1 条
   「CRM 新增联系人 → 自动有 user」的调用方(CRM 联系人创建)在
   #227/#235 落地前不存在;门户可见范围(R-02-6)依赖尚不存在的业务表。
   为「可用性」加一个预建账号端点是负资产:RBAC(#23)未落地,任何
   鉴权都是临时发明,而预建端点天然是邮箱枚举/垃圾账号面(老系统这些
   调用方全是 service-role 机器路径,从不对公网)。所以交付 =
   `ensureShadowAccount` 服务 + 测试 + 文档,PR 标 "Part of #25",
   接线项在 PR 与 docs 里列明。

3. **认领 = 现成的重置流程,零 better-auth 改动。** dist 源码确认
   `resetPassword` 的两分支:`findCredentialAccount` 为空 → 当场
   `createAccount`,否则 `updatePassword` 覆盖(null 密码原地转 scrypt);
   `requestPasswordReset` 只查 user 不要求凭据。老系统的接管同样是
   recovery 链接 + set-password,不是重新注册——行为保真不需要写代码,
   需要的是把这条链路测死(9 条里的 claim 闭环)。

4. **emailVerified 预建即 true。** CRM 邮箱来自真实往来,认领邮件本身
   就发往该地址,地址在认领一刻自证(老系统 `email_confirm: true` 同
   源);不置 true,认领成功后登录会被 403 EMAIL_NOT_VERIFIED 挡死——
   整条链路断在最后一米。

5. **唯一索引升级到 `lower(email)`:把约定变结构。** 老系统的规则是
   「匹配处 lower、存储保原样」,结果是每个身份查询都要记得 lower,反复
   踩坑;新系统写入侧已全部 lowercase(better-auth 注册 transform、导入
   zod、本服务),migration 0003 只是把不变式从「所有写入方的自觉」升级
   为「DB 拒绝」。`ensureShadowAccount` 的并发防线也靠它(双写撞
   23505,输家重查返回赢家)。存量数据全小写,重建索引无风险;部署
   顺序是先 migration 后代码,旧代码写小写不违规。

6. **不存 `claimed_at` 列。** 老系统的 `claimed_at` 是给销售 UI 显示
   "Shadow" 用的缓存时间戳,判定函数(FEAT-197)的真值本来就是「密码
   非空或持有社交身份」。新系统没有消费方,先不冗余;等门户/CRM 要
   显示认领状态时,派生查询或再加列都来得及(加列是 expand,无损)。

7. **幂等语义 = first-write-wins,不改既有行。** 同邮箱再调返回既有
   user,展示名/验证态一律不动(老系统 person 链接「只填 null、拒绝
   改指」的同一哲学);CRM 后续要改联系人的名字,那是 CRM 的 update
   路径,不是预建路径的职责。

**踩的坑:**

- **drizzle 0.45 把 PG 错误包进 `DrizzleQueryError.cause`**:并发测试
  第一轮红,`err.code === "23505"` 判定落空——真错误在 `err.cause` 里。
  `isUniqueViolation` 改为沿 cause 链最多 5 层找 code。没有并发测试的
  话这个 bug 会静默潜伏到生产竞态。
- **重复注册不是 422 而是同形 200**:我对着 better-auth 源码里的
  `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` 写了 422 断言,实测 200——
  切片 2 已裁定并落地防枚举(重复注册与成功注册同形)。第一版测试
  期望错在「读的是异常分支,跑的是防枚举路径」。测试改为钉真正的
  不变式:200 + token null + 影子行原封不动(没有第二个用户、密码仍
  null)。
- **zod v4 的校验顺序**:`z.email()` 是 check,先于链上的 transform
  执行,`" a@b.com "` 会死在校验;要「先归一化再验格式」得用
  `.pipe(z.email())`。
- **eslint `no-unused-vars`**:`eq` 导入了没用(查询全走 `sql` lower)。
  lint 先红,删。
- **Windows worktree 清理两连**:`Filename too long`(node_modules 深
  层路径,`rm -rf` 绕过)+ `Device or resource busy`(残留 bash /
  `vite preview` 进程的 CWD 挂在目录上)——按 CommandLine 匹配杀进程
  后 rmdir 才能走通。以后清理 worktree 先查占用进程。

**值得纳入项目的点:**

- 「读依赖 dist 源码定合同」第六、七次命中(resetPassword 两分支、
  requestPasswordReset 无凭据要求、sign-up 防枚举路径)。本轮还发现
  上次切片的结论(「reset 对无凭据用户建 account 行」)在新场景直接
  复用,docs 里那句「后续员工邀请切片可用」兑现成了本切片。
- 「并发路径必须有并发测试」:isUniqueViolation 的坑只有
  `Promise.all` 双写测试能抓,单发调用永远走不到 23505 分支。
- runner 网络抖动已三次切片连续出现(Lint job 的 PG 服务容器、本次
  server Docker 的 corepack/镜像拉取),模式一致:重跑即绿、代码零
  改动。值得在 runner 侧根治(自托管 runner 已有 docs/guides/
  self-hosted-runner.md,Docker job 换 self-hosted 或给 buildx 加
  registry mirror 可调研),单独开 issue 跟踪,不塞进业务切片。
