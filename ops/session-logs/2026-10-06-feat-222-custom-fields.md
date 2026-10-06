---
session_id: hand-written-222-custom-fields
branch: feat/222-custom-fields
date: 2026-10-06
reason: issue-222
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/222-custom-fields — 2026-10-06

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#222(配置工作室:自定义字段与表单构建器;#232 §4.4
  「自定义字段与表单」+ §4.9 v2.2「react-jsonschema-form v6 + zod 内置字段
  `z.toJSONSchema()` 合成」)——**切片 1:自定义字段内核(API only)**,
  PR 正文写 Part of #222(切片未完,严禁 Closes 关键字)
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净。
  选题:按上轮会话规划的配置工作室 cluster 顺序(#222 → #224 → #225 →
  #226 → #233),#222 无评论、无阻塞、claim 一次成功。

### 本切片改动的文件

- `packages/db/src/schema.ts`:`custom_field_type` 枚举(text/number/boolean/
  date/select)+ `custom_field_defs`(subject 开集 text + fieldKey 每类型唯一
  + 字段级 viewableBy/editableBy jsonb + version 预埋 #226)+
  `custom_field_values`(多态 subject + 每字段一行 upsert,三元组唯一索引;
  形态与 comments/follows 相同,subject 无外键)
- `packages/db/migrations/0016_needy_hardball.sql`(新,drizzle 生成)
- `apps/api/src/custom-fields/registry.ts`(新):`registerFormSubject` ——
  表单 subject 注册表(属主域给内置字段的 zod raw shape);**本切片刻意为空**,
  测试经同一条接缝注入夹具域(与 esign/workflow 注册表同一裁法)
- `apps/api/src/custom-fields/service.ts`(新):纯函数层 ——
  `fieldValueZod`(按定义现算单字段 zod)、`composeFormSchema`(内置 + 自定义
  铺一个 z.object,`z.toJSONSchema` 导出 input 侧,键撞名炸出)、
  `canViewField`/`canEditField`(空数组 = 不限制;可写必须同时可见)、
  `parseValueSubmission`(完整提交语义,逐键 issues,返回 writes 不碰库——
  属主域可进程内复用)
- `apps/api/src/routes/custom-fields.ts`(新):配置面 POST/GET/PATCH 在
  `custom_fields.configure` 权限点后(创建时收口 select 选项非空无重复、
  非 select 不带选项、键 lower_snake_case、内置键冲突 422);表单面
  GET schema(合成 JSON Schema + 字段元数据)、GET/PUT
  `/api/subjects/:subjectType/:subjectId/custom-fields`(可见性门 +
  逐字段裁决;PUT 一个事务里 upsert + 审计)
- `apps/api/src/routes/registry.ts`:6 条新路由声明(3 permission + 3 session)
- `apps/api/src/authz/permissions.ts`:`PERMISSIONS` 加 `custom_fields.configure`
  (owner/admin 默认;与 workflow/approval.configure 同批配置工作室管理者)
- `apps/api/src/app.ts`:挂载 customFieldsRoutes
- 测试:`apps/api/src/custom-fields/service.test.ts`(11 条纯函数:类型词表与
  pg 枚举 parity、五种字段形状、nullable+optional 不进 required、键撞名、
  字段权限语义、逐键 issues)、`apps/api/src/routes/custom-fields.test.ts`
  (7 条集成,独立临时库:403 门、形状收口、schema 合成、必填/越权/未知键
  服务端拒绝、审计同事务、finance 字段可见性裁剪、停用即隐藏、404 反探测)
- 既有测试更新:`authz/authz.test.ts`、`app.test.ts`(admin 精确权限集断言
  加新权限点)
- 文档:`docs/custom-fields.md`(新:内核文档 + fail closed 层次 + 提交语义 +
  剩余项)、`docs/permissions.md`(权限点现状加 custom_fields.configure)、
  `docs/audit.md`(词表加 custom_fields.* 四个动作)
- **无新依赖**(rjsf v6 + @rjsf/shadcn 随第一个消费页面进场,见 PR 剩余项)、
  **无新 env**

### 验证

- `DATABASE_URL=… corepack pnpm verify` 全绿:**76 文件 / 580 测试**(本地
  postgres = docker ally-os-node-postgres-1,带 DB 集成)
- pre-push 钩子正常跑 verify(未绕过)

## 判断层(手写)

### 本次的关键判断

1. **值存多态侧表,不动业务表**:二十个业务表各加一列 jsonb(URS 老路)的
   反面。Twenty 的元数据侧表形态让「自定义字段可在报表、流程门槛、自动化规则
   中使用」(#222 要点第 5 条)变成按字段键统一查询,属主表零改动、加字段不发版;
   唯一代价是属主行没有物理列,join 一次 defs 读回——内核给出 GET 端点一次拼好。
   subject 无外键与 comments/follows 同一形态,属主记录删除时各域自清。
2. **合成 schema 的 io 语义与撞名防线**:`z.toJSONSchema(..., { io: "input" })`
   ——表单渲染的是「提交者要填什么」,input 侧的 required 数组才对应表单必填。
   可选字段用 `.nullable().optional()`:值可显式置 null(清值)、键可整体缺省
   (不改既有值),两者都不进 required(第一次只写 .nullable(),required 数组
   全中,测试当场抓出来)。自定义键与内置键撞名是配置事故,**写入侧当场拒绝**
   (对照注册表 422 builtin_key_conflict),合成时再兜底炸出——不能悄悄盖掉
   内置字段。
3. **字段级权限是 subject 可见性门之内的第二道门**:canEditField 刻意实现成
   「可写必须同时可见」——写一个看不见的字段是瞎写;集成测试里 finance 用户
   拿着 editableBy 放行去写一条他看不见的任务,得到的是 404 而不是 200,这是
   裁定不是 bug。同理「对该角色不可见的必填字段不强制 required」——不能要求
   提交者填看不见的字段,这类配置本身应配成可见;属主域做整单校验可用管理语境
   调 parseValueSubmission 拿全域视角。读侧更严:看不见的字段连「存在」都不在
   响应里出现(不泄漏存在性)。
4. **完整提交语义,不做部分保存**:必填的可见字段必须出现、可选缺省 = 不改、
   null = 清值。设计里「填到一半也保存为潜线索」(#232 §16)是对外表单的
   草稿语义,属询价向导消费域的职则,内核不预置 partial 开关——第一个消费域
   进场时若确需,在 parseValueSubmission 加显式参数而不是写死宽松语义。
5. **角色数组配 viewableBy/editableBy 而不是权限点**:字段级权限的粒度是
   「角色 × 字段」(老系统只有按表写死的列级 GRANT,没有任何机制),存角色名
   jsonb 数组 + 保存时 roleSchema 收口,与 approval levels 的「配置形状在
   保存时收口」同一裁法;不加新权限点(权限点数量爆炸,且这本质是配置数据
   不是代码授权)。空数组 = 不限制,让 99% 的字段零配置。
6. **注册表空、机制先行**:表单 subject 注册表本切片为空(询价向导与清场
   检查表都在后面),schema 端点对未注册类型回 400——与 esign/workflow/
   approval 三个内核同一先例:机制先行不留产线,不出现「能配字段但没地方
   渲染」的半开机状态。验收第 1 条(详情页和列表显示)与第 3 条(两个消费域
   同一表单引擎)依赖 UI 与消费域,诚实写 Part of #222 并逐条列剩余。
7. **测试用真 authzStore + 真 user_role 表**:tasks 的 assignee 校验查的是
   user_role 表而非 authz 上下文——第一版只喂假 store,createTask 400
   (invalid_assignee)。改用 createAuthzStore(db) + beforeAll 落角色行,
   权限链(RBAC 矩阵 → authz 上下文 → 路由门)端到端,桩面更小。

### 踩的坑(都花时间修了)

1. **`.nullable()` ≠ 不必填**:zod 的 toJSONSchema 只把 `.optional()` 踢出
   required 数组,`.nullable()` 的键照样必须出现——第一版可选字段全进
   required,纯函数测试当场红。正解 `.nullable().optional()`,顺带把「缺省
   = 不改既有值 / null = 清值」两种语义都拿到。
2. **eslint 的双向夹击**:先 `as string` 被 non-nullable-type-assertion-style
   要求改 `!`,再被 no-non-null-assertion 拒——本仓库两个规则同时开,测试里
   的出路口只能用 assert-and-narrow 助手(must()),照抄 user-roles.test.ts。
   另外 zod 的 toJSONSchema 返回类型本来就满足 Record<string, unknown>,
   多余的 as 被 no-unnecessary-type-assertion 抓出来——删掉即可。
3. **optional select 导出成 anyOf**:`.nullable().optional()` 的枚举在
   JSON Schema 里是 `anyOf: [{enum}, {type: null}]` 而不是顶层 `enum`——
   测试断言 `properties.tier.enum` 拿到 undefined。这是合法 JSON Schema
   (rjsf 可渲染),改断言读 anyOf[0].enum,并在 service 注释里记下形状。
4. **exactOptionalPropertyTypes 拦 optional 字段赋 undefined**:
   ValueIssue.detail 想直接赋 `issues[0]?.message`(string | undefined)
   不行——条件展开 `...(message !== undefined ? { detail: message } : {})`,
   与 workflow-templates 路由的既有写法一致。
