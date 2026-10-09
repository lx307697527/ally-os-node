---
session_id: hand-written-225-template-ui
branch: feat/225-template-ui
date: 2026-10-09
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

# Session log — feat/225-template-ui — 2026-10-09

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#225(配置工作室:报表与模板,phase-1)——切片 1(编号
  规则内核,#273)、编号配置 UI(PR #286)、切片 2(模板内核,PR #329)已合并。
  本切片落 issue 剩余项 1 的**模板管理 web UI**:channels+templates 列表、
  新建、编辑(完整内容对象 PATCH)、版本史+回滚、预览(样例值+missing
  variables)。PR 写 **Part of #225**(issue 保持 open)。
- **前置收尾(第 0 步)**:fetch --prune;发现 open PR #329(切片 2,四项 CI
  全绿、租约已 release)——按双会话裁决查属主死活期间,属主会话自行完成了
  merge(#0709671)、issue 评论、worktree/分支清理。本会话全程只监视未插手,
  确认收尾干净后进入选题。无残留 worktree,主检出干净。
- **选题**:记忆 next(#225 模板管理切片 或 #34 app 层)。#34 验收是 Slack
  告警(纯 infra,gated);#225 剩余项里模板 web UI 数据面刚就绪、numbering
  「内核→UI」节奏的同构续做,claim #225 租约成功。
- **参考**:切片 2 的 `apps/api/src/routes/templates.ts`(六端点语义)+ 切片 2
  session log;页面形态对齐本仓库 numbering 配置页(PR #286);老系统**没有**
  模板管理 UI(p3c 未建),无老面可对照。
- **落了什么**:
  - `apps/web/src/shared/lib/templates-client.ts`:list/detail/create/update/
    rollback/preview 六个 adapter,响应体 zod 解析,失败模式逐 reason 上报
    (forbidden/unavailable + 内核的内容校验词 unknown_channel /
    subject_required / subject_not_allowed / exists(409)/ not_found /
    version_not_found);`channelWantsSubject` 形状镜像表;`KNOWN_TEMPLATE_TYPES`
    已知类型文档表(三封认证邮件+变量四件套)+ `sampleVariableValue`。
  - `apps/web/src/shared/pages/Templates.tsx`:/system/templates 页——诚实状态
    五态(loading/forbidden/unavailable/empty/channels-empty);新建表单
    (channel 下拉来自服务端注册表、类型文本输入、subject 按镜像表显隐、
    HTML 正文);编辑面板(subject/body/isActive 完整对象 PATCH)+ 预览面板
    (服务端 /preview,样例值自动填充+两段渲染)+ 版本史(当前版本无
    Restore 按钮);行上停用态明说「builtin wording」。
  - 接线:App.tsx 路由(/system/templates)、rail-groups(System 区
    「Content templates」行)、RailIcon 新 glyph `stencil`(背后一张纸:模板
    是被揭开后露出内置文案的那张母版)。
- **测试**:client 12 测(mock fetch:读失败模式、PATCH 完整对象形状、两种
  404 分说、预览透传、已知类型表=文档非枚举);页面 10 测(jsdom-free 源码
  文本钉约:路由/三条纪律前置/五态/失败词表/版本史回滚语义/已知类型提示/
  本地检查只拦显然破损)。
- **验证**:`DATABASE_URL=… corepack pnpm verify` 全绿 153 文件 / 1608 测
  (基线 151/1586,+2 文件 +22 测,零 skip)。
- **剩余项(Part of #225,issue 保持 open)**:
  1. 短信 channel(随短信基建进场注册,零 schema 变更;client 镜像表加一行);
  2. #131(邮件模板管理/批量发送/分析)直接吃本内核;
  3. PDF 品牌配置 logo 接缝(#128 剩余②);
  4. Superset 自助报表/仪表盘/定时发送(infra 部署面)。

## 判断层(本次会话的关键判断与坑)

1. **UI 切片不动 API,一个布尔也不为**:列表端点交回 `{channel,label}`,
   不含 subjectRequired——表单要知道「该 channel 画不画主题框」。改 API 是
   一行的事,但为它重开 API 面不值;用 client 侧镜像表
   (`CHANNEL_SUBJECT_REQUIRED`,numbering-client 镜像日期枚举的同款先例),
   兜底方向选「没上表的 channel **显示**主题框」:多画一个框最多换来一句
   清楚的 400(subject_not_allowed 有专属文案),少画会让用户凭空配出
   半封信。今天注册表只有 email(subjectRequired),镜像表一行;短信进场
   时加一行 `sms: false` 即可。
2. **已知类型表是文档不是枚举**:templateType 是开集(切片 2 裁决),UI 若
   做成下拉会把开集杀死。KNOWN_TEMPLATE_TYPES 只收今天真实消费的三封认证
   邮件,匹配到才显示提示(usedBy+变量四件套),匹配不到照配不拦——消费方
   进场时往表里加一行是文档工作,不是准入门槛。提示顺手把 BUG-285 工序
   (name/email 进 HTML 转义、link 永不转义)说到编辑点上。
3. **预览的两段渲染:屏上结果必须等于屏上变量**:首次渲染时变量还没样例值,
   服务端会如实报 missingVariables;若只把样例值填进输入框而不重渲染,
   用户会同时看到「{{name}} 会原样发出」的警告和已有值的变量框——自相
   矛盾。所以填完样例值立即用同一批值再渲染一次(第二轮 referenced 全有
   值,不会循环);渲染权威始终在服务端 /preview,页面不做本地渲染镜像
   (校验/渲染只有一个权威,回答才不会漂)。
4. **当前版本不给 Restore 按钮**:回滚语义=旧内容落成新版本,对当前版本
   点恢复只会空转一版(+1 版本零内容变化,还留一条审计)。列表只对
   非当前版本给按钮,「current」徽标顶替位置——语义噪音在 UI 层就滤掉,
   不靠后端拒绝。
5. **幂等 PATCH 的 UI 回话**:updated=false 时明说「No changes to save」
   (切片 2 的幂等纪律到屏上),并把编辑面板重置为服务器回传的行——
   避免编辑态与已存状态漂移。
6. **坑:jsdom-free 页面测试是源码文本钉约,JSX 换行会把短语劈开**——
   `takes over as\n soon as it is saved` 不等于 `takes over as soon as it is
   saved`,跨行断言用 `\s+` 正则,单行短语才用 toContain;第一版三个断言
   就栽在这。另一个坑:eslint 的 no-base-to-string 禁 `String(init?.body)`
   (BodyInit 可能是对象),house 手法是 mock 里 `typeof body === "string"`
   窄化后再断言(custom-fields-client.test.ts 同款);`as unknown as
   typeof fetch` 在 vi.fn 签名本就合身时是多余断言会被点名。还有:Heading
   组件只收 h1–h3,嵌套小节别用 h4。
