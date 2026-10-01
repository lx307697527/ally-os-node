---
name: pm-process-audit
description: Business-process audit from a senior product manager's viewpoint — does each flow actually run in real operations, who operates it, and does it survive the abnormal path. Use when asked to "审计业务流程", "产品视角审计", "PM 审计", "process audit", or to review whether the value-chain flows (excluding dormant surfaces) are sound and gap-free. Produces docs/zh-CN/domain-flows/AUDIT-<date>-pm-process-audit.md. This is the PRODUCT-flow lens; it is NOT the industry-depth audit (AUDIT-2026-08-09 §3), NOT the ruling→code realization audit (AUDIT-2026-08-13), and NOT doc-vs-code drift (use drift-audit).
---

# PM 业务流程审计

Goal: 从产品视角判断每条业务流程在真实运营里**跑不跑得通、谁来操作、出了异常兜不兜得住**；把每条发现归入「真缺口 / 已裁定待实现 / 需业务方裁定」三类，绝不替业务拍板。

## 边界与互补（先读，避免重复造轮）

本 skill 补的是**产品流程视角**，与仓库已有的三类审计互补、不重叠：

- **不做代工行业深度 + 裁定落地可行性**（数据模型边界、21 CFR Part 111 监管、运行时自动化）——那是 `docs/zh-CN/domain-flows/AUDIT-2026-08-09.md` §3 的领地。引用它，不重写它。
- **不做裁定→代码兑现度工程核证**（RLS / SECURITY DEFINER / `文件:行号`）——那是 `docs/zh-CN/domain-flows/AUDIT-2026-08-13.md` 的领地。
- **不做文档/地图 vs 代码漂移**——那是 `drift-audit` skill（每周例行）。
- 本 skill 关注：用户旅程闭环、状态机业务语义、金额自洽、异常兜底、可运营性。

## 审计范围

**在役面全审**；**休眠面只核其与在役面的交界**（per ADR-007 DR-25/26），把休眠当缺口报是误报：
- L1 自动分派 / SLA 告警（休眠）
- L2 短信发送面（休眠；合规采集面在役）
- L3 自建预约面（休眠；live booking path = Calendly / iClosed）

价值链主干：marketing 首触 → crm 路由/评分/状态机 → pricing（AI 编排 + 报价 + 门户 accept）→ sample（打样 dev→sent→approved→locked）→ sales/production（quote.accepted 事件自动建单+作业+BOM+工序）→ billing（状态机 + Stripe/PayPal/QB 收款）→ 发货（DR-21 尾款先付后发货）→ 采购回灌 material_prices 规范价。12 域 + 2 app（apps/allyos 员工 SPA、apps/portal 客户门户）。

## 基线先行（必做，避免误报）

动手前**先读基线**，建立「已裁定什么 / 已排期什么 / 已发现什么」的认知，再判断。08-13 早期把 B-1/B-2 当断链报，后来发现是 DR-21 修订后的预期行为——不读基线就会重复这个错误。必读：

- 裁定基线：`ops/architecture/ADR-007*`、`ADR-008*`（47+18 问全裁定）、`docs/zh-CN/domain-flows/REVIEW-LOG.md`、`READINESS-2026-08-12.md`、`OPEN-QUESTIONS-2026-08-09.md`。
- 排期：`ops/backlog/backlog.yaml` 的交付批次 A–F（FEAT-047–053）。很多「看似缺口」其实已裁定+已排期。
- 已有审计：`docs/zh-CN/domain-flows/AUDIT-2026-08-09.md`、`AUDIT-2026-08-13.md`（引用，不重复）。
- 模块地图：根 `CLAUDE.md` 模块索引 + 12 个 `src/modules/*/CLAUDE.md` + 2 个 `apps/*/CLAUDE.md`。

> 注：这是本仓**首个读 ADR 与 domain-flows 的 skill**（既有 8 个 skill 无一读这俩）。合法差异化，因为产品流程审计的前提就是「先懂业务裁定」。

## 审计维度（逐维深挖，每维附「PM 式追问」）

**D1 角色 × 旅程完整性** — 逐角色画旅程：能做什么 → 在哪个界面做 → 做完系统怎么响应 → 怎么知道成功/失败。
追问：财务在哪发出发票？运营在哪确认「可开票/录实际产量/完工」？采购在哪认领电汇、发 PO？客户在哪看到该付多少、怎么付？
缺口信号：某角色有职责但没操作界面；某操作没人会做；某结果没通知到该看的人。

**D2 价值链主干闭环** — 沿主干逐段走，每个跨域交接点（outbox 事件）问：有没有消费者？消费者做完会不会推进下一段？
追问：quote.accepted 后扇出的三件事（合同/定金/建单）都通吗？order.shipped 有消费者吗？invoice.paid → 订单 invoiced 投影通吗？production.job.completed → 尾款票起草通吗？
缺口信号：事件零消费者（死信）；某段通了下段断了（结构性死锁）；「唯一通路是 CEO 例外放行」。

**D3 状态机业务语义** — 逐个状态机：pricing.quotes / sales.orders / production.jobs / billing.invoices / sample / procurement(po/rfq/price_batch)。
追问：状态集完备吗？转换边符合业务吗？有没有死状态（无写入者）/ 孤立状态（无读取者）/ 不可达状态？业务语义自洽吗（例：invoiced 到底是「已开票」还是「已结清」）？
缺口信号：某状态无路径到达；某状态到了系统不响应；枚举值存在但代码从不写入（如 expired、changes_requested）。

**D4 金额与商业逻辑自洽** — 定金比例、加价公式、结算量分段、账期、退款、$45 冲销、多币种 FX、母子发票。
追问：规则间互相一致吗（有没有「规则 A 说 X、规则 B 说非 X」的冲突）？边界算得清吗（部分退款、超产/少产 ±10%、分批发货定金分摊、跨发票退款、非 USD 电汇）？金额来源是快照还是实时读（会不会漂移）？
缺口信号：两处规则方向相反；某金额在库里无落点；某计算「结构性算不准」（缺输入数据）。

**D5 异常与边界路径** — 客户取消、供应商毁约/不回、内部叫停、退款（部分/跨发票/原路）、超产/少产/违约、缺货/延期、纠纷换货、重复付款、超付。
追问：正常 path 走通了，异常呢？系统 fail-loud（报错/告警/留待处理）还是 fail-silent（静默丢弃/默认通过）？
缺口信号：某异常分支静默 return null / 200-ack 丢弃；「人工纪律」承担了本该系统保证的事；取消/退款与 billing 零联动。

**D6 可运营性**（最容易被工程审计漏掉的 PM 视角）— 每个「机器给事实、人给判断」的设计，人有没有座位？有没有运营看板、SLA 监控、告警？「自动」的流程有没有「没跑必须会响」的看守（DR-31 上线门）？出问题人工能不能干预（例外放行、手工建单、强制推进）？干预有没有审计留痕？
缺口信号：RPC 建好但 apps/ 零调用方；cron 建好但没排程；告警只进死信面板不上 Sentry/Slack；运营动作没界面只能跑 SQL。

**D7 跨域信号完整性** — outbox 事件哪些有消费者、哪些是预留？同一事实（订单状态、库存余量、已收款）在不同域是一致读还是各自副本（会不会漂移）？哪些跨域事实必须有可查询台账却没有（事件 ≠ 台账）？
缺口信号：数十事件仅个位数消费者；某事实只能靠 reconcile 兜底发现、没权威表。

**D8 合规与留痕**（仅审在役面）— 合同签署链通吗（BoldSign vs 已废弃 DocuSign）？邮件退订（CAN-SPAM）入口客户够得着吗？短信同意（TCPA）采集面在吗？财务每笔变动有没有不可变审计留痕？数据隐私边界（portal 客户/供应商能读到别人的数据吗）？
缺口信号：合规机制建好但客户够不着；越权读（跨租户/跨角色）；审计可被改写。

**D9 真缺口 vs 排期项 vs 待裁定（分类纪律，最重要）** — 每条发现必须归入其一，**严禁把排期项报成断链**：
- 真缺口：无 backlog 行、无 issue、无裁定承接 → 报。
- 已裁定待实现：在交付批次 A–F（backlog FEAT-047–053）里有 phase 承接 → 标注归属批次，不报为缺口，可提示「排期风险」。
- 需业务方裁定：规则缺失/冲突，答案属 CEO/财务/CTO → 列待裁定清单，标决策者 + 卡住的批次/issue，不自己给答案。

**D10 可规模化与可演进**（选做，Low）— 业务规则硬编码（改规则=迁移+发版）还是可配置？一单多作业/多批发货拆分设计撑得住吗？多租户边界清晰吗？

## 纪律

- **只读**：零代码/DB 改动，不产生 blast-radius 记录。
- **不替业务拍板**：需 CEO/财务/CTO 裁定的，列入「待业务方裁定」清单，标决策者 + 卡住的批次/issue。
- **证据**：每条结论带 `文件:行号` 或 `#issue`。codegraph 对 `.sql` 覆盖 0，SQL 侧一律读迁移原文。
- **分类口径**沿用本系列：confirmed / inferred / unresolved / conflict / missing。推演标注置信度（系统未部署，所有「会发生」均为静态推演，不伪造运行时数据）。
- **严重度**：Critical（资金/库存/订单/权限/数据完整性）> High（核心流程错误或无法继续）> Medium > Low。
- **导航纪律**：先根 `CLAUDE.md` → 模块 `CLAUDE.md` → 才读源码。**绝不扫全仓。**

## 执行步骤

1. **确认基点**：`git fetch` 后确认 main 最新，报告里写实际审计基点 commit。
2. **读基线**（见上「基线先行」）。
3. **先出审计计划**：拟审哪些域 × 哪些维度、预计重点、已知会排除的休眠面与排期项——**等用户确认范围后再展开深挖**。不要闷头跑完全程再交付。
4. **逐域深挖**：可委派 `explorer` 子代理分域并行（drift-audit 的做法，控制上下文），主代理持有判断。
5. **落盘报告**（见下）。

## 报告格式

落盘 `docs/zh-CN/domain-flows/AUDIT-<YYYY-MM-DD>-pm-process-audit.md`（与 wen 的 AUDIT-2026-08-09/08-13 同目录、同命名族，`-pm-` 后缀区分）：

```markdown
# 业务流程审计 · 产品视角 · YYYY-MM-DD

审计基点：main @ <commit>（YYYY-MM-DD）。审计对象：在役面业务流程（休眠面 L1/L2/L3 仅核交界，per DR-25/26）。

## 一、总体结论
业务流程成熟度（一段话）+ 分维度评分：旅程完整性 / 价值链闭环 / 状态机 / 金额自洽 / 异常路径 / 可运营性 / 合规。

## 二、Critical / High 问题清单
每条 = 域 / 严重度 / 类型(D? ) / 问题(一句话) / 证据(文件:行号或#) / 业务影响 / 建议 / 是否需业务裁定。

## 三、按业务域的发现（含 Medium/Low）
逐域过，复用主干标注 ⚠缺口 / ⏳已设计待实现 / ✅合理。

## 四、按角色的旅程缺口
每个角色一段：他「该能做但做不了 / 做了但没人接 / 没人做」的操作。

## 五、待业务方裁定的问题清单
按 CEO / 财务 / CTO 分组，标决策者 + 卡住的批次/issue。

## 六、与既有审计的差异
本轮新增 vs AUDIT-2026-08-09 §3 / AUDIT-2026-08-13 已覆盖，明确互补点。

## 七、核对方法
读迁移/源码原文（不读地图转述）、backlog 全量核对、issue 原文对照、blast-radius 说明（纯只读，零改动）。
```
