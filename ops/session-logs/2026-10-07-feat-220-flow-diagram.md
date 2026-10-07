---
session_id: hand-written-220-flow-diagram-ui
branch: feat/220-flow-diagram
date: 2026-10-07
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

# Session log — feat/220-flow-diagram — 2026-10-07

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#220 剩余项「流程图 / 模板编辑 UI(配置工作室前端)」
  (#282 合并评论的剩余清单原文)。切片 1 内核 #268、切片 2 定义改写+发布
  #282 已落地 API 面;本切片补配置页,PR 写 Part of #220(第一张真实模板 /
  超时投递 / #206 门仍在,严禁 Closes)。
- **前置收尾(第 0 步)**:fetch --prune、无 open PR、无残留 worktree、主检出
  干净且与 origin/main 同步(a9f1bbe)。
- **选题**:phase-1 剩余按编号升序——#219 剩余(签名墙页面)要等第一个有签署
  历史的承载页,#220 流程图 UI 是最小可独立验收增量;claim 原子租约成功。
- **老系统参考**:docs/workflow.md 已裁决——老系统零可配置流程(线索 10 态
  frozen 边表 + TS 硬编码镜像),本页是新设计,无旧代码可搬。
- **数据库**:本地 postgres 可用(容器已起),全量测试带 DATABASE_URL 跑
  (99 文件 / 822 测试,无 skip)。
- **渲染冒烟**:throwaway vitest 文件把 WorkflowDiagram 渲成静态 SVG
  (react-dom/server),本地 http.server + IAB 截图目检两轮(发现并修复
  「边标签被节点矩形吃掉」),临时产物全部删除后才提交。

### 本切片改动的文件

- `apps/web/src/shared/lib/workflow-diagram.ts`(新):服务端引擎的 web 读侧
  孪生——两种流转形态归一 + 手写结构解析(逐字段可读错误、未知键宽容、
  悬空 initial/未知 target/自环 fail loud)+ 确定性分层布局(BFS 跳数分层、
  层内字母序、前向边右→左侧、回边/同层边下方绕行、并行流转分车道、
  bezier 中点锚标签)
- `apps/web/src/shared/lib/workflow-diagram.test.ts`(新,15 例):解析矩阵、
  分层/不重叠/画布包含/x 单调、并行车道、回边下绕、环终止 + 确定性、边序
- `apps/web/src/shared/lib/workflow-client.ts`(新):list 读 + create/update
  写;失败模式判别 union(403/404/409 exists vs default_exists/422 带
  invalid_definition detail 或 unknown_block 缺名/unavailable),响应 zod
  收口;`UpdateTemplateInput` 类型上没有 templateKey/subjectType 这条路
- `apps/web/src/shared/lib/workflow-client.test.ts`(新,4 例):fake fetch
  全失败模式矩阵(含 SPA fallback HTML → unavailable、行类型坏 → unavailable)
- `apps/web/src/shared/components/WorkflowDiagram.tsx`(新):纯展示 SVG
  (viewBox 缩放、marker 箭头 useId 防重、节点/边 `<title>` 说人话、
  标签层画在节点之后 + 卡片色 halo);角色/门槛/理由约束进边标签
- `apps/web/src/shared/pages/WorkflowTemplates.tsx`(新):列表 + 详情(保存
  定义的图)+ 新建(subject type 开集自由输入 + 定义骨架预填)+ 编辑
  (JSON 文本框 + 实时图预览;身份不可改说出口);五个读状态与全部写失败
  原因各有各的话;纪律前置——「在飞实例持有启动时定义」进第一屏与保存 flash
- `apps/web/src/shared/pages/workflow-templates.test.ts`(新,7 例):jsdom-free
  源码纪律——路由/rail 接线、纪律句、编辑面板无身份输入、状态文案、
  409/422 文案、预览与详情同一条 parse→layout 渲染路径、subject 开集
- `apps/web/src/App.tsx`:/system/workflows 路由;`rail-groups.ts`:System 区
  +1 行(icon 留空——RailItem 的可选 icon 分支本就为「行先于其标记」而设)
- 文档:`docs/workflow.md` 新增「配置工作室前端」一节;剩余清单把「后台流程图
  / 模板编辑 UI」替换为更细的「草稿/发布 UI」「可视化拖拽设计器」两条
- 验证:裸 verify 全绿(67 文件/501 测试),DATABASE_URL 全量 99 文件/822
  测试全绿;pre-push hook 同门再跑一遍

## 判断层(手写)

### 关键判断

1. **选「流程图 UI」而非 #219 签名墙:#219 的剩余明确写着「随第一个有签署
   历史的承载页」,而审批页只管在飞——硬做就是把半成品挂在没有业务的页面上;
   #220 的 UI 是 #282 评论里点名的、不欠依赖的最小增量。** 切片边界照
   「流程图 + 模板编辑」一刀:JSON 文本编辑 + 实时图预览是完整闭环(服务端
   四门是权威),拖拽式设计器明确记进剩余清单而不是顺手开坑。
2. **web 侧定义解析是手写的,注释里写明这是取舍不是事故。** AGENTS.md 说外部
   输入走 zod;但引擎的 zod schema 在 apps/api,web 不能跨 app import,而
   渲染面真正要的是「逐字段可读错误 + 未知键宽容」——zod 的 shape 错误是
   一句话的笼统报错。响应信封(workflow-client)仍是 zod(扁平组合,zod 的
   强项);解析器单测 15 例钉住行为等价。两层各用各的工具,判据是错误要不要
   能被人读。
3. **UI 对「能配置但没人消费」诚实:** subject type 是开集(服务端刻意如此,
   属主域进场前先把流程配好),所以创建表单是自由输入不是注册表下拉;页面对
   「模板为空」给真实空态,不造假数据。
4. **预览与详情走同一条 parse→layout 渲染路径,源码测试钉住。** 若编辑预览
   另写一条渲染链,「预览画得出、详情画不出」(或反过来)就会成为真实故障
   模式;单一 parseDraft 函数是结构保证,不是巧合。
5. **渲染冒烟作为本切片的质量门之一。** 布局是纯函数有单测,但 SVG 画出来
   长什么样只有眼睛知道——throwaway 渲染 + 截图目检发现「标签被节点盖住」
   一处,修完(标签层移到节点后)再截一轮才放手;临时文件全删,不进提交。
6. **rail 行不加 glyph。** RailItem.icon 可选分支的注释原文就是「行可以存在
   于其标记被选中之前」;hard-code 一个凑数图形反而违反 #286 手绘 spec 的
   纪律,空着让下一个有审美的切片认领。

### 踩的坑

- **测试夹具的括号层级写错,差点产出「zod 非确定性丢键」的假结论。** liberal
  测试里 `done: {}` 写在了 definition 顶层而不是 states 里,于是解析器(先
  zod 后手写)持续报「unknown target done」。我做了 8 个探针去追「zod v4
  record 静默丢键且跨进程不稳定」,最后 `JSON.stringify` 原始输入才看见
  done 是 initial 的兄弟键。教训:怀疑库之前先 stringify 输入;模块头注释
  里那句「手写是因为 zod 有 bug」已改回诚实版本(手写是为了可读错误与宽容
  未知键)。
- **jsdom-free 仓库里「渲染测试」的真身是源码文本断言**,新增页面照 numbering
  先例写 `.test.ts`(非 tsx);若以后真的需要运行时组件断言,vitest +
  react-dom/server 是本仓库可用的最小通道(本次冒烟已验证)。
- **eslint consistent-type-definitions + non-nullable-type-assertion-style 老
  组合(gotcha 73)**:联合类型对象字面量要 interface;`as number` 收窄要用
  must() 助手。照旧。
- **SVG marker id 是文档全局的**——详情图与编辑预览可能同时在场,useId()
  铸每个实例自己的 id,否则第二个图的箭头引用第一个图的 defs。
- **边标签画在边层会被节点矩形盖掉**(节点后画):分层画序 = 边路径 →
  节点 → 标签,标签带卡片色 paintOrder halo,跨盒子边仍可读。
