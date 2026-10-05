---
session_id: hand-written-110-comments-kernel
branch: feat/110-comments-kernel
date: 2026-10-06
reason: issue-110
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/110-comments-kernel — 2026-10-06

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#110(评论、@提及、通知与活动流;#232 §11「评论、@、
  关注与附件:每个业务对象都有」)——**切片 1:评论内核(@提及通知 +
  通知点击跳转)**,PR 正文写 Part of #110(实时推送、活动流、关注、附件、
  阶段笔记与 AI 摘要未做,严禁 Closes 关键字)
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree;主检出快进 1 个提交
  (#261 任务内核已合并)后干净。选题:全部未完切片的 issue 剩余项仍被
  #227/#235 阻塞(与 #113 会话结论一致);#110 是被 #261 解锁的下一张——
  任务内核就是评论的第一个附着对象,本轮兑现它。
- **老系统勘察(子代理只读)**:issue 正文里的 workspace_comments /
  useComments / ActivityPage 在这一代**从未存在**(更老一代的遗产,仓库
  全历史 pickaxe 无痕迹);唯一的真实锚点是 platform.notifications 的
  「通知 = 事实行,文案与深链在前端算」模式与两个守卫测试的想法。迁移依据
  始终是 issue 验收 + #232,老代码没有可照搬的实现。
- **兼容性确认**:#113 切片 1 的 schema 注释明确「附着列随第一个有附着对象
  的业务域切片 expand-only 进场」——本切片就是这个切片,comments 表的
  subject_type/subject_id 是它的兑现,不是新裁决。

### 本切片改动的文件

- `packages/db/src/schema.ts`:`comments` 表(6 列 1 索引 1 FK;作者
  CASCADE——对话性内容人删随之,与 tasks 的 SET NULL 是同一原则的两侧)
- `packages/db/migrations/0009_lame_jackpot.sql`(新,drizzle 生成,
  expand-only)+ meta 快照
- `apps/api/src/routes/comments.ts`(新):`GET/POST /api/comments`、
  `DELETE /api/comments/:id`;SUBJECT_LOADERS 注册表(task = 第一个注册的
  subject,行属 = 创建人/经办人);提及从正文解析、只对可见者精确匹配
  「@全名」;评论 + 审计 + 提及通知同一事务
- `apps/api/src/routes/registry.ts`:3 条新路由声明(session 类)
- `apps/api/src/app.ts`:挂 commentsRoutes
- `docs/audit.md`:词表补 comment.created / comment.deleted
- `apps/web`:`shared/lib/comments-client.ts`(五态:ok/notfound/forbidden/
  conflict/unavailable);`tasks-client.ts` 补 `get(id)`(TaskGetResult 的
  404 是有意义的「没了或不是你的」,不折进 unavailable);
  `shared/pages/TaskDetail.tsx`(新,`/tasks/:taskId`:任务只读详情 + 评论
  面板 + composer,`?comment=` 滚动定位并高亮);`Tasks.tsx` 行标题改为
  详情链接;`notification-face.ts` 白名单落地(task.assigned /
  comment.mentioned → 深链,文案从 payload 事实拼);`NotificationBell.tsx`
  点击先标已读再 navigate(face.href 非空时);App.tsx 挂详情路由
- 测试:`apps/api/src/routes/comments.test.ts`(独立临时库:7 条集成 +
  mentionsName 纯函数 2 条);`comments-client.test.ts`(5 条);
  `task-detail-page.test.ts`(源码断言 6 条);
  `notification-href-routes.test.ts`(新守卫:白名单 href 必须命中 App.tsx
  注册路由、catch-all 不算——老系统同一守卫的移植);`notification-face
  .test.ts`、`notification-bell.test.ts`、`tasks-page.test.ts` 各扩
- **无新依赖、无新 env**

### 验证

- `DATABASE_URL=… corepack pnpm verify` 全绿:**55 文件 / 416 测试**(此前
  387;本地 postgres = docker ally-os-node-postgres-1)
- `corepack pnpm db:generate` 复核无漂移(「No schema changes」)
- lint / typecheck 干净(过程中修了 11 条自家新增的 lint 红,无一豁免)

## 判断层(手写)

### 本次的关键判断

1. **老系统无物可搬,设计全部落在 issue 验收上**:勘察确认这一代从未建成
   评论/@——这不是「照搬走样」的风险而是「连锚点都没有」。于是两件事定调:
   (a) 形态听 #232 §11 的「挂在每个业务对象上」→ 通用 `/api/comments?
   subjectType=&subjectId=` 面,而不是嵌套 `/api/tasks/:id/comments`——路径
   即形态声明,下一个业务域零迁移注册即用;(b) 可搬的只有模式——通知表存
   事实、前端映射表算文案与深链,以及 href-routes parity 守卫(它在老系统
   抓过深链静默落 catch-all 的真 bug)。
2. **提及解析:正文文本 + 只对可见者精确匹配 @全名,而不是客户端传
   mentionIds**:传 id 是把「通知谁」交给客户端构造,正文与名单可能两张皮;
   文本解析让正文自己携带提及事实,服务端解析面只有一个函数(词边界收口,
   「@Alice1」「@Alicia」不误伤)。只对可见者匹配不是偷懒:任务可见集 =
   创建人+经办人,评论者本就是其中之一,提到圈外人要么是行文要么该先做
   「拉人进任务」的可见性裁决——那不归评论内核顺手发明。歧义不用 400 消:
   composer 写明参与者名单,POST 响应回显 mentioned(前端亮「Notified:」)
   ——用事实消歧,不用报错惩罚行文。
3. **评论作者 FK 用 CASCADE,与任务 assignee 的 SET NULL 相反,是同一原则
   的两侧**:判断标准是「内容是否要比人活得久」。任务是人家的待办记录,人
   走任务留;评论是人对人的话,人删则其话随之(通知行 CASCADE 已然如此,
   评论留着会变成孤儿语境);审计 comment.* 行留下(actor 是 text,不依赖
   用户行)。#129 反馈的 NO ACTION(提交人必须可追)也是同一判据下的另一侧。
4. **@提及通知现在就写,实时推送不做**:comment.mentioned 是通知表第三个
   生产者(此前仅 task.assigned),生产者越多,统一推送层 (#30 hub +
   realtime-client 已在) 的摊销越薄——铃铛订阅作为独立切片排下一张,验收
   的「实时」以 60s 可见轮询为过渡,PR 正文如实列剩余项。
5. **通知白名单这次落地,且 task.assigned 顺带获得深链**:文案与深链的映射
   表是同一个机制,#113 会话留的「href: null(还没有可跳的业务页)」的空转
   到本切片终止;给 task.assigned 补深链不是顺手重构,是这张表落地的题眼。
   点击 = 标已读 + navigate;无处可去的行维持只读点击(兜底面不变)。
6. **第一个记录路由保持只读**:TaskDetail 只展示任务字段 + 评论面板,状态
   翻转/编辑留在列表页;InternalShell 注释里「record chip / parent crumb 随
   第一个记录路由回归」也不在本切片——shell 通用机制该有自己的切片,不与
   评论内核捆绑。切片边界:评论内核 + 它的第一个消费者,仅此。
7. **DELETE 的 403/404 分层照抄任务改派的先例**:可见者删别人的评论 =
   403 author_only(说得出「谁的动词」),圈外人/不存在 = 404(拿不到探测
   结论)。评论者集合 ⊆ 可见者,所以 403 只会落在「看得到但不是作者」上,
   语义干净。
8. **comments-client 的五态、tasks-client 的四态 + get 的 notfound**:
   404 在列表/详情/删除里是「subject 没了或不是你的」——有业务含义,独立成
   notfound,不折进 unavailable;页面据此渲染「不可用」而不是「加载失败」,
   两种失败不同话。

### 踩的坑

1. **worktree 会话的 shell cwd 会漂移**:一条 db:generate 在主检出外跑进了
   老仓库(命令不存在,立即失败,无副作用)——此后每条命令显式 `cd` 进
   worktree。同一根因的变体:packages/ui 的组件清单「时多时少」——多的那次
   其实 ls 的是老仓库的 ui 库(30+ 组件),新仓库 @ally/ui 只有 slice-1
   子集(6 个),**没有 Textarea**;composer 用原生 textarea + tokens 类
   (Tasks 页原生 select 同款处理),import 靠 barrel 文件头确认。
2. **strict + eslint 的连带**:prefer-optional-chain 把
   `subject === null || !subject.viewers.some(...)` 判可简写 →
   `subject?.viewers.some(...) !== true`;personSchema 非 null 后
   `row.author?.id` 是 no-unnecessary-condition → 去 `?.`,**源码断言测试
   必须跟着源码改**(test 里断言的还是带 `?.` 的旧串)。dot-notation 对
   `payload["taskTitle"]` 也有意见。
3. **POST 回显的 mentioned 是 {id,name} 人形**,audit detail.mentioned 才是
   id 数组——两个集成测试先按裸 id 写错了形状。
4. **href-parity 测试读 App.tsx 的相对路径**:测试在 shared/lib/ 下,
   App.tsx 在上**两级**,少写一级就是 ENOENT(套件级失败,零测试执行)。
5. **verify 要带 DATABASE_URL 跑**:裸 `pnpm verify` 会把 14 个集成测试文件
   静默 skip 后报绿——「全绿」和「跳过」是两种绿,pre-push 之前显式带上。
6. **CI 红但 416 条全绿:拆库的 57P01 拆的是 suite 不是断言**(本 PR 唯一一次
   CI 红):migrations.test.ts(本切片未触碰)的 migration_race 测试在
   `DROP … WITH FORCE` 时,若还有空闲池连接被 Postgres 强杀,pg Pool 按「空闲
   客户端出错」语义把 FATAL 57P01 重发到 pool 对象上——没有监听就是未捕获
   异常,vitest 记 1 error 整轮红。本切片新增第 55 个并行 worker 扰动了既有
   时序把它抖出来。修法:按 pg 文档给 race 测试的两个池挂 `error` 空 listener
   (预期的拆除错误),自己的 comments.test.ts 同款加固;断言零改动,测试没有
   被削弱——被削弱的是「拆库时异步报错能炸掉整轮 run」这个隐性行为。
