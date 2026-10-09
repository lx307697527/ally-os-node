---
session_id: hand-written-28-error-tracking-kernel
branch: feat/28-error-tracking
date: 2026-10-09
reason: issue-28
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/28-error-tracking — 2026-10-09

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#28(错误追踪 Sentinel:前端错误上报 + 激增告警,phase-1)
  ——零评论完全未动工。本切片落**错误追踪内核**(error_events / error_spikes
  表 + 公开上报端点 + onError 捕获 + audit.read 读面 + 激增告警任务 + 保留
  策略),PR 正文写 **Part of #28**(管理页 web 面与「测试环境演练一次」随部署)。
- **前置收尾(第 0 步)**:`git fetch --prune` 后无 open PR(#322 已合并删支)、
  无残留 worktree、主检出干净——直接进选题。
- **选题**:① #27 评论列的三个剩余切片在 docs/abuse-prevention.md 切片地图里
  全部有门(拦截可见面等可见性需求、IP 黑名单等真实滥用场景、honeypot 随第一个
  公开表单域 #207/#227)——不可做。② phase-1 按编号 #22→#34:#28/#31/#33/#34
  未动工。#31 的验收绑老系统 12 处调用点替换(切换日动作)、#33 核心
  pg_dump-to-S3 本机无 psql/pg_dump 验证不了、#34 一半是 CloudWatch/SNS
  基础设施本地不可验;**#28 的应用层内核可独立验收**(表 + 端点 + worker 任务
  全部本地可测),故选 #28 切片 1。
- **claim**:`claim_issue.py claim --issue 28` 成功(refs/heads/claims/issue-28)。
- **参考**:**老仓库 HEAD 上已无错误追踪实现**——supabase/functions 无
  ingest-error / error-spike-alert,migrations 无 error_logs,src 无
  errorTracker.ts(issue 的「老系统现状」描述的是更早的状态;老仓库已重构为
  src/modules 结构,security 模块文档亦无此物)。实现按 issue 迁移要点 +
  #232「系统结构」平台服务意图设计,老语义(指纹分组、10/min 节流、30 分钟
  冷却、Slack)从 issue 文字继承。

### 本切片改动的文件

- `packages/db/src/schema.ts`:+ `error_events`(一行一次发生;fingerprint/source/
  message/stack/url/user_agent/request_id;指纹+时间复合索引、时间倒序索引)+
  `error_spikes`(一次告警一行;window_start 唯一 = 幂等键;alerted_at 索引)。
  Migration `0041`(expand-only,零既有对象改动)。
- `apps/api/src/errors/capture.ts`(新):`computeErrorFingerprint`(sha256
  source|栈顶帧|message 首行,服务端权威)、`firstLine` / `topStackFrame` /
  `truncate`(裁剪)、`recordErrorEvent`(落库)、`captureServerError`(onError
  捕获入口,内部 catch 只 warn)。
- `apps/api/src/routes/errors.ts`(新):`POST /api/errors` 公开上报——挂会话门
  之前;PG 限流内核第一个非认证消费域(`errors.ingest` 10/min/IP,拒绝照计数
  进拒绝台账);UA 从请求头取;落库失败仍 202(遥测 sink 不设闸)。
- `apps/api/src/routes/error-events.ts`(新):`GET /api/error-events`(明细,
  最新在前,fingerprint/source 过滤,offset + 精确 total)+ `GET
  /api/error-events/summary`(指纹分组汇总,count 降序 + 最近样本),都走
  `audit.read` 门(与审计/删除台账同扇)。
- `apps/api/src/app.ts`:onError 改 async 补 `captureServerError`(source='api',
  requestId 与 500 响应体一致);errorIngestRoutes 挂会话门前,errorEventsRoutes
  挂 2FA 门后。
- `apps/api/src/routes/registry.ts` + `routes/route-auth.test.ts`:/api/errors
  进公开路由钉死清单(与 webhook 同一款「公开 = 不过会话门,认证是限流+上限」),
  两个读端点声明 audit.read——#23 的双向路由表哨兵红着逼出来的,新公开端点
  必须显式过这关。
- `apps/worker/src/errors/spike.ts`(新):`detectAndClaimErrorSpike`(数行数 →
  冷却 → window_start 唯一键主张,判定与占位一次完成)+ `formatErrorSpikeAlert`
  (值班文案:数字、窗口、阈值、summary 指引)。
- `apps/worker/src/errors/cleanup.ts`(新):事件留 30 天、激增台账留 90 天。
- `apps/worker/src/errors/index.ts`(新)+ `apps/worker/src/index.ts`:登记
  `error-spike-alert`(*/5)与 `error-events-cleanup`(*/10);复用现有
  SlackAlerter(SLACK_WEBHOOK_URL 未配置 = 只记日志,与 job 失败告警同姿态)。
- `apps/web/src/shared/lib/error-reporter.ts`(新)+ `main.tsx`:window error +
  unhandledrejection 双监听,fire-and-forget 永不重试;客户端 10/min 节流 +
  同形状(message+栈顶帧)60 秒冷却;`installErrorReporter(window)` 在
  composition root 只装一次。
- `docs/error-tracking.md`(新):切片地图 + 数据面/捕获面裁决 + 任务节奏。
- `docs/cron-migration.md`:表 A 后新增注记段(error-spike-alert /
  error-events-cleanup 两个任务不在老 HEAD 任务表上,切换日老库无需 unschedule)。
- 测试:`apps/api/src/errors/capture.test.ts`(纯函数 10 例)、
  `apps/api/src/routes/errors.test.ts`(集成 9 例:202 落库/指纹/UA、400 族、
  429+台账+换源、不可归因直通、onError 捕获与 401/403/200 门禁、列表过滤、
  汇总分组)、`apps/worker/src/errors/errors.test.ts`(集成 7 例:quiet /
  窗口外不计 / claimed+台账定格 / 同刻重跑冷却 / 唯一键竞态 / 冷却节奏 / 清理
  + 文案)、`apps/web/src/shared/lib/error-reporter.test.ts`(17 例:normalizer、
  节流、同形状冷却、传输失败吞掉、安装/卸装、main.tsx 源码文本哨兵)。

### 验证

- `DATABASE_URL=… corepack pnpm verify` 全绿(lint + typecheck + 全套测试,
  本地 PG 真库,新套件零 skip)。

## 判断层(本次会话手写)

1. **issue 即规格,老代码缺席就承认缺席**:开工前按惯例去老仓库找
   ingest-error / error-spike-alert / errorTracker.ts 作参考,结果迁移 HEAD 上
   一个都不存在(issue 的「老系统现状」写的是更早的状态)。没有硬凑「参考老
   实现」,PR 与域文档里明写「无代码可对照,语义按 issue 文字继承」——这影响
   验收基线:凡是 issue 没写死的数字(阈值 20、窗口 5min)都是新裁,不是移植。
2. **选题避开了三个「验收绑在别处」的 phase-1**:#31(12 处调用点替换 = 切换日
   动作)、#33(pg_dump 本机没有,记忆里已记 no psql)、#34(CloudWatch 基础设施
   不可本地验)。#28 是 #22–#34 区间里第一个能本地完整验收的。#128(PDF 服务)
   杠杆更高但它是多切片大服务,一个周期吃不下,留给后续会话整体规划。
3. **自研 vs Sentry 的评估就地裁掉**:issue 要求「评估」,裁自研——数据在自己
   库(项目一贯立场)、零新增基础设施(老系统本来就是自研形态)、体量是初创
   小团队量级。裁决写进域文档,Slack 告警复用 worker 已有的 SlackAlerter,
   「测试环境演练一次」的验收项留给部署后。
4. **遥测 sink 与限流 gate 刻意反向**:限流内核失败冒泡 500(#27 裁决 5,闸门),
   错误上报落库失败仍答 202(sink)——上报方是浏览器,5xx 换不来补救只会换来
   重试放大事故。这条与 #27 成对出现,两边注释互相引用。
5. **无 user 列是有意的**:公开上报端点无会话可依赖,api 侧归因靠 request_id
   互查服务端日志;错误行不收 PII,后续真需要时是 expand migration 加列,
   不是现在的猜测。breadcrumbs 同理押后到管理页切片。
6. **踩坑两处**:① Hono 的 router 在首个请求后编译成型,测试里给已发过请求的
   app 再 addRoute 会炸「matcher is already built」——必抛路由必须挪进
   beforeAll;② spike 的「同刻重跑」路径实际先撞冷却检查(冷却查的是最近台账
   行的 alertedAt,与窗口无关),唯一键的 already-claimed 只在「冷却已过 + 同
   窗口行已在」的双 worker 并发下出现——测试要构造台账预插行才能确定性命中,
   顺序调用永远到不了那条分支。
7. **web 测试沿用 house shape**:注入 fetch/clock + 结构化假 window(node 环境
   无 jsdom),main.tsx 的生产接线用源码文本哨兵钉住(version-check.test.ts 同
   款)——installErrorReporter(window) 必须恰好一次且在 createRoot(root) 之前。
