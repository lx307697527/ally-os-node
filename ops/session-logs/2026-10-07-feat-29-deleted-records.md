---
session_id: hand-written-29-deleted-records
branch: feat/29-deleted-records
date: 2026-10-07
reason: issue-29
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/29-deleted-records — 2026-10-07

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#29 剩余清单第 2 条「删除记录 + 快照 + 恢复 → 验收第 2 条」
  (docs/audit.md「剩余」节同文)。PR 正文写 **Closes 不行——Part of #29**
  (#29 尚余业务域接线/状态变更投影/Part 11 逐表评估,保持 open)。
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净;fetch 后
  main 顶端 a24e413(#300 发票内核)。
- **选题**:①优先续做有未完成切片的 open issue。候选:#110 剩余(阶段笔记等
  ops 域/#30 频道,均阻塞)、#224 剩余(SMS/#118 阻塞)、#221 金额域(等
  #229/#231)、#226(等 #206)、**#29 切片 2(无阻塞、验收第 2 条直连)**、
  #30 会话鉴权(可做但面窄)。选 #29——合规内核的收口切片,且 docs/audit.md
  已预留形态(「软删基础设施随第一个有真实删除的业务域落地」)。
- **claim**:`claim_issue.py claim --issue 29` 成功(refs/heads/claims/issue-29)。
- **数据库**:本地 postgres 可用,verify 全程带 DATABASE_URL(1042 测试零 skip)。

### 本切片改动的文件

- `packages/db/src/schema.ts`:`tasks.deleted_at/deleted_by`(expand-only)+
  新表 `deleted_records`(subject 多态身份、title、snapshot jsonb、deleted_*/
  restored_* 六列;(subject_type, subject_id) WHERE restored_at IS NULL 的唯一
  部分索引 = 「一行记录至多一条在飞删除」的结构不变式)。migration 0030 生成
  并提交。
- `apps/api/src/records/deleted-records.ts`(新):`recordDeletion()`(与
  recordAudit 同纪律的事务内写入口)+ 恢复器注册表(register/restorerFor 接缝)。
- `apps/api/src/records/task-restorer.ts`(新):task 恢复器,原子
  `UPDATE … WHERE deleted_at IS NOT NULL` 收口并发;app.ts side-effect import
  装载(approval/billing registry 同形态)。
- `apps/api/src/routes/deleted-records.ts`(新):GET 列表(人名 alias join +
  offset 分页 + 精确 total)+ POST restore(台账行 FOR UPDATE 锁内裁决:
  404/409 restored_already/409 restore_unsupported/409 subject_missing,成功落
  属主域词表审计 + reason/ledgerId 进 detail)。
- `apps/api/src/routes/tasks.ts`:DELETE 动词(行锁复查 + 快照 + recordDeletion +
  task.deleted 审计);列表与 taskVisibleTo 加 `isNull(deletedAt)`。
- `apps/api/src/subjects/registry.ts`:task 加载器对软删行返回 null——评论/
  活动流/关注/自定义字段的时间线随删除一起对行属关闭。
- worker 三处软删过滤:`automations/due-registry.ts`(到期扫描)、
  `automations/field-registry.ts`(update_field 行锁读按不存在处理)、
  `rules/reminder.ts`(对账两查询;删掉的提醒下轮重建,与提前 done 同纪律)。
- `apps/api/src/routes/registry.ts`:3 条新路由声明(DELETE task = session;
  deleted-records 两端点 = audit.read)。
- web:`shared/lib/deleted-records-client.ts`(新,page/restore 适配器,409 带
  服务端冲突词)、`shared/pages/DeletedRecords.tsx`(新,/system/deleted-records,
  快照可展开、恢复冲突逐词翻译)、rail-groups System 区一行 + RailIcon 新
  glyph `restore`(no-two-rows-share-a-glyph 裁决不允许复用 ledger)、App.tsx
  路由;tasks-client 补 `remove()`;Tasks.tsx 删除按钮(仅 created scope)+
  #129 undo-window 第一次接上业务面(行先出全部缓存列表,窗口到期才发 DELETE,
  撤销 = refetch)。
- 测试:API `routes/tasks.test.ts` +3 例(创建人删除面/动词权限/subject 门同关)、
  `routes/deleted-records.test.ts` 新 4 例(验收端到端/恢复往返/fail closed
  三态/两圈历史);worker +3 例(due 不追删行/update_field 对删行 fail loud/
  提醒重建);web +13 例(client 5、页面源码 6、tasks-page 删除撤销 4 中含既有
  断言扩展)。
- `docs/audit.md`:新「删除记录」专节(表格 + 三条裁决)+ 词表两动作 +
  剩余清单该条划掉并留接入指引。

## 判断层(本次的关键判断与踩的坑)

1. **「软删除 + 快照」两件事都做,不是二选一。**老-老系统是触发器抄行(硬删 +
   快照),老系统 FEAT-527 是纯软删(明确不做恢复)。issue 要点原文「统一改为
   软删除 + 快照」读作合取:软删行保住 referential integrity(评论/字段值原地
   不动,恢复即整体回来),快照保住「删的时候长什么样」的事实(列表显示不回表
   join,未来某域转硬删时快照仍在)。台账恢复不覆写(restored_* 原地补)——
   删除史是记录史的一部分,与审计「发生过的事不改写」同源。
2. **恢复的门是 audit.read,不是行属。**行属(创建人)误删后的即时面是撤销窗
   (10 秒内免费),事后面是恢复台;「把全公司可见性已关闭的行重新打开」是合规
   面动词,与审计日志同一批读者。不随首个消费域给普通用户开 Trash 入口——
   那是有真实需求时属主域自己的面。
3. **删除不投递通知是裁决不是省略。**投递纪律是「链接不指向看不到的行」
   (#110 状态投递同裁),而删除把可见性门整个关上——任何收件人点开都是 404。
   给收件人一条点不开的通知比不通知更糟。即时误删面(undo window)+ 事后面
   (恢复台)已覆盖;测试钉住「零投递」。
4. **删除动词属创建人,经办人只有取消。**经办人是受托执行(PATCH 可改内容/
   状态),行属处置(改派/删除)归创建人——与 assignee_creator_only 同一家族。
   签名锁复用 PATCH 的 isSubjectSigned 门(删除是最彻底的改)。
5. **worker 三处读面一起收口,不然软删是假的。**只改 API 读面的话:due 自动化
   会追着已删任务跑(「到期未办即升级」规则 firing on 幽灵行)、update_field
   会改已删行、提醒对账会把删掉的提醒当成在飞的。三处都按「不存在」处理:
   due 跳过、update_field fail loud(run 失败告警)、提醒可重建。各自有集成
   测试,不是注释级的「应该不会」。
6. **坑:no-two-rows-share-a-glyph 是被测试钉住的裁决。**给 /system/deleted-records
   顺手复用 ledger 字形,automations.test.ts 与 rail-groups.test.ts 双双红
   (「no two rows share a glyph: expected 8 to be 9」)。照 RailIcon 头注释的
   「set grows with the rail」补了 restore 字形(回旋箭头,24 grid 手绘同
   stroke spec)。教训:rail 图标是身份不是装饰,新行 = 新 glyph。
7. **坑:并发删除的收口写在行锁里,不靠 API 预检。**两个并发 DELETE 都能通过
   可见性预检(都读到未删行);收口 = 事务内 SELECT … FOR UPDATE 再复查
   deleted_at(READ COMMITTED 下锁等待后重读到最新已提交版本)+ 台账唯一部分
   索引兜底。测试「已删再删 404 + 台账仍一行」钉住。
8. **坑(继承前人):集成测试的 authzStore 别传 stub。**首版 deleted-records
   套件给 authzStore 传了恒空 stub,owner 的 audit.read 永远加载不到,四例全
   403。audit-events.test.ts 的先例是 `createAuthzStore(db)`——权限点门要测,
   authz 就得是真的。另:nudge 断言要清零再断(创建即指派的 task.assigned
   催信号会混进删除用例),通知行断言用「事件类型停在创建时」而不是「空表」。
9. **undo window 的接法:remove 乐观、restore 用 refetch、commit 才发请求。**
   #129 的 undo-window 机制一直在等第一个业务删除面。接法:remove 把行从
   **全部** tasks 缓存键里滤掉(assignee-options 键靠形状检查跳过),undo 不
   回插行而是 invalidate(服务器从未见过删除,refetch 就是完整的恢复),commit
   在窗口关闭(或卸载)时才 DELETE——撤销窗口期服务器零写入,误删真的免费。

## 验收对照(#29 本切片范围)

- [x] 「已删除的记录可以查看」——台账列表(删除时刻/类型/标题/删除人)+
      快照展开原样,audit.read 门后
- [x] 「(已删除的记录可以)恢复」——POST restore 端到端:任务回到一切读面
      (详情/列表/subject 门/评论),台账原地补 restored_*,审计 task.restored
      带 reason;恢复冲突逐词说话(已恢复/不支持/行已不在)
- [x] 删除操作走软删除 + 快照(issue 迁移要点)——首个消费域 task;worker
      读面(due/提醒/update_field)一并收口并有测试
- [ ] 业务域接线(线索状态变更 detail from/to)→ #227,保持 open
- [ ] 状态变更日志投影 → 随 CRM 域评估
- [ ] Part 11 监管表逐表触发器兜底评估 → #203/#204 进场时

测试:`DATABASE_URL=… corepack pnpm verify` 全绿 113 文件 / 1042 测试(+27,
零 skip);本地 postgres 真库集成。docs/audit.md「删除记录」专节;session log
`ops/session-logs/2026-10-07-feat-29-deleted-records.md`。
