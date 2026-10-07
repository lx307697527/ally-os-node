# 规则注册表（#233）

> 老系统对照：业务规则散落在 edge function 常量与 `quote_default_values` 这类表里
> （#232 §4.4），改一条裁决要改代码上线。新系统按 #232 §4「裁决即配置」自建注册
> 表：每条业务规则一行，改规则 = 填依据的一次数据变更，不改代码不上线。

## 已落地：规则注册表内核（#233 切片 1，API only）

| Part | 位置 | 说明 |
| --- | --- | --- |
| 数据模型 | `packages/db/src/schema.ts`（0021 迁移） | `registry_rules`：key（稳定 slug，消费方按字面量引用）、label、category（param/switch/gate）、valueType（number/text/boolean/string_list/number_list/json）、value（null = 「待填」）、changeableBy/enableBy（谁能改）、adjudicationRefs（裁决依据）、riskFlag/riskNote（⚠）、三个运行数据计数、scheduled*（待生效变更）、version（= #226 台账最新版） |
| 首批规则种子 | 0021 迁移（0019 补账先例） | #232 §4.2 表全部条目 + §4.6 五个可插拔模块开关 + §4.8 五个风险开关，共 57 条；默认值全部来自裁决或业主决定；未定数字 value = NULL「待填」；每条规则补 source='created' 的 v1 台账行。刻意跳过两行：标准工时与费率（R-13-4，每道工序的运营数据属生产域）、打样费逐单填（逐单商务条款；系统级含轮数已落 `pricing.sample_included_rounds`） |
| 内核 | `apps/api/src/rules/service.ts` | `getRule`（消费方带 zod 收口期望形状，键不存在/值未设/形状不符全抛错，绝不猜默认值）、`isRuleEnabled`、`changeRuleValue`（立即/定时）、`applyDueRuleChanges`（到点前滚）、`recordRuleOutcome`（触发/例外/越过计数）、`requestGateException`（业务门槛例外唯一通道） |
| HTTP 面 | `apps/api/src/routes/rules.ts` | GET `/api/rules`、GET `/api/rules/:key`（登录即可——全公司共用的业务参数，非敏感数据）、PATCH `/api/rules/:key`（改权逐规则裁决，路由内） |
| 配置版本 | `config-versions/families.ts` 第六族 `registry_rule` | 史/差异/回滚走 #226 台账；`applyRevision` 落列并**清空待生效变更**；`authorizeWrite` 把「谁能改」强制到回滚/草稿/发布写面（`ConfigSubjectSpec` 的新钩子，#233 引入） |
| 权限点 | `authz/permissions.ts` | `rules.configure`（owner/admin）——只管配置工作室面（读史/回滚/台账）；规则的**改值**不在这扇门后 |
| 待填待办提醒 | `apps/worker/src/rules/`（0022 迁移） | #233 切片 2：每日 `rules-pending-reminder` 对账扫描——待填规则在「谁能改」持有者的待办里保有一条 open 提醒（多态附着 `tasks.subject_type='registry_rule'`，任务内核附着列的首个生产者），值填上自动销账，详见下文专节 |

## 核心语义

- **依据必填**：每次改值必须带 `rationale.refs`（裁决编号如 `R-06-4`，或业主决定
  标记如 `OWNER-DECISION-2026-09-30`），可附 note。当前依据存行上，全量史在台账
  （每版快照含当时的 adjudicationRefs）与审计。
- **谁能改**（§4.2）：按行的 `changeableBy` 角色数组，**owner 恒可**（R-16-5 owner
  直通同源，不入列）；开关的启用（关→开）另过 `enableBy`（R-01-6/8/12「启用需
  老板确认」——销售主管可改参数、可关掉，打开要老板）。同一裁决在 PATCH 与
  回滚/草稿/发布两个写面各自强制（族权限点 `rules.configure` 之后的第二扇门）。
  这是配置工作室唯一「族权限点 ≠ 改权」的族：销售主管能改首联时限，但回滚要过
  `rules.configure`（配置工作室维护操作），admin 回滚销售主管治理的规则会被逐
  主体门挡下（owner 可）。
- **生效时间**（§4.2）：缺省立即生效（台账记一版 source='updated'）；给未来的
  `effectiveAt` = 定时变更（落行上 scheduled* 字段 + `rules.change_scheduled`
  审计，**不记台账**——台账记录「生效了什么」，调度意图由审计与行上字段承载）。
  到点由 `applyDueRuleChanges(db, { now })` 前滚：行更新 + 台账记一版
  source='scheduled' + `rules.scheduled_change_applied` 审计（actor = 调度者）。
  cron 接线属 worker 域（见「刻意不在本切片」）。
- **幂等**：同值立即变更 → `changed: false`，不记账不审计；同一份待生效变更重复
  提交同样幂等。立即变更不碰已有待生效变更（先定下月改 8%、今天急改 9% 是两个
  都成立的意图）。
- **开关开着/关着**（§4.3）：内核只提供 `isRuleEnabled`（严格 true = 开）。关着时
  相关数据照样记录是**消费方的纪律**——内核不提供「关 = 停止记录」的语义。
- **运行数据**（§4.8）：`recordRuleOutcome(db, key, "triggered" | "exception" |
  "override")` 原子累加，未知键抛错。消费域（门槛/自动化/流程）各自调用；每周
  汇总给老板与销售主管属报表域（#225）。
- **业务门槛例外**（§4.7）：`requestGateException` 是唯一合法通道——`kind:
  "quality"` 无条件拒绝（质量放行只按 R-15-4，owner 也不例外，**硬底线不是开关**，
  接口测试钉住）；`kind: "business"` 要求例外开关（`gates.business_exception_enabled`，
  默认关）已打开 + 仅 owner + 非空原因；每次越过写 `rules.gate_exception` 审计并
  把该开关的 override 计数 +1（进周报）。
- **硬底线不进注册表**（§4.5）：营销短信禁发、STOP、一键退订、Part 11 签名、
  质量放行职责分离、数据隔离、计算结构写在代码里，注册表里没有也不允许有对应
  键（测试钉住：这些键 GET 不见、PATCH 404）。

## 记账协议（写入侧纪律）

与 #226 台账协议逐条一致：台账写与行写同事务（先 `nextConfigVersion`，行
version 一并落，再 `recordConfigRevision`）；无实效变更不记账；changes 摘要为
`{ value: {from,to}, adjudicationRefs: {from,to} }`。种子行按 0019 先例补
source='created' 的 v1，使「行.version = 台账最新版」从第一行成立。

## 待填规则的待办提醒（#233 切片 2，worker）

- **对账语义**（`apps/worker/src/rules/reminder.ts`，每日 13:00 UTC 的
  `rules-pending-reminder` 任务）：`value is null` 的规则 → 给「谁能改」角色持有
  者的我的待办里各保有一条 open 提醒任务（多态附着 `tasks.subject_type =
  'registry_rule'`——任务内核附着列的第一个生产者，0022 expand-only 进场）；
  「谁能改」无人持有时回落 owner（owner 恒可改同源），连 owner 都没有 → 告警
  跳过（一条没人看得见的任务是假成功）。
- **销账与重建**：值填上 → 遗留 open 提醒自动关闭（`task.status_changed` 审计，
  from/to 带词表）；经办人提前勾掉而值仍空 → 下一轮再建一条——待办的目的就是
  填值，值没填 = 没完成，提醒是故意的。
- **写入纪律与任务内核（#113）逐条对齐**：任务行 + `task.created` 审计 +
  `task.assigned` 通知同事务，实时「催」提交后发（失败只降级回轮询）；actor 用
  `system:rules-registry`（非 uuid actor 的先例是 `automation:<runId>`）——系统
  行为不署名给任何用户。任务/通知文案英文（RULE-010）。

## 决策表值类型（#233 × #221，审批路线首个消费域）

- **形状**（`apps/api/src/rules/decision-table-schema.ts`）：值 = 一张 GoRules ZEN
  v2 决策表（引擎 `@gorules/zen-engine` 锁主版本 ^2，§4.9 选型）——`hitPolicy`
  （first/collect）+ 列定义（`inputs`/`outputs`，各带 `id`/`field`）+ `rules`
  （每行是「列 id → 单元格表达式」的 map，`_id` 行标识必填）。输入单元格是 unary
  测试（`== 'grant'`、`> 100`，空串 = 恒真），输出单元格是标准表达式（字符串
  字面量带引号）。空 `rules` 合法 = 什么都不命中（路由语义：临时全部 fail closed）。
- **写面两道门**：zod 形状（`changeRuleValue` 的 valueType 收口，形状错
  `invalid_value` 400）+ **编译探针**（`assertDecisionTableCompiles`——ZEN 引擎对
  解析不了的单元格是**静默不命中**，一张带错字的表不报错、只是永远走不到那一行；
  探针逐单元格跑 unary/标准表达式编译，只拒 parserError，类型不匹配留给运行期）。
  立即与定时变更过同一扇门。回滚走 #226 台账（快照 value 透传，回滚后的表原样生效）。
- **求值**（`evaluateDecisionTableRule`）：注册表值 → 单节点 JDM 图（input →
  decisionTableNode → output）→ 输出 map（按输出列 field 键）。无命中 = 空对象
  （不是错误——路由语义由消费域裁决）；键不存在/值未设/形状不符 = 注册表内核三错，
  引擎失败包 `DecisionTableEvaluationError`——**坏表 fail loud，绝不伪装成无命中**。
- **首个消费域 = 审批路线**（#221 v2.2）：种子规则 `approval.routing.user_role`
  （gate 类别，0023），路由表 `{action} → configKey`，种子语义与 #221 切片 2 的
  硬编码行为逐条等价（grant/revoke → `role_grant` 线）。属主域调
  `resolveApprovalRoute(db, subjectType, facts)`（`apps/api/src/approval/routing.ts`）
  拿「进哪条线」；unmatched 六因（表缺失/未设/坏表/求值失败/无命中/输出不是
  configKey 单值）由调用方 fail closed。输出列 field 必须叫 `configKey`。

## 刻意不在这切片里的（#233 保持 open）

- ~~**决策表值类型**（GoRules ZEN，§4.9）~~：已随首个消费域 #221 审批路线进场
  （0023，见上节）；后续消费域（#223 费率分档等）按同一形态各落自己的路由/分档表。
- **gate 类别的种子与条件积木**：category 枚举已留 `gate`，门槛条件随 #220 的
  条件积木消费域进场；首个流程门槛落地时把 §4.3 的默认条件登记进来。
- **定时生效的 cron 接线**：`applyDueRuleChanges` 内核已测；worker 侧 JobDefinition
  随第一个消费域一起接（同 workflow due scan 的裁法——内核先行，交付归 worker）。
  结构性前提：内核现居 apps/api，worker 不跨 app 依赖——接线那天内核随消费域
  一起下沉共享包（automations 内核居 packages/automations 同一先例）。
- **规则效果周报**（§4.8 每周汇总）：#225 报表域。
- **改治理本身**（changeableBy/enableBy/riskFlag 的编辑）与规则的新增/退役面：
  治理变更 = 改裁决，随 #226 受监管变更控制（#206）一起裁。
- ~~**前端配置工作室 UI**~~：见下节。

## 配置工作室 UI（`/system/rules`，#233 前端切片）

规则面进配置工作室（System 区 rail「Rules registry」），与 numbering/workflows
同款页面纪律：数据层适配器把每个失败模式报告成话（`rules-client.ts`），页面每个
状态自己开口（加载/不可达/空表/史被拒），服务端永远是唯一权威。

- **读面全公司可见，写面逐规则裁决**：列表/详情登录即可（业务参数不是敏感数据，
  与 API 读面同裁）；「Change value」面板把 403 的 `roles` 与 400 的 `issues`
  原样说话——决策表的逐格编译错误直接给到编辑者，不翻译成一句「无权/无效」。
- **改值表单按值类型出题**：number/text/boolean（开关 on/off，带 enableBy 确认
  提示）/两种 list（一行一项）/json/decision_table（JSON 文本 + 实时只读表格
  预览，预览≠保存权威——四道 zod+编译探针门都在服务端）。依据 refs 逐行至少
  一条，客户端缺依据/坏值不发请求；可选未来时刻 = 定时生效（面板显示待生效
  变更与依据，明说 worker 到点前滚、此前现值照活）。switch 无「清回待填」路
  （内核对 switch 拒 null）。
- **台账史与一键回滚**（#226 `registry_rule` 族）：每版带 source/changedBy/
  逐字段 from→to 摘要；回滚 = 恢复版记为新版、历史不改写、可带原因，回滚同时
  清掉待生效变更（families.ts 既有语义）。无 rules.configure 的账号在页面里
  得到「史与回滚需要配置工作室权限」的明确答复，表照用。
- **刻意没有**：「新建」（硬底线在代码里，规则随裁决进场）与「草稿/发布」
  （registry_rule 族对草稿答 409 publish_unsupported）。

