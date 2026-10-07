session_id: hand-written-224-condition-registry
branch: feat/224-condition-registry
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

# Session log — feat/224-condition-registry — 2026-10-07

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#224 剩余项 2「条件积木复用 workflow 的注册表形态(跨对象
  条件、自定义字段条件)」——**条件积木注册表切片**。PR 正文写 Part of #224
  (事务短信/报名序列/AI 步骤、更多积木、效果度量等剩余项仍在,严禁 Closes)。
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净;origin/main
  顶端 b8fec57(#293,update_field)即基线。
- **选题**:①优先续做有未完成切片的 issue。#224 昨今两天连并切片 1–6,剩余
  清单里事务短信(等 SMS 通道)、报名序列(等序列域)、AI 步骤(等 #118)、
  update_field 更多可写面(等属主域)都被依赖阻塞,**条件积木是下一个零依赖
  切片**(custom_field_values 按字段键查询已备好,docs 剩余项原文点名),按续做
  优先选它。claim 时租约显示上一任已 release,正常接手。
- **老系统参考(只读)**:条件积木对应老触发器里的 WHEN 条件(TG_TABLE 上的
  WHERE)与 #222 立项承诺「自定义字段可在报表、流程门槛、自动化规则中使用」
  (custom_field_values 表注释同文);路径条件够不着另一张表,这是本切片的空当。
- **数据库**:本地 postgres 可用(5432 端口活着),verify 全程带 DATABASE_URL
  (无 skip)。

### 本切片改动的文件

- `packages/automations/src/index.ts`:条件从单一 path 形状扩为并集
  (pathConditionSpecSchema 原样 + blockConditionSpecSchema `{block 1..100,
  config?}`,z.union 两形状键互斥);op 语义提取为导出纯函数
  `conditionValueFitsOp`(形状闸)/`valueSatisfiesOp`(比较裁决),路径 refine
  与积木实现共用;`evaluateConditions` 起为 async,第三个可选参数
  `evaluateBlock`(ConditionBlockEvaluator 接缝)——积木行未接 evaluator 或
  evaluator 抛错都收成 `{block, passed: false, error}`(fail closed、扫描不停
  摆);ConditionOutcome 起为并集(path 行 / block 行带 error)。包仍零依赖。
- `apps/worker/src/automations/condition-registry.ts`(新文件):
  `registerConditionBlock`/`conditionBlockSpec` 接缝 + `blockConditionEvaluator`
  (未注册 → error 行;积木抛错 → 收编 error;正常裁决透传)。第一个成员
  **custom_field**:config zod(subjectType 1..100、fieldKey lower_snake_case
  1..64、op 四值、value 按形状闸)+ `subjectIdFromTarget`(event 裸 id / due
  前缀 id,前缀不匹配 fail loud)+ 定义行按 (subjectType, fieldKey) 查(存在
  即可,active 不拦)+ 值行按 (subjectType, subjectId, fieldDefId) 查(没写过
  = 解析不到)+ `valueSatisfiesOp` 裁决。
- `apps/worker/src/automations/scanner.ts` + `due-scanner.ts`:求值接上
  evaluator;求值后对带 error 的逐条件行打 `logger.warn`(规则被跳过但原因
  可见)。两个扫描器 import condition-registry 即完成注册(模块装载侧写,
  与 due-registry 同法,worker 引导零改动)。
- 测试:包 +9(block 条件解析矩阵、无 evaluator/有 evaluator/evaluator 抛错/
  混合 AND 不短路/op 语义直测);worker `condition-registry.test.ts` 新文件 4
  (接缝三档答案);worker 集成 +8(custom_field 端到端 event/due 各一、值不符
  诚实 skip、exists 两态、停用字段仍可作条件、字段键笔误/坏 config/未注册积木
  三种 error 行);api 路由 +1(block 条件原样入库 + 空积木名 400 + 换 spec
  台账 +1);web client +2(custom_field 结构化往返、未知积木 json 旁路、
  outcome 两种形状);页面源码纪律 +1。
- `apps/web/src/shared/lib/automations-client.ts`:ConditionDraft 起为标签联合
  (path/custom_field/json 旁路)、conditionToDraft 学习两种结构化形状(不再把
  不认识的形状吞成空 path 条件)、buildConditions 双形状 + 共享
  buildConditionValue、ConditionOutcomeView 起为标签联合(path/block 带
  error)。
- `apps/web/src/shared/pages/Automations.tsx`:条件编辑器加 Kind 选择器
  (路径/自定义字段/原样 JSON),custom_field 分支(Record type + Field key +
  共用 op/value 控件),fail-closed 脚注;详情列表画 `block · 名字 · config`;
  runs 条件格画 block 裁决与失败原因。
- `docs/automations.md`:「条件积木注册表」专节(形状/注册表/fail-closed
  分寸/custom_field/op 单源/不短路/UI)+ 剩余项 2 改写(机制已落,更多积木随
  属主域进场)。
- 无 API 路由改动(保存面由共享 schema 自动收口)、无迁移、无新 env。

## 判断层(本次的关键判断与踩的坑)

1. **并集不加判别键,不做硬切。** due 触发切片对旧 trigger 形状做了硬切
   (「上线前数据,无 migration」);条件这里没必要跟着切——path 与 block 两
   形状靠必填键(path+op vs block)天然互斥,z.union 顺序即裁决,存量规则零
   迁移、存量测试零改语义。给条件加 `kind: "path"` 判别键看似更整齐,代价是
   所有现存规则 JSON 与全部 UI 草稿模型陪葬——形状上有更便宜的路时,破坏性
   迁移不是纪律,是浪费。
2. **注册表跟执行走:自动化的积木在 worker,workflow 的在 api。** 看似同类
   的两个注册表落点不同,原因是执行进程不同(workflow 引擎在 api 进程,自动化
   扫描/求值在 worker)。保存面(API)两边都看不到 worker/api 之外的注册表时,
   用同一条 fail-closed 裁决兜底(存得进、跑必败、告警)——裁法统一,落点跟随
   执行,不为了「保存时就报错」制造跨进程编译依赖。
3. **「没法求值」既不是「不满足」也不是「失败重试」。** 三档答案分得很开:
   正常裁决(false)= 诚实 skip,无 error 无告警;求值不了 = skip + error 落
   run 行 + warn 告警、**不进重试**——条件是过滤器,重试修不了配置错,重试
   只会把告警刷屏;动作(如 update_field)才走 fail-loud-then-retry。把过滤器
   的配置错误塞进重试协议,是把两套语义搅在一起。error 落在逐条件结果里而不
   是 run.error:它回答的是「哪个条件、为什么没过」,不是「这次执行为什么失败」。
4. **op 语义提取成包的导出纯函数,不为 DRY 的名义,为「两种形状一份裁决」。**
   custom_field 的 eq/ne/in/exists 若在 worker 重写一遍,路径条件与积木条件对
   同一个 op 的边角(undefined、null、in 空数组)必然漂移;tests 里把
   valueSatisfiesOp/conditionValueFitsOp 直测钉住,两边共用即两边同寿。
5. **坑:custom_field_values.value 列 NOT NULL,而 drizzle 把 JS null 写成
   SQL NULL。** 测试想钉「显式 null 清值也是在场值」时当场撞 23502——顺藤摸
   瓜发现 **#222 的 PUT 路由对可选字段显式 null 的清值提交会 500**(service 层
   parseValueSubmission 放行 null,插入层被 NOT NULL 拒),这是 #222 切片的
   潜在 bug,不属于本切片(不顺手修),已如实记入 PR 上报。本切片的测试改为只
   覆盖可达路径(值行存在/不存在),代码注释不过度承诺。
6. **坑:集成测试中段 TRUNCATE 两次漏表。** 第一次漏 automation_rules(第一
   条规则还在匹配第二个事件),第二次漏 custom_field_values(值行活着,exists
   恒真)——两次都是「测试前半段的状态漏进后半段」。教训:多表测试的中间重置
   要按「这段测试的先行条件」整组清,不是「刚才写了哪张就清哪张」。
7. **UI 纪律的坑是现成的:conditionToDraft 会把不认识的形状吞成空 path 条件。**
   切片 3 的 json 旁路只覆盖了 trigger/action;conditions 一旦长出 block 形状,
   老解析器就把 `{block: …}` 变成 `{path: "", op: "eq"}`——编辑一次即静默销毁。
   所以本切片把 client 的草稿模型升级为标签联合(custom_field 结构化 + json
   旁路),页面源码纪律测试钉死「不认识的形状原样往返」;这也是「给开集加形状
   时必须同时教 UI 认路或教 UI 让路」的具体化。
8. **求值不短路是观测决策,不是性能疏忽。** AND 语义短路更省,但 runs 的
   逐条件结果承诺「完整回答为什么没触发」;一条命中三次的规则,第三次想知道的
   是三个条件各是什么裁决,不是只看到第一个 false。积木求值可能带查询,不短路
   有成本——先按可观测走,真有昂贵积木时再议短路豁免(写进 docs 的分寸)。
9. **停用的自定义字段仍可作条件,是裁决不是疏漏。** 停用 = 表单不再渲染、
   值冻结;规则作者明确点名了这个 fieldKey(规则比字段的生命周期长是常态)。
   定义行整个不在(键笔误、域从未配过)才是 error——「配置存在但停用」与
   「配置不存在」必须是两种答案。

## 验收对照(本切片范围)

- [x] 「条件:基于对象字段(含自定义字段)的组合条件」——自定义字段条件经
      custom_field 积木落地(op 语义与路径条件同源),集成测试端到端覆盖
      (event 与 due 两种触发、正反例、error 三态)
- [x] 「每次执行留日志:逐条件结果」——block 条件的裁决与失败原因落
      automation_runs.conditionResults,runs UI 原样可读
- [x] 「不改代码即可新增规则」对条件积木成立:建「VIP 任务更新即通知」规则
      (task.updated → custom_field 条件 → notify)零代码,automations.test.ts
      端到端覆盖
