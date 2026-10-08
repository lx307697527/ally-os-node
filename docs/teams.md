# 团队:用户生命周期管理(#26)

花名册、创建邀请、改名、停用/启用——团队管理的服务端 API 与配置页
(`/system/team`,`users.manage` 权限点,owner/admin 默认持有)。老系统
没有这套面:staff-invite edge function(super_admin 专属)管建号,
`core.users.status` 枚举定义了 active|suspended|disabled 却没有任何实现
路径,删除从未落地;issue #26「老系统现状」描述的 admin-create-user /
AdminUsers / AdminSystemUsers / AdminProfiles 页面与 profiles 表在老库中
不存在(写 issue 时凭记忆引用了更早的系统)。本页记录的是新系统按
#232 §12 + #144 的自建裁决。

## 角色词表的衔接

#26 验收标准写「超级管理员能创建用户、改角色、停用;普通管理员不能」。
docs/permissions.md 的老角色映射表裁定 **super_admin 并入 admin**——新系统
没有第二档管理员,这句验收按 #144 的裁决(「团队管理(增删成员、改角色)
只有管理员能做」)落在 `users.manage` 上:owner/admin 默认持有,业务角色
一律没有。「超级管理员 vs 普通管理员」的区分在新设计里就是「持有
users.manage 的人 vs 其他人」。

## 创建 = 影子账号服务 + 初始角色 + 激活邮件

- `POST /api/users`(body:email、name?、roles?)。**insert 走 #25 的
  `ensureShadowAccount`**——「所有新增账号代码路径都调同一个服务函数」,
  管理员建员工号与 CRM 预建客户号是同一条路径:无密码 credential account、
  `emailVerified = true`(激活邮件本身发往该地址,地址在激活那一刻自证;
  老 staff-invite 的 `email_confirm: true` 同款)、trim + lower 邮箱归一化、
  并发双写撞唯一索引由输家重查兜底。同邮箱已有账号 → 409 `user_exists`
  (对已认证的管理员不做反枚举,反枚举是公开端点的纪律)。
- **创建面不收特权角色**。roles 词表从注册表派生 = 全部角色 −
  `OWNER_APPROVAL_ROLES`(owner/admin/finance)——形状层即策略,连 owner
  本人也不能在建号请求里夹带;特权角色的唯一入口是 user-roles 端点的
  R-16-6 门(审批线或 owner 亲执),先建后授,审计里才有一个「谁授的」
  可追溯动作。
- **激活邮件走密码重置通道**:服务端 `auth.api.requestPasswordReset` 生成
  24h 一次性令牌,`sendResetPassword` 回调按「有没有设过 credential 密码」
  分流措辞——没有 = 邀请(「account was created for you」,renderAccountInviteEmail),
  有 = 重置(#22 原语义)。同一条通道服务两个语义,判定只看凭据存在性,
  不另立状态列(#25「认领不另设标记」同裁)。发送失败不阻塞建号、不抛出
  (失败只记日志;用户可自助再走一次忘记密码)。审计 `user.created`
  (detail 带 email/roles/invited),初始角色逐个补 `role.granted`
  (detail.via = "user_created")。

## 停用是除名的唯一入口;删除没有端点

- `POST /api/users/:userId/disable` / `enable`:盖 `auth_user.disabled_at`
  (migration 0036,expand-only)+ 同事务删该用户全部会话行 + 审计
  `user.disabled` / `user.enabled`。三件事在一个事务里——停用生效即旧
  cookie 全部失效,不等自然过期。已是目标态幂等 200 不审计
  (real-change-only,同 role.granted)。
- **登录门**:`hooks.before` 在 `/sign-in/email` 入口查到停用行直接
  403 `account_disabled`(body 带 code 与完整句子,登录页原样上屏)。
  已知取舍:这让「这个地址已被停用」在无密码情况下可确认——内部员工
  系统的诚实 UX 优先于对已知邮箱的存在性掩蔽;有效账号与不存在地址
  仍走 better-auth 原路径,枚举者得不到「有效账号」的确认。
- **会话门**:会话解析器(`createSessionResolver`)对停用用户的会话一律
  视为无效(每个 /api/* 请求 401)——停用时刻删会话是第一道防线,解析器
  兜住删除与并发登录之间的竞态。disabledAt 经 better-auth additionalFields
  (type: date,input: false)进会话读取,认证端点改不了它。
- **老板的账号只有老板能动**:停用/启用 owner 角色的用户要求操作者持有
  owner 角色(403 `owner_required`),R-16-6 同族裁决。门在幂等短路之前——
  对碰不得的目标,连「它已是目标态吗」都不回答。self-disable 409
  `self_disable`(在飞会话停用自己的账号把自己锁在外面)。
- **「停用最后一个 owner」结构性不可能**:停 owner 需要操作者是另一个
  在职 owner,自己停自己被 409 挡住——任何时刻至少剩操作者本人在职。
  角色本身的误操作另有 grant-role CLI 作运维恢复通道(#23)。
- **删除为什么不做**:审计日志 append-only(#29,「审计不可删除」)+
  业务外键级联会毁记录(auth_user 被到处引用,级联形状由各表自定——
  一个 DELETE 就是数据损失)。硬删除不提供 API;将来的极端情形(如
  监管要求的记录抹除)走独立的匿名化流程,不冒充成「删用户」。
- 改名:`PATCH /api/users/:userId`(strict body: name,1–200 字符),
  真实变更才落行与审计(`user.updated`,detail 带 from/to),同名幂等。

## 读面

- `GET /api/users?status=active|disabled&limit=&offset=`:全量账号(客户
  影子账号在同一个池里,roles 列让人一眼分辨员工与门户账号),角色聚合
  随行(text[] cast——app_role 的数组类型没有 node-pg 解析器)、
  total 分页。停用筛选是管理员的主读法。
- 权限声明见 routes/registry.ts(users.manage 五条);401/403 分层与
  全站一致。

## 系统用户:无对应物,不渡河

老系统没有「系统用户」概念(service-role key 只存在于 Edge Function 环境变量,
从不进前端;也没有面向用户的 API key)。新系统无 HTTP 面的机器动作一律以
`cli:<script>` 记审计(audit.ts 的 actor 约定),不需要一类可登录的「系统
用户」。issue #26 的 AdminSystemUsers 随老系统现状勘误一并关闭语义:该项
在新设计中不存在。

## 测试

- routes/users.test.ts(集成,8 例):花名册聚合与筛选、users.manage 门、
  创建(归一化/审计/激活邮件/特权角色拒绝/409/400/403)、改名(from/to 审计、
  幂等、404)、停用(会话吊销、登录拒绝、幂等无重复审计)、self_disable、
  owner_required 双向、启用恢复。
- auth/auth.test.ts(+2):无密码账号的邮件是邀请措辞、设过密码后同通道
  变重置措辞;停用账号旧会话当场失效、新登录 403、启用恢复。
- packages/mailer(+2):邀请模板转义、链接原样、text 推导、措辞不提「重置」。
- web:users-client.test.ts(adapter 契约 + 词表镜像)、team-users.test.ts
  (源文本纪律)。
