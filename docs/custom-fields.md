# 自定义字段与表单引擎（#222）

老系统**没有任何自定义字段机制**：询价向导是 3686 行写死 HTML
（`apps/landing/public/quote/index.html`），同一组字段在前端 HTML、
`apps/allyos/src/shared/lib/intake-fields.ts`（原话 "character for character
copy"）、SQL 函数签名与 CHECK 约束四处手工同步，靠 parity 测试防漂移——加一个
字段要同时改四处并发版；唯一「动态」的 `crm.inquiries.submission_payload` jsonb
用 CHECK 约束把未知 key 钉死（feat288 p2 的「UNREPRESENTABLE」）。清场检查表、
字段级权限在老系统不存在（最接近的只有按表写死的列级 GRANT）。

新设计（#232 §4.4/§4.9 v2.2）把字段做成**配置工作室的一种可配置对象**：自定义
字段存元数据表（Twenty 的元数据表 + ERPNext「不改表结构加字段」的裁法），内置
字段由属主域用 zod 定义、`z.toJSONSchema()` 导出，两者**合成一份 JSON Schema**
——前端 react-jsonschema-form v6（`@rjsf/shadcn`）渲染和服务端校验共用同一条
定义，不存在两处各写一遍「必填/类型/选项」的漂移面。值存多态侧表（每字段一行），
报表/流程门槛/自动化规则能按字段键统一查询，属主业务表零改动。

## 已落地：自定义字段内核（#222 切片 1，API only）

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 数据模型 | `packages/db/src/schema.ts`（migration `0016`） | `custom_field_defs`（subject 开集 text + fieldKey 每类型唯一 + 五种字段类型 + 字段级 viewableBy/editableBy + version = #226 台账版本）、`custom_field_values`（多态 subject + 每字段一行 upsert，值唯一索引防并发双插；形态与 comments/follows 相同，subject 无外键，属主记录删除时各域自清） |
| 表单 subject 注册表 | `apps/api/src/custom-fields/registry.ts` | `registerFormSubject(type, { builtin })`——属主域给出内置字段的 zod raw shape；本切片注册表为空（询价向导与清场检查表两个消费域都在后面），schema 端点对未注册类型回 400，不出现「能配字段但没地方渲染」的半开机状态。测试经同一条接缝注入夹具域 |
| 纯函数层 | `apps/api/src/custom-fields/service.ts` | `fieldValueZod`（按定义现算单字段 zod：类型/长度/选项/日历日在服务端收口）、`composeFormSchema`（内置 + 自定义铺进一个 z.object，`z.toJSONSchema` 导出 input 侧；自定义键与内置键撞名炸出）、`canViewField`/`canEditField`（空数组 = 不限制；**可写必须同时可见**——写看不见的字段是瞎写）、`parseValueSubmission`（完整提交语义：未知键/越权键/类型错/必填缺逐键报错，返回 writes 由调用方定事务边界）。属主域可在进程内直接复用，与 esign/approval 的进程内接缝同一裁法 |
| 路由 | `routes/custom-fields.ts` | 配置面（POST/GET/PATCH）在 `custom_fields.configure` 权限点后；表单面（schema 合成、字段值读/写）登录即可——subject 可见性门（subjects/registry.ts，与评论/活动/关注同一扇）+ 字段级权限逐字段裁决。fieldKey/subjectType 是身份创建后不改写；其余内容就地 PATCH（strict、真变更才动行，#226 后续切片的「内容改写端点」已随配置面 UI 切片进场），每次真变更 bump 版本记台账 |
| 权限点 | `authz/permissions.ts` | `custom_fields.configure`：加字段 = 改所有人的表单，配置工作室归 owner/admin；**填值**不在此点后——可见性门 + 字段级 viewableBy/editableBy 各裁各的 |
| 审计 | `docs/audit.md` 词表 | `custom_fields.field_created` / `field_activated` / `field_deactivated` / `values_updated`（target = subject id，detail 记 fieldKeys——subject 引用在 detail，进对象活动流时间线） |

## 字段级权限的语义（fail closed 的层次）

1. subject 对调用者不可见 → 404（反探测，与任务详情同答；类型未注册 400）；
2. 字段对调用者角色不可见（viewableBy 不放行）→ 读响应里**连存在都不出现**，
   提交侧按 not_editable 拒——可写必须同时可见；
3. editableBy 不放行 → 逐键 422 `not_editable`，整单拒绝（一个字节不落库）；
4. 未知键 / 停用字段的键 → 422 `unknown_field`；类型或选项不符 → 422 `invalid`；
5. 「对该角色可见」的必填字段缺失 → 422 `required`；**对该角色不可见的必填字段
   不强制**（不能要求提交者填一个看不见的字段——这类配置本身应配成可见；属主域
   做整单校验时可用管理语境调 `parseValueSubmission` 拿全域视角）。

## 提交语义

完整提交（表单整张交上来）：必填的可见字段必须出现；可选字段缺省 = 不改既有值，
显式 `null` = 清值 = **删值行**（不存 SQL NULL：`value` 列 NOT NULL 是跨模块契约
——worker 的 `custom_field` 条件块依赖「行在场即有 JSON 值」，行不在场 = 未填或
已清，`eq`/`ne` 不满足、`exists` 表达「必须有/没有」）。值 upsert（一记录一字段
一行，唯一索引兜并发），updated_by / updated_at 随写更新，审计行与值写入同事务
（含清值时 detail 的 `clearedFieldKeys`）。

## 已落地：配置面 UI + 内容就地改写（#222 配置面切片）

- **`/system/custom-fields`（System 区 rail「Custom fields」）**：字段定义的
  配置面。列表带 subject 类型/状态/文本三道筛选，行 = 键/标签/类型与选项/
  访问摘要（required + 逐组角色或「所有人」）/状态/版本；创建面板（subject
  类型带 datalist 建议、lower_snake_case 键、五种类型、select 逐行选项、
  required、viewableBy/editableBy 角色勾选——customer 在词表里，字段可以给
  客户看）；就地编辑面板（身份两键不可改）；`/system/audit` 同款的 #226
  台账史 + 一键回滚（回滚 = 恢复版记为新版、历史不改写、可带原因）。
  服务端 `custom_fields.configure` 门，无权限的账号在页面里得到明确答复。
- **内容就地改写端点（PATCH 扩展）**：`PATCH /api/custom-fields/:id` strict
  收口 label/fieldType/options/required/viewableBy/editableBy/active——
  fieldKey/subjectType 是身份不在内容里；无实效变更幂等返回（不留审计、不
  记账）；真变更同事务 bump 版本 + 记台账 `source=updated`。选项规则按
  **改后的有效对**收口：select 必须带非空无重复选项、其余类型不带——不许把
  select 改成没有选项，也不许给文本字段挂选项。审计：纯 active 翻转沿用
  `field_activated`/`field_deactivated`；内容变更（含与 active 同次）记一条
  `custom_fields.field_updated`，detail 带逐字段 from/to。
- **改型不改值**：fieldType/options 改写（含回滚、草稿发布两条路）从不重写
  已写入的值——值行保留写入时的 JSON，读方按定义现值解析；这条纪律与
  「编辑只影响之后的提交」的快照裁决不同向（值的快照在写入时刻，不在定义
  修订时刻），是字段引擎自己的不变式。

## 刻意不在这切片里的（#222 保持 open）

- **表单构建器 UI（拖放、分组、条件显示）**：配置工作室前端进场（拖放设计器
  选型见 #232 §16——Formily 设计器还是基于 rjsf 自建，第 2 期前定）。
- **react-jsonschema-form 渲染接线与详情页/列表展示**：`@ally/ui` 先行
  （slice-1 子集），rjsf v6 + `@rjsf/shadcn` 随第一个消费页面进场。
- **第一个消费域**：询价向导（#207/#227 的对外表单）与清场检查表
  （phase-3/4 内部检查表）注册各自的内置字段、把 `parseValueSubmission` 接进
  各自的提交事务——两域共用同一个表单引擎（#222 验收第 3 条）。
- **对外（未登录）表单提交**：询价向导的公开提交面随获客模块切片设计（防刷、
  限流、turnstile），不预置匿名写路径。
- **配置版本、审计与回滚（#226）**：台账已进场——字段创建即记 v1，停用/恢复
  与内容改写各记一版且可回滚（docs/config-versions.md）；草稿层与一键发布已
  进场（字段草稿过族契约后一键发布，同 docs）；就地改写已进场（PATCH，见上
  节）；受监管变更控制门是 #226 剩余切片（等 #206）。
- **报表 / 流程门槛 / 自动化规则中使用自定义字段**：值侧表已可统一按字段键查询，
  消费方随 #224/#225/#233 进场。
