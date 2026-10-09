---
session_id: hand-written-28-error-admin-page
branch: feat/28-error-admin-page
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

# Session log — feat/28-error-admin-page — 2026-10-09

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#28(错误追踪 Sentinel,phase-1,模块 #185)——续做
  切片 2 **管理页 web 面**:`/system/error-events` 消费 #323 已并的读面
  (GET /api/error-events + /summary),闭合验收第 1 条「前端和后端错误都能
  在同一个地方查看」的查看面。剩余(Slack 演练、breadcrumbs)仍压在部署
  与真实交互面上,见 PR 剩余项。
- **前置收尾(第 0 步)**:一个 open PR #324(#31 storage kernel,另一会话
  活跃中)——CI 红(Lint·Typecheck·Test 挂,#325 并入 main 带来的
  rate-limit-denials.test.ts 新 fake 缺 `head`),但该会话**正活着修**:
  我观察到磁盘改动在我首次 `git status`(干净)之后 2 分钟内出现、随后它把
  origin/main 合进分支并提交了 merge(a0552b8,head() stub for the new fake)。
  按「不碰别人现场」跳过,不与属主会话抢同一个 worktree。
- **选题**:① 未完成切片优先——#28 评论明列剩余三片,其中管理页自身可独立
  验收且无外部门(读面切片 1 已落,issue 文字已点名「同 #27 拦截可见面的
  裁法」);#27 剩余两片仍压在真实滥用/首个表单域上。`claim --issue 28`
  成功(接管上一会话已 release 的租约)。
- **参考**:#232「系统结构」平台服务;issue 正文老系统 `/admin/error-logs`
  (老仓库迁移 HEAD 上无实体);活先例 = #325 RateLimits 页(汇总条 + 台账
  + 诚实状态机 + 无动词)与它的 rate-limit-client(失败模式照报)。

### 本切片改动的文件

- `apps/web/src/shared/lib/error-events-client.ts`(新):双读适配器
  (summary + list),zod 解析,forbidden/unavailable 失败模式照报;
  行 schema 的 source 读作 string(表列是开集),过滤参数才收窄 web/api。
- `apps/web/src/shared/pages/ErrorEvents.tsx`(新):指纹汇总条(窗口 7 天,
  次数降序,样本 message;点指纹 = 台账过滤,再点解除)+ source ghost tab
  + 过滤 chip + 台账表(Time/Source/Message/URL/Request ID/Stack 折叠)+
  offset 分页;诚实状态机,汇总单独失败只降级汇总位。
- `apps/web/src/App.tsx`:`/system/error-events` 路由 + 注释(遥测非工作
  队列、无处置动词)。
- `apps/web/src/shared/shell/rail-groups.ts`:System 组 +1 行(rate-limits
  之后,安全/健康遥测相邻)。
- `apps/web/src/shared/shell/RailIcon.tsx`:+`pulse` 字形(心电脉冲,按
  stroke spec 手绘;glyph 独占)。
- `docs/error-tracking.md`:切片地图管理页标 ✅,新增「管理页」一节;切片 1
  状态改为「✅ #323」消除「本切片」歧义。
- 测试:`apps/web/src/error-events-page.test.ts`(13:双端点与 zod、失败
  模式、开集显示/闭集过滤、状态机全格、汇总单独降级、无动词负断言、
  分诊钻取、行字段、过滤塌加载行守卫、过滤归零分页、分页界、路由/rail
  接线、pulse 字形在册)。

**验证**:`DATABASE_URL=… corepack pnpm verify` 全绿 142 文件 / 1481 测试
(+1 文件 +13,零 skip;本地 PG 真库)。零 API 改动、零 schema 改动——本切片
纯 web 面,无 migration,无 registry 变更。

## 判断层(手写)

1. **第 0 步遇到「CI 红但属主活着」的 PR,不接手**:流程写「CI 红→开
   worktree 修」,但 #324 的 worktree 里另一个会话正在干活——磁盘改动出现在
   我两次观察之间(首次 status 干净、2 分钟后多了未提交修复),随后它自己
   merge main 修好了。两个会话抢同一个 worktree 是最坏的并发形态(index 锁、
   push 互踩);判据是**文件 mtime 与 git 状态的观测差**,不是租约(租约已
   过期但人还活着)。让属主按自己的流程走完,我的第 0 步结论记「不碰」。
2. **切片 2 的验收语义**:验收第 1 条「同一个地方查看」在切片 1 只成立了
   数据/接口面,页面才是「查看」的本体;本切片并进去,第 1 条才真正闭合。
   第 2 条(Slack 演练)压在部署+SLACK_WEBHOOK_URL 上,不硬凑——PR 写
   Part of #28 列剩余项,issue 保持 open。多验收条 issue 的切片推进,
   「Closes」要对着验收条而不是对着切片号。
3. **显示开集、查询闭集**:error_events.source 是刻意开集(worker/portal
   进场不动数据库),web 侧行 schema 若照抄 API 查询校验的 z.enum,未来
   第一个新来源的行会把整页打成 unavailable——显示读 string,过滤参数才
   收窄到当前端点接受的并集。两端契约不对齐的地方,松的那端给显示,
   紧的那端给意图。
4. **过滤变化时翻页保留是撒谎**:RateLimits 的 placeholderData=(previous
   时分页平滑是安全的(只有 offset 变,问题没换)。本页有过滤器,react-query
   的 previous 跨 queryKey 传递——换过滤后先显示旧行再跳新行,是「用旧答案
   冒充新答案」。守卫改成比较 previous key 的过滤槽位:同过滤(翻页)保留,
   异过滤塌回加载行。多一个状态维度,占位数据的语义就要跟着按维度裁。
5. **指纹显示用行把手不是缩略位图**:64 hex 在表格里是噪音,前 12 位 +
   title 全值 + 过滤态全值,是「可读把手、无损过滤」的最小裁法。没有做
   指纹→别名的命名(那是「错误分诊工作台」的需求,现在做是镀金——汇总条
   的样本 message 已经自描述了)。
6. **stack 默认折叠**:分诊第一眼要 message、url、requestId;8KB 栈文本
   进表格既毁行高也拖慢扫描。details 折叠是零状态方案,测试断言
   data-testid 钉住「栈在但收着」。
7. **无动词裁决沿用并加负断言**:错误台账比限流台账更容易被加「标记已修/
   忽略」类动词(工作队列直觉),但处置语义(谁标记、标记后聚合怎么算、
   与 error_spikes 的关系)没裁过——页面先按纯遥测落,not.toContain
   ("Resolve"/"Dismiss"/"Delete") 钉住,未来加处置动词得先裁语义再来改测试。
8. **pulse 字形按 stroke spec 手绘**:rail 图标独占(两处既有测试强制),
   新行必须新字形;路径在 24 网格上留 3.5 边距、心电脉冲语义与「错误激增」
   对得上。类型联合、GLYPHS 表、rail 行三处同步——本切片的接线测试断言
   `nav: "error-events", icon: "pulse"` 在 rail 源里,漏一处即红。
9. **坑:gh issue list 有默认截断**:低编号 open issue(#28)不在
   `--limit 100` 的列表输出里(按创建时间倒序被截掉),按编号海选会漏掉
   优先级①的候选——选题时对记忆/评论里点名的 issue 直接 `gh issue view`
   逐个核对状态,不信列表的完整性。
