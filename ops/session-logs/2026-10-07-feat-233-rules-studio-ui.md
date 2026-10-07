---
session_id: hand-written-233-rules-studio-ui
branch: feat/233-rules-studio-ui
date: 2026-10-07
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

# Session log — feat/233-rules-studio-ui — 2026-10-07

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#233 剩余项「前端配置工作室 UI / 决策表的 JDM Editor 配置
  UI 随配置工作室前端」——**规则注册表 UI 切片**(`/system/rules`)。PR 正文写
  Part of #233(#233 仍有周报/cron 接线/JDM 编辑器等剩余项,严禁 Closes)。
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净;fetch 后
  main 顶端 eae7e30(#287)。
- **选题**:①优先续做配置工作室未完成切片。候选 #222 form builder(注册表
  仍空、消费域 #207/#227 未进场,UI 会是无米之炊)vs #233 规则 UI(57 条真实
  种子 + API 写面齐备)。选后者——延续 #286/#287 的「内核已就位 → 配置面
  收口」切片模式,真实数据 Immediate value。
- **数据库**:本地 postgres 可用,verify 全程带 DATABASE_URL(无 skip)。

### 本切片改动的文件

- `apps/web/src/shared/lib/rules-client.ts`(新):规则面适配器 + 展示纯函数。
  与 numbering-client 同纪律:响应逐个 zod 解析、失败模式枚举化;不同处——
  **失败载荷携带数据**(403 带 roles、400 带逐格编译 issues),因为本族是唯一
  「族权限点 ≠ 改权」的配置族,页面要说「谁有权」而不是「无权」。展示侧
  parseDecisionTableDisplay 刻意宽松(画不出回退原始 JSON,永不代裁校验);
  filterRules/valueSummary/buildRuleValue/formatValueDraft/parseRefs 全部
  纯函数可单测。
- `apps/web/src/shared/pages/RulesRegistry.tsx`(新):列表(文本/类别/待填
  筛选)+ 详情(治理字段、按类型的值渲染含决策表网格、定时生效面板)+
  改值表单(按值类型出题、refs 逐行至少一条、可选 datetime-local 定时)+
  台账史(逐版 source/changedBy/from→to 摘要)+ 一键回滚(选版本+可选原因)。
- `apps/web/src/App.tsx`:路由 `/system/rules` + 中文裁决注释。
- `apps/web/src/shared/shell/rail-groups.ts`:System 区一行(无图标——图标
  可选,不加新 glyph 不碰 no-two-rows-share-a-glyph 测试)。
- `apps/web/src/shared/lib/rules-client.test.ts`(新,15 例)、
  `apps/web/src/shared/pages/rules-registry.test.ts`(新,11 例,源码纪律)。
- `docs/rules.md`:新「配置工作室 UI」节 + 剩余项划掉该条。
- 无 API/db 改动:零新路由(route-auth registry 不动)、零迁移。

## 判断层(本次的关键判断与踩的坑)

1. **选题判断:UI 切片选有数据的,不选有空注册表的。** #222 的 form builder
   面对空 `registerFormSubject`(内置字段零注册,消费域未进场),做出来是
   honest-empty-state 壳子;#233 规则面有 57 条种子 + 既有 API 面(enable/
   disable、台账、回滚),第一天就有真实内容可看。同模式先例:#286 编号 UI、
   #287 流程 UI 都是「内核先行、配置面收口」。
2. **失败载荷进类型**:numbering-client 的失败是扁平 reason 字符串,本切片
   把 403 的 roles / 400 的 issues 提升为失败变体的载荷(`readJson` 因此多
   带了 raw body)。动机:决策表编译探针的错误是逐格定位的(哪一行哪一格
   不解析),这正是编辑者最需要的反馈;把它压成「invalid」等于丢掉 #280
   写面探针的存在意义。教训:适配器失败形状要跟内核错误的信息量对齐。
3. **展示器刻意宽松,校验刻意缺位**:parseDecisionTableDisplay 对任何不像表
   的值返回 null → 页面回退原始 JSON,而不是猜测渲染半个表。「展示永不代裁
   校验」在 UI 侧的对应物:客户端 buildRuleValue 只挡明显坏提交(空 refs、
   非数字、非 JSON 对象),ZEN 语义(空表合法、输出表达式、hitPolicy)一行
   都不 mirror——那四道门在服务端,复制一份就是第二真相源。
4. **无草稿面的实现方式是「不存在」而非「禁用」**:registry_rule 族对草稿答
   409 publish_unsupported,所以页面/适配器根本不出现 draft/publish 路径
   (源码纪律测试钉住 client 无 "config-drafts" 字样)。「没有的面不渲染
   灰按钮」——灰按钮会让人以为点一下就行。
5. **路由无新面**:本切片纯前端,route-auth registry 不动、无迁移、无 API
   改动——UI 切片的验收边界就是「把既有内核面变成人可用的」。
6. **坑:JSX 源码纪律测试的散文断言**。源码里的 JSX 文本按缩进换行,
   `toContain("recorded as a new version")` 会被换行拆断(3 处失败都是这个),
   统一改 `page.replace(/\s+/g, " ")` 后断言;教训:源码文本断言要么挑
   不换行的短语,要么先折叠空白,别耦合排版。
7. **坑:`Heading` 只收 h1–h3**(TS6133 顺带抓了未用导入)。`as="h4"` 直接
   类型错,@ally/ui 的切片一子集纪律(gotcha 35)在 Heading 上同样成立;
   区块标题降级为 h3。
8. **决策表行排序**:种子表行无天然顺序,展示按 `_id` 排序(与求值语义无关,
   first hit 求值顺序是数组序——展示排序只为可读,不暗示优先级,注释写明)。
9. **queryFn 闭包与 no-non-null-assertion**:`useQuery` 的 enabled 门 +
   `selectedId ?? ""` 占位,替代 `selected!.id`(eslint no-non-null-assertion
   与 non-nullable-type-assertion-style 双开,gotcha 73 同源)。

## 验收对照(本切片范围)

- [x] 「修改一条参数必须填写依据;可定在未来某日生效;无需上线即生效」——
      表单强制 refs ≥ 1、datetime-local 可选未来时刻,页面把「已发单据不回改」
      说在前头
- [x] 「历史可查、可一键回滚,回滚本身也留审计」——台账史逐版摘要 + 回滚
      面板,成功话术明说「恢复版记为新版、审计在案」
- [x] 「没有『谁能改』权限的用户修改规则被服务端拒绝」——403 roles 原样
      呈现给尝试者
- [x] 「硬底线项在注册表中不可见、不可修改」——无新建面,源码纪律测试钉住
- [x] 决策表治理(§4.9)——只读网格 + JSON 编辑 + 服务端逐格编译错误透出
      (JDM 拖拽编辑器仍属后续,#233 保持 open)
- [ ] 每周规则效果汇总 → #225 报表域(保持 open)
- [ ] applyDueRuleChanges cron 接线随第一个消费域(既定裁法)
- [ ] 治理字段(changeableBy/enableBy/riskFlag)编辑随 #206 受监管变更

测试:`DATABASE_URL=… verify` 全绿 101 文件 / 848 测试(+26);docs/rules.md
配置工作室 UI 专节;session log `ops/session-logs/2026-10-07-feat-233-rules-studio-ui.md`。
