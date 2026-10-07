---
session_id: hand-written-113-task-event-fanout
branch: feat/113-task-event-fanout
date: 2026-10-07
reason: issue-113
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/113-task-event-fanout — 2026-10-07

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#113(后台任务管理)切片 1 的后续——剩余项「任务状态/
  改派对关注者的投递」(该剩余项同时挂在 #110 的剩余清单里,标注「随任务
  域切片」)。PR 正文写 Part of #113(#113 仍开:AI 拆分等 #118、分配邮件
  随 #116 渠道语义裁决、团队全局视图随 RBAC、ops 六态随 ops 域)。
- **前置收尾(第 0 步)**:接手时有一枚 open PR #298(#110 附件切片),CI
  watch 全绿后 merge 时发现已被并发会话 squash 合并(e65186d,issue 评论
  亦已发);收尾其残留在主检出的 worktree(Windows 长文件名导致
  `git worktree remove` 删目录失败,git 已注销注册,`rm -rf` 补删)与本地
  分支,main 快进到 e65186d。
- **选题**:①优先续做 issue 评论里的未完成切片。核对最近活跃 issue 的
  剩余清单:#110 剩余全部等外部依赖(阶段笔记等 ops 域、AI 摘要等 #118、
  实时自刷新等 #30);#222 剩表单构建器(设计选型未决)与消费域;#226 剩
  ① 等 #206、③ 刻意推迟;#224 剩 SMS/AI/序列(外部依赖)。#113 剩余项 3
  (分配邮件)的阻塞(#116 渠道层)已随 #281 落地,且「任务状态/改派对关注
  者的投递」正是 #110 明文「随任务域切片」的挂账项——零依赖、边界清晰,
  选定为本切片。claim 原子接管成功(上一会话残留租约)。
- **老系统参考(只读)**:老系统三套任务表各自带 task_activity,通知止步
  于站内信/邮件边函数(send-task-assignment-email);关注机制不存在
  (#110 切片 4 已裁决 greenfield)。本切片的投递语义全部依据新内核的既有
  裁决,无老代码可移植。
- **数据库**:本地 postgres 可用,verify 全程带 DATABASE_URL(无 skip)。

### 本切片改动的文件

- `apps/api/src/routes/tasks.ts`:PATCH 的事务里,真实状态流转对关注者扇出
  `task.status_changed`(facts:taskTitle/actorName/from/to)——名单 = 关注
  者(含改派后复活的陈旧关注行)− 操作者 − 定向事件已覆盖的新经办人(一人
  一个 PATCH 至多一条,定向优先)− 不在当前可见者集合的人;提交后随既有
  nudgedTo 一并实时「催」。模块头注释同步(投递语义与改派裁决)。
- `apps/web/src/shared/lib/notification-face.ts`:白名单 + `task.status_changed`
  文案(动词从 to 的事实来:completed/cancelled/reopened,缺位用中性的
  updated 不硬凑方向),去处 = 任务详情深链(路由已存在,parity 守卫自动覆盖)。
- `docs/notifications.md`:生产者清单三 → 四;新增任务域裁决段(改派无
  关注者事件的结构性理由、内容编辑不扇出)。
- 测试:`apps/api/src/routes/tasks.test.ts` +2(投递正例带 facts 断言与
  操作者排除/no-op 零通知;改派收口为零 + 陈旧关注行复活时定向优先),
  `apps/web/src/shared/lib/notification-face.test.ts` +2(文案四动词与
  白名单精确形状);beforeEach 增补 follows 清表。

## 判断层(手写 —— hook 写不出这部分)

- **本次的关键判断——改派对关注者的投递「结构性为零」,于是不为不可能的
  收件人立事件**:动笔前按 #110 剩余清单的字面(「任务状态/改派对关注者的
  投递」)本打算落两个事件类型;推演可见性模型时发现:关注者 ⊆ 可见者 =
  {创建人, 经办人},而改派只能由创建人操作(403 creator_only),改派把旧
  经办人移出可见者、创建人是操作者本人——**可投递集合恒为空**。若照字面
  落 `task.reassigned`,那是永远发不出一行的事件类型。裁决:改派的「投递」
  就是新经办人的定向 task.assigned(已存在),关注者侧不立事件;唯一真实的
  重叠路径(陈旧关注行随重新指派复活,同一人同时命中定向与扇出)用「一人
  一个 PATCH 至多一条、定向优先」收口(comments 内核「提及优先」同构)。
  裁决写进路由注释、docs/notifications.md 与 #110 的收口评论。
- **试过又放弃的路径**:①先写的集成测试断言 bob「零通知」——漏了创建时
  的 task.assigned 那一条,修正为按事件类型序列断言(顺带让 no-op 零通知
  的断言更有钉力);②考虑过给「被移走的旧经办人」发定向通知(taken away),
  放弃:无 issue 文本依据、老系统也没有,定向通知的词表不为想象的需求扩
  张(需要时随真实域需求进场)。
- **顺手发现但不在本次范围内的问题**:无新发现;`payloadDetail` 的 digest
  渲染键序(taskTitle 优先)与本切片 payload 形状天然契合,worker 零改动。
- **留下的尾巴 / 下一个人该知道的事**:#113 剩余项 3「分配后邮件」在
  #116 渠道层语义下需要一次裁决——设计 §11 的邮件渠道是「每日摘要」而非
  即时邮件,摘要天然覆盖 task.assigned(emailDigest=true 的未读行都进);
  若业务要即时分配邮件,那是渠道层新增「即时信」类型,不是任务域的活。
  #110 剩余清单的这条(「任务状态/改派对关注者的投递」)本切片收口,评论
  已注明;#110 其余剩余项依赖不变。
- **派出的子代理及各自结论**:无(单切片,直接实现)。
- **值得纳入项目的点**:推演「谁可能收到」先画集合(关注者 ⊆ 可见者,操作
  者排除,定向覆盖去重)再写代码,结构性为零的路径直接在注释/文档里记
  裁决——比留一个死事件类型等 review 抓便宜得多;这条已体现在
  docs/notifications.md 的新段落里。
