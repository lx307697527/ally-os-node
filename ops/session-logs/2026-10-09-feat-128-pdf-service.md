---
session_id: hand-written-128-pdf-service
branch: feat/128-pdf-service
date: 2026-10-09
reason: issue-128
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/128-pdf-service — 2026-10-09

> 机械层与判断层均由本次 agent 会话手写(ZCode 定时迁移会话)。

## 机械层

- **引用的 issue**:#128(统一 PDF 生成服务与模板配置,phase-1,解锁 #225
  模板管理)——零评论未动工。本切片落**服务内核 + 首个承载单据(发票)**:
  `packages/pdf` 渲染包 + 模板配置 API + 发票确认时刻存档 + 读路径回填。
  PR 写 **Part of #128**(收据/报价/估算/PO/贸易信用参考五类单据逐切片进场,
  见 PR 剩余清单)。
- **前置收尾(第 0 步)**:无 open PR;无残留 worktree;主检出干净。fetch
  prune 删了 `feat/28-error-admin-page` 远端分支。对照记忆:#22/#27/#28/#31/
  #33/#34 均已关闭(记忆滞后),phase-1 实际剩余 = #128 / #219–#226 / #233。
- **选题**:规则①核对 phase-1 各 issue 末条评论——#219(剩含义选择,等消费
  域)、#220(剩属主域接线,等 #227/#231/#243)、#221(剩金额域,等 #229/#231)、
  #222(剩表单构建器,选型未决)、#224(剩 SMS/AI/属主域)、#225(剩 Superset
  部署 + 模板管理,**显式等 #128**)、#226(剩 #206 门)、#233(剩 #220/#206 门)
  全部在门内;#224 评论里发现过的 #222 null 清值 bug 已随 PR #295 修掉。
  规则②按编号:**#128 是 phase-1 下一个**——零切片开工、零门槛、且是 #225
  唯一的应用层前置。claim #128 一次成功。
- **参考**:老系统 `supabase/docs/pdf-rendering.md`(FEAT-344 渲染器底座与
  FROZEN_DOCUMENTS 快照纪律)、`supabase/functions/invoice-pdf/model.ts`
  (白名单纪律)、`_shared/pdf.ts` layoutInvoice 的版式语言(navy 页眉带/
  FROM-BILL TO 两栏/明细表/收款指示框/状态横幅);#232 §「仍然自建」表
  (PDF 走统一服务,量小不值得引入组件)。

### 本切片改动的文件

- `packages/pdf/`(新包):`template.ts`(模板配置 zod 权威 + DEFAULT,银行
  字段印 "TO BE CONFIGURED" 显眼占位)、`model.ts`(InvoicePdfModel 白名单
  契约 + formatMoney/formatQuantity/formatDate)、`labels.ts`(单据标题与
  状态横幅词表)、`invoice.tsx`(react-pdf 版式:页眉带/两栏/明细表/余额块/
  PAID IN FULL/收款框/页脚)、`deterministic.ts`(stablePdfBytes:三处易变
  元数据锚定替换)、`render.tsx`(zod 再校验 → 渲染 → 确定性字节)。
  依赖 `@react-pdf/renderer@^4.3.1`。
- `packages/storage/src/index.ts`:+ 可选 `get?(key)`(读回能力,对象不在回
  null、故障原样抛)+ `readStoredBytes` 收窄口(实现缺能力 = 部署错误,
  typed error)。既有 39 处 Storage 实现/假实现零改动(接口可选)。
- `packages/db/src/schema.ts`:+ `pdf_template_config`(单例行,id=1,平铺列)、
  `invoice_documents`(一发票一份存档,唯一索引 ×2,templateSnapshot jsonb
  自证)。Migration `0043`(expand-only,无种子行——PATCH 是 upsert)。
- `apps/api/src/billing/pdf.ts`(新):loadPdfTemplate/savePdfTemplate(行↔
  嵌套配置映射)、buildInvoicePdfModel(逐字段白名单组装:头+行+实时付款
  台账+贷项抵扣)、archiveInvoiceDocument(确认时刻幂等存档)、
  getOrBackfillInvoicePdf(draft 现渲/issued 读存档/无档补档)。
- `apps/api/src/routes/pdf-template-config.ts`(新):GET/PATCH
  `/api/pdf-template-config`(invoices.manage 门;PATCH 完整对象 strict,
  no-op 幂等不留审计,真变更逐字段 from/to 记 `pdf.template_updated`)。
- `apps/api/src/routes/invoices.ts`:+ `GET /api/invoices/:id/pdf`(draft
  现渲 DRAFT 横幅不落桶、issued 读存档原件、void 409、读故障 500);confirm
  成功发出后尽力存档(失败只 warn,读路径补档)。deps 加 `storage`。
- `apps/api/src/app.ts`:pdfTemplateConfigRoutes 挂载;
  `apps/api/src/routes/registry.ts`:三条新路由声明。
- `tsconfig.base.json`:+ `"jsx": "react-jsx"`(.tsx 源跨包编译需要;.ts 包
  不受影响)。
- `apps/api/package.json`:+ `@ally/pdf` workspace 依赖。
- 测试:`packages/pdf/src/pdf.test.ts`(10:模板 schema、格式化、进程内+
  跨进程确定性、快照哈希钉版式、状态横幅三态)、`packages/storage/src/
  index.test.ts`(+2:收窄口拒绝与透传)、`apps/api/src/routes/
  invoice-pdf.test.ts`(9:草稿现渲不落桶/确认存档读原件/模板变更已存档
  不变/存档失败确认不拦+读路径补档/void 409+404+400/权限门/缺省模板与
  PATCH 校验/no-op 幂等与逐字段审计/DB 行过同一 zod 面)。
- 文档:`docs/billing.md`(+ 发票 PDF 节)、`docs/audit.md`(+ 
  `pdf.template_updated` 词条)、`docs/storage.md`(+ 读回能力节)。

**验证**:`DATABASE_URL=… corepack pnpm verify` 全绿 147 文件 / 1524 测试,
零 skip(本地 PG 真库;lint/typecheck/test 三段全过)。pre-push 钩子同门。
session log:`ops/session-logs/2026-10-09-feat-128-pdf-service.md`。

## 判断层(手写)

1. **渲染器选 @react-pdf/renderer,不选无头 Chromium**:#128 给了两个候选。
   Chromium 排版强但要浏览器二进制——Docker 镜像、CI、本地 vitest 全要跟着
   变,「量小不值得引入组件」(#232 自建裁决)反着读就是:引入浏览器运行时
   比引入 React 模板重一个量级。react-pdf 纯 JS、结构化单据(发票是表格不是
   海报)正好是它的主场,且 vitest 里直接可跑——快照测试能钉到字节。
2. **确定性不是渲染器的属性,是本仓库造出来的**。@react-pdf/renderer 的输出
   有**三处**每次渲染都变:`/CreationDate` 内联 token、trailer 的随机 `/ID`、
   以及**设了 title/creator 之后才出现的独立日期字符串对象**
   (`16 0 obj (D:…)`——最小冒烟文档看不见它,带元数据的真版式才长出来)。
   只修第一处的版本,进程内三次渲染哈希一致、跨进程就漂——快照测试在本地
   绿、在 CI 新进程必红。`stablePdfBytes` 三处全锚定替换;锚定而非全局正则,
   是因为页面正文是 Flate 压缩二进制,全局替换理论上可能撞上压缩字节序把好
   文档改坏。教训写进 deterministic.ts 注释:**进程内稳定 ≠ 跨进程稳定**,
   钉住版式的快照断言跑在 CI 新进程里才是真门。
3. **Storage.get 做成可选能力,不做必选方法**。接口已有 39 处实现(38 个是
   测试假实现):必选方法意味着一个 PDF 读路径的需求让 38 个与 PDF 无关的
   测试文件都改一行——不顺手重构无关代码的反面教材。可选 + `readStoredBytes`
   收窄 + typed error(缺能力 = 部署配置错误 → 500,fail closed)把涟漪压到
   本切片的两个新假实现。代价是调用方要 feature-detect,这笔账记在
   docs/storage.md。
4. **存档语义:确认时刻钉版,读路径自愈**。「发票状态是事实,PDF 是它的
   投影」——存档失败不回滚确认(老系统同裁:生成挂事件,与状态机解耦);
   读路径发现 issued 无存档就用当前模板补档(老 invoice_pdf_backfill 的同一
   语义),补上后唯一索引保证永不重生成。「模板改了新票生效、已存档不变」
   的验收两条各由一条路径结构性满足,不靠约定。台账带 `template_snapshot`:
   「这张票当时按什么配置渲染」自证,审计可读。
5. **模板配置不进 config-revisions(#226)**。配置工作室六族都有版本/草稿/
   回滚,但那是「先审后上」的配置(规则、审批线、流程);PDF 模板是即改即
   生效的品牌事实,没有第二人复核的消费需求。可追溯由 `pdf.template_updated`
   (逐字段 from/to)+ 存档行 template_snapshot 承担——机制不缺位,只是不
   预支 #226 的重量。需要版本化时在同一裁决下 expand,注释里写明。
6. **billTo 显式 null,不造假数据**。老系统发票印客户名/地址;新系统客户主
   数据是 #235(phase-2),今天只有 subject 引用没有抬头。白名单模型收
   `billTo: null` 印 NOT_STATED,而不是从 subject 拼一个临时名——单据是
   商业文件,「暂时没名字」要印出来,不能替客户域预支一个会漂的字段。
7. **坑:Windows Git Bash 的 sed 处理 JSON 不可靠**。给 packages/pdf/
   package.json 插依赖时 sed 产生了重复的 "dependencies" 键(无效 JSON,
   install 才炸);改用 heredoc 整文件重写,后续多行精确改动一律 python
   内联补丁(可断言 old 串存在)。会话里第二处同类坑: Edit 工具对已被
   sed 改过的文件会拒写("modified since read"),混合编辑时先 Read 再改。
8. **坑:zod v4 的 `.finite()` 是 deprecated no-op**,lint(no-deprecated)
   直接红——v4 的 number 默认拒 Infinity。从老会话记忆里带来的 v3 习惯要
   逐个过 lint。
