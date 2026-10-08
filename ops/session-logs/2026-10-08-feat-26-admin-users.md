---
session_id: hand-written-26-admin-users
branch: feat/26-admin-users
date: 2026-10-08
reason: issue-26
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/26-admin-users — 2026-10-08

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#26「后台用户、系统用户与资料管理」(phase-1,模块 #185)。
  PR 正文写 **Closes #26**(验收两条全部满足,见下)。
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净。
  fetch --prune 后远端分支无变化需清理。
- **选题**:①候选里 #233/#220/#226/#221/#113/#110/#116 的剩余项全部路由到
  属主域(#227/#231/#243)、#118、#115、#206 或设计选型未决;②phase-1 按
  编号顺序,#22(代码侧全毕)/#23(余项随模块)/#25(余项随 CRM)都被
  阻塞,**#26 是第一个依赖全就位且未动工的**——它的前置 #22 auth、#23
  RBAC 基座、#24 2FA、#29 审计、#25 影子账号已全部合并。
- **claim**:`claim_issue.py claim --issue 26` 成功(claims/issue-26)。
- **worktree**:`.claude/worktrees/26-admin-users`,分支 feat/26-admin-users,
  自 origin/main(67841c8)。corepack pnpm install 成功(hooks 已装)。
- **数据库**:本地 postgres 可用(PG 16.15),verify 全程带 DATABASE_URL,
  **129 文件 / 1289 测试零 skip**(基线 126/1264:+3 文件 +25 测试)。

### 本切片改动的文件

- `packages/db/src/schema.ts`:auth_user.disabled_at(migration 0036,
  expand-only 单列,可空时间戳)。
- `apps/api/src/authz/permissions.ts`:新权限点 `users.manage`(owner/admin
  默认),注册表注释写明与 roles.assign 的分立理由。
- `apps/api/src/routes/users.ts`(新):GET /api/users(status 筛选 + 角色
  聚合 + total)、POST /api/users(创建邀请)、PATCH /api/users/:userId(改名)、
  POST /api/users/:userId/{disable,enable}。特权角色词表从注册表派生
  (ROLES − OWNER_APPROVAL_ROLES)。
- `apps/api/src/auth/auth.ts`:better-auth user additionalFields disabledAt
  (type date、input false);hooks.before 拦 /sign-in/email 的停用账号
  (403 code+message 双字段);createSessionResolver 停用即无会话;
  sendResetPassword 回调按凭据存在性分流邀请/重置措辞。
- `packages/mailer/src/mailer.ts`:renderAccountInviteEmail(邀请措辞,
  不提「重置」)。
- `apps/api/src/app.ts` + `index.ts`:挂载 usersRoutes;AppDeps 新注入
  sendPasswordSetupEmail(生产走 auth.api.requestPasswordReset;不得 reject)。
- `apps/api/src/routes/registry.ts`:users.manage 五条声明(route-auth 双向
  比对测试背书)。
- `apps/web/src/shared/lib/users-client.ts`(新):roster/生命周期/角色动词
  的 adapter,失败模式逐码分相;STAFF_ROLES(14,alias APPROVAL_ROLES 不抄
  第二份)与 INVITE_ROLES(11 = 14 − R-16-6 三角色)。
- `apps/web/src/shared/pages/TeamUsers.tsx`(新):/system/team 花名册 +
  创建面板 + 改名 + 停用/启用 + 角色授予/撤销;三条纪律进第一屏。
- `apps/web/src/App.tsx` + `shared/shell/rail-groups.ts`:/system/team 路由
  与 System 区 rail 行。
- `apps/api/src/authz/authz.test.ts`、`apps/api/src/app.test.ts`:admin 生效
  权限集期望值补 users.manage。
- 测试:routes/users.test.ts(新,8 例集成)、auth/auth.test.ts(+2)、
  packages/mailer(+2)、web users-client.test.ts(新,6)、
  team-users.test.ts(新,7);30 个既有测试文件的 AppDeps 字面量补
  sendPasswordSetupEmail(sed 机械补齐)。
- docs:teams.md(新,裁决全文)、permissions.md(users.manage 词条)、
  auth.md(停用门/会话失效/邀请分流表)。

## 判断层

### 关键判断

1. **issue 的「老系统现状」与老库对不上,按勘误自建而非照抄**。派只读探索
   agent 摸老库:admin-create-user、AdminUsers/AdminSystemUsers/AdminProfiles、
   profiles 表全部不存在;实际是 staff-invite(super_admin 专属)+ 权限中心
   (审批制角色变更)+ core.users.status(只有枚举没有实现);禁用与删除在
   老系统从未落地。于是本切片的实现依据是 #232 §12 + #144,老系统只供了
   三个真实动机:email_confirm: true(地址自证)、审计双写(权限变更逐条留痕)、
   「不能撤最后一个 super_admin」(G4)。勘误写进 docs/teams.md 首节,PR 正文
   同步——「老代码只是参考」在这次是字面生效。

2. **「超级管理员 vs 普通管理员」按映射表翻译成 users.manage**。验收原句
   在新 14+1 角色设计里没有对应物,docs/permissions.md 已裁定 super_admin
   并入 admin;承接 #144 验收「团队管理只有管理员能做」,落成新权限点
   `users.manage`(owner/admin 默认)。**与 roles.assign 刻意分立**:创建/
   停用不动任何人的权限,R-16-6 审批语义不覆盖它们;反向亦然——管理员能
   建号不等于能授特权角色。

3. **创建面不收特权角色,连 owner 也不给夹带**。roles 的 zod 词表从注册表
   派生(全部角色 − OWNER_APPROVAL_ROLES)——形状层即策略,特权角色的唯一
   入口是 user-roles 端点的 R-16-6 门(审批线/owner 亲执),先建后授,审计里
   才有一个「谁授的」可追溯动作。不接受「创建时顺手把老板角色也给了」的
   请求,即使发起人就是老板。

4. **删除没有端点——这是对 issue「删除要定义清楚」的回答**。定义清楚的结果
   是「不做」:审计 append-only(#29)+ auth_user 被业务外键到处引用(级联
   形状各表自定,一个 DELETE 就是数据损失);停用是除名的唯一入口(盖
   disabled_at + 同事务删全部会话 + 登录门 + 会话解析门四层);将来的极端
   情形(监管抹除)走独立匿名化流程,不冒充成「删用户」。

5. **「停用最后一个 owner」靠结构保证,不写死代码**。推演:停 owner 需要操作者
   持有 owner(owner_required 门),自己停自己 409 self_disable——所以任何
   一次 owner 停用发生时,必然存在第二个在职 owner(操作者本人)。没有加
   一个永远摸不到的 last_owner 分支;两道门各自的测试(409/403)钉住这条
   结构性质。

6. **owner 门的裁决在幂等短路之前**(测试抓出来的顺序错误)。第一版把
   「已是目标态 200」放在 owner_required 之前——admin 对在职 owner 发
   enable 拿到 200,等于用接口探测了老板账号的状态。修成 404 → self →
   owner_required → 幂等:对碰不得的目标,连「它已是目标态吗」都不回答。

7. **邀请与重置是同一条通道的两种措辞,不立第二种令牌**。管理员建号后的
   激活邮件走 auth.api.requestPasswordReset(better-auth 对无凭据账号当场
   建 credential,#25 源码确认过的语义),sendResetPassword 回调按「有没有
   credential 密码」分流——没设过 = 邀请措辞,设过 = 重置措辞。判定只看
   凭据存在性,#25「认领不另设标记」同裁;不给从没设过密码的人发「有人
   请求了重置」的惊吓信。

8. **停用登录门的位置与已知取舍**。hooks.before 在密码校验之前拒绝
   (403 account_disabled)——这让「这个地址已被停用」在无密码情况下可确认,
   存在性掩蔽让位于内部员工系统的诚实 UX;有效账号与不存在地址仍走
   better-auth 原路径(时序仿真),枚举者得不到「有效账号」的确认。取舍
   写进 docs/auth.md,不是没看见。

### 踩坑

- **better-auth 的契约靠 .d.mts 逐条验,不靠记忆**:additionalFields 支持
  的 DBFieldType("date" → Date)、input/returned/defaultValue 的语义、
  APIError 的 { code, message } 体、hooks.before 的 AuthMiddleware 形状,
  全部翻 node_modules 里的 dist typings 确认后才动手。「date」类型若猜成
  string,会话解析器的 instanceof Date 判空就是一条静默不生效的门。
- **enum 的 array_agg 没有 node-pg 解析器**:花名册第一版 roles 聚合直接
  array_agg(app_role),驱动把 app_role[] 还原成 "{admin}" 字符串——
  toEqual(["admin"]) 当场红。cast 成 ::text[] 让驱动走原生数组解析。
- **2FA 启用的账号登录响应没有会话 cookie**(twoFactorRedirect 挑战):
  测试夹具先签会话再置 twoFactorEnabled 标志——user-roles.test.ts 里有
  同款注释,抄夹具要抄到这条顺序,不然 admin 的请求全是 401。
- **AppDeps 加必填字段牵动 30 个测试文件**:每个文件各自字面量构造 deps,
  没有共享 fixture builder。sed 两个模式(`stripe: undefined,` 与短写
  `stripe,`)批量插入后,stripe.test.ts 的第三种形态
  (`stripe: channel(...)`)漏网,typecheck 抓住补齐。grep 输出的 Windows
  反斜杠路径会让 sed 批量失败,批量文件操作用 git ls-files 拿路径。
- **JSX 源码换行会切开断言**(上一会话的教训原样复现):源文本断言挑
  行内短语,整句跨行永远红——team-users.test.ts 第一屏纪律断言改用
  "privileged roles (owner, admin, finance) need the"。
- **eslint 的 unused-vars 默认「after-used」**:vi.fn((_url, _init) => …)
  两个未用参数全报;照 custom-fields-client.test.ts 的既有模式在闭包里
  消费 init(记录 request body 断言),断言还更扎实。

### 验收对照(#26)

- [x] 超级管理员能创建用户、改角色、停用;普通管理员不能 —— users.manage
  (owner/admin 默认)四条生命周期端点 + 既有 roles 端点;「超级管理员」
  按 docs/permissions.md 映射并入 admin(#144 裁决),普通业务角色一律
  403;owner 角色目标再拦一层 owner_required。
- [x] 每次操作都写审计日志 —— user.created / role.granted(via
  user_created)/ user.updated(from/to)/ user.disabled / user.enabled,
  全部落 audit_events(append-only),集成测试逐条断言。

**「系统用户」一项**:老系统无对应物(探索证实),新系统机器动作以
`cli:<script>` 记审计,无一类可登录的系统用户——勘误随 PR 说明,#26 按其余
两项验收闭环(Closes)。
