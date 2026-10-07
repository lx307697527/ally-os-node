---
session_id: hand-written-225-rules-effect-digest
branch: feat/225-rules-effect-digest
date: 2026-10-07
reason: issue-225
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/225-rules-effect-digest — 2026-10-07

> 机械层与判断层均为本次会话手写(ZCode 定时迁移会话,无 transcript 可回放)。

## 机械层(自动)

- **引用的 issue**:#225 报表与模板——本切片落「规则效果周报」(#232 §4.8
  「每周汇总给老板和销售主管」;#233 验收第 8 条「每周自动生成规则效果汇总」
  由此满足)。#233 的历次切片评论两次把这项路由到「#225 报表域」,故租约落在
  #225;#225 本身保持 open(剩 Superset 部署面与模板管理 #128)。
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净;fetch 后
  main 顶端 1a42067(#301 删除记录内核)。
- **选题**:①有未完成切片的 issue 里,#224/#226/#233 的可动项全被既定裁法挡住
  (cron 随消费域、治理字段随 #206、草稿面随真实需求),唯一未阻塞的「效果度量
  周报」归属 #225。第一次抢 #225 输了(另一会话推进租约);按序扫 phase-1 剩余
  (#115/#118/#120/#122/#124/#128/#130/#134/#145~#151)与 phase-2/3/4 全部
  open issue,租约全被并发会话持有;期间抢到 #204(批次放行)但确认其依赖
  #203 批记录域(表尚不存在、issue 被租)后**主动释放**并留协调评论;数分钟后
  重试 #225 成功(前持有者已释放)。
- **claim**:`claim_issue.py claim --issue 225` 成功(refs/heads/claims/issue-225)。
- **数据库**:本地 postgres 16 可用,verify 全程带 DATABASE_URL(零 skip)。

### 本切片改动的文件

- `packages/db/src/schema.ts`:新表 `rules_effect_digest_runs`(enum
  pending/sent;week_start/week_end、counters_at 全量快照 jsonb、entries 冻结
  条目 jsonb、total_rules、recipients 冻结名单、sent_at)+ 类型
  `RuleEffectDigestEntry`。migration 0031 生成并提交(零 Custom SQL,drizzle 直出)。
- `apps/worker/src/rules/effect-digest.ts`(新):`computeDigestEntries`(纯:
  上一份快照 × 本期计数 → delta 条目 + 新快照)、`renderEffectDigest`(纯:英文
  文案,首报/安静周/链接各有措辞,RULE-010)、`runRulesEffectDigestScan`(挂起期
  先重发、否则差分冻结一期 → 逐人发信 → 盖章;失败上抛进重试)。
- `apps/worker/src/rules/index.ts`:`rulesJobs` 增 `rules-effect-digest`
  (cron `0 14 * * 1`,周一 14:00 UTC);`RulesJobsDeps` 增 mailer/webAppUrl。
- `apps/worker/src/index.ts`:引导处给 rulesJobs 传 mailer 与 WEB_APP_URL。
- `apps/worker/src/rules/rules.test.ts`:job 注册测试适配新 deps(断言改按名字
  找,不钉数组长度——本域现有两个任务)。
- `apps/worker/src/rules/effect-digest.test.ts`(新):集成 7 条(首报全量、
  二期纯增量、安静周心跳、发送失败留 pending→冻结重发、收件人冻结、无收件人
  不建行、cron 注册)+ 纯函数 5 条。
- `docs/rules.md`:新增「规则效果周报」专节;「刻意不在本切片」清单划掉周报项。

### 验证

`DATABASE_URL=… corepack pnpm verify` 全绿:114 文件 / 1054 测试(较基线
+5 文件 +53 测试,其中本切片 +12 条,其余来自 main 在本切片期间合并的
#299/#300/#301),零 skip。pre-push 钩子全量重跑同套(未绕过)。

## 判断层(本次的关键判断与踩的坑)

### 关键判断

1. **选题阶段的竞争环境**:全仓 40+ 个 open issue 的租约几乎全被并发会话持有
   (TTL 90 分钟)。处理顺序验证了 playbook 的两条纪律:①抢到 #204 后没有
   「既然占到了就硬做」——读 #204 正文 + schema 确认批记录表不存在、批记录域
   (#203)正被别人租着设计,硬做必然撞车,于是释放并在 issue 留了依赖说明;
   ②第一次抢 #225 失败后按序扫完全部 issue 再回头重试,而不是原地 sleep 等
   租约过期——几分钟后前持有者释放,重抢即中。**占着做不了比没抢到更糟**,
   release 是正确的止损。
2. **增量只能差分,快照落 run 行**:`recordRuleOutcome` 是计数器(UPDATE +1),
   不是事件流——「本周 N 次」从任何现有数据都追不回来。三选一:逐事件明细表
   (把计数器重复造一遍,还要回填历史)、审计流推导(触发/例外计数根本不写审计)、
   **每期一行快照**(选它):`counters_at` 存全量三计数,下一期 from 就是它,
   delta 计算是纯函数。entries 只存有活动的规则,但 from 必须全量——某条规则
   从「沉默」变「活跃」时,它的基线得有出处。
3. **at-least-once,刻意比通知摘要简单一档**:通知摘要(#116)有行级
   `digest_sent_at` exactly-once 台账,因为它每日跑、按人隔离失败。周报每周跑、
   收件人个位数,重复投递无害——发送失败 run 留 pending,**重发冻结内容而不是
   重算**(重算会让「发过一半」的那期数据永远报不出来,这是比重复更糟的失败
   模式)。信已出而盖章前崩 → 下周重发同一封,注释里明说这个窗口。
4. **收件人冻结在计算时刻**:本周报告是算给「当时在场的人」的;集成测试钉住
   「pending 期间新进场的 owner 不进重发名单」。无收件人则不建 run、不落快照——
   空报告是假成功(与待办提醒的空回落同裁),且不落快照让跨越的时段由收件人
   出现后的那一期一起报出来,数据不丢。
5. **安静周照发**:`No rule activity this period (N rules watched)`——短报本身
   是「周报还活着」的心跳,收件人不必猜「是没活动还是没周报」。零活动不等于
   零信息。

### 踩的坑

1. **测试断言不能写死算术**:首版集成测试把 totals 写成手算字面量
   (`totals 5 triggered / 1 exception / 0 override`),红了才知道——run 表在
   beforeEach 里 truncate 而规则计数跨测试累积,每条测试的第一期实际是
   「开机以来全量」,第二期才是相对增量。改成两个更强的断言:delta 单独断
   (`{2,1,0}`),邮件整体断「== renderEffectDigest(run 行)」逐字相等——
   既是冻结语义的最强钉子,也免了所有算术。
2. **种子总数不是 0021 的 57**:0023 随审批路线补种了 `approval.routing.user_role`,
   在册规则 58 条 + 夹具 59。周报「N of M」的 M 断言改成实时 count——种子数随
   已合并迁移演化,写死只会制造无意义的红。
3. **vitest `stored.find(run => run.status === "sent")` 拿错行**:两条 run 都
   是 sent,find 返回无序结果集的第一条(其实是第一期)。runs() 查询补
   `orderBy(weekEnd)` 后按下标取——无序集合上做 find 是测试自己的坑。
4. **`pick<EffectDigestServices>` 漏了 logger**:sendRun 的 catch 里用
   `services.logger.error` 但 Pick 类型没带,strict TS 当场红——注入面按用途
   收窄时别忘 catch 分支也算用途。

### 遗留与边界(刻意不在本切片)

- #225 剩余:Superset 部署面、模板管理(#128)——issue 保持 open。
- #233 验收第 8 条由本切片满足,但 issue 保持 open(JDM 拖拽编辑器、治理字段
  编辑随 #206、gate 种子随门槛消费域)。
- 周报只报三计数增量;§4.8 的「可能陈旧」开关标记(v2.2 借 Unleash)是
  #233 的持久 flag,不是周报一行话能承载的,未做。
- 无新路由/权限点(纯 worker 面),故无 app.request() 测试——runbook 的
  「每路由一测」在此无对象。
