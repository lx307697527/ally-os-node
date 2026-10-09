# 错误追踪：前后端错误统一捕获、汇总与告警（#28）

前端与后端的错误进同一张表、同一个查询面，激增时 Slack 喊人。老系统的对应物
（`errorTracker.ts` 全局捕获、`ingest-error` / `error-spike-alert` edge function、
`/admin/error-logs` 页面）在老仓库迁移 HEAD 上已不存在——本域按 issue #28 的迁移
要点重建，老语义（指纹分组、客户端 10/min 节流、30 分钟冷却、Slack 告警）从 issue
文字继承，未对照老代码（无代码可对照）。

设计依据：#232「系统结构」平台服务 · 所属模块 #185 · phase-1。

## 切片地图

| 切片 | 内容 | 状态 |
| --- | --- | --- |
| 内核（切片 1） | error_events / error_spikes 表 · 公开上报端点 · onError 捕获 · 读面（列表 + 指纹汇总）· 激增告警任务 · 保留策略 | ✅ #323（2026-10-09） |
| 管理页 | /admin/error-logs 的 web 面（消费读面 API） | ✅ 本切片（`/system/error-events`） |
| 验收演练 | 「错误激增时 Slack 能收到告警（测试环境演练一次）」 | 待部署后演练（worker 需配 SLACK_WEBHOOK_URL） |

## 数据面

- **error_events：一行一次发生**。聚合（次数、firstSeen、lastSeen）是
  fingerprint 上的查询投影不是存储形态；行数即发生次数，激增检测数行数即可。
- **指纹服务端算**：sha256(source | 栈顶帧 | message 首行)。客户端声称的分组
  不可信（公开端点的请求体谁都能填）；source 进指纹，web 与 api 的同名错误不
  互相污染分组。message 首行分组的含义：「…: cause」链算同一个错。
- **字段是分诊最小集**：message/stack/url/user_agent 各有长度上限（遥测行不是
  免费存储）；**没有 user 列**——web 侧上报是无会话的公开面，api 侧归因靠
  request_id 与服务端日志互查，错误行不收 PII。breadcrumbs（老 errorTracker 有）
  刻意不做：当前后台还是壳，等 web 控制台有真实交互面了随管理页切片再加列
  （expand migration，不破契约）。
- **error_spikes：一次告警一行**，window_start 唯一键 = 幂等键。检测到 → 先落
  台账（主张窗口）→ 再投递 Slack；通道失败只 warn 不重投——台账行已证明
  「检测到并主张了这个窗口」，at-most-once 刻意为之。

## 捕获面

- **web（公开上报端点 POST /api/errors）**：挂在会话中间件之前——报错最常见的
  时刻恰恰是会话不在/刚断的时刻，登录门会把最重要的样本挡在门外。zod 上限
  （message 2K / stack 8K / url 500）、UA 只从请求头取（请求体声明不了）、指纹
  服务端补。限流复用 #27 切片 1 的 PG 内核：`errors.ingest` 10 次/分钟/IP（服务端
  节流才是真节流，客户端 10/min 只是礼貌）；不可归因不计数（同 #27 裁决 1）。
  拒绝照计数 + 拒绝进 rate_limit_denials 台账，与认证面同一套语义。
- **web 客户端（apps/web/src/shared/lib/error-reporter.ts）**：window 的 error +
  unhandledrejection 双监听，fire-and-forget，永不重试（失败的上报就丢了，页面
  不能为上报再抛错）。客户端 10/min 节流 + 同形状（message + 栈顶帧）60 秒冷却
  ——崩循环页面每 tick 抛同一个错，冷却把它压成一声。
- **api（app.onError 捕获）**：unhandled 500 落一行 source='api'，requestId 与
  响应体一致可互查。刻意的 4xx（校验失败、权限拒绝）不抛异常，不进本表——
  这里是「程序没料到的事」的台账，不是请求统计。
- **落库失败不产生用户可见失败**（遥测定位，与限流内核刻意相反）：上报端点
  落库失败仍答 202、onError 捕获失败只 warn——上报方是浏览器，5xx 换不来补救
  只会换来重试放大事故；限流内核是闸门所以错误冒泡（#27 裁决 5），遥测是
  sink，sink 不设闸。

## 读面（audit.read 门，owner/admin 默认）

- `GET /api/error-events`：明细列表，最新在前，fingerprint/source 过滤，
  offset 分页 + 精确 total（audit-events 同形状）。
- `GET /api/error-events/summary`：按指纹分组的汇总（窗口默认 7 天、上限 30），
  count 降序 + 最近样本 message——分诊第一屏「最近哪种错误最多」，点进指纹
  再翻明细。管理页（web 面）随可见性切片消费这两个端点。

## 管理页（/system/error-events，#28 切片 2）

- System 区的「Error events」页，消费上面两个端点；`audit.read` 同门，
  无权限的账号在页面里得到明确答复。同 #27 拦截可见面的裁法：**台账是遥测
  不是工作队列，页面没有处置动词**——上报方已把行写好，页面对「什么坏了、
  坏在哪、多频繁、从何时」负责，不对修复负责（测试有负断言钉住这条）。
- 形态与 rate-limits 页同构：指纹汇总条（窗口 7 天、次数降序、样本 message
  自描述）+ 明细台账（最新在前、offset 分页 + 精确 total）。指纹是 64 位
  十六进制，表格里用前 12 位做行把手（完整值在 title 与过滤态里）；点汇总
  行的指纹 = 台账按指纹过滤，再点一次解除。source 过滤（web/api）是 ghost
  tab；每次改过滤把分页归零、台账诚实塌回加载行——旧行回答的是另一个问题，
  翻页才保留旧页。
- 失败面逐个说：403（无 audit.read）与不可达各有说辞；汇总单独失败只降级
  汇总位，台账照常渲染。stack 默认折叠（details），点开看全文——分诊第一眼
  要的是 message 与发生位置，不是 8KB 的栈文本。
- 行 schema 的 source 是开集（表列不枚举，worker/portal 进场不改数据库）：
  web 侧行 schema 读作 string，未来来源的行照常渲染；过滤参数才收窄到
  当前端点接受的 web/api。

## 激增告警（worker 任务 error-spike-alert，每 5 分钟）

- 检测 = 数行数：最近一个 5 分钟窗口的 error_events 行数 ≥ 20 即激增。阈值与
  窗口是代码常量（#27 同一裁法），节奏按老语义（定时检测、30 分钟冷却、Slack）。
- 判定与占位一次完成：先过冷却（最近一次告警 30 分钟内 → 不喊），再撞
  error_spikes.window_start 唯一键主张窗口——cron 重试或双 worker 并发，后到的
  拿 already-claimed 放弃，「告警不重复」是结构保证。
- Slack 文案面向值班的人：数字、窗口、阈值、去 summary 端点的指引；不猜根因。
- 任务名沿用老名 error-spike-alert；老仓库迁移 HEAD 的任务表上没有它（见
  docs/cron-migration.md 表 A 后的注记），切换日老库无需 unschedule。

## 清理（worker 任务 error-events-cleanup，每 10 分钟）

错误事件留 30 天（与限流拒绝台账同一性质的运维遥测，同一个数）；激增台账留
90 天（一行一次告警，体量极小，季度回顾对得上告警史）。
