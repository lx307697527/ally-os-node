---
session_id: hand-written-129-slice4-undo-bell-feedback
branch: feat/129-undo-bell-feedback
date: 2026-10-06
reason: issue-129
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/129-undo-bell-feedback — 2026-10-06

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **时间跨度**:2026-10-06 凌晨~(UTC+8)
- **引用的 issue**:#129(后台框架与通用交互;切片 4:删除撤销 + 通知铃 +
  反馈入口;#232「系统结构」)
- **PR**:feat/129-undo-bell-feedback

### 前置收尾(第 0 步)

- 无 open PR、无残留 worktree、主检出干净。
- **发现并修正:#129 被误关闭**——PR #251 正文写了「Closes #129 的切片 3」,
  GitHub 关键字机制不看语义,把整个 issue 关了;而该 PR 自己的评论还列着
  「剩余:切片 4 / i18n / ops」。本次重开 issue 并留言说明,然后续做切片 4。
- main 上 15:04 UTC 的红 run 是已知 service-container 端口 flake 且已被
  #258 合并后的新 HEAD run 取代,未重跑。

### 本切片改动的文件

- `packages/db/src/schema.ts`:新表 `notifications`(userId FK cascade、
  event_type、aggregate、payload jsonb、is_read/read_at;(user_id, created_at
  desc) 索引 + 未读部分索引);新表 `feedback_reports`(BR- 编号唯一、
  type/priority/status 三个 pgEnum 与老 CHECK 词表逐值一致、提交人快照)
- `packages/db/migrations/0006_conscious_vulture.sql`(新,expand-only)+ meta
- `apps/api/src/routes/notifications.ts`(新):summary 单读(≤20 行 +
  未读封顶 21 哨兵)、按 id 已读(他人 id 静默 no-op)、read-all
- `apps/api/src/routes/feedback.ts`(新):提交端点,提交人从会话解析落快照,
  BR-+8hex 撞号沿 cause 链认 23505 重掷(≤3 轮)
- `apps/api/src/routes/registry.ts`:4 条新声明(session 级);app.ts 挂载
  (在 2FA 强制门之后 = 默认门后)
- `apps/api/src/routes/notifications.test.ts` + `feedback.test.ts`(新,
  DB 集成:隔离/封顶/静默 no-op/快照/400 族)
- `packages/ui/src/Toast.tsx`(新,缩减移植:brand 面 + onUndo/action +
  autoDismiss + BUG-547 live-region 裁定;card/slide 随弹窗切片再来)+
  index.ts 导出
- `apps/web`:undo-window.ts(纯状态机)+ use-delete-with-undo.ts(薄壳)+
  notification-face.ts(unreadBadge/describe 兜底面/相对时间)+
  notifications-client.ts(zod 适配器)+ use-visible-poll.ts(移植)+
  NotificationBell.tsx + feedback-draft.ts(纯校验)+ feedback-client.ts +
  FeedbackDialog.tsx;InternalShell 加 `bell` 槽位与 `onSubmitFeedback`
  菜单项(壳仍不取数);App.tsx 组合根接线(模块级单例 adapters)
- `docs/notifications.md` + `docs/feedback.md`(新)
- **无新依赖、无新 env**

### 验证

- `corepack pnpm verify` 全绿;`DATABASE_URL=… corepack pnpm test`
  **344/344**(存量 300 + 新增 44);vite build 通过

## 判断层(手写 —— hook 写不出这部分)

**做了什么判断,为什么:**

1. **useDeleteWithUndo 判定为「老仓库不存在,按设计自建」。** 全仓零命中
   (issue 的 hook 清单引自更早的 ally-nutra 仓库——已知坑)。最接近的先例是
   QuoteBuilder2 的纯本地撤销,但它删的是未保存草稿,无窗口期、无服务端往返。
   新系统删的是已落库数据,所以做成有界窗口状态机,三条语义是刻意裁定:
   **有界窗口**(10s,到期即真删——无界"待删"等于把删除交给用户忘了点)、
   **替换即提交**(同时只有一条悬而未决,被替换的那条立即提交,不会悄悄丢)、
   **卸载即提交**(带着待删项导航走,提交照做)。commit 失败 = 服务端拒绝 =
   行还在,**自动恢复显示**(吞掉已删的行是本机制唯一不允许的失败模式),
   onCommitError 只管上报。Toast 的 autoDismiss 与窗口共用 UNDO_WINDOW_MS
   ——通知消失与删除落库是同一件事的两面。目前尚无业务消费方(第一个删除面
   随 CRM 落地),与 @ally/ui「组件随需要它的页面移植」同款:机制先行、测试
   钉住、消费方到来即插即用。
2. **通知铃判为「框架 + 端点」本切片落地,扇出生产者刻意不落地。** 老系统
   的写入方是 core.outbox 触发器按白名单扇出;新系统还没有 outbox/事件总线,
   业务事件一个都不存在——现在建扇出是无源之水。表结构按老系统直译(减
   outbox_id,幂等键随生产者补列,expand-only),docs/notifications.md 写明
   生产者接缝。轮询裁决原样渡河(60s 可见轮询、隐藏暂停、回归即读、失败的
   读不是零、写入后服务端重读),realtime 总线(#30)没有通知发布者,铃不动。
3. **反馈入口 = FeedbackForm 的最小闭环,不是 SupportDesk。** 老仓库里「后台
   内提交问题」是 FEAT-198 的 feedback_reports + submit RPC;SupportDesk 是
   客户工单的员工侧(知识库是 AI 外延),都另账。本切片只做「入口」:表 +
   提交端点 + 会话菜单入口的对话框;管理队列、附件(等 @ally/storage)、
   GitHub 同步、AI 助手、提交后给管理员发通知(FEAT-637)全部列为剩余。
   type 只收表单两值,process_gap 是 AI 助手专属词,API 不收。
4. **已读端点保留「他人 id 静默 no-op」的反探测裁定。** 不区分「不存在」与
   「不是你的」,两种情况都是 200 {marked:0};畸形 uuid 才 400。summary 的
   未读数封顶 21(=「超过 20」哨兵)也原样渡河——为 "20+" 角标数出精确总数
   是白花的查询。
5. **铃是槽位不是依赖。** InternalShell 加 `bell?: ReactNode`,组合根把
   渲染好的铃元素递进来;壳的纪律(「goes and gets nothing」)零破坏,
   internal-shell.test.ts 的「壳不 import/fetch」断言加固了这一点。反馈入口
   同理:onSubmitFeedback 只是回调,对话框状态在组合根。
6. **Toast 缩减移植并写明欠条。** 只搬 brand 面(onUndo/action/autoDismiss/
   BUG-547 的「live region 先空提交、文字后到」裁定);card 外观与 slide
   动效是 FEAT-638 的弹窗通知那套,随那个切片一起移植,文件头写明,避免
   「半个组件」被误当成完整裁决。
7. **describeNotification 先落兜底面。** 老系统 678 行展示层(event_type →
   title/detail/href 白名单 + SQL 双向 parity)的价值绑定在「有生产者」上;
   现在所有事件都不存在,先把接缝(payload.title/detail 否则 event_type
   原文、href 恒 null)立住,白名单随第一个扇出生产者来。

**踩的坑:**

- **eslint 规则错位消耗三轮**:prefer-nullish-coalescing 连报三次,行号一直
  指着 use-visible-poll.ts:59——前两轮我改的都是 ??= 相关行,第三轮才看清
  59:7 是老代码原样的 `if (timer === null) timer = setInterval(...)`。报错
  行号要逐列核对到具体表达式,不能凭「这文件我刚改过」的印象定位。
- **useDeleteWithUndo 的 TS 收窄两难**:同步路径 `windowRef.current` 经 `??=`
  后已收窄,可选链会被 no-unnecessary-condition 打回;而卸载 effect 的闭包里
  TS 不追踪 ref 赋值,直取又报 possibly-null。解法:同步路径直取、闭包内
  可选链(两处各有注释说明为什么是那样)。
- **React 19 类型:FormEvent 已弃用**,onSubmit 用 SyntheticEvent(切片 1 的
  已知坑第二次命中)。
- **测试夹具的假 resolveSession 最初无条件返回会话**,「未登录 401」用例
  全红——假会话解析必须按标记头分流,无标记返回 null。
- **drizzle 0.45 把 PG 错误包进 DrizzleQueryError.cause**(已知坑第 N 次
  命中):BR- 编号撞唯一索引要沿 cause 链认 23505,直接查 err.code 永远
  undefined。识别逻辑与 shadow-account.ts 同构。

**值得纳入项目的点:**

- **PR 正文别写「Closes #N 的切片 X」**——GitHub 关键字不看中文语境,会把
  整个 issue 关掉。部分完成一律写「Part of #N」+ 剩余项清单。
- **撤销窗口类机制(乐观 UI + 延迟提交)的三条不变式**值得复用:替换即提交、
  卸载即提交、失败即恢复。任何「先斩后奏」的 UI 都该对齐这三条。
- **`z.string().uuid()` 在 zod v4 已弃用**,新代码用 `z.uuid()`(本次 lint
  的 no-deprecated 抓的,记入工具箱)。
