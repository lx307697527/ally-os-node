# 自动化规则引擎（#224）

老系统把业务连锁反应写在**数据库触发器**里（#134 清单的 38 个）和约 30 个
pg_cron + pg_net 定时任务里（#32）：逻辑分散在 887 个迁移文件与线上
`cron.job`，看不见、难测试、改一条要发迁移。新设计（#232 §4.4「自动化规则」行、
§4.9 v2.2 实现选型）统一成 **「触发 → 条件 → 动作」的可配置规则**：规则是数据
不是代码，动作由后台作业（pg-boss）执行，每次执行留日志——参考 Odoo 的自动化
规则模型（触发 → 过滤条件 → 动作），刻意不引入 n8n（把核心业务连锁反应放进
可视化编排，会重演老触发器「看不见、难测试」的问题）。

## 已落地：自动化内核（#224 切片 1，事件触发 + 两个内核动作）

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 形状与纯引擎 | `packages/automations/src/index.ts` | 规则 spec 的 zod（trigger / conditions / actions，**API 保存时校验与 worker 运行时解析共用同一份**，两端不长两套形状）+ 纯求值：`eventMatchesTrigger`、`resolvePath`（点路径只穿普通对象，原型链键到不了）、`evaluateConditions`（AND，全过才放行）。包零依赖（只有 zod），api 与 worker 各自引入 |
| 数据模型 | `packages/db/src/schema.ts`（migration `0017`） | `automation_rules`（trigger/conditions/actions 三段 jsonb + enabled + version 预埋 #226 + createdById）、`automation_runs`（一次执行一行：status `pending`/`skipped`/`succeeded`/`failed`、逐条件结果、逐动作结果、error；(rule_id, source_event_id) 唯一约束是扫描窗口重叠的防重发闸；**规则删除后 run 仍在**——rule_id SET NULL + rule_name 快照，执行日志是观测面不随配置消失） |
| 路由 | `apps/api/src/routes/automations.ts` | 规则 CRUD + 执行日志读面（`GET /api/automations/runs`，最新在前，可按 ruleId/status 过滤），全部在 `automations.configure` 权限点后。spec 整体替换不局部合并；spec 变更版本 +1 并留审计（#226 进场前的最小纪律），改名/停用不动版本 |
| 权限点 | `authz/permissions.ts` | `automations.configure`（owner/admin 默认）：新增一条规则 = 改全公司的连锁反应，属配置工作室；runs 的查看也在此点后（运行记录含收件人名单与业务事件细节，不另开读口） |
| 扫描器 | `apps/worker/src/automations/scanner.ts` | `automation-scan` 任务（每分钟）：90 秒审计事件尾窗 × 启用规则 → 触发命中（审计 action 精确匹配）→ 条件求值 → 插 run 行（条件不过 = `skipped`，不发执行任务）；重叠窗口的重复命中靠唯一约束吸收。兼任滞留清障：pending 超 2 分钟重发执行任务（singletonKey 去重挡在途重复）、超 90 分钟终判 `failed`（执行任务 4 次尝试的最坏总时长 ≈ 66 分钟之外留余量） |
| 执行器 | `apps/worker/src/automations/runner.ts` + `actions.ts` | `automation-run` 任务：顺序执行动作，**每动作一个事务 + run 行 SELECT … FOR UPDATE**（并发处理器在行锁上排队，动作不双跑）；动作失败不终结 run——进度带外写回后向上抛，pg-boss 重试 3 次（60s 指数退避）每次告警，重试只补失败的那个动作（action_results 是幂等闸：动作行存在 ⟺ 该动作已提交） |
| 审计 | `docs/audit.md` 词表 | `automations.rule_created` / `rule_updated` / `rule_deleted`（配置面生命周期）。规则的**执行**不进审计——进 automation_runs；动作产物进各自域的词表（如 `task.created`，actor 带 `automation:<runId>` 前缀、detail.via = automation） |

## 关键裁决

- **触发统一为「审计事件 action 精确命中」**：新建（`task.created`）、字段变化
  （域事件 detail 带 from/to，条件对 `detail.to` 断言）、进入阶段
  （`workflow.state_changed` + 条件 `detail.to`）在切片 1 是同一种触发；定时与
  相对时间触发（预约前 N 小时）是独立的扫描器形态，随后续切片进场。
- **事件源 = 审计流（#29 audit_events）**：审计流是「一次业务变更一行」的既成
  事实（活动流 #264 是它的第二个读者，自动化是第三个），不为自动化再造事件
  总线。含义：**域逻辑要触发自动化，就必须写审计**——这本来就是 docs/audit.md
  的纪律，不是新增负担。
- **回路防护**：自动化动作产物（actor `automation:<runId>` 前缀）不进匹配——
  「规则触发规则」会在一个窗口内连环爆炸。规则触发规则如确有业务需要，等条件
  积木显式表达，不给隐式通路。
- **执行在 worker、不在 API**：动作由 pg-boss 执行（重试、告警、观测与现有
  runner.ts 同一套），API 只开配置与读面。动作实现随 worker 进场（建任务、发
  通知是内核动作；邮件/短信/webhook/AI 步骤随所属域切片注册新的动作类型——
  spec 是 discriminated union，扩展不改表）。
- **扫描尾窗 90 秒，不追停摆缺口**：服务停摆超过窗长的事件本切片不补（游标
  硬化留待切换期随首批真实域任务一起评估——现在没有生产规则，追平机制是空转
  的复杂度）。
- **动作配置保存时收口**：与 workflow 积木「只校验名字」不同，自动化动作的
  config 是内核定义的（不是属主域注入的），zod 在 CRUD 时就拒绝坏形状——
  「不改代码新增规则」的入口不能带病入库；worker 运行时再 parse 一次是防呆
  （手工改库、未来导入），坏了终判 `failed`（error = rule spec is invalid）。

## 验收对照（#224）

- [ ] #134 中需要移到应用层的逻辑都用规则实现，并有测试 —— **后续切片**（逐域
      迁移；触发/条件/动作的形状已备好，相对时间触发待进场）
- [x] 每条规则的执行记录可在后台查看（runs 读面 + automation_runs 全量留痕），
      失败会重试（pg-boss 3 次指数退避）并告警（每次失败尝试都进 runner.ts 的
      告警通道；重试耗尽由扫描器终判 failed）
- [x] 不改代码即可新增一条「进入阶段 → 建任务 + 发通知」的规则并生效（API 建
      规则 → `workflow.state_changed` + 条件 `detail.to` → 扫描命中 → 建任务 +
      双通知，worker 测试端到端覆盖）

## 剩余项（#224 保持 open）

1. 定时与相对时间触发（预约前 N 小时）——扫描器加「日期字段 × 偏移」形态
2. 动作类型扩展：发邮件/事务短信（随 #116 统一通道）、改字段、报名序列、
   AI 步骤、webhook
3. 条件积木复用 workflow 的注册表形态（跨对象条件、自定义字段条件——
   custom_field_values 按字段键查询已备好）
4. 规则效果度量（触发/例外/越过计数，§4.8 周报）与 #233 规则注册表的接驳
5. #226 配置版本化与发布（版本列已预埋）；规则配置 UI（配置工作室）
