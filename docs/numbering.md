# 编号规则（#225）

> #232 §4.6「报表与模板」的自建半边：发票、报价、PO、收据等单据编号格式可配置。
> 报表/仪表盘/定时发送走 Apache Superset（#232 §4.9 v2.2，`infra/` 单独部署、
> 嵌入 SDK + 访客令牌），不在本仓库代码里。PDF/邮件/短信模板的自建部分是
> #225 的下一个切片（模板管理，复用 #128 统一 PDF 服务）。

## 已落地：编号规则内核（#225 切片 1，API only）

- **规则即数据**：`numbering_rules` 一行一条规则——subject（编号对象，开集 text）、
  label、prefix（前缀，连字符由前缀自带）、dateFormat（`YYYY` / `YYYYMM` /
  `YYYYMMDD` / null，枚举 `numbering_date_format`）、padding（序号位宽下限，
  超宽自然加长）、startNumber、active。配置面 `POST/GET/PATCH /api/numbering-rules`
  在 `numbering.configure` 权限点后面（owner/admin 默认持有）。
- **可编号对象是注册表**：`numbering/registry.ts`（#225 切片刻意为空）。属主域
  切片在模块装载时 `registerNumberedSubject(subject, { label })`；未注册类型配置
  面回 400——不出现「能配规则但永远没人发号」的死配置。`GET
  /api/numbering-rules/subjects` 是配置 UI 的下拉数据源。
- **分配无 HTTP 面**：`allocateDocumentNumber(tx, subject, { now })` 是进程内
  调用，属主域在自己的创建单据事务里调用（与 workflow 实例启动同一裁法），号
  随业务记录同事务提交/回滚。无生效规则抛 `NoActiveRuleError`（fail closed：
  没有编号的单据不该存在）。
- **渲染**：`prefix + 日期段（有则后跟 "-"）+ 零填充序号`，承老系统形态
  （`INV-3092`、mockup `INV-202608-0001`）。

## 号的语义（与老系统的两处刻意差异）

老系统：发票号是专用 sequence（FEAT-060，`start 1000`，否决年月前缀），询价引用
是计数器表（20260825140000），全写死在 SQL 里；两套「计数」语义分裂过一次
（BUG-054：seed 按「下一个号」读、mint 按「上一个号」读，首个号被永久跳过）。

1. **首号 = startNumber，语义只有一种读法**（`last_issued` = 已发出的最大号），
   有专项测试（BUG-054 回归护栏）。
2. **计数器随属主事务回滚**（老 nextval 非事务、回滚烧号）：回滚的单据从未存在，
   号归还后可复用——**已提交的单据之间编号无 gap 不重复**。代价是分配在属主
   事务期间持有计数行锁（同规则并发开单在分配处串行化），本系统单据量级下可
   忽略；真要非事务序列由属主域自建 PG sequence，不进本内核。

**唯一性由单调性结构性保证**：每规则一条单调计数，永不按日期段重置（老 FEAT-060
同一裁法——日期段只渲染进号串，不做「每期从 1 开始」）。改前缀/日期段/位宽只
影响之后发出的号，序号继续——验收第 3 条「修改编号规则后新单据使用新格式，
编号不重复」不靠事后查重，集成测试覆盖。按年重启属于业务裁决，随第一个真实
消费方（报价 #229 / 发票等）与 #226 配置版本化一起进场。

## 配置面的改写纪律

- 格式字段（label/prefix/dateFormat/padding）**允许就地改**——「改格式 = 改之后
  发出的号」正是验收题意；每次实效变更经配置版本台账（#226，见
  docs/config-versions.md）记一个新版本并留审计（`numbering.rule_created` /
  `numbering.rule_updated`，detail 带 `changes: {field: {from, to}}`，与台账 changes
  同形），real-change-only：无实效变更不记账不留审计行；已发出的号不变。
- `startNumber` 不可改（strict PATCH 显式 400）：对已在发的系列无效果，静默忽略
  会让管理员误以为系列已重开。重开系列 = 停用旧规则另建（`active` 上的部分唯一
  索引保证一对象一套生效规则，停用规则留档可查）。
- 日期段取 **UTC** 日历。时区是有业务后果的裁决（+8 时区每月头 8 小时会拿到上
  个月标签），随第一个真实消费方定，届时经 `@ally/config` 注入（`NUMBERING_TIMEZONE`），
  内核保持无环境依赖、`{ now }` 可注入测试时钟。

## 刻意不在这切片里的（#225 保持 open）

- **Superset**（自助报表、仪表盘、定时发送）：`infra/` 单独部署 + 嵌入 SDK +
  访客令牌行级过滤，属部署面而非应用代码——等 infra 通道，不在本仓库切片里。
- **模板管理**（PDF/邮件/短信/合同模板统一管理）：#225 下一个切片；PDF 渲染
  走 #128 统一 PDF 服务，模板表 + 属主域注册表与编号同一套法。
- **配置 UI**：编号规则的管理页随配置工作室前端进场（subjects 端点已就绪）。
- **测试/发布流**：#226 台账与草稿发布已进场（版本史/差异/回滚/存草稿/一键
  发布，见 docs/config-versions.md）；受监管变更控制门随 #206 进场。
- **第一个真实消费方**：发票/报价/PO 单据域都在 phase-2+（#229/#231 等），
  进场时注册 subject 并在创建事务里调用 `allocateDocumentNumber`。
