# 审计日志（#29）

谁、什么时候、对哪条记录、做了什么、细节是什么——审计日志是平台内核服务
（#232「平台服务：认证与权限 · 审计日志 · …」），也是 #232 数据底线的载体：
**审计日志不可删除**。

老系统对应物：老-老系统用 176 个数据库触发器逐表写审计与删除快照（新设计已
抛弃该形态）；上一代内核是 `core.audit_log`（按月分区）+ `core.emit_event()`
 Governed-Action 内核——业务 RPC 在**同一事务里显式调用**，外加 append-only
触发器（`fix747` no_update、`fix906` 补 no_delete）。状态变更的跨记录读法是
`crm.status_change_log` 视图（FEAT-081）。

## 已落地：审计内核 + 查询面（#29 切片 1）

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 共享写入器 | `apps/api/src/audit/audit-log.ts` `recordAudit(db, entry)` | 所有业务域复用的唯一写入口。actor 来自会话（运维 CLI 用 `cli:<script>` 前缀），action 走词表，detail 放变更细节 |
| append-only 底线 | `packages/db/migrations/0007_*.sql` | `audit_events` 拒绝行级 UPDATE/DELETE（触发器，老系统 `audit_log_is_immutable()` 的直译）。#232「审计日志不可删除」的结构化落点：绕过应用的人工写路径改写/抹不掉历史 |
| 时间索引 | 同上 | `(created_at desc)`——日志页唯一读法「最新在前翻页」；过滤列刻意不建索引（追加型表，老系统 core.audit_log 除主键外同样不建，查询慢了再加） |
| 查询端点 | `apps/api/src/routes/audit-events.ts` | `GET /api/audit-events`，`audit.read` 权限点门（owner/admin 默认持有）；offset 分页 + 精确 total；actor/action/target 精确匹配过滤；纯读端点（查询不写审计） |
| 权限点 | `apps/api/src/authz/permissions.ts` | `audit.read`：#232 §12 老板「全部查看」+ 管理员；其余角色不给默认，审计日志含全公司操作记录 |
| 后台页面 | `apps/web/src/shared/pages/AuditLog.tsx` | `/system/audit`，System 区第一个页面。时间/操作人/动作/对象/详情（JSON 原样），固定步长翻页 + 「N 条」页脚；加载 / 403（明确说无权限）/ 不可达 / 空表，四种状态都不撒谎 |

## 层次裁决：应用层写，数据库兜「不可变」

#29 迁移要点原问句：「审计留在数据库触发器，还是移到应用层？」本切片的裁决
及理由：

- **写入在应用层**（`recordAudit`，业务代码同事务显式调用——即老系统
  `core.emit_event()` 的形态，不是 176 个触发器的形态）。新系统所有写路径收敛
  在 API，应用层审计记录的是「谁、通过哪个路由、对哪条记录」；触发器方案今天
  没有附着对象（业务表还没进场），先建机制不留产线 = 生产死代码。
- **数据库侧只保留一条不可协商的底线**：表 append-only。应用层审计挡不住绕过
  应用的写路径（直连、运维失误、SQL 注入后的持久化），触发器挡得住——这正是
  老系统 `fix906` 的论证：不存在合法的行级 UPDATE/DELETE 流量，所以无条件拒绝。
- **将来 Part 11 监管表**（电子批记录等，phase-4）进场时逐表评估「触发器兜底
  人工写路径」；那是逐表的决定，随表落地，不预置机制。第一个落的是电子签名表
  本身（#219，0012 触发器：签名行 append-only，与 audit_events 同一裁决）。
- **失败语义**：审计写入失败原样抛出，业务操作随之失败——宁可操作失败回滚，
  不做「记不上就算了」的静默降级（审计丢失比业务失败严重）。

## 词表与 detail 约定

- action 是开集，格式 `domain.object.verb`：`role.granted`、`role.revoked`
  （R-16-6；直接执行 detail 记 `role`，经审批生效 detail 记
  `role`/`via: "approval"`/`requestId`/`submittedBy`，actor 记终审批准人）、
  `task.created`、`task.updated`（detail 记 `fields: [...]`）、`task.assigned`、
  `comment.created`（detail 记 `subjectType`/`subjectId`/`mentioned`）、
  `comment.updated`（#110 切片 5；detail 记 `subjectType`/`subjectId`/
  `fields: ["body"]`；正文未变的幂等提交不落此行）、
  `comment.deleted`（detail 记 `subjectType`/`subjectId`）、
  `follow.created`/`follow.deleted`（关注 #110 切片 4；行无 id，身份是
  `(subject_type, subject_id, user_id)` 三元组——target 为空，subject 引用在
  detail，进对象活动流）、
  `esignature.created`（电子签名 #219；target = 签名行 id，detail 记
  `subjectType`/`subjectId`/`meaning`/`recordVersion`/`recordHash`/
  `signedAt`/`receivedAt`——签名人、时间、含义、记录版本四要素齐在审计行上
  （Part 11.50/11.70 的查询面）；离线补同步的重放不落第二行）、
  `workflow.template_created`（流程模板 #220；target = 模板行 id，detail 记
  `subjectType`/`templateKey`/`productType?`/`isDefault`/`states`——配置了哪些
  状态一眼可查）、
  `workflow.template_updated`（流程模板就地改写 #220/#226；target = 模板行 id，
  detail 记 `subjectType`/`templateKey`/`changes`（顶层字段 from/to）——无实效
  变更的幂等 PATCH 不落此行）、
  `workflow.instance_started`（流程实例 #220；target = 实例行 id，detail 记
  `subjectType`/`subjectId`/`templateKey`/`from`——起点即初始状态）、
  `workflow.state_changed`（流程推进 #220；target = 实例行 id，detail 记
  `subjectType`/`subjectId`/`event`/`from`/`to` 与人工推进时的 `note`——
  流转历史表之外的第二份权威读法，历史表 append-only、审计不可删除）、
  `approval.config_created`（审批线 #221；target = 配置行 id，detail 记
  `subjectType`/`configKey`/`name`/`steps`——配了几级审批一眼可查）、
  `approval.requested`（审批提交 #221；target = 请求行 id，detail 记
  `subjectType`/`subjectId`/`configKey`/`steps`——subject 引用在 detail，
  进单据的活动流时间线）、
  `approval.action_recorded`（审批裁决 #221；target = 裁决行 id，detail 记
  `requestId`/`subjectType`/`subjectId`/`configKey`/`stepIndex`/`level`/
  `decision` 与可选的 `note`、`signatureMeaning`——#221 验收「谁、何时、
  同意或驳回、意见、签名含义」的查询面；裁决行本身 append-only（0014））、
  `approval.completed`/`approval.rejected`（请求终态 #221；target = 请求行
  id，detail 记 `subjectType`/`subjectId`/`configKey`/`decision`/`finalStep`
  ——终态同时给发起人落一条站内通知，#110 通知内核）、
  `custom_fields.field_created`（字段定义 #222；target = 定义行 id，detail 记
  `subjectType`/`fieldKey`/`fieldType`/`required`/`viewableBy`/`editableBy`
  ——字段级权限配了哪些角色一眼可查）、
  `custom_fields.field_activated`/`custom_fields.field_deactivated`（字段停用
  与恢复 #222；target = 定义行 id——定义一经创建不改写，active 翻转是唯一的
  状态路（内容改写端点随 #226 后续切片），每次翻转同时记台账新版本）、
  `custom_fields.values_updated`（字段值提交 #222；target = subject id，
  detail 记 `subjectType`/`subjectId`/`title`/`fieldKeys`——subject 引用在
  detail，进对象的活动流时间线；值行本身可 upsert，审计行记「谁在何时写了
  哪些键」）、
  `automations.rule_created`/`automations.rule_updated`/`automations.rule_deleted`
  （自动化规则 #224；target = 规则行 id，detail 记 `name` 与 spec 摘要
  （trigger/conditions/actions），spec 变更再记 `version`/`from`/`to`——规则的
  生命周期是纯配置面，每次变更一条审计；规则的**执行**不进审计词表，进
  automation_runs（执行日志表，一次一行，与审计同附录性：run 行不删除）），
  状态变更类动作在 detail 里带 `from`/`to`（如
  `{ from: "new", to: "contacted" }`），日志页详情列原样展示。
- detail 放变更细节（授予/撤销了什么、从哪到哪、审批裁决等），不放大对象全文
  ——要内容找 target 对应的记录，日志只记变化。
- from/to 的第一个真实生产者是任务状态流转（`task.status_changed`，#113 切片
  1）；「前后值」的下一个业务域（#227 线索）按同一约定进 detail，不改表。

## 第二个读者：按对象的活动流投影（#110 切片 3）

审计表的第二个读者是**协作面向**的活动流：`GET /api/activity`（#232 §11
「评论、@、关注与附件」；老系统对应物 `crm.activities` 手工落活动行——不照
搬）。裁决：**活动流是 audit_events 的按对象读投影，不建第二张活动表**。每
个业务变更本来就在同一事务里落了审计，再立一张表等于每个域把同一事实写两
遍，两条写路径早晚会分叉；审计行的 append-only 正好是活动史需要的语义（发
生过的事不会被改写）。

一条事实流、两个读者，门各归各：

| 读者 | 端点 / 页面 | 门 | 面向 |
| --- | --- | --- | --- |
| 系统审计日志 | `GET /api/audit-events` → `/system/audit` | `audit.read`（owner/admin） | 全公司操作记录，合规面向 |
| 对象活动流 | `GET /api/activity?subjectType=&subjectId=` → 记录详情页时间线 | subject 可见者（subjects/registry.ts，与评论同扇） | 单对象历史，协作面向 |

投影只含该 subject 自己的行——看得到对象就看得到对象的历史，不构成越权面；
不匹配任何 subject 的行（role.granted 等）不出现在任何活动流里。

**行 → subject 的归属约定**（新域接线时照此落）：一行审计属于 subject
`(T, ID)` 当且仅当

- `target = ID`——动作直接落在该对象上（词表的 object 段 = subject 类型，
  如 `task.*` 的 target 是任务 id）；或
- `detail.subjectType = T` 且 `detail.subjectId = ID`——多态子对象挂在
  subject 上（第一个是评论：`comment.created/updated/deleted` 的 target 是
  评论 id，subject 引用在 detail）。

将来新域的活动行默认自动进该对象的时间线；若某个动作**不该**出现在协作
时间线（例如只对合规有意义的内部标记），在本文件登记并让该行不带 subject
引用（target 指别的凭据、detail 不带 subject 键），投影端不做动作黑名单
——黑名单会让「新域忘了登记」从「多显示一行」劣化成「漏显示该显示的」。

## 测试清库的唯一通道

行级 DELETE 被触发器拒绝后，测试清库只剩 **TRUNCATE**（DDL，不触发行触发器）。
纪律：

- 生产代码没有任何对 `audit_events` 的 TRUNCATE / DELETE / UPDATE 路径；
- 并行的集成测试文件**共享同一个库时不得 TRUNCATE 共享表**（会抹掉别的文件
  正在断言的行）——需要空表的测试文件自开临时库（`routes/audit-events.test.ts`
  是样板），不需要空表的用带唯一前缀的行、不清理（`packages/db/src/index.test.ts`）。

## 剩余（#29 后续切片）

- 业务域接线：每个域的真实变更调 `recordAudit`（第一个是 #227 线索状态变更，
  detail 带 from/to）——验收「修改线索状态、删除记录后日志页可见」随之可验。
- 删除记录 + 快照 + 恢复：软删除基础设施随第一个有真实删除的业务域落地
  （快照进 deleted-records,恢复走 API,全记审计）。
- 状态变更日志投影（老 `crm.status_change_log` 的对应物）：状态变更行多了以后
  的跨记录读法,随 CRM 域评估是视图还是查询端点。
- 按表触发的兜底审计:随 Part 11 监管表(#203/#204)逐表评估,评估记录回本文件。
