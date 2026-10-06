---
session_id: hand-written-221-approval-todo
branch: feat/221-approval-todo
date: 2026-10-07
reason: issue-221
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/221-approval-todo — 2026-10-07

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#221——**切片 3:审批待办页 + #219 签名对话框首消费**,
  PR 正文写 Part of #221(决策表/pg-boss 催办/会签票签/配置 UI 未完,严禁
  Closes 关键字);#219 的前端半边随本切片落地,PR 与 issue 双向注明。
- **前置收尾(第 0 步)**:接手时唯一 open PR #278(#233 切片 2)CI 四项全绿
  → squash 合并(gh pr merge 撞上 worktree 占用本地分支的预期报错,远端分支
  经 gh api 补删,ls-remote 复核)+ issue #233 成果评论;三个已合并 PR 的
  worktree 残留目录(226/233×2)git 元数据已注销、目录干净,rm -rf 清掉
  (cmd rmdir 在 Git Bash 里被 MSYS 路径改写坑掉,绝对路径也报找不到文件)。
- **数据库**:本地 postgres 可用,全部测试带 DATABASE_URL 跑(无 skip)。

### 本切片改动的文件

- `apps/api/src/approval/service.ts`:`ApprovalTodoRow` 扩充裁决语境四字段
  (submittedBy/payload/requireSignature/signatureMeaning)——查询加 submitter
  join 与 payload 列,flatMap 从当前级 enrich;响应形状 additive,无新路由
- `apps/api/src/routes/approvals.test.ts`:+1 例(裁决语境矩阵:签名行带
  submittedBy/payload/requireSignature/meaning,纯记录行 payload null + 无签名)
- `apps/web/src/shared/lib/approvals-client.ts`(新):todo/get/act 三读写,
  zod 收口,失败模式不摊平(401/403 按 body.error 劈成 invalid_credentials vs
  two_factor_required vs not_approver,404=notfound,409=conflict,422 按
  signature_required 劈分)
- `apps/web/src/shared/lib/payload-rows.ts`(新):payload → 标签/值行的纯函数
  (snake_case 读成词、identifier 形字符串才 humanize、对象逐键、其余兜底行)
- `apps/web/src/shared/components/SignatureDialog.tsx`(新):#219 前端半边——
  会话外重输密码、含义展示(Part 11.50)、每次尝试 crypto.randomUUID() 铸
  clientToken;presentational + 本地密码态,裁决调用与错误归消费页
- `apps/web/src/shared/pages/Approvals.tsx`(新):`/approvals` 待办页——列表
  逐行展开(payload 行渲染 + 详情拉取两扇门 + 备注 + 批准/驳回),陈旧收件箱
  (gone/conflict/not_approver)收起并说实话,签名级批准必经对话框
- `apps/web/src/shared/shell/RailIcon.tsx`:"approvals" 字形(橡皮图章:柄、
  座、印痕,24 网格手绘同笔画规格);`rail-groups.ts` Home 区加
  Approvals 行;`App.tsx` 加路由
- 测试:`apps/web/src/approvals-page.test.ts`(13 例源文本)、
  `apps/web/src/payload-rows.test.ts`(5 例真单测)
- 文档:`docs/approval.md` 切片 3 表格 + 剩余项拆分(待办页已落地,配置 UI
  仍随配置工作室)

## 判断层(手写)

### 关键判断

1. **切片边界:只做待办页,不做审批配置 UI。** 剩余项原文是「审批配置 UI 与
   待办页(数据面已就绪)」捆在一起,但两者不是一回事:待办页是**个人工作台
   面**(Home 区,与 Tasks 同列——#232 §11 我的工作台),配置 UI 是**配置工作
   室面**(owner/admin 的治理界面,整个工作室前端还没开工)。且 R-16-6 的
   角色变更请求此刻就在在飞位上、只能靠裸 API 裁决——待办页是当下有真实
   消费者的半边。docs/approval.md 的剩余项相应拆成两条。
2. **待办行必须自带裁决语境(本切片的核心服务端判断)。** 现状有个结构性
   张力:详情 GET 过单据可见性门,而配置点名的裁决人**不要求**恰好是单据
   可见者(approvals.ts 切片 1 注释原话)——裁决人很可能点开详情只得 404,
   却被期待裁决。解法不是放宽详情门(动安全姿态),而是让待办行自带四件
   语境:谁提交的、payload(「批的到底是什么」,#270 切片 2 的立意)、当前级
   要不要签名、什么含义。两扇门在页面里各自说话:看得到 → 完整历史;看不到
   → 明说「按上方摘要裁决」。404 在这里是**有意义的回答**,不是错误。
3. **422 不是 UI 的发现路径。** requireSignature/signatureMeaning 随待办行
   下发,UI 提前知道要不要弹签名框;服务端 422 signature_required 保持为
   底线(backstop),而不是靠「先裸批一次吃 422 再补签名」驱动交互——那是
   把 fail-closed 当轮询用。
4. **SignatureDialog 是仪式不是动词。** 组件只管:重输密码、展示含义、每次
   尝试铸新 clientToken;act 调用、错误路由、刷新全归消费页。含义**展示**
   而非选择:审批语境含义由级别配置定(#269 的裁决),#219 正文写的「含义
   选择」留给未来真正让签署人挑含义的消费域去扩展这个组件,不为它预建
   分支。clientToken 每次尝试一枚:重放幂等靠它兜「响应丢了」;被拒(密码
   错)后的重试是真新事件,新 token 名正言顺。
5. **陈旧收件箱必须说实话。** 面板打开期间请求被别人裁掉/关掉(gone/
   conflict/not_approver):收起面板、刷新列表、flash 说实际发生了什么——
   绝不 flash「Decision recorded」(这条裁决没落就是没落)。服务端这些
   409/403 语义在 adapter 层不摊平成 unavailable,就是为了让页面能这样分话。
6. **服务端只动响应形状,不开新路由。** todo GET 本就 session 门 + 配置点名
   即授权,扩字段不加面;routes/registry.ts 声明表零改动(route-auth registry
   测试照旧绿)。payload 进待办行不是权限扩张:配置点名本就是裁决授权,
   payload 正是给裁决人看的(#270 立意),可见性门的职责在详情侧不变。

### 踩的坑

- `exactOptionalPropertyTypes` 下 zod `.optional()` 的 parse 产物是
  `error?: string | undefined`,手写注解 `{error?: string}` 接不住——返回类型
  要带上 `| undefined`(gotcha 71 的近亲:这回不在 schema 在函数签名)。
- `JSON.stringify` 按 TS 类型永远返回 `string`(运行时对 undefined/Symbol 才
  返 undefined),`?? String(value)` 被 eslint no-unnecessary-condition 打回
  ——jsonb 来的 payload 不可能是那两类,直接删。
- Git Bash 里 `cmd //c "rmdir /s /q 相对路径"` 被_MSYS 路径改写_吞掉(报
  「系统找不到指定的文件」,绝对路径同样中招)——清残留目录用 `rm -rf` 才对。
- web 测试引用新文件先落对相对路径(payload-rows.test.ts 第一版把
  `shared/lib/` 前缀丢了,vitest 直接 Cannot find module——测试先行先红在
  错误的地方也是白红)。

### 验收对照(#221 范围内本切片条目)

- [x] 待办页:待我审批(点名/角色命中)逐行可见,语境够裁(submittedBy/
      payload/签名要求;集成测试 + 源文本测试双断言)
- [x] 签名级批准走签名仪式(重输密码 + clientToken;含义展示);驳回不签
- [x] 裁决错误逐因可读(密码错/需 2FA/已被裁决/并发冲突/需签名)
- [ ] 「满足条件的单据自动进入审批」→ #233 决策表(保持 open)
- [ ] pg-boss 催办、多级通知扇出 → #116 渠道层(保持 open)
- [ ] 会签/票签、审批配置 UI(保持 open)
