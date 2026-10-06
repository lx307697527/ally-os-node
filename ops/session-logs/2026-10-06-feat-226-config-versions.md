---
session_id: hand-written-226-config-versions
branch: feat/226-config-versions
date: 2026-10-06
reason: issue-226
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/226-config-versions — 2026-10-06

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#226(配置工作室:配置版本、审计与发布;#232 §4.4/§4.9
  「配置版本与发布自建:状态机、决策表、表单 schema 统一纳入同一套版本、审计、
  回滚」)——**切片 1:配置版本台账内核**,PR 正文写 Part of #226(严禁 Closes)
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净。选题按
  既定接续计划:phase-1 剩余 = #226(五个内核 #220/#221/#222/#224/#225 的
  version 列全部预埋等它,是后续所有配置工作室切片的解锁项)→ #233 →
  phase-2+(#207 最低)。

### 本切片改动的文件

- `packages/db/src/schema.ts`:`config_revisions` 表(subjectType 开集 text +
  多态 subjectId 无外键 + version + snapshot jsonb + changes jsonb + source
  枚举 created/updated/rolled_back + changedById),unique(subject_type,
  subject_id, version);五族配置行 version 列的「恒 1 预埋」注释全部改写为
  「台账最新版」语义
- `packages/db/migrations/0019_*.sql`:drizzle 生成表/枚举/索引 + **手写段**:
  ①存量行补账(五族 INSERT..SELECT,快照形状与 families.ts 逐一同构);
  ②append-only 触发器(`config_revisions_is_immutable()`,与 0007/0012/0013/
  0014 同一裁决)
- `apps/api/src/config-versions/registry.ts`(新):注册缝
  `registerConfigSubject`(label + configurePermission + 可选 applyRevision)
- `apps/api/src/config-versions/service.ts`(新):`nextConfigVersion` /
  `recordConfigRevision` / `listConfigRevisions` / `getConfigRevision` /
  `rollbackConfig`(回滚 = 前滚新版本,append-only 不破)/ `diffSnapshots`
  (路径级深差异)/ `jsonEqual` / `topLevelChanges`;领域错误四枚
- `apps/api/src/config-versions/families.ts`(新):五族快照契约(导出
  snapshotXxx 构建器供配置面用)+ 三族 applyRevision(custom_field/automation/
  numbering);workflow/approval 刻意不带(无就地改写路径 → 回滚 409)
- `apps/api/src/routes/config-versions.ts`(新):subjects 列表 / 版本史 /
  单版详情 / diff / rollback 五端点,**权限按族动态裁决**(路由内检查 =
  各族配置面同一权限点);rollback 错误 → 4xx 映射
- `apps/api/src/routes/registry.ts`:五条路由声明(kind: "session" + 注释说明
  族内动态权限,403 面由 config-versions.test.ts 覆盖)
- **五族配置面接入**(每次真实变更与配置行写入同一事务记一版):
  `workflow-templates.ts`/`approvals.ts`(POST 包事务 + v1)、
  `custom-fields.ts`(POST v1 + PATCH active 翻转记版,**新加 real-change-only
  幂等门**)、`automations.ts`(POST v1;PATCH 从「spec 变更才 +1」改为**台账
  记账:任何实效变更都记版**,新加 no-op 幂等返回;DELETE 不变,台账留史)、
  `numbering-rules.ts`(POST v1;PATCH 记版,纪律文案从「历史由审计承载」改为
  「台账 + 审计」)
- `apps/api/src/app.ts`:挂载 configVersionsRoutes + families side-effect import
- 测试:`routes/config-versions.test.ts`(8 条集成,独立临时库:注册表清单/
  404/跨族动态权限 403/自动化全生命周期 v1→v3/详情与 diff/回滚端到端+审计/
  numbering+custom-field 族回滚/create-only 族 409/append-only 触发器)、
  `config-versions/service.test.ts`(6 条纯函数:jsonEqual/topLevelChanges/
  diffSnapshots);`automations.test.ts` 的 PATCH 纪律测试改写为新语义
- 文档:`docs/config-versions.md`(新);workflow/approval/custom-fields/
  automations/numbering/audit 六份文档的 #226 相关过时表述更新
- **无新依赖、无新 env**

### 验证

- `DATABASE_URL=… corepack pnpm verify` 全绿:**83 文件 / 644 测试**(含 DB
  集成;本地 postgres = docker ally-os-node-postgres-1)
- 迁移在干净临时库跑通(集成测试自建库即验证)

## 判断层(手写)

### 本次的关键判断

1. **切片 1 = 台账,发布流留给后续切片**:#226 验收四条里,「版本历史+差异+
   回滚」是自洽可独立验收的内核;「测试环境→一键发布」「受监管走变更控制」
   需要给五族配置引入 draft/published 状态模型并改所有读侧(解析器只读生效
   行),那是另一个量级的语义迁移,硬塞进一个 PR 必然烂尾。「核心公式结构不可
   改」是结构性满足(公式在代码里、配置面 strict zod),PR 正文如实说明而非
   硬凑代码。PR 写 **Part of #226** 并列剩余项。
2. **台账 vs 各族自版本化**:五个内核已各自预埋 version 列,最省事的做法是
   各族自己 +1。但那样会有五套版本语义(automations「spec 才 +1」、numbering
   「从不 +1」、workflow/approval「永不改写」),回滚没有统一事实来源。裁成
   **一本 append-only 台账 + 行.version = 台账最新版** 的不变式:回滚、diff、
   审计读者只学一次;「停旧建新不改写」的临时纪律(#226 前的最小纪律)按注释
   里的预告退役——但只退役到「有台账可追溯」的程度,workflow/approval 的定义
   改写端点本切片不建(无改写路径 = 无可回滚差异,applyRevision 留空,回滚
   409 而非假装成功)。
3. **回滚 = 前滚一个新版本,不改历史**:append-only 触发器下唯一合法形态,
   而且「配置在什么时候被谁滚回过」本身就是版本史的一部分(#232 §4.2 历史
   字段含一键回滚的记录语义)。目标内容与现状一致时 409 rollback_no_change——
   记一版「内容没变的 rolled_back」是假变更,污染活动流投影。
4. **权限按族动态裁决,不设统一 config_versions 权限点**:回滚 = 改那族配置,
   若设新权限点,持有 automations.configure 但不持 numbering.configure 的人
   要么能回滚编号规则(越权)要么不能回滚自动化(权责不符)。族注册时声明
   configurePermission,路由内检查;route-auth 声明表按 kind:"session" 登记
   并注释说明(动态权限的 403 面由 config-versions.test.ts 的 carol 反例覆盖:
   只有 numbering.configure 的人读编号史 200、读自动化史 403)。
5. **automations PATCH 纪律升级**(行为变更,测试同步改写):旧纪律「spec 变更
   才 +1,改名/停用不动」在台账语义下不再成立——改名就是改了配置,#226 验收
   「谁、何时、改了什么」不该漏掉改名。顺带获得 no-op 幂等(旧实现空 PATCH
   也会 UPDATE+留审计)。这是 #226 题内的纪律统一,不是顺手重构。
6. **存量行补账在迁移里做**(0019 手写 INSERT..SELECT 五族):staging 已在跑,
   行没账 = 不可回滚也不可读史;补账快照与 families.ts 构建器逐字段同构,
   台账前的演进史(automations 曾到 >1 版)以补账时刻现状为一版事实——无法
   重建的历史不假装重建,注释写明。
7. **custom-fields PATCH 加 real-change-only 门**:旧实现翻到同值也 UPDATE+审计;
   台账语义下会记一版假变更。停用/恢复幂等返回现状,与 numbering PATCH 同纪律。

### 踩的坑(都花时间修了)

1. **测试里的夹具 subject**:numbering 注册表生产为空(fail closed 的正确
   行为),测试直配 `subject: "invoice"` 被 400 unregistered_subject 拒——
   注册表注入缝(`registerNumberedSubject`)正是为测试预备的,夹具域 + 文件级
   模块隔离,与 numbering-rules.test.ts 同法。
2. **Python 批量改写的 old 文本必须先精确核对**:两次因凭记忆写 old 串
   (漏了 `existing` 查询段/「在飞」两字)断言失败;文件未被写入(写盘在全部
   replace 之后)是唯一的安全垫——批改一律「先 grep 核对、再断言 count==1、
   最后写盘」。
3. **zod v4 的 `z.enum` 接受 readonly tuple**(`schema.customFieldType.enumValues`
   直接可用);泛型 `parseSnapshotOrThrow<S extends z.ZodType>` 返回
   `z.output<S>` 让五族 applyRevision 免掉逐字段 as 断言——第一版逐字段 cast
   的写法被 typecheck 放行但丑,重构成泛型后零断言。
4. **lint 的 prefer-nullish-coalescing 只_flags「值语义」的三元**:
   `nextSpec !== undefined ? nextSpec : {}` → `?? {}` 可改;但
   `body.description !== undefined ? body.description : before.description`
   不能改 `??`——description 是 `string | null`,`null ?? x` 会把「显式清空」
   变成「保持原值」,语义反转。eslint 没报它(null 参与使 ?? 不安全),人肉
   复核时差点顺手改掉。
