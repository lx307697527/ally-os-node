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

## 刻意不在这切片里的（#233 保持 open）

- **决策表值类型**（GoRules ZEN，§4.9）：随首个消费域进场（#221 审批路线 /
  #223 费率分档），valueType 届时加 `decision_table`。
- **gate 类别的种子与条件积木**：category 枚举已留 `gate`，门槛条件随 #220 的
  条件积木消费域进场；首个流程门槛落地时把 §4.3 的默认条件登记进来。
- **定时生效的 cron 接线**：`applyDueRuleChanges` 内核已测，worker 侧 JobDefinition
  随第一个消费域一起接（同 workflow due scan 的裁法——内核先行，交付归 worker）。
- **待填规则的待办提醒**：需任务/报表消费域（#261/#225）。
- **规则效果周报**（§4.8 每周汇总）：#225 报表域。
- **改治理本身**（changeableBy/enableBy/riskFlag 的编辑）与规则的新增/退役面：
  治理变更 = 改裁决，随 #226 受监管变更控制（#206）一起裁。
- **前端配置工作室 UI**。
