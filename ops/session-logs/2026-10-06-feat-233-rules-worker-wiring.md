---
session_id: hand-written-233-rules-worker-wiring
branch: feat/233-rules-worker-wiring
date: 2026-10-06
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

# Session log — feat/233-rules-worker-wiring — 2026-10-06

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#233——**切片 2:待填规则的待办提醒(worker)**,PR 正文写
  Part of #233(决策表/门槛种子/cron 接线/周报/治理编辑/前端 UI 未完,严禁
  Closes 关键字)。
- **前置收尾(第 0 步)**:两个 open PR——#276(#233 切片 1)CI 绿但已在
  15:07Z 被其原会话合并(本会话 merge 时发现 already merged,#233 租约随即被
  原会话释放、issue 已留成果评论);#277(web 白屏修复)CI 排队中、归原会话
  盯,不抢。选题:按「issue 评论里有未完成切片的优先」续做 #233 切片 2,
  claim 时原会话已 release,原子占位成功。
- **数据库**:本地 postgres 可用,全部测试带 DATABASE_URL 跑(无 skip)。

### 本切片改动的文件

- `packages/db/src/schema.ts`:`tasks` 加多态附着列 `subject_type`/`subject_id`
  (text/uuid 可空)+ `tasks_subject_idx`——任务内核注释里预留的「随第一个业务
  域切片 expand-only 进场」,本切片是第一个生产者(registry_rule)
- `packages/db/migrations/0022_cold_lily_hollister.sql`(新):drizzle 生成,
  纯 expand(两列 + 一索引)
- `apps/worker/src/rules/reminder.ts`(新):对账扫描——待填规则(value is
  null)×「谁能改」角色持有者(无人持有回落 owner,再无人则告警跳过)保有一条
  open 提醒任务;值填上自动关闭遗留提醒(task.status_changed 审计);任务行 +
  task.created 审计 + task.assigned 通知同事务,实时「催」提交后发
- `apps/worker/src/rules/index.ts`(新):`rulesJobs({db,pool,logger})` 域工厂,
  登记 `rules-pending-reminder`(cron `0 13 * * *`,retry 1——次日扫描即兜底)
- `apps/worker/src/index.ts`:注册 `rulesJobs`
- 测试:`apps/worker/src/rules/rules.test.ts`(6 例集成 + 1 例注册形状,独立
  scratch DB)
- 文档:`docs/rules.md`(已落地表格加一行 + 新增「待填规则的待办提醒」专节,
  cron 接线条目补结构性前提)

## 判断层(手写)

### 关键判断

1. **切片边界:只做待办提醒,不做 applyDueRuleChanges 的 cron 接线。** 剩余项
   清单里 cron 接线看似是最小的一项,但有个结构性前提:内核在 apps/api,worker
   不跨 app 依赖(automations 的先例是内核下沉 packages/automations);rules
   内核的依赖闭包拖着 config-versions 台账与其 families 注册表(families.ts
   模块装载时向 CONFIG_SUBJECTS 注册),下沉不是「挪个文件」而是牵动 #226/#233
   两个刚合并的域。且 slice-1 文档已明确裁决「cron 接线随第一个消费域一起接
   (同 workflow due scan 裁法)」——注册表目前尚无任何消费域,抢在消费域之前
   接线等于重裁 slice-1 的边界。照办,并在 docs/rules.md 把这个结构性前提写
   明,给未来那天的执行者留路标。
2. **提醒是对账(reconcile)不是发信。** 扫描保证两条不变式:待填规则 × 可改
   者至少一条 open 提醒;值已填则无 open 提醒。副产品语义:经办人勾掉任务但值
   仍空 → 下一轮重建(待办的目的就是填值,提醒是故意的)——PR 正文里明示这是
   设计而非 bug。去重靠 (subject, assignee, open) 查询,不靠标题字符串:附着
   列(0022)正是为此进场,顺带成为任务内核多态附着的首个生产者。
3. **分派人 = 「谁能改」角色持有者,不含 owner 直通并集。** effectiveChangeableBy
   是改值面的裁决(含 owner 直通),提醒面若照抄会让唯一 owner 在 8 条待填规则
   上收 8 条任务、其中 3 条本该 admin/销售主管填——提醒应指向规则的治理角色
   (种子里每条恰好单角色),持有者缺失时才回落 owner,连 owner 都没有则告警
   跳过:一条没人看得见的任务是假成功(fail-closed 的提醒面版本)。
4. **系统任务的 actor 与署名。** actor 用 `system:rules-registry`(先例:
   automations 的 `automation:<runId>`);故意不借用 AUTOMATION_ACTOR_PREFIX——
   那个前缀是自动化扫描器的回路防护标记,提醒任务不是自动化产物,不该对自动
   化隐身。createdById 留空:任务路由「换经办人只有创建人能改」因此对系统任务
   关闭(经办人仍可改内容/状态),可接受且诚实。
5. **测试清库纪律(本切片最险的坑)。** 最初想沿用 automations.test.ts 的
   `truncate … auth_user cascade`,但 0021 之后 auth_user 被 registry_rules.
   scheduled_by_id 引用,TRUNCATE CASCADE 会连种子一起清掉(老套件写那行时
   registry_rules 还不存在——时间炸弹的实证)。改成:users/roles 在 beforeAll
   一次性插入,规则(种子+前序改动)跨测试持久,只清 tasks/notifications/
   audit_events(确认无任何表引用它们);隔离靠「每测动自己的规则」+ 按
   subject/assignee 限定断言——与 API 侧 rules.test.ts 的不清库纪律合流。

### 踩的坑

- `TRUNCATE … CASCADE` 沿 FK **引用方向**级联(不看 ON DELETE 行为),被引用表
  一起没——auth_user 被 registry_rules 引用后,老模板的清库行从「无害」变
  「清种子」。给后来者:凡是 truncate auth_user 的测试套件,0021 之后都中招。
- worker 想复用 apps/api 的 `applyDueRuleChanges` 是结构性不可行(app 间不互相
  依赖),不是忘了接——同理本切片对 registry_rules 全程直查表(automations
  scanner 直查 audit_events 同一裁法),内核读口(getRule 的 zod 收口)留给
  真正的消费域。
- gh pr merge 撞上「原会话已在几十秒前合并」:already merged 报错即对方完成
  step-5 的信号,收手转选题,不重试不清理对方的 worktree(它还在盯第二个 PR)。

### 验收对照(#233 范围条目「待填中提醒」)

- [x] 8 条待填规则上线即进「谁能改」持有者待办(集成测试按角色矩阵断言)
- [x] 值填上 → 提醒自动销账 + status_changed 审计(测试)
- [x] 幂等:重复扫描不重复建/不重复通知(测试)
- [x] 角色无人持有回落 owner;owner 也无则跳过并告警(测试)
- [ ] 每周规则效果汇总 → #225 报表域(保持 open)
