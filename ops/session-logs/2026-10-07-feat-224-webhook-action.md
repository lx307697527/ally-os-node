---
session_id: hand-written-224-webhook-action
branch: feat/224-webhook-action
date: 2026-10-07
reason: issue-224
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/224-webhook-action — 2026-10-07

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#224 剩余项 1「动作类型扩展:webhook(切片 4 评论的剩余
  清单里第一个不被依赖阻塞的)」——**send_webhook 动作切片**。PR 正文写
  Part of #224(短信/改字段/报名序列/AI 步骤、条件积木、效果度量等剩余项
  仍在,严禁 Closes)。
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净;fetch 后
  origin/main 顶端 721b217(#291,send_email 动作),主检出 fast-forward 3 个
  提交后开出 worktree。
- **选题**:①优先续做有未完成切片的 issue。#224 今天刚并切片 3(config UI
  #290)、4(send_email #291),剩余清单里「事务短信(等 SMS 通道)」被依赖
  挡住,**webhook 是第一个零依赖、且与刚合并切片同构(动作联合扩展)的
  切片**,按续做优先选它。
- **老系统参考(只读)**:ally-os 的 webhook 全是**入站**(stripe/calendly/
  hubspot/boldsign/comms-twilio 等回调 edge function,验签 + zod 收口)——
  老系统没有出站自动化 webhook(出站连锁反应在 38 个数据库触发器里,#134)。
  新系统这是按 issue 要点「动作:……webhook」新做的事件动作;入站 webhook
  的「验签 + zod 校验第三方输入」纪律在出站侧对应为「zod 收口配置 + SSRF 闸」。
- **数据库**:本地 postgres 可用(5432 端口活着),verify 全程带 DATABASE_URL
  (无 skip)。

### 本切片改动的文件

- `packages/automations/src/index.ts`:`sendWebhookActionSchema`(url https+
  公网 refine、method POST/PUT/PATCH 默认 POST、headers ≤10 且 token 名/
  值禁 CR-LF-NUL、body 任意 JSON)进动作 discriminated union;新增纯函数
  `parseIpv4`/`parseIpv6`(手写 16 字节解析,含 :: 缩写与尾嵌 v4)、
  `isBlockedIpv4`/`isBlockedIpv6`(0/8、10/8、100.64/10、127/8、169.254/16、
  172.16/12、192.168/16、198.18/15、::、::1、fc00::/7、fe80::/10、::ffff:
  映射查内嵌 v4)、`isWebhookIpAllowed`(解析不了 = 拒绝)/
  `isWebhookHostAllowed`(域名挡 localhost 家族与 *.local/*.internal 后放行,
  解析成私网的公网域名由执行时 DNS 复查挡)。包仍零依赖(只有 zod,无
  node:dns——保存面只做无网络判定的形状闸)。
- `apps/worker/src/automations/actions.ts`:`executeSendWebhook`——执行时
  url 复查(防呆第二层)+ DNS 复查(node:dns lookup all,逐地址过闸,一条
  私网答案 = 拒绝,一个包不出网)+ `redirect: "error"` +
  `AbortSignal.timeout(10s)` + 非 2xx = 失败(响应体有界读 2KB 即取消流、
  200 字符截断进 error,**headers 密钥绝不进 error**)+ 成功不读响应体直接
  取消。ActionServices 增 `webhookFetcher`/`dnsLookup`(测试注桩,worker
  装配默认全局 fetch + node:dns)。
- `apps/worker/src/automations/runner.ts`:穷举 switch 进 `send_webhook` 分支。
- `apps/worker/src/automations/index.ts`:actionDeps 注入默认 fetch 与
  dns lookup。
- `apps/web/src/shared/lib/automations-client.ts`:ActionDraft 联合 +
  actionToDraft + buildActions 的 send_webhook 结构化编辑(headersText
  「Name: Value」每行一条,bodyText JSON,明显坏提交挡线下)。
- `apps/web/src/shared/pages/Automations.tsx`:类型选择器新选项、编辑器四件
  (URL/方法/headers/body,第一段文案把 https 公网、两道闸、at-least-once、
  无模板说在前头)、ActionCard 展示分支(方法 + URL + 头计数)。
- 测试:包形状矩阵 4 例(https/公网放行矩阵、私网与垃圾 url 拒绝矩阵含
  WHATWG IPv4 规范化变体、头部注入/坏名/超量、方法枚举);worker 集成 5 例
  (端到端默认 method/content-type/redirect/signal/无通知无审计、非 2xx 进
  重试且 error 无密钥、DNS 私网拒绝且零出网、at-least-once 500→200 两次
  投递、扫描器对坏 spec 不产生 run;+执行器直测 url 复查 1 例;
  +due-scanner 夹具注桩)、web client 往返 1 例(含最小形状与三失败分支)、
  页面源码纪律 1 例。
- `docs/automations.md`:「send_webhook 动作」专节(形状/SSRF 三道闸/传输
  裁决/at-least-once/不进审计五条)+ 关键裁决与剩余项 1 改写(webhook 已落,
  短信等 SMS 通道)。
- 无 API 路由改动(保存面由共享 schema 自动收口)、无迁移、无新 env。

## 判断层(本次的关键判断与踩的坑)

1. **出站 webhook 的第一性风险是 SSRF,不是「能不能发出去」。** 自动化规则
   由 automations.configure(owner/admin)配置,但规则触发是无人值守的:一个
   「触发 → webhook → http://169.254.169.254/latest/meta-data/」规则就是一条
   从 worker 网络内向外网办内网事的通路(云凭证、数据库、内部服务全在私网
   段)。所以闸做三道:保存时形状闸(zod,无网络判定)、执行时 url 复查、
   DNS 逐地址复查——三层全部 fail closed,集成测试钉死「DNS 一条私网答案
   = 零出网」。已文档化残余:DNS rebinding 不在检查范围,接出口代理时收口。
2. **https-only 是给负载里密钥的下限,不是给自己找麻烦。** webhook 场景
   authorization 头几乎必带 secret,明文 http 等于把 secret 交给路径上每一跳。
   集成测试用注入的假 fetcher,不需要真 https 端点,本地开发不受影响;真要
   对内网服务发 webhook 的需求属于代码里的 worker 任务,不属于运营可配置
   的规则面。
3. **redirect: "error" 是被忽视的 SSRF 面。** fetch 默认跟随重定向:过闸的
   公网 url 一个 302 就能把请求带去 127.0.0.1——前两道闸全部白做。webhook
   端点本就不该 3xx,直接拒收。
4. **坑:我以为 runner 的防呆 parse 是坏 spec 的第一道闸,测试被扫描器教育。**
   「库里插坏 url 的规则 → 期待 run 终判 rule spec is invalid」的用例失败:
   扫描器用同一份 schema 校验 spec,坏规则根本不产生 run 行(更早一层 fail
   closed)。这比预想更严,是好事——测试改断言扫描层零 run、零出网,并把
   「三层闸的最外层先关死」写进文档。教训:给分层防御写测试前先确认每层
   真实可达的路径,别把不可达路径当验收。
5. **payload 不做模板插值是刻意的。** 「把事件语境带进负载」很诱人,但那是
   条件积木/模板切片的事;本切片的 payload 是保存时点死的静态 JSON,和
   send_email 的静态正文同裁。接收方区分不了来源是作者的设计——要带
   credentials/来源标记,作者在 headers/body 里自己带。小步不想象需求。
6. **error 是运营可读面,密钥绝不进。** action_results 的 error 会被规则
   读者看到(HTTP 状态码、对端错误说明、解析到的私网地址都在),所以
   headers 的值一条不进 error;集成测试显式断言 error 里没有 Bearer token。
   「排障要看得见、密钥要看不见」两个都要成立。
7. **响应体必须有界读。** Resend 的响应体小是 API 合同,任意第三方端点没有
   这个合同——2KB 读上界 + 取消流 + 200 字符截断,超大响应耗不掉 worker
   内存。成功路径干脆不读(2xx 状态即投递事实,流直接取消)。

## 验收对照(本切片范围)

- [x] 「动作:……webhook」——send_webhook 进动作联合,保存面 zod 收口
      (https 公网闸)、worker 执行(SSRF 三道闸 + 重试 + 留痕)、runs 留
      逐动作结果,端到端集成测试覆盖
- [x] 「动作通过 pg-boss 执行,可重试、可观测,失败告警」对 webhook 动作
      同样成立(复用 runner 重试协议,失败抛给 pg-boss、每次尝试告警、
      重试只补失败动作;at-least-once 语义测试钉死)
- [ ] 短信/改字段/报名序列/AI 步骤(剩余项 1 其余半边)
- [ ] 条件积木注册表、效果度量、#134 逐域迁移(#224 保持 open)

测试:`DATABASE_URL=… corepack pnpm verify` 全绿(见 PR 正文计数);
docs/automations.md send_webhook 专节;session log
`ops/session-logs/2026-10-07-feat-224-webhook-action.md`。
