---
session_id: hand-written-110-comment-edit
branch: feat/110-comment-edit
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

# Session log — feat/110-comment-edit — 2026-10-06

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#110(评论、@提及、通知与活动流)——**切片 5:评论编辑**,
  PR 正文写 Part of #110(切片未完,严禁 Closes 关键字)
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净。
  选题:#110 评论明示「评论编辑(无阻塞,下一切片候选)」,规则①命中。

### 本切片改动的文件

- `packages/db/src/schema.ts`:comments 加 `edited_at`(可空 timestamptz,
  null = 从未编辑;注释同步改真话——原来写着「编辑随后续切片进场,没有
  消费者的列不预置」,现在消费者来了)+ 注释:编辑历史由审计承载,列只服务
  「(已编辑)」一个读者
- `packages/db/migrations/0011_far_lilith.sql`(新,drizzle 生成,expand-only:
  一条 ADD COLUMN)
- `apps/api/src/routes/comments.ts`:
  - `PATCH /api/comments/:id`:门序与删除一致(id 400 → 行 404 → subject 门
    404 → 作者 403 author_only);真变化才动行(正文 trim 后相等 = 幂等成功,
    不动 edited_at、不写审计、不重解析提及——follows 内核同一纪律)
  - 提及差集:新增提及 = parse(新正文) − parse(旧正文)(两版都只认当前
    可见者、排除作者),只对差集补发 comment.mentioned + 提交后实时催;
    不查询历史通知,纯函数差集
  - `commentJson` 收敛三个出口(list/create/edit)的行形状(含 editedAt,
    author 可空——leftJoin 形态)
- `apps/api/src/routes/registry.ts`:PATCH 声明(route-auth 契约守卫)
- `apps/api/src/routes/comments.test.ts`:+7 条集成(编辑落库 + 审计 +
  editedAt;author_only/404/400 家族;幂等无审计;新增提及补通知 + 催;
  已提及者不重复打扰/撤回提及不通知/再加回再通知;编辑对圈外人名字不通知;
  改派出可见者集合后作者 404)
- `apps/web`:`comments-client.ts`(edit 适配器 PATCH + 四态;commentRowSchema
  加 `editedAt: z.string().nullable()`、author 收紧为 nullable 与服务端
  leftJoin 形态一致);`TaskDetail.tsx`(own 行内 Edit/Save/Cancel、「(edited)」
  标记、编辑失败四态话术;activity 词表加 comment.updated = "edited a
  comment" 且与 comment.created 同深链);`comments-client.test.ts`(+3)、
  `task-detail-page.test.ts`(author 断言适配 optional chaining,+1 条编辑
  UI 源码断言)
- 文档:`docs/audit.md`(词表登记 comment.updated 及幂等不落行纪律;归属
  约定的评论行补 updated)
- 顺带(在范围内,理由见判断层 5):`packages/db/src/migrations.test.ts`
  并发迁移测试加显式 30s 超时

### 验证

- `corepack pnpm verify` 全绿:**65 文件 / 486 测试**(含 DB 集成,本地
  postgres),连续两轮稳定
- pre-push 钩子正常跑 verify(未绕过)

## 判断层(手写)

### 本次的关键判断

1. **编辑语义照内核既有形态长,不发明新机制**:动词归作者本人(与删除同一
   403 author_only 形态);门序与删除同序(行定位 → subject 门 → 作者);
   404 与不存在同回答(反探测)。老系统没有可移植的评论实现(greenfield,
   同切片 1/4),#232 §11 只说「每个业务对象都有」,编辑细节是本切片的裁决。
2. **真变化才落审计**:正文 trim 后相等的 PATCH 是幂等成功——不动 edited_at、
   不写 comment.updated、不重解析提及。依据是 follows 内核(#110 切片 4)的
   「PUT/DELETE 幂等只在真变化时落审计」同一纪律;否则连点两次保存就是两条
   假活动。
3. **编辑与提及:差集补通知,不重发、不撤回**。「新增提及 = parse(新) −
   parse(旧)」,两版解析都只认当前可见者、排除作者——创建时已通知过的人
   永不因编辑二次打扰;把 @ 撤掉不通知任何人(撤回不是通知的动词);删了
   再加回 = 相对当前正文又是新增,再通知。不查询历史通知表/审计来算差集,
   纯两版正文函数,重复编辑同一批名字天然幂等。编辑不向关注者重发扇出:
   关注者订阅的是「有新评论」这个动静,不是「有评论被改」;已发通知里的
   摘要是发出时的事实快照,不随编辑重写(通知是已发送事实,不是投影)。
4. **edited_at 而非 updated_at,单列不加编辑历史**:行只有 body 可变,编辑
   历史的完整载体是审计行(comment.updated,append-only),列只服务 UI 的
   「(已编辑)」标记;不预置 version 表(无消费者)。schema 里「没有消费者的
   列不预置」的旧注释由本切片兑现,改为真话。
5. **migrations 并发测试的显式超时是本切片范围内的事,不是顺手重构**:
   stash 对照实证——干净 main 全量绿,加上本切片的 11 条测试(其中 7 条打
   postgres)后,该测试在 65 worker 并行下持续超 5s 默认预算(单独跑 0.5–0.9s)。
   它断言的是 advisory lock 的串行化语义不是速度,预算被并行负载顶爆是假红;
   本切片新增的 DB 并行负载只是把既有隐患推过线(CI 换更慢的 runner 同样可能
   中招)。给 30s 显式超时,让机器忙时测的仍是那把锁,不是时钟。
6. **验收标准的诚实处理**:#110 唯一验收条(「被 @ 的人实时收到通知,点击后
   跳到对应位置」)已在切片 2 闭环,本切片是切片清单的续项;剩余项(附件、
   阶段笔记+AI 摘要、邮件汇总、状态/改派投递、活动流实时自刷新)在 PR 正文
   逐条列出,PR 写 Part of #110。

### 踩的坑(都花时间修了)

1. **route-auth 守卫:新路由必须登记**——PATCH /api/comments/:id 一上,
   route-auth.test.ts 立红(声明白名单双向比对,#23 的机制)。这是机制在
   正常工作,登记一行即绿;教训是「新路由三件套」要背下来:实现、registry
   声明、测试。
2. **task-detail-page.test.ts 是源码断言式测试**:把 `row.author.id` 改成
   `row.author?.id`(author 收紧为 nullable 后 typecheck 所需)会打断「源码
   包含某串」的断言。页面行为的回归网在这里长在源码文本上,改渲染结构时
   记得同步改断言,别当它是纯行为测试。
3. **eslint no-unnecessary-boolean-literal-compare 对判别联合也开火**:
   `page.ok === true ? … : …` 在测试里被判多余比较(联合判别式在它眼里就是
   boolean 比较)。正解不是压 lint,是把断言写成整体 toEqual——顺带更严
   (整形状相等,不是挑一个字段)。
4. **全量并行下的 5s 超时假红**:单跑全绿、全量必红,先怀疑自己新增了
   contention——stash 对照(干净 main 绿 / 改动后红)十分钟定案是负载型,
   修预算而不是修测试逻辑(判断层 5)。对照法比读代码猜快得多。

### 剩余(#110,后续切片)

- 附件(等 @ally/storage)
- 阶段笔记 + AI 摘要(被 ops 域阻塞)
- 邮件汇总(被 #116 阻塞)
- 任务状态/改派对关注者的投递(随任务域切片)
- 活动流实时自刷新(需 subject 维度频道,随 #30)
