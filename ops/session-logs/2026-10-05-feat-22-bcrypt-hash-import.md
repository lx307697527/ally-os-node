---
session_id: hand-written-22-bcrypt-import
branch: feat/22-bcrypt-hash-import
date: 2026-10-05
reason: issue-22-slice-5
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/22-bcrypt-hash-import — 2026-10-05

> 机械层本次由 agent 手写(ZCode 定时迁移会话,SessionEnd hook 未触发);
> 判断层为本次会话手写。

## 机械层(自动)

- **时间跨度**:2026-10-05 晚间(UTC+8)
- **引用的 issue**:#22(切片 5:存量 bcrypt 哈希导入;老系统
  `auth.users.encrypted_password` = GoTrue/pgcrypto bcrypt cost 10)
- **PR**:feat/22-bcrypt-hash-import
- **前置收尾**:无 open PR、无残留 worktree、主检出干净;#22 切片 4
  (Google OAuth,PR #254)已合并;claim 租约成功

### 改动的文件

- `apps/api/src/auth/legacy-password.ts`(新):`verifyLegacyPassword` 按
  哈希格式分派(bcrypt 前缀 → `bcryptjs.compare`;其余 → better-auth
  `verifyPassword` 显式回落);坏哈希 catch → false(401 不是 500)
- `apps/api/src/auth/auth.ts`:`emailAndPassword.password.verify` 接线,
  hash 不覆写(新密码/重置仍 scrypt)
- `apps/api/src/auth/legacy-import.ts`(新):GoTrue 导出行的 zod schema、
  `importLegacyUsers` 决定路径(冲突判定 + 行级事务写入,dry-run 与
  apply 共用)、`LegacyImportReport`
- `apps/api/src/scripts/import-legacy-users.ts`(新):CLI;env 走
  `envSchema.pick({ DATABASE_URL, LOG_LEVEL })`,报告 JSON 走 stdout、
  pino 走 stderr,退出码 0/1/2,默认 dry-run
- 依赖:`apps/api/package.json` + `bcryptjs@^3.0.3`(纯 JS,无原生构建)
- 测试:`legacy-password.test.ts`(5 条,含固定老系统向量)+
  `legacy-import.test.ts`(11 条集成:dry-run 不写、原 id/名/时间/验证态
  落库、原密码登录 AC、幂等重跑、密码补写分支、未确认 403、OAuth-only
  null 密码 401、非 bcrypt 格式 fail closed、坏行不中断批、email 异 id
  不合并、重置后 scrypt 接棒)
- `docs/auth.md`:新增「已落地:存量 bcrypt 哈希导入(切片 5)」章节,
  后续切片清单划掉哈希导入项
- **无 schema 改动、零 migration**(导入目标 `auth_user`/`auth_account`
  形状切片 1 已备好)

### 验证

- `corepack pnpm verify` 全绿(lint + typecheck + 189 tests);
  `DATABASE_URL=… corepack pnpm test` 全绿 228/228(与 CI 同配置)
- CLI 三态手工冒烟:fixture 导出 → dry-run 报告不写库 → `--apply` 写入
  (坏行 exit 1 + 逐行原因)→ 重跑幂等(imported 0 / skipped 2)

## 判断层(手写 —— hook 写不出这部分)

**做了什么判断,为什么:**

1. **verify 按格式分派,而不是给 bcrypt 换掉整个密码体系。** 提供自定义
   verify 后 better-auth 完全不再兜底(create-context.mjs 里
   `password?.verify || verifyPassword`,源码确认)——所以 scrypt 分支必须
   在自定义 verify 里显式回落 `better-auth/crypto`。这个设计保住了两个
   方向:导入的 bcrypt 原样验证(老用户原密码登录,#22 验收第 1 条),
   新注册/重置仍是 scrypt(不引入 bcryptjs 到写路径)。备选方案「导入时
   把 bcrypt 重哈希成 scrypt」被否:那需要老库明文或在线代理登录,做
   不到,或者强制全员重置——正是本切片要消灭的。

2. **不做登录成功后重哈希(bcrypt → scrypt 升级写回)。** 这是主流做法
   (Auth0/Supabase 都有),但 better-auth 没有内置钩子,要在登录热路径
   上加一次有条件的 account 写,还要处理并发写冲突;收益只有「哈希格式
   统一提前」,而迁移本来就随改密自然完成、bcrypt cost 10 也未破损。
   记录在 docs 里作为显式非目标,不做隐式省略。

3. **坏哈希 catch 成 false(401),不透传库层抛错(500)。** 读 better-auth
   dist 源码时发现 `verifyPassword` 对非法哈希是 throw("Invalid password
   hash"),默认路径下哈希都是自家写的不会坏;但导入把「别人产的哈希」
   放进了这张表,截断/损坏行不该把登录端点打成 500。语义上「这行密码
   对不上」就是 false,用户走重置流程。测试用垃圾哈希钉住。

4. **导入器是库 + 薄 CLI,不是 admin API 路由。** RBAC 还没落地(#23),
   任何「导入端点」都要么裸奔要么发明临时鉴权;而这是一次性切换操作,
   直接持有 DATABASE_URL 的 CLI 是最诚实的形态——没有网络面,天然
   fail closed。核心逻辑 `importLegacyUsers(db, rows, opts)` 依赖注入,
   集成测试不走 CLI 进程。

5. **CLI 默认 dry-run,`--apply` 才写库;dry-run 与 apply 走同一条决定
   路径。** 两版逻辑合并(早期草稿是 applyRow/applyRowDry 两份,review
   自己时发现冲突判定写了两遍,合成一个 `importRow(db, row, apply)`),
   避免「演练说没问题、实跑换了套逻辑」的裂缝。ops/rules 的 fail-closed
   在这里的落点:能安全误跑的命令才配得上「可重跑」三个字。

6. **同 email 异 id 报错不合并。** 切换窗口里新系统可能已经自己注册了
   同邮箱用户(注册流程切片 2 已上线),那条记录可能已有会话和未来的
   外键;静默按 id 合并或按新 id 合并都是数据损失。宁可让切换运维看到
   一条 error 手动裁决。这是本切片唯一需要人介入的冲突类型,报告里
   带双方 id。

7. **非 bcrypt 格式 fail closed,空密码照常导入。** 老库只应产出
   $2a$/$2b$;导出里出现别的格式说明导出本身有问题(比如把别的表混进
   来了),导入一个永远验证不过的哈希比报错更糟——它会伪装成「用户
   忘了密码」。反之 encrypted_password 为空(GoTrue 的 Google-only
   用户常态)是合法数据:照常建号,credential 密码留 null,登录 401,
   用户走重置或 Google——与切片 4 的 OAuth 路径自然衔接。

8. **测试向量用固定老系统哈希,不用 bcryptjs 现场生成。** 现场生成再
   现场验证是同库自我循环,bcryptjs 的实现回归会互相掩护;固定向量
   ($2a$ cost 10)把「老库哈希 + 原密码」这个合同钉死。$2a$/$2b$ 前缀
   等价性用脚本实测后写进测试(老 GoTrue/pgcrypto 产 $2a$,bcryptjs
   生成 $2b$,比对层无差别)。

**踩的坑:**

- **`constructor(public readonly …)` 参数属性直接炸在 Node strip-only
  模式**(ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX)——AGENTS.md 的
  `erasableSyntaxOnly` 规则早就写了「no constructor parameter
  properties」,但只有真用 `node` 跑 .ts 文件时才会以运行时错误的形式
  出现(CLI 冒烟测试立功,tsc 对库代码反正能过?不——tsc 同样会报,
  只是我先跑的是 CLI)。改为显式字段赋值。
- **`report.imported += await importRow(...)` 字符串拼接**:importRow
  返回 "imported" | "skipped" 字面量,`+=` 静默变成 `"0imported"`。
  TS 对 `number += string` 本应报错——实际是我在 `+=` 上想当然,改成
  显式 `if (outcome === "imported") report.imported += 1`。集成测试
  第一轮 7 条红就是它。
- **闭包内赋值的 `wrote` 标志触发 `no-unnecessary-condition`**:eslint
  的 CFA 不追踪事务回调内的赋值,认为 `wrote` 恒 false。改成事务
  `return changed` + 外层 `await` 接值,分析器闭嘴,代码也更直白。
- better-auth 1.7.7 的 `verifyPassword` 对坏哈希**抛错不返回 false**
  (dist 源码确认)——见判断 3,这个行为差异直接决定了要不要 catch。
- pnpm workspace 下 `node -e "import('@ally/db')"` 只在 apps/api 目录
  解析得到(workspace 包不 hoist 到根);CLI 冒烟和临时检查脚本都得
  cd 进 apps/api 跑。

**值得纳入项目的点:**

- 「读依赖 dist 源码定合同」第五次命中(verify 完全替换语义、sign-in
  的 accountId 匹配条件、坏哈希抛错)。对 better-auth 这类文档略滞后
  的库,源码就是文档。
- 「薄 CLI + 可注入核心」的测试策略好用:11 条集成测试全部走
  `importLegacyUsers` 直调,CLI 本身只配了三态手工冒烟(它的分支只有
  参数解析和退出码)。
- 下个切片(#25 员工/门户开通与 shadow account)会直接复用本切片的
  两个形状:credential account 的构造函数式写法,和「错误逐行收集、
  不中断整批」的报告模型。
