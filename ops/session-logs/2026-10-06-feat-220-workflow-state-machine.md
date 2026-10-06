---
session_id: hand-written-220-workflow-state-machine
branch: feat/220-workflow-state-machine
date: 2026-10-06
reason: issue-220
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/220-workflow-state-machine — 2026-10-06

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#220(配置工作室:流程与状态机;#232 §4.4「配置工作室」表
  + §4.9「借鉴与引入的开源项目」XState v5 行)——**切片 1:流程内核(服务端
  API)**,PR 正文写 Part of #220(超时投递/首个属主域/#226 版本化/流程图 UI
  未完,严禁 Closes 关键字)
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净(快进到
  #267 esign kernel)。选题:各切片 issue(#219/#113/#25/#23/#129/#110/#29)的
  剩余项全部被其他 issue 明确阻塞(#219 剩 SignatureDialog,评论原文说随 #221
  或 #204 落地),无一可独立续做;phase-1 零评论绿地按编号序落 #220。
- **老系统普查(Explore 子代理,只读)**:结论——老系统全部状态机是「SQL 迁移
  内 frozen 边表 + TS 硬编码镜像 + parity 测试」三件套,无任何可配置流程表/引擎
  (最接近的 `production.phase_defs` 只存词表,流转边仍写死在 RPC 里)。普查清单
  进了 docs/workflow.md 开头与 PR 正文,作为「替代了什么」的证据。

### 本切片改动的文件

- `packages/db/src/schema.ts`:`workflow_templates`(subject 开集 text +
  (subject_type, template_key) 唯一 + product_type/is_default 选择维度 +
  definition jsonb + version 恒 1 预埋 #226)、`workflow_instances`
  ((subject_type, subject_id) 唯一 = 一对象一实例、definition 启动时刻快照、
  current_state/state_entered_at/state_due_at)、`workflow_transitions`
  (历史;actor_id 不带 CASCADE,与 esign 签名人同裁)
- `packages/db/migrations/0013_minor_lucky_pierre.sql`(新,expand-only):
  drizzle 生成 + 手写 append-only 触发器(`workflow_transitions_is_immutable`
  + BEFORE UPDATE/DELETE,0007/0012 同款裁决)+ 部分唯一索引「每类型至多一个
  默认模板」
- `apps/api/src/workflow/engine.ts`(新):zod 模板 schema(流转收 XState 字符串
  简写与对象两种形态)→ 拓扑校验(initial/target/自环/非空)→ `compileMachine`
  (剥离扩展字段喂 XState)→ @xstate/graph 可达性;`applyWorkflowEvent`
  (resolveState + actor.send 的无驻留推进)、`allowedEvents`、`stateDueAt`、
  `referencedBlocks`
- `apps/api/src/workflow/blocks.ts`(新):条件积木/动作积木注册表,本切片为空
- `apps/api/src/workflow/registry.ts`(新):可挂流程 subject 注册表,本切片为空
- `apps/api/src/workflow/service.ts`(新):`startWorkflow`(模板解析:产品类型
  精确命中 → 默认 → 无模板;唯一索引幂等双启动)、`applyTransition`(员工地板 →
  拓扑 → roles → requireNote → 门槛 → CAS 乐观并发 → 历史+审计同事务;进入后
  动作提交后执行、失败带出不回滚)、`subjectFlow`/`transitionHistory`/
  `findDueInstances`
- `apps/api/src/routes/workflow-templates.ts`(新):POST/GET×2,`workflow.configure`
  权限点;保存四道校验(zod/拓扑/XState 可达性/积木存在性);23505 沿 cause 链
  识别 → 双默认 409
- `apps/api/src/routes/workflow-instances.ts`(新):GET 实例 / POST 推进 /
  GET 历史,可见性门(subjects/registry.ts)同扇;**启动无 HTTP 面**(属主域
  进程内调用)
- `apps/api/src/authz/permissions.ts`:新权限点 `workflow.configure`(owner/admin
  默认);`app.test.ts`/`authz.test.ts` 的权限集钉子随新点更新
- `apps/api/src/routes/registry.ts`:六条新路由授权声明
- 测试:`workflow/engine.test.ts`(11,纯函数;@xstate/graph 全路径枚举 + 全矩阵
  拒绝)、`routes/workflow-templates.test.ts`(4,临时库)、
  `routes/workflow-instances.test.ts`(9,临时库;生命周期/解析/拒绝矩阵/门槛/
  customer 地板/运行时 fail closed/启动拒绝/并发 CAS)、
  `packages/db/src/workflow-immutable.test.ts`(2,共享库)
- 文档:`docs/workflow.md`(新,含老系统 frozen 边表普查结论)、`docs/audit.md`
  词表三动作、`docs/permissions.md` 权限点现状段
- 依赖:`xstate@5.33.2` + `@xstate/graph@3.0.4` 进 apps/api
- 验证:`DATABASE_URL=… corepack pnpm verify` 全绿(**72 文件 / 532 测试**,含
  DB 集成;lint/typecheck/test 三段全过)

## 判断层(本次会话手写)

### 关键判断

1. **切片边界 = 内核 API,无 web UI**。与 #267(esign 切片 1)同形:机制先行
   不留产线,三个注册表(subject/条件积木/动作积木)刻意为空、只留 register
   接缝——四个属主对象(线索/商机/订单履约/偏差)全在 phase-2+,现在放任何
   「示例模板/示例积木」都是死数据。第一消费域(#221 审批或 #227 线索)进场
   注册。PR 写 Part of #220。
2. **XState 只当拓扑计算器,扩展字段不进 XState**。#232 §4.9 原文「服务端只用
   它计算『当前状态 + 事件 → 下一状态』」照单执行:roles/gates/requireNote/
   timeoutAfterHours/entryActions 是本仓库扩展,zod 收下后剥离,createMachine
   只见 `{on: {EVT: {target}}}`。理由:门槛要异步查库(XState guard 是同步的),
   动作要在事务提交后跑(XState action 在状态机里执行)。@xstate/graph 的两个
   真实用途:保存时可达性校验、测试全路径枚举(引原文「列出全部路径生成接口
   测试」)。
3. **实例存 definition 快照,模板行一经创建不改定义**。模板改版不得改写在飞
   实例的语义——与签名绑定 recordVersion 同一裁法;「模板怎么演进」整体让给
   #226(版本列预埋恒 1),本切片只立「停用旧行 + 新键」的最小纪律。
4. **并发推进用 CAS 不用锁**:UPDATE 带 `current_state = 读到的值` 条件,抢输
   409 `concurrent_conflict` 不落历史行。测试用 Promise.all 两条合法流转验证
   「恰好一个赢」;输家不写历史是断言的一部分。
5. **员工地板放内核**:流转是员工动作,纯 customer 角色在 service 层即 403,
   模板 roles 只是再收紧。理由:客户门户(门户可见订单)落地后,无角色的流转
   会把推进权漏给客户;内核地板比「指望每张模板记得写 roles」fail-closed。
6. **`requireNote` 是内核字段不是积木**:老系统 feat056「转 qualified/
   disqualified/waitlisted 必须带非空理由」是流转的结构属性,内核化后任何域
   免费获得;业务性条件(合同已签等)才走积木。
7. **自环流转明确不收**:XState 外自转移会重入状态,「状态值不变」与「事件未被
   接受」无法区分——保存时直接拒绝,注释写明语义留给未来。
8. **启动不开 HTTP 面**:没有「用户凭空启动一个流程」的业务动作,startWorkflow
   是属主域创建记录时的进程内调用(与 #25 ensureShadowAccount 的服务先行同形)。
   读/推/历史有 HTTP 面(配置工作室与属主域 UI 的未来消费面)。
9. **超时半边进场**:stateDueAt 在进入状态时一次算好(应用证明自己的输出),
   findDueInstances 是纯索引查询;「提醒负责人怎么送」需要负责人概念(属主域)
   + #116 渠道层,列为剩余项。

### 踩的坑

1. **zod v4 的 `z.record()` 没有 `.min()`**(类型报 TS2339)——「至少一个状态」
   挪进自写 validateTopology。
2. **XState JSON 的字符串简写流转**(`"CONTACT": "contacted"`)首轮 zod 直接拒
   ("expected object, received string")——设计文档手写 JSON 都会用简写,改
   union 两形态归一后校验。
3. **getSimplePaths 的 steps 含 `xstate.init` 合成事件**(进入初态)——全路径
   测试按 `xstate.` 前缀过滤,否则第一断言就红。
4. **drizzle 把驱动错误包进 DrizzleQueryError.cause**——部分唯一索引(双默认)
   的 23505 在 cause 链上,isUniqueViolation 沿链找码;esign-immutable 早有
   causeMessage 先例,这次在路由侧又踩一遍。
5. **TRUNCATE 单表被 FK 拦**(instances 引用 templates)——三张流程表同语句清。
6. **better-auth 未验证邮箱登录 403**——测试脚手架图省事跳过验证邮件,全部
   用例齐挂 403;照 esignatures 测试补 spyMailer + verify-email 链接点击。
7. **exactOptionalPropertyTypes × zod 推断**:zod 输出的可选属性带 `| undefined`,
   手写中间接口(RawTransition/RawState)不写 `| undefined` 就赋值不兼容——
   显式补齐。
8. **夹具存在性与类型维度分离**:第一版把「subject 存在」寄托在 productType
   Map 的 has() 上,无类型的夹具 subject 直接变「不存在」(subject_not_found)
   ——拆独立 existence Set。教训:测试夹具的语义要和真实加载器契约一样显式。
