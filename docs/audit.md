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
  `task.deleted`（软删 #29 切片 2；target = 任务行 id，detail 记 `title`——删除
  同事务落台账快照，见「删除记录」一节；删除不投递通知，理由见同节）、
  `task.restored`（恢复 #29 切片 2；target = 任务行 id，detail 记 `title`/
  `ledgerId` 与可选 `reason`——target 即 subject 引用，恢复后记录的活动流
  能看到 deleted → restored 的完整圈）、
  `comment.created`（detail 记 `subjectType`/`subjectId`/`mentioned`）、
  `comment.updated`（#110 切片 5；detail 记 `subjectType`/`subjectId`/
  `fields: ["body"]`；正文未变的幂等提交不落此行）、
  `comment.deleted`（detail 记 `subjectType`/`subjectId`）、
  `comment.attachment_added`/`comment.attachment_removed`（评论附件 #110；
  target = 评论行 id，detail 记 `subjectType`/`subjectId`/`attachmentId`/
  `fileName`（added 另记 `sizeBytes`）——附件挂在评论行上，动作落在评论上，
  活动流投影经 detail 的 subject 引用自动收录）、
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
  `approval.config_updated`（审批线就地改写/停用 #221；target = 配置行 id，
  detail 记 `subjectType`/`configKey`/`changes`（顶层字段 from/to）——无实效
  变更的幂等 PATCH 不落此行，#226 台账同记一版 source=updated）、
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
  与恢复 #222；target = 定义行 id——纯 active 翻转沿用这两个词，每次翻转同时
  记台账新版本）、
  `custom_fields.field_updated`（字段定义就地改写 #222/#226；target = 定义行
  id，detail 记 `subjectType`/`fieldKey`/`changes`（逐字段 from/to）——真变更
  才动行，无实效变更的 PATCH 幂等返回不留审计；内容与 active 同时改落一条
  `field_updated`，不拆两行）、
  `custom_fields.values_updated`（字段值提交 #222；target = subject id，
  detail 记 `subjectType`/`subjectId`/`title`/`fieldKeys`——subject 引用在
  detail，进对象的活动流时间线；值行本身可 upsert，审计行记「谁在何时写了
  哪些键」；提交含显式 null 清值（= 删值行）时 detail 另记
  `clearedFieldKeys`，「这值为什么没了」沿审计流可查）、
  `automations.rule_created`/`automations.rule_updated`/`automations.rule_deleted`
  （自动化规则 #224；target = 规则行 id，detail 记 `name` 与 spec 摘要
  （trigger/conditions/actions），spec 变更再记 `version`/`from`/`to`——规则的
  生命周期是纯配置面，每次变更一条审计；规则的**执行**不进审计词表，进
  automation_runs（执行日志表，一次一行，与审计同附录性：run 行不删除）），
  `invoice.created`/`invoice.updated`/`invoice.confirmed`/`invoice.voided`
  （发票内核 #192；target = 发票行 id，detail 恒记 `number`（单据号是人查票
  的第一把钥匙）与 `totalCents`；created 另记 `invoiceType` 与 subject/source
  引用（subject 引用在 detail，进对象的活动流时间线）、`lineCount`；updated
  记 `fields: ["lines"]`（草稿换行整体替换，无实效变更的幂等 PATCH 不落此行）；
  confirmed 记财务确认时刻的金额（R-12-6「谁确认发出了多少」的查询面）；voided
  另记可选 `reason`——作废只对草稿，已发出的票走后续的红冲动词）、
  `payment.recorded`/`payment.voided`
  （收款台账 #192 切片 2；target = 收款行 id，detail 恒记 `invoiceId`/
  `invoiceNumber`（钱挂在哪张票上）、`amountCents`/`method` 与记账/作废后该票
  的 `paymentStatus`/`paidCents`（实时付款态——**门槛跨越的事实在此**：
  「尾款到账→该批可发货」（R-12-4）等收款触发业务的消费域沿这条审计行接线）；
  recorded 另记 webhook 幂等键 `sourceType`/`sourceKey`（有则记）；voided 另记
  必填 `reason`（误录更正要说清为什么）——退款不在此词表，是 #240 的独立流程）、
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

## 删除记录：软删 + 台账快照 + 恢复（#29 切片 2）

issue 迁移要点「删除操作统一改为软删除 + 快照」与验收第 2 条「已删除的记录
可以查看和恢复」的落点。老-老系统用触发器逐表抄行（176 个，新设计已抛弃），
上一代老系统的 FEAT-527 商机软删明确把恢复划出边界（「本单边界：不做恢复」）
——本切片把两半都补齐，形态是：

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 软删列 | `tasks.deleted_at/deleted_by`（0030，expand-only） | 删除动词置列，**一切读面统一 `is null` 过滤**——行属也看不到已删行；恢复 = 清列 |
| 台账 | `deleted_records`（同 migration） | 一行 = 一次删除的事实：谁删的、何时、删除时刻的全行快照（JSON 投影）。恢复不删台账行——原地补 `restored_*`，删除史是记录史的一部分（与审计同一纪律：发生过的事不改写） |
| 写入口 | `apps/api/src/records/deleted-records.ts` `recordDeletion()` | 删除动词的业务事务显式调用，与 `recordAudit` 同一写纪律——失败则业务失败，不做静默降级 |
| 恢复器注册表 | 同文件 + `records/task-restorer.ts` | 「怎么救一行」只有属主域知道（task = 清软删列，原子 UPDATE … WHERE deleted_at IS NOT NULL 收口并发）。未注册类型存得进、恢复必拒 409 `restore_unsupported`（fail closed，与 due 锚点/可写字段同一裁法）；属主域在新切片里照此注册 |
| 端点 | `apps/api/src/routes/deleted-records.ts` | `GET /api/deleted-records`（列表 + 快照原样）与 `POST /api/deleted-records/:id/restore`，都在 `audit.read` 权限点后。恢复在台账行锁内进行：已恢复/未注册/行已不在各答各的 409（`restored_already`/`restore_unsupported`/`subject_missing`），恢复成功落属主域词表的审计（如 `task.restored`） |
| 页面 | `apps/web/src/shared/pages/DeletedRecords.tsx` → `/system/deleted-records` | System 区第二页：删除时刻/类型/标题/删除人/状态 + 快照展开 + Restore。恢复冲突逐词翻译，四种读状态不撒谎（与审计页同一纪律） |

**首个消费域是 task**（创建人动词 `DELETE /api/tasks/:id`）：任务是本仓库第一
个有真实删除需求的记录域（评论是对话性内容、作者硬删是既定裁决，不翻案）。

裁决三条：

- **动词属创建人**（403 `delete_creator_only`）。经办人是受托执行——改内容/
  状态、取消是经办人的逃生门；删除是行属对记录本身的处置。签名锁定与 PATCH
  同门（#219）：签过名的记录一律拒改，删除是最彻底的改。
- **删除不投递通知。**删除把可见性门关上（subjects/registry.ts 的 task 加载器
  对软删行返回 null，评论/活动流/关注/自定义字段同一扇门一起关闭），投递只能
  深链到 404 的详情页——给收件人一条点不开的通知比不通知更糟。误删的即时面
  是 web 撤销窗（#129 的 undo-window 机制在此第一次接上业务面：行先出列表，
  撤销窗到期才发 DELETE，撤销免费），事后面是本恢复台。
- **门在 `audit.read`。**恢复是「把全公司可见性已关闭的行重新打开」的合规面
  动词，查看与恢复同门（owner/admin 默认持有）；不随第一个消费域给行属开
  Trash 入口——那是真实需求出现时属主域自己的面，门自己配。

worker 侧同一纪律：due 扫描、规则待填提醒对账、update_field 行锁读对软删行
一律按不存在处理（删掉的任务不再触发自动化、提醒可重建、改已删行 fail loud）。

## 剩余（#29 后续切片）

- 业务域接线：每个域的真实变更调 `recordAudit`（第一个是 #227 线索状态变更，
  detail 带 from/to）——验收「修改线索状态、删除记录后日志页可见」随之可验。
- ~~删除记录 + 快照 + 恢复~~：已随切片 2 落地（首个消费域 task，见下一节）；
  新业务域要删除动词时照同一形态接入（软删列 + recordDeletion + 恢复器注册）。
- 状态变更日志投影（老 `crm.status_change_log` 的对应物）：状态变更行多了以后
  的跨记录读法,随 CRM 域评估是视图还是查询端点。
- 按表触发的兜底审计:随 Part 11 监管表(#203/#204)逐表评估,评估记录回本文件。
