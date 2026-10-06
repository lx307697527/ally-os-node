---
session_id: hand-written-221-approval
branch: feat/221-approval
date: 2026-10-06
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

# Session log — feat/221-approval — 2026-10-06

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#221(配置工作室:审批;#232 §4.9 v2.2「审批流转自建,
  由 pg-boss 执行;审批路线用 GoRules 决策表存进规则注册表 #233」)——
  **切片 1:审批内核(服务端 API)**,PR 正文写 Part of #221(触发条件/#233
  决策表、R-16-6 第一消费方、pg-boss 执行、多人审批方式、配置停用/#226、UI
  未完,严禁 Closes 关键字)
- **前置收尾(第 0 步)**:接住上个会话的 open PR #268(#220 流程内核)——
  CI 全绿后 squash 合并;worktree 清理碰上「Filename too long」(gotcha 47:
  git worktree prune + cmd rd /s /q),远端分支删除用 ls-remote 复核(gotcha
  32/50);issue 成果评论与租约释放已由原会话完成(收尾四项逐项核对,gotcha
  53)。选题:#220 剩余项全部阻塞在 phase-2 域(#227/#231/#243/#226/#116);
  #219 剩 SignatureDialog 需第一消费方;#221 是配置工作室集群零评论绿地的
  下一张,且是 #219/#220 两个注册表文档里点名的「第一个消费域」。
- **老系统参考(只读)**:最接近的实现是 `security` 域的报价金额审批 RPC
  (feat349 approval_notifications:超 `quote_approval_threshold()` 的报价停在
  pending_approval,outbox 白名单通知 domain_owners)——规则写死在 SQL、按域
  各建一套;SFP 审批只在前端判断(#221 正文原话)。新系统收敛为统一内核,
  触发条件让给 #233 决策表。

### 本切片改动的文件

- `packages/db/src/schema.ts`:`approval_configs`(subject 开集 text +
  (subject_type, config_key) 唯一 + levels jsonb + version 恒 1 预埋 #226)、
  `approval_requests`((subject_type, subject_id, config_key) WHERE pending
  部分唯一索引 = 同单同线至多一个在飞、levels 提交时刻快照、current_step/
  status/completed_at)、`approval_actions`(裁决流水;actor_id 不带 CASCADE,
  与 esign 签名人/workflow_transitions 同裁)
- `packages/db/migrations/0014_light_leo.sql`(新,expand-only):drizzle 生成
  + 手写 append-only 触发器(`approval_actions_is_immutable` + BEFORE
  UPDATE/DELETE,0007/0012/0013 同款裁决)
- `apps/api/src/approval/service.ts`(新):`parseApprovalLevels`(zod:1–10 级、
  users ≤20 / roles ≤14、每级 users∪roles 非空、customer 拒收)、
  `submitApprovalRequest`(配置快照 → 部分唯一索引幂等)、`actOnApproval`
  (审批人匹配 → 2FA 门 → 事务内 action 行 + esign 签名仪式 + CAS 推进 +
  审计 + 终态通知发起人;哨兵类 CeremonyRejected/ConcurrentConflict 把事务内
  失败转成语义化拒绝)、`approvalRequestView`(裁决行 left join 签名墙)、
  `approvalTodo`(待我审批)、`loadApprovalActionRecord`(签名绑定的 load)
- `apps/api/src/approval/registry.ts`(新):模块装载时接线三个消费方向——
  工作流门槛积木 **approval.passed**(blocks 注册表第一个成员)、esign 可签名
  subject **approval_action**(签名注册表第一个生产成员)、approval_action
  可见性门(发起人 + 点名人 + 已裁决人 + 配置角色现任持有者)
- `apps/api/src/routes/approvals.ts`(新):配置两端点(approval.configure
  权限点;levels 422 detail 用 issues path+message)、请求四端点(提交/详情
  过单据可见性门,待办/裁决由配置点名授权;拒绝语义 → 401/403/404/409/422)
- `apps/api/src/esign/service.ts`:`signSubject` 参数改泛型 `<TDb extends
  Pick<Db, "select"|"insert"|"transaction">>`——审批内核在自己的推进事务里传
  PgTransaction 与同一份 load(loadRecord 拿到的 db 与调用方传入同型);行为
  不变,路由侧调用不受影响
- `apps/api/src/authz/permissions.ts`:新权限点 `approval.configure`(owner/
  admin 默认);顺手把过时的「#23 切片内的两个权限点」注释改准
- `apps/api/src/routes/registry.ts`:六条新路由授权声明
- `apps/api/src/app.ts`:挂 approvalsRoutes + import approval/registry.ts(门槛
  积木与可签名注册的副作用)
- 测试:`routes/approvals.test.ts`(13,临时库:配置校验/权限 403/可见性门/
  双提交 409/驳回重提/两级按序+越级 403/todo 点名与角色/签名仪式(缺输入 422/
  无 2FA 403/密码错 401 **整包回滚**/签名落墙)/半套仪式输入 400/门槛积木
  fail closed → 批准放行/并发单赢家/审计验收)、`packages/db/src/approval-
  immutable.test.ts`(2,共享库:触发器拒 UPDATE/DELETE)
- 测试钉子随新权限点更新:`authz.test.ts`、`app.test.ts` 的权限集精确断言
- 文档:`docs/approval.md`(新)、`docs/audit.md` 词表五动作、
  `docs/permissions.md` 权限点现状段、`docs/workflow.md` 积木注册表行
- 验证:`DATABASE_URL=… corepack pnpm verify` 全绿(**74 文件 / 547 测试**,含
  DB 集成;lint/typecheck/test 三段全过)

## 判断层(本次会话手写)

### 关键判断

1. **切片边界 = 填坑,不是再挖坑**。#267(esign)与 #268(workflow)的注册表
   文档都点名「第一个消费域 = #221 审批」——本切片把三条刻意为空的接缝接上
   两半:esign 可签名 subject 的第一个生产成员(approval_action)、workflow
   条件积木的第一个成员(approval.passed);第三条(R-16-6 角色授予走审批)是
   行为变更、需要通知与 UI 配合,留切片 2,user-roles 路由的 fail-closed 等
   价物保持不动。这样 #221 落地即让 #219/#220 从「机制先行」变成「有产线」。
2. **授权双门制:配置点名 vs 单据可见性,各裁各的**。配置管理走
   approval.configure(owner/admin,改审批线 = 改「谁有权裁决什么」);裁决权
   由配置点名(users ∪ roles)裁决——角色审批人**不要求**恰好是单据可见者
   (配置点名即授权);提交与详情读过单据可见性门(subjects/registry,看得到
   单据才看得到它的审批)。把两扇门捏成一门(比如裁决也要求可见性)会让角色
   制审批线对不可见单据死锁;拆开则每扇门语义单一。
3. **自批合法(R-16-5),内核不做职责分离**。#232 §12 原文「业务审批可以自批;
   只有质量放行必须由检测人以外的另一名 QA」——职责分离是质量放行域(R-15-4,
   phase-3/4)的业务规则,不是审批内核的默认。内核只挡 customer 角色(审批是
   员工动作,与流程内核的员工地板同裁)。
4. **签名仪式在推进事务内,哨兵转拒绝**。要求签名的级别:action 行 + esign
   签名 + CAS 推进 + 审计 + 通知同事务,要么全成要么全不算——Part 11 的联结
   签名不能落在被回滚的裁决上,裁决行也不能离开被拒的签名独活。事务内失败用
   哨兵类(CeremonyRejected/ConcurrentConflict)抛出、事务外转语义化拒绝
   (401/409),路由不知道 savepoint 的存在。为此 signSubject 参数改泛型
   (行为不变):泛型让 loadRecord 拿到的 db 与调用方传入同型,绑定语义不会
   长出第二种。
5. **驳回是终态,重提是新请求**。NocoBase 的「驳回回到发起人」落成:请求
   status=rejected + 终态通知发起人(#110 通知内核,「回到」是真的递到手上),
   修改后重新提交 = 新请求行——历史逐请求可溯,action 行 append-only(0014
   触发器),不存在任何改写路径。不在旧请求上「重置回第一级」:那需要 UPDATE
   请求行,与「裁决流水不可改写」的底线打架。
6. **并发双保险:唯一约束串行化 + CAS 守迁移**。action 行的
   (request_id, step_index) 唯一约束把同级两个审批人串行化(输家撞 23505 →
   409),UPDATE 带 current_step/status 条件守住状态迁移。不变式是「只有一个
   赢家」;输家的拒绝理由有两种合法形态(真撞车 concurrent_conflict / 晚到
   读到终态 request_closed),测试断言 409 + 单行裁决,不钉理由。
7. **levels 快照进请求,配置行一经创建不改**。与流程实例的 definition 快照
   同一裁法:配置改版/停用不改写在飞请求的审批路线。版本化(#226)进场前
   连「停用」端点都不开(workflow-templates 同裁:POST + GET),先立「配置
   不可变」的纪律;version 列预埋恒 1。
8. **触发条件整体让给 #233,内核只提供进程内入口**。「满足条件的单据自动进入
   审批」的路线(金额区间 → 谁批)是 GoRules 决策表(#232 §4.9),决策表存
   规则注册表(#233)。本切片的 submitApprovalRequest 是属主域的进程内调用
   (与 startWorkflow 同形态),提交面开 HTTP 只为配置工作室测试与未来非自动
   场景(人工发起的审批)。
9. **签名含义限 reviewed|approved**。#232 §4.4「签名含义(执行/复核/批准)」
   三值里,审批语境没有 performed(执行是操作者对自己做的事实)——级别配置
   的 signatureMeaning 收成两值,默认 approved;requireSignature 只约束同意
   (驳回回到发起人是内部协作,不是监管事实,不签)。

### 踩的坑

1. **erasableSyntaxOnly 连构造器参数属性也禁**(TS1294)——`constructor(public
   reason: ...)` 这种参数属性写法在 Node 原生跑 .ts 的仓库里不合法,哨兵类
   要显式声明字段再赋值。enum/namespace 的坑广为人知,参数属性是第一次撞上。
2. **把 signSubject 的 db 参数放宽成 Pick<Db,...> 反而弄坏路由调用**——
   逆变:esigntures 路由传的 spec.load 是 (db: Db) => ...,宽参数的函数位
   不能喂给窄参数的形参。正解是泛型 `<TDb extends Pick<...>>`,loadRecord 的
   db 类型跟随调用方传入的实参类型,两侧调用点都不用改。
3. **inArray 进 pgEnum 列不能 as never 糊弄**——levels 快照里的角色名是
   string,先 roleSchema.safeParse 收窄再 inArray,非法名(库被外力改歪)静默
   剔除,既过类型又 fail closed。
4. **并发测试别钉拒绝理由**(见判断 6)——首轮断言 concurrent_conflict,单级
   配置下赢家事务太快,输家的初始读经常落在提交之后,拿到的是 request_closed。
   409 状态 + 单行裁决才是要保护的不变式。
5. **「未注册 subject 类型」的断言不能用 helper**——测试的 submit() helper
   写死了已注册的 subjectType,第一个断言(期望 400)拿到 201;未注册类型要
   裸发请求。
6. **权限集的精确断言是钉子**——authz.test.ts / app.test.ts 用 Set/数组全等
   断言 admin 的默认权限,新权限点一加就红。这是预期行为(矩阵缺省为空的
   一部分),更新钉子属于切片内工作,不算破坏测试。
7. **lint 的 require-await 对夹具 loader 很挑剔**——`async (_db, id) => ...`
   里没有 await 就报错;照 esignatures.test.ts 的夹具写法改 `() =>
   Promise.resolve(...)`。SUBJECT_LOADERS["approval_action"] 还要过 dot-notation
   规则(`.approval_action`)。
8. **TRUNCATE 带外键的表族要一条语句**——approval_actions → requests →
   configs 三张表 + esign/audit/notifications/workflow 族,单语句 cascade 清;
   userRole 刻意不清(beforeAll 授的角色是夹具的一部分,清了每条测试都得重授)。
