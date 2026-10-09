---
session_id: hand-written-27-denials-visibility
branch: feat/27-denials-visibility
date: 2026-10-09
reason: issue-27
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/27-denials-visibility — 2026-10-09

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#27(反滥用:验证码、reCAPTCHA、机器人闸门与限流,
  phase-1)——续做切片 2 **拦截可见面**:拒绝台账的 API 读面 + System 区
  管理页,闭合验收第 3 条「管理页面能查看被拦截的请求」。
- **前置收尾(第 0 步)**:无 open PR;发现 `.claude/worktrees/31-storage-files-kernel`
  有**活跃中的另一个会话**(租约持至 04:34Z、WIP 文件 1 分钟前刚改过)——
  「分支已合并」只覆盖已提交部分,worktree 里还有未提交的 #31 WIP,按清理
  规则的精神(只清真正死掉的残留)跳过不动;主检出干净。
- **选题**:① 未完成切片优先——#28(#323 今日已并,剩 admin 页面/Slack 演练/
  breadcrumbs)与 #27(剩可见面/IP 黑名单/honeypot)都在册;按编号取 #27。
  剩余三片里 honeypot 明确压在第一个公开表单域(#207/#227)、IP 黑名单压在
  真实滥用场景,只有**拦截可见面**自身可独立验收且无外部门——它的数据面
  (rate_limit_denials)切片 1 已落,缺的只是读路径。
- **claim**:`claim_issue.py claim --issue 27` 成功(接管已释放的旧租约)。
- **参考**:#232 §1.1「公开接口统一限流、honeypot、reCAPTCHA」;老系统
  /admin/rate-limits 页在老仓库当前树上找不到实体(仅 issue 文字与 FEAT-019
  规格在),形态按本仓库既有先例落:#28 刚并的 error-events 读面(列表+汇总
  双端点、audit.read 同门)与 #29 的 AuditLog 页(诚实状态机 + offset 分页)。

### 本切片改动的文件

- `apps/api/src/routes/rate-limit-denials.ts`(新):`GET /api/rate-limit-denials`
  (最新在前 + 精确 total,action/identifier 精确过滤,分页上限 200)+
  `GET /api/rate-limit-denials/summary`(默认 7 天按动作分组:次数、distinct
  来源数、最近拒绝;上限 30 天/100 组)。
- `apps/api/src/app.ts`:挂载在 errorEventsRoutes 之后(同属安全遥测读面簇)。
- `apps/api/src/routes/registry.ts`:+2 行,均 `audit.read` 权限点门。
- `apps/web/src/shared/lib/rate-limit-client.ts`(新):双读适配器,zod 解析,
  forbidden/unavailable 失败模式照报(audit-client 同形)。
- `apps/web/src/shared/pages/RateLimits.tsx`(新):汇总分诊条 + 台账表
  (Time/Source/Type/Action/Count/Limit/Request ID)+ offset 分页;状态机
  诚实——loading/forbidden/unavailable/empty 各有说辞,汇总挂了只降级汇总
  自己,台账照常渲染。
- `apps/web/src/App.tsx`:`/system/rate-limits` 路由 + 注释(遥测非闸门、
  页面无放行动词)。
- `apps/web/src/shared/shell/rail-groups.ts`:System 组 +1 行(复用 ledger 图标)。
- `docs/abuse-prevention.md`:切片地图切片 2 标 ✅,新增「拦截可见面」一节。
- 测试:`apps/api/src/routes/rate-limit-denials.test.ts`(7:401、403×2 端点、
  列表排序/精确 total/ISO 契约、双过滤、分页与上限 400、汇总分组与 7 天窗、
  读不写审计)、`apps/web/src/rate-limits-page.test.ts`(9:端点与 zod、失败
  模式、状态机、汇总单独降级、无动词断言、行字段、分页、路由/rail 接线)。

**验证**:`DATABASE_URL=… corepack pnpm verify` 全绿 141 文件 / 1468 测试
(+2 文件 +16,零 skip;本地 PG 真库)。零 schema 改动——切片 1 的 0040 已含
台账表与两个读法索引,本切片纯读,无 migration。

## 判断层(手写)

1. **「分支已合并」≠「worktree 可删」**:第 0 步清理时 #31 worktree 的分支
   tip 已在 origin/main 里,但工作区还有 52 个文件、202 行的未提交改动,且
   文件 mtime 在 1 分钟前、issue 租约还在手上——这是另一个会话的**活现场**,
   不是死残留。清理规则的字面(分支已合并)会误删别人的 WIP;按规则的精神
   (清真正死掉的)跳过,并把「活跃租约 + 新鲜 mtime」作为不可碰的证据链。
2. **切片选择的现实约束是「无外部门」**:#27 剩余三片里两片被刻意压着
   (honeypot 等表单域、IP 黑名单等真实滥用场景),可见面是唯一能独立验收
   的——它的上游(台账数据面)切片 1 已备好。给「等 X」切片排序时,X 的
   进场时点本身就是约束,不该硬撬。
3. **页面形态按本仓库先例,不照老系统**:老 /admin/rate-limits 页在老仓库
   树上找不到实体(可能没活到迁移 HEAD),凭 issue 文字复刻是猜;#28 今日
   刚并的 error-events(列表+汇总、audit.read 同门)与 #29 AuditLog(诚实
   状态机)是活的、被审过的先例,照它们的形状落,新面自动获得同构的可读性。
4. **汇总条是分诊刚需,不是镀金**:台账只有「一行一次拒绝」的事实,管理员
   打开页面第一个问题永远是「最近谁在撞」;distinct 来源数把「一个人手滑」
   和「一个网段在扫」分开。这与 error-events 的指纹汇总同构——安全遥测的
   「汇总先屏 + 明细可翻」两段式从此是本仓库的既定形状,#28 的 admin 页
   面可以直接继承。
5. **坑:生产写入方的 `now` 参数不落 deniedAt**。recordRateLimitDenial 收
   `now` 但插入时没用它(deniedAt 走列 defaultNow)——测试想倒填时间轴做
   汇总窗口断言,走生产方喂不进去。改直接插表播种,注释写明缘由:读面套件
   只管喂确定的事实,生产方的形状由切片 1 自己的套件证明。这也算给未来
   切片留的标记:若哪天 deniedAt 需要可倒填(导入历史拒绝记录),得先改
   写入方契约。
6. **页面刻意无动词**:解禁/拉黑的诱惑写在 IP 黑名单切片里等治理面定形;
   可见面如果顺手带一个「解除」按钮,就把「等真实滥用场景」的裁决架空了。
   测试里放了一条负断言(`not.toContain("Unblock")`)把这条钉住。
7. **双查询的失败面要逐个说**:汇总和台账各一个 useQuery,403 同门所以一起
   说;网络失败只可能是各自——页面把汇总失败降级为汇总位的一句话说辞,
   台账照常渲染。诚实状态机的成本从一的状态变成二,但每个格子都有说辞,
   不留「白屏但说不出为什么」的角落。
8. **rail 图标是独占资产,不是随便复用的装饰**:两处既有测试(rail-groups
   本表 + automations 页的接线测试)都强制「no two rows share a glyph」
   (2026-09-14 老系统裁决)。给新行挑图标先查全表占用,复用现成字形是最省事
   也必红的写法;RailIcon 的「set GROWS WITH THE RAIL」注释就是给这种情况
   预备的——按 stroke spec 画一个 shield,类型联合、表、行三处同步。
9. **源文本断言要过折叠再比散文**:web 测试是 jsdom-free 的源文本断言,JSX
   里一行散文被换行拆开,直接 toContain 单句必红;automations 测试的
   collapsedPage(先 `replace(/\s+/g, " ")` 再断言)是现成解法。data-testid
   与代码标识符不受影响,只有散文断言需要折叠。
