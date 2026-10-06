---
session_id: hand-written-224-due-triggers
branch: feat/224-scheduled-triggers
date: 2026-10-07
reason: issue-224
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/224-scheduled-triggers — 2026-10-07

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#224 剩余项 1「定时与相对时间触发(预约前 N 小时)——独立
  扫描器形态」(切片 1 合并评论与 docs/automations.md 剩余项同一措辞);设计依据
  #232 §4.4「自动化规则」行 + §4.9(Odoo 自动化规则模型:触发含「某个日期前后
  N 天」)。PR 正文写 Part of #224(验收第 1 条逐域迁移未完,严禁 Closes)。
- **前置收尾(第 0 步)**:fetch 后无 open PR、无残留 worktree、主检出干净;
  origin/feat/221-approval-modes 已被合并流程删除(正常)。
- **选题**:①优先级下三个候选(#224 到期触发 / #225 numbering UI / #222 form
  builder)里选 #224——纯内核切片、消费面清晰(task.dueAt 今天就在),另外两个
  的首消费(#229/#231、#207/#227)都还没进线。claim_issue 原子租约拿到
  (taking over → OK)。
- **数据库**:本地 postgres(ally-os-node-postgres-1)可用,全部测试带
  DATABASE_URL 跑(无 skip)。

### 本切片改动的文件

- `packages/automations/src/index.ts`:triggerSpecSchema 起为判别联合
  (`kind: "event" | "due"`);due = subjectType + anchorField + direction
  (before/after)+ offsetMinutes(5..129600,即 5 分钟..90 天);
  `eventMatchesTrigger` 收窄(event 触发专用,due 永不命中事件扫描);
  `dueEventContext`(到期语境合成,与审计事件同形状)
- `apps/worker/src/automations/due-registry.ts`(新):due subject 注册表
  (内核接缝 + 属主域注册;`anchorFields` 声明式白名单);第一个成员
  **task(锚点 dueAt)**:只扫 open、排除 automation_rule 附着的任务(防环);
  带过滤在 SQL 侧(`make_interval(mins => N)`,before 减 after 加)
- `apps/worker/src/automations/due-scanner.ts`(新):`automation-due-scan`
  任务(每分钟,90s 尾窗与事件扫描同语义);fail closed(spec 坏/subject 未
  注册/字段未声明 → 跳过 + 告警);run 行复用 (rule_id, source_event_id) 唯一
  约束去重(source_event_id = subject 行 id)
- `apps/worker/src/automations/actions.ts`:create_task 产出的任务附着
  `subject_type='automation_rule'` + subject_id=ruleId(导出
  AUTOMATION_TASK_SUBJECT_TYPE)——观测面 + due 防环闸
- `apps/worker/src/automations/index.ts`:automationJobs 登记第三个任务
  due-scan(cron/队列策略与事件扫描一致:retryLimit 1,下一轮扫描是兜底)
- 测试:`packages/automations/src/index.test.ts`(+due 形状矩阵、+kind 必填
  旧形状拒绝、+due 语境条件求值);`apps/worker/src/automations/due-scanner.test.ts`
  (新,10 例:端到端、(rule,行) 一次性、after 方向、窗外不补、done 不扫、
  防环、fail-closed 矩阵、event 规则不归 due 扫、条件 skipped、注册表 seam
  fixture);`automations.test.ts`(trigger 形状迁移 + e2e 断言任务附着);
  `routes/automations.test.ts`(+due 触发 201/400/旧形状 400);
  `config-versions`/`config-drafts` 测试的形状迁移
- 文档:`docs/automations.md` due 触发专节(四件套 + 四条裁决:(rule,行) 一次
  性、不追停摆缺口、语境不写审计、纯 wall-clock 刻意不做)+ 剩余项重排
- **无 migration**(trigger/conditions 是 jsonb,形状变化不动表);主检出与
  本 worktree 的 dev 库如残留切片 1 形状的规则行,扫描器按「spec 坏」跳过并
  告警——上线前数据,不做兼容
- 验证:`DATABASE_URL=… corepack pnpm verify` 全绿 94 文件 / 783 测试
  (基线 93/770,+1 文件 +13 测试)

## 判断层(手写)

### 关键判断

1. **切片只做 due(日期字段 × 偏移),不做纯 wall-clock cron 触发。** issue 要点
   里「定时、相对时间」并列,但纯定时(「每周一 9 点建任务」)没有记录语境:
   条件无事可做、去重要发明 tick 窗口键、和域定时任务(#32 对照表逐域登记
   pg-boss)与 #225 Superset 定时报表职责重叠——做了只是第二套 cron。docs 里
   把这条边界写成显式裁决(「刻意不做 + 何时再议」),不是遗漏。
2. **触发形状升级为判别联合且不留旧形状兼容。** 考虑过 `z.union` 按键形状区分
   或 preprocess 兼容 `{action}`,最终 `kind` 显式判别 + 旧形状 400:规则是
   上线前数据(dev 库是 scratch,无生产行),双形状是永久税;旧行如果残留在
   某个 dev 库,扫描器按既有「spec 坏 → 跳过 + 告警」路径 fail closed,不会
   带病执行。理由写进了测试注释,防止后人「顺手加兼容」。
3. **防环做在锚点侧(subject_type='automation_rule' 不扫),不做在动作侧。**
   「due 触发 → create_task(dueInHours)」若不设防,子任务到期再触发规则,每
   ≥5 分钟自增一条任务;跨规则链(A 建的任务触发 B)同理。把自动化产出的任务
   统一附着到规则行,一石二鸟:防环 + 「这条规则 spawn 过哪些任务」的观测读法
   (tasks_subject_idx)。相比「due 规则禁止 create_task 动作」的配置面限制,
   数据侧一闸更简单且不需要跨形状裁;人工建的链条入口不受影响。
4. **(规则, 行) 一次性 + 不追停摆缺口,与事件扫描器对齐。** 到期语义最初诱惑
   是 #278 待填提醒式的 reconcile(扫描「所有已到期未 fired」),那会碰到
   「规则启用前就过期的 Ancient 行」spam 问题;改用 90s 窗 + 唯一约束去重后,
   语义变成「到期时刻落在窗内才响、每 (规则,行) 只响一次」,与切片 1 的「不追
   停摆缺口」裁决同源。锚点改期不重报也在这条裁决里显式记录(要支持需把锚点值
   纳入去重键,等真实域需求)。
5. **注册表放 worker 侧而不是 @ally/automations 包。** due-registry 的成员要
   import drizzle schema 与 @ally/db 的 Db,而形状包刻意零依赖(只有 zod);
   消费方也只有 worker(扫描器)。API 保存面不校验 subjectType 是否注册——
   与 event 触发「不校验审计 action 是否存在」同裁:形状收口在保存面,存在性
   在运行面 fail closed(未注册 → 跳过 + 告警)。anchorFields 白名单放注册表
   声明里,扫描器先查表再取数,避免 loader 内部静默吞错字段。
6. **第一个成员注册 task(dueAt) 而不是留空注册表。** esign 注册表留空是因为
   没有可签业务单据;这里 tasks.due_at 今天就存在,「任务到期前 N 小时提醒」
   是真实的立即消费面,注册表带真实成员能把「扫描 → 唯一约束 → 执行」整条链
   在生产形态下测掉,seam 测试用 fixture subject(meeting)证明未来域零改动
   接入。
7. **due 触发不写审计。** 合成语境(task.due)只活在 automation_runs 与条件
   求值——「到期时刻到了」不是一次业务变更,写审计违反 docs/audit.md 的
   「一次业务变更一行」纪律;测试断言了端到端后 audit_events 为空,把这条裁决
   钉住。

### 踩的坑

- **eslint require-await 打在 fixture loader 上**:async 函数体没有 await 的
  注册表 fixture 被拒;改 `loadDueRows() { return Promise.resolve([...]) }`
  (非 async 返回 Promise)——不是 `.sync` 选项问题,是接口形状的正常写法。
- **drizzle select 的可空列类型不因 WHERE 收窄**:dueAt 带过滤已排除 null,
  类型仍是 `Date | null`;不做 `as Date` 断言,投影处 flatMap 防御式跳过
  (noUncheckedIndexedAccess 仓库同款纪律:窄化靠控制流,不靠断言)。
- **python 脚本批量换 trigger 形状时漏了 `to: { action: ... }` 断言形状**
  (config-versions/service.test.ts),verify 第一轮红;教训:形状迁移类改动,
  迁移脚本跑完后必须 `grep -v kind` 反查残留,不能只换「写法像定义」的行。
- **automation-scan 的滞留清障 sweeper 不用在 due-scanner 复刻**:它扫的是全表
  pending run 不问来源,两个扫描器都在场时一处清障就够;文档里写明这个耦合
  (若未来事件扫描器退役,sweeper 要跟着搬家)。
