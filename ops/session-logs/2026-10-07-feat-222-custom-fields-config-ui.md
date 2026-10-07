session_id: hand-written-222-custom-fields-config-ui
branch: feat/222-form-builder-ui
date: 2026-10-07
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

# Session log — feat/222-form-builder-ui — 2026-10-07

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#222 剩余项——**自定义字段配置面 UI + 内容就地改写端点**
  (`/system/custom-fields` + PATCH 扩展)。PR 正文写 Part of #222(#222 仍有
  表单构建器拖放 UI、rjsf 渲染接线、消费域接入等剩余项,严禁 Closes)。
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净;fetch 后
  main 顶端 331b13a(#296)。
- **选题**:①优先续做未完成切片。#226(①等 #206、③等真实需求)、#220/#221
  (等属主域)、#224(等 SMS/#118/真实域)、#110(等 storage/#116)的剩余项
  全被依赖阻塞;#225 剩 Superset 部署面(基建重)。#222 的配置面是唯一有先例
  模式(#289 approval 同款)且不被阻塞的切片。`claim_issue.py claim` 成功。
- **数据库**:本地 postgres 可用,verify 全程带 DATABASE_URL(无 skip)。

### 本切片改动的文件

- `apps/api/src/routes/custom-fields.ts`:PATCH 从「仅 active 翻转」扩为 strict
  内容改写(label/fieldType/options/required/viewableBy/editableBy/active,
  fieldKey/subjectType 是身份不在内容里)。真变更才动行:无实效变更幂等返回
  `{field: current}`,真变更同事务 `nextConfigVersion` + `recordConfigRevision`
  (source=updated,changes 逐字段 from/to)。选项规则按**改后的有效对**
  (fieldType, options)收口 → 422 invalid_options。审计分流:纯 active 翻转
  沿用 `field_activated`/`field_deactivated`;内容变更(含与 active 同次)记
  `custom_fields.field_updated`。
- `apps/api/src/routes/custom-fields.test.ts`:+5 例(内容改写 happy path 带
  台账/审计断言、有效对选项规则五连、no-op 幂等三断言、审计分流、403/strict
  未知键),14/14 绿。
- `apps/web/src/shared/lib/custom-fields-client.ts`(新):字段面适配器
  (list/create/update/history/rollback),与 approval-config-client 同纪律
  (zod 解析、失败模式枚举化、409/422 按服务端 error 词分叉)。
  `FIELD_ROLES` 镜像含 **customer**(与 APPROVAL_ROLES 刻意相反)。
- `apps/web/src/shared/pages/CustomFields.tsx`(新):三道筛选 + 创建面板
  (subject datalist、select 逐行选项、角色勾选)+ 就地编辑面板(身份两键
  不可改)+ 台账史 + 一键回滚;五态各有各的话。
- `apps/web/src/App.tsx`(路由 + 中文裁决注释)、
  `apps/web/src/shared/shell/rail-groups.ts`(System 区一行)、
  `RailIcon.tsx`(新 glyph `fields`:输入框 + 光标,手绘 24 网格,同 stroke spec)。
- `apps/web/src/shared/lib/custom-fields-client.test.ts`(新,5 例)、
  `apps/web/src/shared/pages/custom-fields.test.ts`(新,7 例,源码纪律)、
  rail 测试结构性通过(glyph 唯一性约束满足)。
- `docs/custom-fields.md`(新「配置面 UI + 内容就地改写」节 + 剩余项改写)、
  `docs/audit.md`(field_updated 词条 + 纯翻转词条改写)、
  `packages/db/src/schema.ts`(version 列注释改写,db:generate 零迁移)。
- session log(本文件)随 PR 提交。

## 判断层(本次的关键判断与踩的坑)

1. **「form builder 空注册表」的旧裁决为何不妨碍本切片——先划边界再做。**
   #233 的 session log 曾明确拒绝 #222 form builder UI(「`registerFormSubject`
   空,做出来是 honest-empty-state 壳子」)。本切片刻意不是 form builder:
   做的是**字段定义的配置管理面**(列表/创建/停用/就地改/台账/回滚),对应
   #289 给 approval 配置做过的同一件事。字段定义面有真实数据与真实消费路径:
   defs 可对 `task` 创建(SUBJECT_LOADERS 唯一注册域),值读写 API 全通,
   #224 切片 7 的 `custom_field` 条件块已能按字段键分支——第一天就有用,不是
   壳子。真正等消费域的是 form builder(分组/条件显示/拖放)与 rjsf 渲染接线,
   两者在 #232 §16(设计器选型未决)与「随第一个消费页面进场」的既定裁决下
   保持不动。
2. **fieldType 进不进就地 PATCH:进,跟族契约走,不另立第二套内容契约。**
   曾考虑把 fieldType 挡在 PATCH 外(改型会让旧值按新类型被解读),只许走
   草稿→发布。但 `customFieldDefDraftContentSchema` 本身就含 fieldType——
   草稿发布与回滚两条路都已能改型;PATCH 若更严,同一族就有两套内容契约,
   下一个人必然困惑。真正的风险点不在「哪条门能改型」而在「改型不改值」,
   于是把它写成显式不变式:**值行保留写入时的 JSON,定义修订从不重写已写入
   的值**(与 approval「在飞请求带提交时刻快照」不同向——值的快照在写入
   时刻,不在定义修订时刻),docs 与页面第一屏都说这条。
3. **审计动作分流而非合并:纯 active 翻转保留旧词。** automations 用单一
   `rule_updated` 覆盖一切;但 custom_fields 的 `field_activated`/
   `field_deactivated` 已在词表里且被既有测试钉住——合并成单一词会让「这个
   字段什么时候被停过」的审计查询跨版本断流。裁决:纯 active 翻转沿用旧词,
   内容变更(含与 active 同次)记新词 `field_updated` 一条(changes 全量),
   一事务一审计行不拆两条。docs/audit.md 同步改写,不造死词。
4. **PATCH 返回形状从 `{id, active}` 改成 `{field: 行}`**:旧形状是切片 1
   「只翻 active」时代的最小返回;编辑面板要整行,approval PATCH 的
   `{config: 行}` 是现成先例,跟着先例走,测试同步改。
5. **踩坑(小)**:测试里 `String(init?.body)`/`String(input)` 撞
   `no-base-to-string`,Request/URL 要先 instanceof 窄化;未用参数要 `_` 前缀
   (TS6133)。两处都是 lint/typecheck 层,一次修复。
6. **验证**:`DATABASE_URL=… corepack pnpm verify` 全绿 108 文件 / 978 测试
   (+2 文件 +17,零 skip);本地 postgres 真库集成。db:generate 零迁移
   (schema.ts 仅注释改写)。
