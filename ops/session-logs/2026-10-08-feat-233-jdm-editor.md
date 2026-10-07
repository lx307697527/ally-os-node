---
session_id: hand-written-233-jdm-editor
branch: feat/233-jdm-editor
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

# Session log — feat/233-jdm-editor — 2026-10-08

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#233(规则注册表,phase-1)——剩余项「决策表的 JDM 拖拽
  编辑器」。PR 正文写 **Part of #233**(gate 种子随 #220、治理字段编辑随 #206、
  #223 等消费域自己的表,保持 open)。
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净(顶端
  5d9aa74,#308 已合并)。
- **选题**:①优先续做有未完成切片的 open issue。盘点 phase-1 各 issue 剩余项:
  #219(签名墙页面随承载页)、#220(全部随属主域/#116/#206)、#221(金额域首
  接线随 #229/#231)、#222(表单构建器 UI 设计器选型 #232 §16 未决、rjsf 随
  首个消费页、外部表单面随消费域)、#224(事务短信/AI 步骤等外部通道)、#225
  (Superset 部署面+模板随 #128)、#226(发布门随 #206)——全部 gated;唯一
  自包含且有真实消费域(审批路由已用决策表)的是 #233 的 JDM 拖拽编辑器。
  `claim_issue.py claim --issue 233` 成功。
- **数据库**:本地 postgres 可用(docker compose 的 ally-os-node-postgres-1),
  verify 全程带 DATABASE_URL,**123 文件 / 1220 测试零 skip**。

### 本切片改动的文件

- `apps/web/src/shared/lib/rules-client.ts`:
  - 决策表编辑器纯函数层(全部离 DOM 可单测):`TableDraft`/
    `TableColumnDraft`/`TableRowDraft` 类型(列与行带**稳定句柄 key**);
    `emptyTableDraft`/`formatTableDraft`(宽容解析,形状不符 → null)/
    `serializeTableDraft`(镜像服务端形状规则先拒一轮:唯一 id、≥1 输出列、
    20/20/500 上限、孤儿单元格逐条指名)/`moveTableRow`/`moveTableColumn`
    (kind 内重排)/`addTableColumn`/`removeTableColumn`(末输出列拒删)/
    `addTableRow`/`removeTableRow`/`patchTableColumn`/`setTableCell`。
  - **显示解析修正(回归修复)**:`parseDecisionTableDisplay` 原按 rules 为
    对象解析,服务端(`decisionTableValueSchema`)存的是 **rules 数组**(每行
    自带 `_id`)——真实值(0024 种子表在内)一律画不出网格、只能回退原始
    JSON。改为按数组形状解析、行序 = 存储顺序(first 策略下行序即路由序,
    显示不再重排),行 id 取行内 `_id`,缺失时 `row_N` 兜底。
- `apps/web/src/shared/components/DecisionTableEditor.tsx`(新):网格编辑器
  ——hit policy 下拉(first/collect 语义各说清楚)、列头三输入(id/field/
  label)+ 增删 + kind 内拖拽、行手柄拖拽重排 + 逐格文本编辑、末输出列禁删、
  空单元格语义明说(输入空=恒真,输出空=不产出)、空表状态自己开口(fail
  closed)。HTML5 原生拖拽,零新依赖;拖拽只从 ⠿ 手柄发起(单元格输入不被
  劫持);组件不碰网络。
- `apps/web/src/shared/pages/RulesRegistry.tsx`:decision_table 的变更表单出
  「Grid / JSON」双面——打开按值定型(`formatTableDraft` 非 null 走网格,
  待填规则走 `emptyTableDraft`,画不出退 JSON);网格提交先过
  `serializeTableDraft`(issues 原样亮出、不发请求),服务端 zod + 编译探针
  仍是唯一权威;JSON 模式保留原文本框 + 只读预览作为显式逃生口。
- 测试:`rules-client.test.ts` +12 例(round-trip 不改写未触碰的值、改名列
  id 不搬格子、孤儿单元格指名拒存、行序即路由序、kind 内重排、碰撞 free
  id 生成、空表合法等;显示解析回归钉 0024 种子形状);`decision-table-editor
  .test.ts`(新,7 例源码断言);`rules-registry.test.ts` +3 例(双面切换、
  客户端结构闸、按值定型)。
- `docs/rules.md`:「配置工作室 UI」增网格编辑器专条(稳定句柄、纯函数层、
  双面切换、服务端唯一权威、孤儿单元格不静默消失);「刻意不在这切片里的」
  划掉 JDM 编辑器并注明格内高亮随消费域;显示解析修正单独成条。

## 判断层(手写)

### 关键判断

1. **单元格以稳定句柄为键,永不以可编辑的列 id 为键**。第一版设计是 cells
   直接按列 id 键、改 id 时同步 re-key 所有行——被自己否掉:用户清空 id 准备
   输入新值的那个 keystroke,cells 全部悬空。改为 format 时给列/行铸一次性
   句柄(`col-N`/`row-N`),cells 按句柄键,serialize 时才映射回 id——改名
   在任何中间态都不搬数据,round-trip 测试钉住「改名只改值里的 id,不动格子」。

2. **编译探针不进浏览器——客户端只镜像形状规则,服务端仍是唯一权威**。三个
   候选:(a) web 打包 @gorules/zen-engine 做逐格即时校验——被否:zen-engine
   是 WASM,为打字时的红线把引擎塞进 bundle 不值;(b) 只靠服务端 400 回来——
   被否:纯 JSON 时代已经证明 issues 面板够用,但网格让「哪一格错了」可指认,
   客户端至少该挡住结构性硬伤;(c) 选它:`serializeTableDraft` 镜像 zod 形状
   规则(唯一 id、≥1 输出、上限、孤儿格)先拒一轮,语法错仍由服务端编译探针
   沿既有 issues 面板逐格原样回来。与「预览≠保存权威」同一条纪律的两半。

3. **显示解析 bug 就地修,不算范围蔓延**。format→serialize round-trip 测试
   跑 display 对比时红,顺藤摸出既有 `parseDecisionTableDisplay` 按「rules 为
   对象」写,而服务端存数组——意味着 #280 落地的只读网格对**任何真实值**
   从未画出过(全部静默回退 raw JSON,0024 种子表也不例外)。判断:这是编辑
   器切片的读侧孪生(网格显示与网格编辑器共用同一条形状事实),不动它,编辑
   器的「打开即网格」对真值永远不成立;修复带回归测试钉种子形状,PR 正文单独
   说明。教训方向:只读网格切片当初的测试用的是对象形状夹具——夹具照着解析
   器写而不是照着存储形状写,测试绿了功能却从未对真值工作过。

4. **JSON 模式保留为显式逃生口,孤儿单元格拒绝静默消失**。画不出的值(JSON
   解析失败/形状不符)退回 JSON 文本模式——网格不假装什么都能画,与显示侧
   「画不出回退 raw JSON」同一裁法;行里引用已删列的孤儿格子,从网格保存被
   指名拒存并指路 JSON 模式,而不是默默丢弃 corrupt 数据。两边共享同一个
   serialize 结果,「Grid/JSON 只是一张表的两种看法」由切换函数互证。

5. **HTML5 原生拖拽 + 手柄发起,零新依赖**。dnd 库(dnd-kit 等)为一个
   「行/列换位」引入依赖不值;原生 DnD 的两个坑逐一处理:Firefox 要求
   setData 才肯起拖;拖拽源若是整行/整列,单元格里的文本输入会被拖拽劫持——
   draggable 只放手柄 span 上。列拖拽的跨 kind 拒绝放在纯函数层
   (`moveTableColumn` 只在 kind 切片内重排),组件层即便传错 index 也穿不过去。

6. **选题裁法**:剩余项里「随 X 进场」的延后标注要逐条验真而非照抄——盘点
   后 phase-1 只有 #233 的 JDM 编辑器无前置;它也不是 UI 大而化之的「待定」
   (#222 的表单拖放设计器才挂着 #232 §16 的未决选型),决策表的列/行模型
   已被 #280 的只读网格和 #221 的消费域钉死,作成面只是补齐同一形状的写侧。

### 踩坑

- **`_id` 先被当普通单元格**(判断 1 的前身):formatTableDraft 第一版把行内
  `_id` 也收进 cells(键 `_id` 不是任何列 → serialize 报孤儿格),round-trip
  测试当场红——「显示解析器读对象形状」的既有 bug 就是追这条失败的断言时
  顺藤摸出来的,一石二鸟。
- **源码文本断言与 lint 规则耦合**:为过 prefer-optional-chain 把
  `dragged.kind !== target.kind` 改写成 `dragged?.kind !== target?.kind`,
  源码断言跟着红。写源码断言应挑语义短语(「A table needs at least one
  output column」)而非实现短语;本切片残留的实现短语断言(?. 形态)已在
  修完 lint 后同步,后续改动仍可能要跟着动——记下这笔取舍。
- **Windows bash heredoc 追加截断**:大段测试用 `cat >> … << 'EOF'` 追加在
  文件尾部被截断(EOF 未被识别),测试文件缺尾导致语法错。改用 Edit 工具
  补齐;之后的文件写入一律走 Write/Edit。
