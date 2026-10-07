---
session_id: hand-written-233-due-activation
branch: feat/233-due-activation-cron
date: 2026-10-08
reason: issue-233
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/233-due-activation-cron — 2026-10-08

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#233(规则注册表,phase-1)——剩余项「定时生效的 cron 接线」。
  PR 正文写 **Part of #233**(JDM 拖拽编辑器、gate 种子随 #220、治理字段编辑随
  #206 未完,保持 open)。
- **前置收尾(第 0 步)**:无 open PR(#304 已于昨日合并,即 main 顶端 3d808c4)、
  无残留 worktree、主检出干净。
- **选题**:①优先续做有未完成切片的 open issue。盘点:#233 的五条剩余项里
  「applyDueRuleChanges cron 接线」的延后条件(随第一个消费域进场)已被 #280
  (决策表 + #221 审批路由首消费)满足,docs/rules.md 的裁法原文「接线那天内核
  随消费域一起下沉共享包」给出了完整施工图;其余候选(#192/#193 的剩余项)要么
  等门户/订单域、要么是部署面。选 #233 本切片。
- **claim**:`claim_issue.py claim --issue 233` 成功(接替昨日会话的租约)。
- **数据库**:本地 postgres 可用(docker compose 的 ally-os-node-postgres-1),
  verify 全程带 DATABASE_URL,**119 文件 / 1107 测试零 skip**(基线 117/1097:
  +2 文件 +10)。

### 本切片改动的文件

- `packages/rules/`(新包 `@ally/rules`,依赖 @ally/db + drizzle):
  - `src/ledger.ts`:`nextConfigVersion` / `recordConfigRevision` 及其类型
    (ConfigChanges/ConfigRevisionSource/RecordConfigRevisionInput)从
    apps/api/config-versions 原样下沉,记账协议注释随行。
  - `src/due-activation.ts`:`applyDueRuleChanges` + `DueActivation` 从
    apps/api/rules/service.ts 下沉;返回值加富(from/to/rationale/version/
    scheduledById);**提交后审计不再在内核里写**(归属裁决见判断层 1/2)。
  - `src/due-activation.test.ts`(新,6 例,真库):到点前滚全断言(行/台账
    source='scheduled'/富结果)、未到点不动、幂等二扫、无调度依据回落行上
    adjudicationRefs、limit 取最早、连续激活版本号 v2→v3。
- `apps/api/src/config-versions/service.ts`:删除下沉的两个原语,改为从
  `@ally/rules` 引入并**再导出**——7 个 api 引用方(routes×5、drafts、本模块
  rollbackConfig)零改动。
- `apps/api/src/rules/service.ts`:删下沉段(约 120 行),改从 `@ally/rules`
  引入原语;docblock 指向前滚内核新居。
- `apps/api/src/routes/rules.test.ts`:applyDueRuleChanges 改从 `@ally/rules`
  引;定时生效用例里 `rules.scheduled_change_applied` 审计断言移出(改由 worker
  job 测试钉,api 侧保留行/台账/版本断言)。
- `apps/api/package.json` / `apps/worker/package.json`:+ `@ally/rules`。
- `apps/worker/src/rules/due-activation.ts`(新):`rules-due-activation` job
  (每分钟,`* * * * *`,retryLimit 1/expire 300s)——内核前滚 + 提交后逐条落
  `rules.scheduled_change_applied` 审计(actor = 调度者,schema 直插与 reminder.ts
  同纪律);安静分钟不进日志。
- `apps/worker/src/rules/index.ts`:登记第三个 rules job;删除「刻意不登记」的
  过时注释。
- `apps/worker/src/rules/due-activation.test.ts`(新,4 例,真库):到点 → 审计行
  (actor=调度者、detail from/to/version)、未到点无审计、二扫不重复、job 注册
  (cron 断言)。
- `docs/rules.md`:内核表拆「改值面/到点前滚」两行;生效时间语义改指 worker 任务;
  「刻意不在本切片」该项划掉;新增「定时生效接线」专节(下沉、职责切分、已知
  窗口、节流与兜底)。

## 判断层(手写)

### 关键判断

1. **审计写入器不随内核下沉——`recordAudit` 仍在 apps/api,提交后审计移到
   worker job,内核改返回富结果**。三个候选里选了这个:(a) 把 recordAudit 搬进
   packages/rules 再由 api re-export——被否:审计写入器是平台设施,住进 rules 包
   意味着将来任何 worker 域要写审计都得 `import { recordAudit } from "@ally/rules"`,
   黏聚错误还会引发第二次搬家;(b) 搬进 @ally/db——被否:db 包刻意保持
   client+schema+ migrations 的形状(14 行 index),塞业务写手改包格;(c) 内核
   返回富结果、job 落审计——选它:包收「域事务内核」,投递层收「投递 Concern」,
   与 automations「包收形状、worker 收交付」的分工同构。代价是内核返回值变胖
   (DueActivation 从 3 字段到 8 字段),换来 job 不复算任何字段——审计的
   detail 与台账同源,不会长出第二套事实。

2. **审计归属移动不引入新窗口**。内核自带的「审计在提交后写」本来就在事务外:
   commit 后、审计行前进程死,旧设计里该条审计同样丢失(cron 重试时变更已不再
   到期)。新设计窗口相同,且第一失败面更诚实:job 落审计失败 → handler 抛 →
   pg-boss 重试 → 二扫空转 → 台账(source='scheduled' + changedById)仍是完整
   事实,「谁定的」永远可答。job 测试钉住「前滚了 ⇒ 审计行在,actor=调度者」,
   docs/rules.md 把这个窗口明写进专节而不是装不存在。

3. **台账原语下沉、api 侧再导出(而非 7 处直改 import)**。原语是纯 SQL 面,
   域语义(草稿/回滚/差异)仍居 api;api 内部继续从 config-versions/service 引入,
   依赖图保持单一入口,回滚面与记账面的关联在同一模块可见。worker/包侧直连
   `@ally/rules`——跨包消费方没有理由绕道 api 模块。

4. **fixture 必须带 v1 台账行(测试初跑红的根因)**。直插的 registry_rules 行
   version 默认 1 但台账无行,`nextConfigVersion` 从空史起算返回 1,激活落 v1
   与行初值撞版——「行.version = 台账最新版」是生产不变式(0021 种子补账先例:
   每条种子规则补 source='created' 的 v1),fixture 不补就是测了一个不存在的
   世界。修法:fixture 经被测的 recordConfigRevision 补 v1(顺带 dogfood),断言
   从 v2 起算;台账行数断言相应排除 v1。

5. **每分钟 + retryLimit 1 + 安静分钟静默**。定时的治理变更按调度时刻生效,
   分钟粒度足够(调度面最小单位是「某一天」);扫描是几十行小表上的顺序扫,
   不建索引(reminder 的 value IS NULL 扫描同一取舍,表长大再裁——写进注释与
   docs,不留「忘了建索引」的悬案)。重试收敛到 1 次:下一分钟扫描是天然兜底,
   多侧重试只会放大重复扫描(automations 扫描同裁);applied=0 不打日志,否则
   每分钟一行的噪声把真信号埋掉。

6. **选题裁法**:「随第一个消费域进场」的延后条件要验证而非照抄——#280 已把
   决策表消费域(#221 审批路由)落了地,本切片的施工图(docs/rules.md 那句
   「接线那天内核随消费域一起下沉共享包」)是上一会话留好的交接,接住即可,
   不需要新的架构裁决。

### 踩坑

- fixture 无 v1 台账(判断层 4):第一次跑 10 例红 3,报的是 version 断言
  (1≠2)与台账行数——表象是「内核少记了一版」,实际是 fixture 破坏不变式。
  教训:迁移测试时,seed 补账类的隐性不变式(0021 注释里有)要跟着测试走。
- 两处 `noUnusedLocals`(Logger/Db import)在 typecheck 才暴露——本仓 strict
  面包括未用导入,手写文件时 imports 收着点。

## 验收对照(本切片范围)

- [x] 定时变更到点自动生效(worker job 每分钟前滚;集成测试真库钉住)
- [x] 前滚 = 行更新 + 台账 source='scheduled' 同事务(内核测试,行锁/limit/幂等)
- [x] `rules.scheduled_change_applied` 审计以调度者为 actor(job 测试钉住)
- [x] 内核下沉共享包,worker 不跨 app 依赖(automations 先例兑现)
- [x] 错过扫描不丢变更(下一轮补前滚,at-least-once)
- [ ] JDM 拖拽编辑器、gate 种子随 #220、治理字段编辑随 #206 → #233 保持 open
