---
session_id: hand-written-113-task-kernel
branch: feat/113-task-kernel
date: 2026-10-06
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

# Session log — feat/113-task-kernel — 2026-10-06

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#113(后台任务管理;#232 M6「任务:一套任务系统,可挂在
  任何记录上」)——**切片 1:任务内核(建表 + CRUD + 分配 + 状态流转)**,
  PR 正文写 Part of #113(评论 / AI 拆分 / 分配邮件未做,严禁 Closes 关键字)
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净。
  选题:全部未完切片的 issue(#22/#23/#25/#29)剩余项都被 #227/#235 阻塞
  (与上一会话的结论一致);#110(评论/@/活动流)的评论要挂在业务对象上,
  新系统还没有业务表,现在做 = 无附着对象机制;#116 通知服务缺生产者;
  #122 仪表盘缺业务数据。#113 是 phase-1 里唯一有「独立可用附着物」的协作簇
  问题(老系统 standalone_tasks 本就独立存在),且是 #110 评论与 #116 通知的
  解锁点(任务分配 = 通知表第一个真实生产者)。
- **老系统参考**:d:\Code\ally-os 的 main 在 issue 撰写(2026-09-30)之后
  又演进了(AdminTasksPage/workspace_tasks/task_projects 在当前 main 已不可
  见;apps/allyos 前端按域重构,supabase/functions 顶层 61 个)——老代码按
  纪律只作参考不照搬,状态词表锚定仍存在的 `crm.tasks` CHECK
  (open|done|cancelled,`tasks_status_check`,apps/allyos TaskCard 的勾选式
  翻转)。

### 本切片改动的文件

- `packages/db/src/schema.ts`:`task_status` 枚举 + `tasks` 表(9 列 2 索引
  2 FK;assignee/creator 都 ON DELETE SET NULL——人删任务留)
- `packages/db/migrations/0008_old_old_lace.sql`(新,drizzle 生成,
  expand-only)
- `apps/api/src/audit/audit-log.ts`:`recordAudit` 参数从 `Db` 放宽为
  `Pick<Db, "insert">`——调用方在事务回调里写审计(#113 首个,PgTransaction
  满足同一条 insert 接口)
- `apps/api/src/routes/tasks.ts`(新):`GET/POST /api/tasks`、
  `GET /api/tasks/assignee-options`、`GET/PATCH /api/tasks/:id`;zod 收
  body/query;变更 + 审计 + 通知在同一事务;可分配面 = 至少一个非 customer
  角色;行属 = 创建人或经办人,无关人 404(不区分不存在与不属于,与通知
  端点的反探测裁定同型)
- `apps/api/src/routes/registry.ts`:5 条新路由声明(session 类)
- `apps/api/src/app.ts`:挂 tasksRoutes
- `apps/web`:`shared/lib/tasks-client.ts`(zod + ok/forbidden/conflict/
  unavailable 四态);`shared/pages/Tasks.tsx`(Home 区第二个页面:范围
  tab × 状态 chips、勾选式完成、内联创建表单、固定步长翻页、四态不撒谎);
  App.tsx 挂 `/tasks`;rail-groups home 组加 Tasks 行(note 同步改真话);
  RailIcon 加 `tasks` 字形(自绘,遵守 stroke spec)
- 测试:`apps/api/src/routes/tasks.test.ts`(11 条集成,独立临时库样板);
  `apps/web/src/shared/lib/tasks-client.test.ts`(5 条);`apps/web/src/
  tasks-page.test.ts`(源码断言 9 条)
- 文档:`docs/audit.md` 词表节补 task.* 动作与「from/to 第一个真实生产者」
- **无新依赖、无新 env**

### 验证

- `corepack pnpm verify` 全绿:**51 文件 / 387 测试**(含 DB 集成;本地
  postgres = docker ally-os-node-postgres-1,tests 对 04:24 与 04:36 两轮)
- 迁移与 schema 同步由 CI 的 db:generate 步骤复核;vite build 在 CI docker
  job 覆盖

## 判断层(手写)

### 本次的关键判断

1. **选题跳过 #110 按编号次序的默认**:phase-1 按编号下一张是 #110(评论/
   @提及/活动流),但它的评论要挂在「每个业务对象」上,而新系统一张业务表
   都没有——按 #29 切片 1 的同一裁决(「先建机制不留产线 = 生产死代码」),
   现在做必是空转。#113 相反:老系统 standalone_tasks 证明任务系统不依赖
   业务域独立可用,#232 §11 又明说「一套任务系统,可挂在任何记录上」——
   先落任务内核,#110 的评论组件才有第一个附着对象(任务详情页的评论),
   #116 的统一通知服务才有第一个生产者(task.assigned)。一个切片给两个
   阻塞中的 issue 解锁,是本次选题的核心理由。
2. **三套任务表的合并裁决(#113 迁移要点的要求)**:裁成一套。老系统
   tasks/task_projects(看板)、workspace_tasks(工作区)、crm_tasks(回拨)
   三套并存正是迁移要点点名要消除的;#232 §11 一句话定了方向。切片 1 的表
   只有独立任务需要的列;业务对象附着列(subject_type/subject_id,老
   crm.tasks 的多态形态)与 ops 的 T-编号/六态/模板列(#156)随各自切片
   expand-only 进场——列没有消费者就不预建,和 #29 拒绝预置 from/to 列是
   同一条纪律。
3. **授权:本人数据、登录即可,不新开权限点**:创建人/经办人可见可改,与
   通知/反馈(#129)同一先例。老系统「每个可分配成员一个标签页」的全局
   看板涉及「谁能看全团队任务」的真裁决,归 RBAC 模块切片(#23 后续)带
   权限点讨论,不在本切片顺手发明。
4. **可分配面 = 至少持有一个非 customer 角色**:零角色账号(如 #25 影子
   账号)和纯门户账号不可被派任务;assignee-options 端点就是这条裁决的
   读取面。客户角色表已在(#23 落了 15 角色枚举),裁决有附着物。
5. **分配通知现在就写,邮件不做**:notifications 表和铃铛已在(#129),
   task.assigned 是它的第一个真实生产者——写通知不是投机设计,是给 #116
   落第一个接线点;邮件渠道等统一通知服务(#116)带渠道偏好时一并做,
   不在任务路由里直连 mailer 绕过未来的渠道层。派给自己不发通知。
6. **审计与业务同一事务**:recordAudit 参数放宽为 Pick<Db,"insert"> 后,
   任务变更、审计、通知在 db.transaction 里原子落库——比 user-roles 的
   顺序写(先授后记)更贴 #29 的失败语义(审计写失败则业务失败)。
7. **PATCH 的 no-op 语义**:逐字段 diff,真变化才写审计才动 updatedAt;
   同值 PATCH 返回现状、零审计行。防止重复点击制造审计噪音。
8. **老系统演进的现实**:d:\Code\ally-os main 比 issue 撰写时又前进了不少
   (AdminTasksPage 已不可见,前端按域重构)。迁移依据始终是 issue + #232
   设计,老代码只取仍可验证的锚点(crm.tasks 的状态词表、多态附着形态);
   老系统里已消失的 UI 形态不逆向复原。

### 踩的坑

1. **recordAudit 的 Db 类型不收事务**:第一版把 tx 传进 recordAudit 直接
   类型红($client 缺失)。正解不是 as any 而是收窄参数面——审计只需要
   insert,Pick<Db,"insert"> 让 Db 和 PgTransaction 都满足,调用方类型不变。
2. **zod 外部输入的 exactOptionalPropertyTypes**:页面构造 query 时写
   `status: cond ? x : undefined` 过不了 typecheck(可选属性不接受显式
   undefined)——用条件展开 `...(cond ? {} : { status: x })`,与仓库里
   feedback 表单的既有写法一致。
3. **测试假会话的名字与 DB 行不一致**:集成测试的 resolveSession 假实现用
   小写 key 当 user.name,通知 payload 断言 actorName 时对不上 DB 里的
   显示名——生产中会话名与 auth_user.name 本就同源,修夹具对齐,不改产品
   代码。
4. **Hono 字面路由与参数路由的顺序**:/api/tasks/assignee-options 必须先于
   /api/tasks/:id 注册,否则 "assignee-options" 落进 uuid 校验吃 400。
   顺序依赖在路由文件里加注释钉住。

### 遗留 / 备注

- #113 剩余(各归其位):任务评论 → #110 评论内核落地后以任务为首个附着
  对象;AI 拆分粘贴 → 等 #118 统一 AI 客户端;分配邮件 → 等 #116 统一通知
  服务渠道层;团队全局视图(按成员的看板)→ RBAC 模块切片带权限点裁决;
  ops 六态/T-编号/标准任务模板(#156)→ ops 域切片 expand-only 进列。
- tasks.test.ts 复用了 audit-events.test.ts 的独立临时库样板(断言审计
  精确行数的文件必须 hermetic)。
- 分配通知的 payload 形态({taskTitle, actorName})是铃铛 face 层的输入,
  #116 服务化时如有出入在 face 层适配,不改通知表。
