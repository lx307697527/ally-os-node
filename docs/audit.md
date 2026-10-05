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
  人工写路径」；那是逐表的决定，随表落地，不预置机制。
- **失败语义**：审计写入失败原样抛出，业务操作随之失败——宁可操作失败回滚，
  不做「记不上就算了」的静默降级（审计丢失比业务失败严重）。

## 词表与 detail 约定

- action 是开集，格式 `domain.object.verb`：`role.granted`、`role.revoked`；
  状态变更类动作在 detail 里带 `from`/`to`（如
  `{ from: "new", to: "contacted" }`），日志页详情列原样展示。
- detail 放变更细节（授予/撤销了什么、从哪到哪、审批裁决等），不放大对象全文
  ——要内容找 target 对应的记录，日志只记变化。
- 验收标准里「前后值」的完整形态随第一个真实状态变更域（#227 线索）落地，
  届时按本约定进 detail，不改表。

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
