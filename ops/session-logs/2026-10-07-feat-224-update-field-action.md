---
session_id: hand-written-224-update-field-action
branch: feat/224-update-field-action
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

# Session log — feat/224-update-field-action — 2026-10-07

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#224 剩余项 1「动作类型扩展:改字段」——**update_field
  动作切片**。PR 正文写 Part of #224(事务短信/报名序列/AI 步骤、条件积木、
  效果度量等剩余项仍在,严禁 Closes)。
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净;origin/main
  顶端 cec801f(#292,send_webhook)即基线。
- **选题**:①优先续做有未完成切片的 issue。#224 今天刚并切片 4(send_email
  #291)、5(send_webhook #292),剩余动作类型里事务短信等 SMS 通道、报名序列等
  域进场、AI 步骤等基建,**改字段是下一个零依赖、且与前两个切片同构(动作联合
  扩展)的切片**,按续做优先选它。
- **老系统参考(只读)**:#134 触发器清单里「改字段」形态的真实业务:
  `sync_signing_to_documents`(签署完成 → 文档状态跟写)、
  `set_lead_submitted_at`/`update_lead_last_activity_at`(事件 → 字段刷新)、
  `sync_task_to_bug_report`——都是「某行变化 → 另一行(或同一行)字段跟写」,
  新系统归一为 update_field 动作;这些域 phase-2+ 才进场,本切片用 task.status
  做第一个真实消费面。
- **数据库**:本地 postgres 可用(docker 容器 5432 端口活着),verify 全程带
  DATABASE_URL(无 skip)。

### 本切片改动的文件

- `packages/automations/src/index.ts`:`updateFieldActionSchema`(subjectType/
  field 1..100、value 显式键缺席即拒、null 是值)进动作 discriminated union;
  新增纯函数 `subjectIdFromTarget`(裸审计 target = 配置 subjectType 的行 id;
  `type:id` 前缀匹配剥前缀;**别的 subject 前缀 = 配错对象,拒绝**;无 target =
  拒绝)。包仍零依赖。
- `apps/worker/src/automations/field-registry.ts`(新文件):update_field 的
  subject 注册表——`registerUpdatableSubject`/`updatableSubjectSpec` 接缝 +
  声明式白名单(「哪张表哪个字段容许自动化改、值域、痕迹」= 属主域裁决,与
  due 锚点/可签名 subject 同一裁法)。第一个成员 **task.status**:值域
  open/done/cancelled、行锁(`SELECT … FOR UPDATE`)下读旧值、no-op 不动行不写
  审计、真变化 UPDATE(+updatedAt)+ `task.status_changed` 审计(from/to +
  `automation:<runId>` actor + via/ruleId/ruleName detail)。
- `apps/worker/src/automations/actions.ts`:`executeUpdateField`——五道闸
  fail loud(subject 注册、field 注册、target 解析、签名锁、值域/行存在在
  field spec 内),签名锁 = esign_signatures 按 subject 前缀查询(#219 与人手
  PATCH 的 record_signed 同裁决,自动化不豁免);结果 `{ ref: subjectId }`。
- `apps/worker/src/automations/runner.ts`:`loadTriggerTarget`——due 触发不写
  审计行,合成 target 由 trigger 重建;event 触发回审计行取(行不在 = null,
  动作自己 fail loud);穷举 switch 进 `update_field` 分支,RuleLoad 带
  triggerTarget。
- `apps/web/src/shared/lib/automations-client.ts`:ActionDraft 联合 +
  actionToDraft + buildActions 的 update_field 结构化编辑(subjectType/field/
  valueText,值必须 JSON.parse 得动——空框不是值,挡线下)。
- `apps/web/src/shared/pages/Automations.tsx`:类型选择器新选项、编辑器三件
  (subject/field/value,第一段文案把「只改触发行、白名单外存得了跑必败、
  签名锁定、no-op 静默成功」说在前头)、ActionCard 展示分支
  (`subject.field → value` 截断)。
- 测试(+14):包 7(update_field schema 接受矩阵含 null/嵌套 JSON、缺键/
  缺 value/空串拒绝;subjectIdFromTarget 五分支);worker 集成 4(端到端:
  状态改写 + automation 署名审计 + actionResults.ref;no-op 成功但零行写零
  审计;签名记录拒改且行不动;六种坏配置逐道闸错误消息原样可读)+ due 1
  (到期后 1 小时自动取消,合成 target 由 trigger 重建);web client 往返 1
  (结构化往返 + null 值 + 三失败分支);页面源码纪律 1。
- `docs/automations.md`:「update_field 动作」专节(形状/一行语义/白名单
  注册/签名锁/no-op 五条)+ 剩余项 1 改写(改字段已落,更多可写面随属主域
  注册)。
- 无 API 路由改动(保存面由共享 schema 自动收口)、无迁移、无新 env。

## 判断层(本次的关键判断与踩的坑)

1. **目标永远是「触发语境自己的那一行」,不做查询。** update_field 的靶子 =
   触发它的那条记录(event → 审计 target;due → 合成 target)。让规则作者写
   「按条件找出一片行来改」就是自动化批量改写——那是另一档危险(一次误配改全
   表),不属于无人值守的动作面。`subjectIdFromTarget` 对「带别的 subject 前缀」
   fail loud 而不是猜:改错行比不改更糟。
2. **可写面 = worker 侧声明式白名单,保存面故意验不了。** 「task.status 能不能
   改、值域是什么」是任务域的裁决,和 due 锚点一样只有属主域知道;注册表在
   worker(执行时才用得上),API 保存面看不到——所以未注册组合存得进、执行必败
   告警(fail closed),due 未注册锚点同一条既定裁决,UI 第一段明说。没有为了
   「保存时就报错」把注册表挪去共享层:那会把 worker 的执行知识变成 api 的编译
   依赖,层次倒置。
3. **首组白名单只有 task.status,两个诱惑被挡了。** assigneeId 很有用,但改
   经办人必须带「可分配面 = 至少一个非 customer 角色」裁决(routes/tasks.ts 的
   findAssignableUser),搬进 worker 就是第二份实现、必然漂移;dueAt 写静态绝对
   时刻进规则,半年后规则还在、时刻早过期——都是「等真实需求进场,把裁决挪到
   共享位置再开」的口子,写进了 docs 剩余项。小步不想象需求。
4. **签名锁(#219)不豁免自动化,做在执行器层而不是 field spec 层。**
   「签过名的记录一律拒改」是 subject 级裁决不是字段级,放执行器对所有未来
   subject/field 一律生效;实现 = esign_signatures 按 subject 前缀查一行
   (append-only 表,「有签名行 = 锁定」与人手 PATCH 的 isSubjectSigned 同语义,
   两处注释互指)。今天恒通过(可签名注册表为空,任务上不可能有签名),第一个
   把 task 注册为可签名的域进场那天这道闸即生效——**为今天恒通过的闸写集成
   测试**(直插签名行),不因为「现在不可能」就不钉。
5. **no-op = 成功,但零行写零审计。** 与人手 PATCH「真变化才写审计、才动行」
   同裁。反过来(no-op 也写审计)的话,一条反复命中的规则会把审计流刷成自己的
   转发日志——审计流是自动化的事件源(#29 第三个读者),不能被自动化的产物灌水。
   集成测试钉死:第二次命中 succeed + `task.status_changed` 零新行。
6. **坑:执行时怎么找回「该改哪一行」——run 行没存 target。** 设计时发现
   automation_runs.source_event_id 是多态的:event run = 审计事件 id,due run =
   **subject 行本身**(due 语境不写审计)。执行器要改行就得重建 target:due 从
   trigger spec 重拼 `subjectType:sourceEventId`,event 回审计行查 target。零
   migration 拿下;真要给 run 行加「触发语境快照」列是另一个切片的事(条件在
   扫描时已求值存档,动作只要 target,现在不需要)。
7. **value 的「缺席」和「null」是两回事。** zod 的 `z.unknown()` 把缺键当
   undefined 收进来,`{field: "status"}` 不带 value 会静默通过——补
   refine `"value" in config`(conditionSpec 同招):缺键 = 作者忘了写目标值,
   拒;显式 null = 清空的意图,放进形状由域裁决可空性。web 侧同构:空框在
   buildActions 就拒(「an empty box is not a value」),不把形状非法的规则交给
   服务端当权威。
8. **坑:lint 抓了 `let triggerTarget = null` 的无用初值**,顺势重构成
   `loadTriggerTarget` 辅助函数——两分支各自 return,loadRuleSpec 少一层嵌套,
   due/event 的 target 语义在函数名和 docstring 里自解释。lint 输出有时是设计
   提示,不只是格式投诉。
9. **回路防护免费拿,但要写明白。** 自动化改字段产生的 `task.status_changed`
   带 `automation:<runId>` actor,扫描器按前缀跳过——「规则改字段 → 触发另一条
   监听该事件的规则」没有隐式通路(与 create_task 同一裁决);活动流照常可见、
   detail 署名规则。这是既有机制,本切片的义务是**不破坏它**(审计 actor 一字
   不差走前缀)并把它写进文档。

## 验收对照(本切片范围)

- [x] 「动作:……改字段」——update_field 进动作联合,保存面 zod 收口、worker
      执行(注册闸/目标闸/签名锁 + 重试 + 留痕),runs 留逐动作结果(ref =
      被改行 id),端到端集成测试(event 与 due 两种触发)覆盖
- [x] 「不改代码即可新增一条规则并生效」对改字段成立:建「到期后 1 小时未办
      即取消」规则(due 触发 → update_field task.status=cancelled)零代码,
      due-scanner.test.ts 端到端覆盖
