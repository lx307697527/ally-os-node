# 配置版本、审计与发布（#226）

> #232 §4.4「所有配置本身有版本、有审计，可以回滚；先在测试环境试，再一键发布
> 到生产」与 §4.9「配置版本与发布（自建）：状态机、决策表、表单 schema 都是
> JSON，统一纳入同一套版本、审计、回滚」。切片 1 落地统一的版本台账内核；切片
> 2 落地草稿层与一键发布；「受监管配置走变更控制」是后续切片（依赖 #206）。

## 已落地：配置版本台账内核（#226 切片 1，API only）

- **一本台账记五族配置**：`config_revisions` 一行一版——subjectType（配置族，
  开集 text）+ subjectId（多态，无外键，与 custom_field_values 同裁）+ version
  （族内从 1 单调递增）+ snapshot（该版本时刻的用户可编辑内容全量快照）+
  changes（顶层字段 `{field: {from, to}}` 摘要，created 为 null）+ source
  （`created` / `updated` / `rolled_back`）+ changedById。**整表 append-only**
  （0019 触发器，与 audit_events/esign_signatures/workflow_transitions/
  approval_actions 同一裁决）——回滚 = 按历史快照追加一个新版本，改写历史不
  存在合法业务路径。
- **五族全部入账**：workflow_template（#220）、approval_config（#221）、
  custom_field_def（#222）、automation_rule（#224）、numbering_rule（#225）。
  各配置面的每次真实变更（创建/就地改/停用翻转）与配置行写入**同一事务**记一
  版；配置行的 `version` 列 = 台账最新版（不再是恒 1 的预埋）。
- **快照契约在 families.ts**：每族声明「快照长什么样」（zod schema）与「回滚
  怎么落列」（applyRevision）。快照只含用户可编辑内容——id/键/时间戳/审计元
  数据不在内；`numbering` 的 startNumber 刻意不可恢复（对已在发的系列无效果，
  同 PATCH 面的拒绝理由）。快照过不了族 schema = 台账被绕过写入面动过，当场
  炸 500，绝不静默把不可信形状写进配置行。
- **读面与回滚**（`GET/POST /api/config-versions/...`）：版本史列表（不含快照）、
  单版详情（含快照）、任意两版的路径级差异（`diff?from=&to=`，嵌套对象展开为
  点分路径，数组作有序整体）、回滚（`POST .../rollback {toVersion, reason?}`）。
  **权限按族动态裁决** = 各族配置面的同一权限点（族注册时声明，路由内检查）——
  回滚 = 改那族的配置，不能比配置面本身宽松；subjects 列表登录即可（只有族名）。
- **回滚语义**：恢复目标版本内容 + 追加 `rolled_back` 新版本 + 审计
  `config.rolled_back`（带可选 reason）。目标内容与现状一致 → 409
  `rollback_no_change`（回滚是 no-op 时明确拒绝，不记假变更）；目标版本不存在 →
  404；配置行已删（规则删除、模板替换）→ 404 `subject_not_found`（台账行仍在，
  历史是对「存在过的配置」的事实）；快照恢复撞上族的结构不变式（workflow 模板
  历史版带 `isDefault=true` 而默认位已被别的模板接管）→ 409 `rollback_conflict`
  （整个事务已回滚，先摘位再回滚，绝不静默盖掉期间的线上变更）。
- **存量行补账**：0019 迁移把五族已有行按当前 version 入账（source `created`，
  快照与写入面形状同构）。台账前的演进史无法逐版重建（automation_rules 曾靠
  「spec 变更 +1」到过 >1 的版本），以补账时刻现状为一版事实；版本连续性自此
  由「写入侧同事务记账」保证。

## 已落地：草稿层与一键发布（#226 切片 2，API only）

- **「测试环境」= 配置对象上的草稿层，不是另一套部署**：草稿存独立 overlay 表
  （`config_drafts`，一对象至多一份，再存即整份替换），活配置的读路径（流程
  实例解析、审批线快照、表单合成、worker 扫描、发号）在发布前**看不见**它
  ——「试」不碰生产行为是结构性保证（草稿在另一张表），不靠读侧自觉过滤。
- **保存面与配置面同强度**：`PUT /api/config-drafts/:subjectType/:subjectId`
  的内容必须过该族草稿契约（`draftContentSchema`，registry 接缝）——形状 =
  快照形状（strict，未知键 400），校验强度 = 各族配置面的**业务**校验
  （automation 复用 `ruleSpecSchema`、custom-field 带 select 选项规则、
  numbering 同 PATCH 面）。存进去的必须是「发布后能直接生效」的内容，发布面
  不做比保存面更弱的第二次放行。可选 `note` 记草稿意图，发布时随审计留档。
- **一键发布 = 前滚一个 `published` 新版本**：`POST .../publish` 在一个事务里
  走该族的 `applyRevision` 接缝（与回滚同一条「快照落列」契约，零新机制）——
  更新配置行 + 台账记 v(n+1)（source `published`，带 `{field:{from,to}}`
  摘要）+ 删草稿；提交后审计 `config.published`（带可选 reason 与草稿 note）。
  发布本身就是版本史的一部分：发布过的版本照常可 diff、可回滚，没有特殊通道。
- **无盲发**：保存草稿时记下当时的台账最新版（`base_version`，服务端取值，
  客户端不可指定）；发布时台账最新版与之不符 = 草稿过期（409 `draft_stale`，
  草稿是在旧现状上写的，发布会把期间的线上变更悄悄盖掉）——重存（在新现状
  之上重写草稿）是唯一路径。GET 草稿答 `stale` 标记 + 相对当前生效内容的变更
  摘要（过期时照样现算：「草稿想改什么、现状已经变成什么样」正是重存决策要
  看的画面）。
- **no-op 与竞态都给明确语义**：草稿内容与现状一致 → 409 `publish_no_change`
  （不记假变更）；并发发布/发布与线上 PATCH 同时在飞 → 台账唯一索引兜底撞
  23505 → 事务整体回滚 → 409 `publish_conflict`（fail loud 的竞态给可重试的
  语义，绝不静默盖掉别人的变更；草稿行 FOR UPDATE 锁住，并发保存与并发发布
  在这一行上串行化）。
- **能力随内容改写路径走**：只有注册了 `draftContentSchema` + `applyRevision`
  的族能存草稿（automation_rule / custom_field_def / numbering_rule /
  workflow_template 四族——workflow 的定义改写面随 #220/#226 进场，definition
  的草稿校验与 POST/PATCH 同一道四门）；approval 的就地 PATCH 随 #221 配置
  UI 切片进场但**没有草稿面**（即改即生效，不需要第二层），草稿与发布对它
  答 409 `publish_unsupported`；回滚则随 applyRevision 对它开放。权限 = 各族
  配置面的同一权限点（动态按族裁决，与台账读面共用 config-versions/http.ts）。

## 记账协议（写入侧纪律）

1. 记账与配置行写入同事务——账外变更会让「行.version = 台账最新版」断掉，
   版本号是回滚的寻址方式，缺行比业务失败严重。
2. 先 `nextConfigVersion(tx, subjectType, subjectId)`，再写配置行（version 列
   一并落），再 `recordConfigRevision(...)`。配置行 UPDATE 的行锁把同对象并发
   记账串行化，`unique(subject_type, subject_id, version)` 兜底撞车即炸
   （fail loud，静默重号比失败严重）。
3. 无实效变更不记账不留审计（与 numbering PATCH / comment edit 同一纪律）。
   automation PATCH 由此获得幂等性：翻到现状 = 返回现状版本，什么都不发生。

## 与老系统的对照

老系统没有配置版本机制：流程、审批、表单、编号全部写死在代码或 SQL 里（3686
行硬编码向导 HTML、12 个写死阶段、前端写死的审批邮箱），「改配置」= 改代码发
版，无史可查、无版可回。新设计把可配置性本身作为第一原则（#232 §4.1：两个月
内 12 条旧裁决被推翻），台账让「裁决即配置」可追溯——每条配置变更都有谁、
何时、改了什么、当时的全貌。

## 刻意不在这切片里的（#226 保持 open）

- **受监管配置的变更控制门**（验收第 3 条）：「影响批记录、检验、放行的配置
  发布前需审批 + 电子签名」。变更控制域在 #206（phase-5）；届时配置族注册时
  声明 `regulated: true`，发布端点对受监管族 fail-closed 校验变更控制审批。
  发布端点（切片 2）已进场，门随 #206 进场即插上。
- **核心计算结构不可配**（验收第 4 条）：结构性满足——公式写在代码里并有测试
  （§4.5「计算结构」硬底线），配置面只收参数且全部 strict zod（多打的未知键
  400）；定价规则 #223（phase-2）进场时公式结构同样在代码里，可配的只有费率
  表与分档（GoRules 决策表值类型，#233）。
- ~~**workflow / approval 的定义改写端点**~~：均已进场——workflow 随 #220/#226
  （PATCH + 草稿发布 + 回滚），approval 随 #221 配置 UI 切片（就地 PATCH +
  回滚，无草稿面）。生产六族现都带 applyRevision；没有改写路径的族（夹具、
  未来新族未接前）注册时不带 applyRevision / draftContentSchema，回滚答 409
  `rollback_unsupported`、草稿与发布答 409 `publish_unsupported`。
- **配置工作室 UI**：subjects/史/差异/草稿/发布端点已就绪，前端随配置工作室
  切片进场。
