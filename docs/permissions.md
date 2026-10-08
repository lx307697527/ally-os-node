# 角色与权限（#23）

老系统的授权是数据库里的 679 条 RLS 策略 + `core.has_role()` / `core.has_any_role()`
两个 SECURITY DEFINER 函数（migration `20260718000100_core_identity.sql`），散落在
165 个迁移文件里，还有「`CREATE OR REPLACE FUNCTION` 自动把 EXECUTE 授权回 `anon`」
的已知坑（`rls-super-admin-gaps.md`）。新系统把授权收拢到 **API 层**：会话中间件
之后统一加载角色与生效权限集，路由上显式声明门，数据库不再承担逐表策略（将来
可选保留 RLS 作第二道防线，但应用连接不依赖它）。

设计权威：#232 §12「角色与权限」——权限按「角色 = 一组权限点」建模，一个人可以
同时有多个角色；权限在服务端分四层检查（功能 / 记录 / 字段 / 职责分离）。

## 已落地：RBAC 基座（#23 切片 1）

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 角色与权限点注册表 | `apps/api/src/authz/permissions.ts` | 服务端单一真相源。15 个登录角色（闭集，PG 枚举 `app_role`）+ 权限点（开集，`PERMISSIONS` 常量），`ROLE_PERMISSIONS` 是角色默认集矩阵 |
| 数据模型 | `packages/db/src/schema.ts`（migration `0003`） | `user_role`（多角色，PK (user_id, role)，FK → auth_user 级联删除）+ `user_permission`（个人附加权限点，text 列，合法性由注册表收口）。对应老 `core.user_roles`；老表预留的 scope 列（租户级角色）未迁——#232 里没有租户级角色，等出现再动 |
| 生效权限计算 | `authz/permissions.ts` `effectivePermissions` | 角色默认集 ∪ 个人附加授权。`label_design` 这类「授予任意角色的人」的权限点走个人附加授权，无角色默认携带 |
| 请求级加载 | `authz/middleware.ts` `authzMiddleware` | 紧跟 sessionMiddleware 挂在 `/api/*`：每请求查一次库（两小查询），把 `{ roles, permissions }` 放进 context——老系统每条 RLS 反复调 `has_role()` 的等价物，新系统一请求只查一次 |
| 授权门 | 同上 `requireRole(...roles)` / `requirePermission(p)` | 任一角色即过（has_any_role 语义）/ 持有效权限点即过；不过答 403 `{ error: "forbidden", code: "role_required" \| "permission_required", … }`。401（未登录）与 403（登录但无权）分层不变 |
| 角色管理端点 | `routes/user-roles.ts` | `GET/POST /api/users/:userId/roles`、`DELETE /api/users/:userId/roles/:role`，全部挂在 `roles.assign` 权限点后面。授予幂等（重复授予 200 `granted:false`），**只有真实变更写审计**（R-16-6：所有权限变更留审计，落 `audit_events`，actor/target/detail 齐全） |
| R-16-6 高级角色门 | `routes/user-roles.ts` + `authz/role-approval.ts` | 授予/撤销 `owner` / `admin` / `finance` 需要「老板确认」（#221 切片 2 起）：owner 本人直接执行（R-16-5 自批）；其余 `roles.assign` 持有者走审批线——线已配置（`approval_configs` 里 `user_role`/`role_grant`）则 202 建审批请求，老板终审**批准即生效**（同一事务里写 user_role + `role.granted`/`role.revoked` 审计，detail 带 `via: "approval"`）；线未配置/停用则保持 fail-closed 等价物 403 `owner_approval_required`（不预置配置数据）。在飞请求重复提交 409 `owner_approval_pending` |
| 路由授权声明 | `routes/registry.ts` + `routes/route-auth.test.ts` | 验收第 2 条的落点：每个 `/api/*` 路由（含公开路由）必须在 `API_ROUTES` 里有一行 auth 声明；测试把 app 实际路由与清单**双向比对**——新路由不写声明、或声明指向已删除的路由，测试都红；公开路由集合钉死，新公开端点必须显式改测试 |
| 引导 CLI | `apps/api/src/scripts/grant-role.ts` | 授权端点依赖已有角色（鸡生蛋），第一台机器由运维用本脚本开第一个 owner/admin：`node --env-file-if-exists=.env apps/api/src/scripts/grant-role.ts --email <地址> --role owner --apply`。默认 dry-run；绕过 API 的 R-16-6 门属运维动作，写审计（actor 记 `cli:grant-role`）；也是撤掉最后一个 owner 后的恢复通道 |
| 矩阵即测试 | `authz/authz.test.ts` | 验收「每个角色能 / 不能访问什么」：注册表里每个（角色 × 权限点）组合逐对断言与 `ROLE_PERMISSIONS` 一致——新权限点加进注册表的那一刻自动被覆盖 |

`GET /api/me` 现在返回 `authz: { roles, permissions }`——前端据此做渲染层裁剪
（老系统 `useAdminPermissions` 的角色），真正的访问控制在服务端，前端字段只是展示。

## 权限矩阵（角色 × 权限点）

裁决原文（#232 §12）逐角色照录，落地状态标注。**「随模块」= 该权限点随对应业务
模块的切片进场**，进场时在 `PERMISSIONS` 注册、在 `ROLE_PERMISSIONS` 挂默认角色、
矩阵测试自动覆盖。

| 角色 | 裁决默认权限（按 #232 §12） | 本切片落地 |
| --- | --- | --- |
| 老板 owner | 全部查看；审批：手工建单超 $100,000、PO 超阈值、退款超阈值、拉黑、账期与额度、特别版合同条款、授予高权限；合同我方签字（或授权他人）；授权质量放行例外；维护法规风险清单；设定买断价、标签设计费和提成规则；打开业务门槛例外开关 | `roles.assign`（高级角色授予的实际执行者）、`audit.read`（#29，「全部查看」先落在审计日志） |
| 管理员 admin | 分配权限（授予老板/财务/管理员级需老板确认，R-16-6）；维护规则注册表中的管理员项 | `roles.assign`（高级角色提交审批、老板终审批准后生效，见上）、`audit.read`（#29） |
| 销售主管 sales_lead | 公海认领、改派归属、取消订单、同意签后变更、判定交货后赔偿、批准营销邮件、配置 qualified 规则和销售等级、设非数量折扣上限、发起退款和拉黑、查看利润 | —（随 #234/#239/#240/#237 等） |
| 销售 sales | 公海认领；客户、报价、订单；确认配方与价格；代客户确认打样（留证据）；标记无效线索；标记配方保密；查看自己单子的毛利率 | —（随 #227/#229 等） |
| 客服 customer_service | 改客户资料；处理和回复工单 | —（随 #235/#209） |
| 销售助理 sales_assistant | 改客户资料；协助报价与跟进 | — |
| 运营助理 ops_assistant | 改客户资料；起草营销邮件；完工后运营确认 | —（随 #237/#231） |
| 配方师 formulator | 配方审核、配方变更审核、标记配方保密 | —（随 #126/#202） |
| 采购 purchaser | 选择供应商、RFQ、PO、收货差异处理、记录供应商付款 | —（随 #194 等） |
| 仓库 warehouse | 收货、移库、领料、发货、盘点；不能改批次质量状态 | —（随 #218/#178 等） |
| 生产主管 production_lead | 排产、执行和管理批记录、修改预计完工日、裁决离线冲突 | —（随 #215/#203） |
| QA qa | 来料和成品放行（不能放行自己检测的批次）、偏差处置、规格书与 COA 签字、标签成分核对、确认到厂参观时间 | —（职责分离属第四层检查，随 #204） |
| 化验员 lab_technician | 录入检测数值 | —（随 #198） |
| 财务 finance | 确认发送发票、认领收款、执行退款、审批低于 50% 的定金、审核开票信息、恢复暂停发货、维护开票抬头/免税证明/账期字段、QuickBooks | `invoices.manage`（#192：发票全生命周期——手工建草稿、改草稿、确认发出、作废；收款台账同门（切片 2：记账、读台账、作废误录）；触发点的系统生成不在此权限点后面，属主域在自己的业务事务里调 `billing/service.ts`） |
| 客户 customer（门户） | 我的订单和待办；只能看到自己公司的数据 | —（记录层检查随门户模块；#25 的影子账号是其账号基座） |

权限点现状：`roles.assign`（admin/owner 默认）、`users.manage`（admin/owner 默认，#26 用户生命周期——花名册、创建邀请、改名、停用/启用；团队管理与「分配权限」分立：创建/停用不动任何人的权限，R-16-6 审批语义不覆盖它们，管理员也不因能建号就能授特权角色——特权角色的唯一入口仍是 user-roles 端点的 R-16-6 门，创建面连 owner 也不给夹带；停用/启用 owner 角色的账号在路由内再拦一层 owner_required——老板的账号只有老板能动，裁决全文见 docs/teams.md）、`audit.read`（admin/owner 默认，#29 审计日志查询；含全公司操作记录，不给其余角色默认开）、`label_design`（**无角色默认携带**，
只单独授人——标签设计是独立权限点不新增角色，R-16-4；外部设计师开受限账号即
「无员工角色 + label_design + 分配的产品」，记录层检查随 #169）、
`workflow.configure`（admin/owner 默认，#220 流程模板管理——改流程 = 改全员的
工作方式，属配置工作室；实例的**推进**不在此权限点后面，能推谁由属主域的可见性
门与模板流转上的 roles 裁决，内核只守「纯 customer 角色不可推进」的地板）、
`approval.configure`（admin/owner 默认，#221 审批线管理——改审批路线 = 改「谁
有权裁决什么」，属配置工作室；请求的**提交与裁决**不在此权限点后面，单据可见性
门与配置点名（指定人员/角色）各裁各的，业务审批自批合法 R-16-5）、
`custom_fields.configure`（admin/owner 默认，#222 自定义字段管理——给对象加字段
= 改所有人的表单与详情页，属配置工作室；字段**值的填写**不在此权限点后面，由
subject 可见性门 + 字段级 viewableBy/editableBy 逐字段裁决，配置权和填写权分离）。
`automations.configure`（admin/owner 默认，#224 自动化规则管理——新增一条规则 =
改全公司的连锁反应（建任务、发通知），属配置工作室；规则的**执行结果**（runs
执行日志）的查看也在此权限点后面，运行记录含收件人名单与业务事件细节，是配置面
的一部分，不另开读口）。
`numbering.configure`（admin/owner 默认，#225 编号规则管理——改编号格式 = 改所有
之后发出的单据号，属配置工作室；**发号**不在任何权限点后面，分配是属主域创建
单据事务里的进程内调用，号随单据的可见性门走）。
`invoices.manage`（**finance/owner 默认**，#192——第一个非 configure 族的业务
单据权限点：发票全生命周期（手工建草稿、改草稿、确认发出、作废）与收款台账（记账、读台账、作废误录，#192 切片 2——#232 §12 财务「认领收款」）都在它后面。
三处刻意不在它后面：触发点的**系统生成**（属主域在自己的业务事务里调
`billing/service.ts`，有没有权生成由触发点自己的业务门裁决）、销售的**记录级
可见**（「只看自己单子的发票」，随订单域 #231 的可见性门进场）、admin 不默认
持有（管理员是分配权限与配置工作室的角色，发票是业务单据，要持有走授权，
R-16-6 授 finance 级需老板确认）。
所有员工通用的三件事（代客户注册 R-01-10、查看和回复投诉工单 R-14-3、查看未标
保密的配方 R-05-9）不做成权限点——它们是登录即可的默认，随各模块落地。

## 老角色 → 新角色映射（供数据迁移参考）

老 `core.app_role` 是 16 值（FEAT-001 定 13 值 + FEAT-052 加 finance/qc/formulator），
与 #232 §12 的 14+1 角色不是一一对应。导入 `user_role` 时的建议映射（**迁移执行时
由 owner 逐条确认，本表不是裁定**）：

| 老（core.app_role） | 新（app_role） | 备注 |
| --- | --- | --- |
| super_admin | admin | 「超级管理员」并入管理员 |
| ceo | owner | 老板；coo/cmo 同为高管位，出现时逐个裁定 |
| admin | admin | |
| cmo | sales_lead | 销售主管 |
| sales / closer | sales | closer（成交手）并入销售 |
| account_executive | sales_assistant | 销售助理 |
| ops | ops_assistant | 运营助理 |
| purchaser | purchaser | |
| lab_technician | lab_technician | 化验员 |
| finance / qc / formulator | finance / qa / formulator | FEAT-052 三个值与设计同名 |
| customer | customer | 门户 |
| supplier | （无映射） | 设计里没有供应商门户角色；有真实供应商账号时再裁定 |

## 后续切片（本切片未做，验收项对应）

- **验收第 3 条「跨租户访问回归测试」**：需要第一个带归属的业务资源（客户/报价/
  订单），随 #235/#227 落地 `requirePermission` + 数据归属检查的组合并写 A 读 B 的
  回归测试。四层检查里的记录层、字段层（成本价/利润/银行信息）、职责分离（放行人
  ≠ 检测人，R-15-4）同理随模块进场。
- 权限点随业务模块持续注册；每个模块切片自带「角色 × 新权限点」的矩阵增量。
- ~~R-16-6 的「老板确认」从「仅 owner 可执行」升级为真审批流~~：#221 切片 2 已落地
  （`authz/role-approval.ts`；审批线未配置时保持仅 owner 可执行的 fail-closed）。
  待办页/配置 UI 随配置工作室前端进场。
- 权限变更审计目前落 `audit_events`；审计的查询/展示界面随工作台模块（#191）。
