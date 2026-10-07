---
session_id: hand-written-224-automations-config-ui
branch: feat/224-automations-config-ui
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

# Session log — feat/224-automations-config-ui — 2026-10-07

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#224 剩余项「规则配置 UI(配置工作室)」(切片 1 #272 事件
  内核、切片 2 #285 due 触发均已落地,API 面齐:规则 CRUD + runs 读面 +
  `automations.configure` 门 + automation_rule 族已进 #226 台账带
  applyRevision/回滚)。本切片补配置页,PR 写 Part of #224(动作类型扩展、
  条件积木、效果度量仍在,严禁 Closes)。
- **前置收尾(第 0 步)**:fetch --prune、无 open PR、无残留 worktree、主检出
  干净且与 origin/main 同步(a1a3a15,#289)。#219 先查过:功能已全但 issue 注释
  明说剩余「签名墙页面展示」要等第一个有签署历史的承载页,不可关,跳过。
- **选题**:①优先级下候选 #221(amount-line 随 #229/#231)、#222(表单构建器
  随消费域)、#224(配置 UI)、#233(JDM 编辑器)——选 #224 配置 UI:API/worker
  内核全就绪、零依赖、与最近四个 config 页面(#286-#289)同构。claim 原子租约
  成功。
- **老系统参考**:老系统的自动化逻辑是 887 个迁移文件里的 DB 触发器 + pg_cron
  定时任务,无配置面可言——本页是新设计;对照 docs/automations.md 的裁决
  (保存即生效、fail-closed、runs 留痕)写文案。
- **数据库**:本地 postgres 可用,全部测试带 DATABASE_URL 跑(无 skip);
  本切片纯 UI,无 schema 改动,无需 db:generate。

### 本切片改动的文件

- `apps/web/src/shared/lib/automations-client.ts`(新):list/runs 读 +
  create/update/remove 写 + #226 台账 history/rollback(automation_rule 族),
  失败模式判别 union,响应 zod 收口;liberal 显示助手(triggerSummary /
  actionsSummary / conditionsSummary / formatOffset / parseConditionOutcome /
  parseActionResult / filterRules)与 spec 草稿模型(specToDraft / buildSpec,
  **未知 trigger/action 形状走 `kind:"json"` 原样 JSON 往返**)
- `apps/web/src/shared/lib/automations-client.test.ts`(新,20 例):adapter
  失败模式、POST/PATCH 请求形状(spec 顶层 vs 嵌套、description 清空=null)、
  runs 查询串、台账回滚拒绝原因、buildTrigger/buildConditions/buildActions
  矩阵(边界 5/129600 分钟、1/2160 小时)、未知形状往返不毁、显示助手
- `apps/web/src/shared/pages/Automations.tsx`(新):列表(文本/触发类型/启停
  过滤)+ 新建/编辑表单(SpecEditor:trigger kind 切换、条件行增删、动作卡增删,
  结构化字段 + 原样 JSON 旁路)+ 详情面(spec 绘制、启停、两段确认删除)+
  runs 执行日志(状态过滤、仅选中规则、逐条件裁决/逐动作结果/错误原样)+
  #226 版本史与一键回滚;每个读状态(加载/403/不可达/空表,runs 同)与全部写
  失败原因各有各的话
- `apps/web/src/shared/pages/automations.test.ts`(新,9 例):jsdom-free 源码
  纪律——路由/rail 接线(bolt 字形独占)、「保存即生效,没有发布开关」进第一屏、
  runs 留痕文案、开集 spec 的 JSON 往返、删除后果、读状态齐全、due fail-closed
  说在前头、幂等版本语义、#226 台账接线
- `apps/web/src/App.tsx`:/system/automations 路由;`rail-groups.ts`:System 区
  +1 行(nav "automation-rules");`RailIcon.tsx`:新 glyph `bolt`(闪电轮廓,
  rail 测试禁两行同图)
- 文档:`docs/automations.md` 新增「已落地:规则配置 UI」专节;剩余项第 4 条
  改为「配置 UI 已落地,草稿发布面暂未接 UI(随第一个先审后上需求进场)」
- 验证:`DATABASE_URL=… corepack pnpm verify` 全绿 105 文件 / 896 测试
  (本切片 +2 文件 +29 测试);pre-push hook 同门再跑一遍

## 判断层(手写)

### 关键判断

1. **开集 spec 的编辑面纪律是本切片的灵魂,不是「做个表单」。** trigger/action
   存 jsonb 开集,webhook/email/AI 等新动作类型会随属主域进场而本构建没有编辑器
   ——UI 若按已知形状硬拆,编辑一条旧规则就会把不认识的形状静默抹掉。所以
   specToDraft 对不认识的形状走 `kind:"json"` 原样旁路,列表摘要诚实说
   「not drawn by this build」:显示不装校验器,编辑也永不销毁操作员看不见表单
   的部分。这让「新动作类型进场」对 UI 是零迁移——旧规则照常显示/保存。
2. **草稿面刻意不做。** automation_rule 族在 #226 切片 2 已带 draftContentSchema
   (API 支持草稿发布),但全仓库没有任何页面接过草稿面;自动化规则的既有裁决
   是「保存即生效,worker 每周期读 enabled」。直改 + 台账回滚已覆盖当前需求,
   草稿面留给第一个真实的「先审后上」需求——不在 UI 切片里预付无人要求的复杂度。
3. **PATCH 幂等语义给 UI 语义**:API 对无实效变更返回现状版本,编辑面拿前后版本
   对比区分「No effective change — version N stands」与「Saved — version N is
   live now, the ledger has the change」——台账有没有记账,页面说得出来,不
   假装每次保存都是变更。
4. **due 的 fail-closed 在表单里就有答案**:due 编辑器脚注明说「未注册的锚点对
   能保存但永不触发,worker 会告警」,事件触发明说条件只看得到事件四列——
   内核裁决文档化到配置面,不留到「规则为什么不跑」的排障时刻。
5. **runs 是观测面不是装饰**:skipped 行展示逐条件裁决(哪条不过)、failed 行
   展示逐动作结果与错误、create_task 的产物 ref 可跳——验收第 2 条「执行记录
   可查、失败重试告警」的后台半边由本页补齐(重试与告警已在切片 1)。

### 踩的坑

- **gotcha 121 复现**:SpecEditor 的 testid 用模板字符串拼 prefix(create/edit),
  源码测试断言拼好的字面量必挂——断言模板本体(`automations-${prefix}-trigger-json`)。
- **`expect.stringContaining` 返回 any**,塞进 toEqual 的对象字面量撞
  no-unsafe-assignment(本仓库首次用这个 matcher)——写 `expectError(result, regex)`
  helper:先断言 `ok` 为 false 再窄化读 error,顺带比 stringContaining 的失败
  输出可读。
- **no-base-to-string 两处**:`String(init.body)`(BodyInit 联合)与
  `String(config.title ?? "")`(unknown)都会被 lint 拒——前者改成 payload
  常量直接 `toBe` 比对(顺带更严格:整串相等而非 parse 后相等),后者
  `typeof === "string"` 收窄。
- **TS 闭包丢窄化**:`run.actionResults` 判空后在 map 回调里再访问报
  TS18047(属性访问在闭包里不保持窄化)——提局部 const。
- **共享 mock 断言错位**:同一 it 里第二个 adapter 用新的 fetch mock,却对第一个
  mock 断言 `mock.calls[0]`——runs 查询串测试的 bare 断言取错了调用;每个
  adapter 配对自己的 mock。
