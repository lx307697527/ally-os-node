---
session_id: hand-written-224-automation-kernel
branch: feat/224-automation-kernel
date: 2026-10-06
reason: issue-224
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/224-automation-kernel — 2026-10-06

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#224(配置工作室:自动化规则引擎;#232 §4.4「自动化规则」行
  + §4.9 v2.2「自建,pg-boss 执行;规则模型参考 Odoo」)——**切片 1:事件触发的
  自动化内核**(触发 → 条件 → 动作 + 执行日志 + 两个内核动作),PR 正文写
  Part of #224(切片未完,严禁 Closes 关键字)
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净(f562a3d,
  #271 已合并)。选题:配置工作室 cluster 顺序里 #222 切片 1 上轮已合并,本轮按
  既定顺序做 #224;#224/#233 均无评论(无未完成切片争议),claim 一次成功。
- **老系统参考**:老库 887 个迁移文件里 grep 不到 #134 说的 38 个触发器
  (dashboard 直加,不在迁移文件里)——新引擎本就是重建而非照搬,不影响设计;
  触发/条件/动作形状全部依 #232 §4.4 + Odoo 模型自建。

### 本切片改动的文件

- `packages/automations/`(新包):spec zod(trigger / conditions / actions
  discriminated union)+ 纯引擎(`eventMatchesTrigger`/`resolvePath` 点路径只穿
  普通对象、`evaluateConditions` AND + fail closed、`AUTOMATION_ACTOR_PREFIX`
  回路防护标记)。零依赖(只有 zod),api 与 worker 共用同一份形状。
- `packages/db/src/schema.ts`:`automation_rules`(trigger/conditions/actions
  三段 jsonb + enabled + version 预埋 #226 + createdById)、
  `automation_runs`(status pending/skipped/succeeded/failed pg 枚举、逐条件/
  逐动作结果 jsonb、(rule_id, source_event_id) 唯一约束、rule_id ON DELETE
  SET NULL + rule_name 快照)
- `packages/db/migrations/0017_goofy_shinko_yamashiro.sql`(新,drizzle 生成,
  expand-only)
- `apps/api/src/routes/automations.ts`(新):规则 CRUD + runs 读面,全部在
  `automations.configure` 权限点后;spec 整体替换、spec 变更版本 +1 留审计
- `apps/api/src/routes/registry.ts`:5 条新路由声明(全 permission)
- `apps/api/src/authz/permissions.ts`:`automations.configure`(owner/admin 默认)
- `apps/api/src/app.ts`:挂载 automationsRoutes
- `apps/worker/src/automations/`(新):`actions.ts`(executeCreateTask /
  executeNotify,db 通道收窄为 `Pick<Db, "insert">` 直插事务连接,services
  发布/日志分注)、`runner.ts`(automation-run:每动作一事务 + run 行
  FOR UPDATE,进度带外写回后抛给 pg-boss 重试)、`scanner.ts`(automation-scan
  每分钟:90s 审计尾窗 × 启用规则,automation: actor 回路防护,滞留重发
  2min / give-up 终判 90min)、`index.ts`(任务工厂,db/pool/boss 注入)
- `apps/worker/src/index.ts`:createDb + automationJobs 接线,pool 兼作
  pg_notify 发布执行器,shutdown 关池
- `apps/worker/package.json`:加 @ally/automations、@ally/db、@ally/realtime、
  drizzle-orm、zod(workspace/对齐版本);`apps/api/package.json` 加
  @ally/automations
- 测试:`packages/automations/src/index.test.ts`(11 条纯函数:触发精确匹配、
  点路径防原型链、四 op 语义与 fail closed、spec 形状收口)、
  `apps/api/src/routes/automations.test.ts`(8 条集成,独立临时库:403 门、
  401、CRUD + 审计、400 坏形状、PATCH 版本语义、404、删规则留 runs、runs
  过滤)、`apps/worker/src/automations/automations.test.ts`(11 条集成,
  独立临时库 + 桩注入 send/publish:**端到端验收**——规则「进入 review →
  建任务 + 发通知」从审计事件到任务/通知/铃铛帧全链、skipped、重扫去重、
  回路防护、停用不触发、重试只补失败动作、规则删除终判、滞留重发与
  give-up、收件人去重 + 铃铛降级、坏 spec 防呆)
- 既有测试更新:`authz/authz.test.ts`、`app.test.ts`(admin 精确权限集断言
  加 automations.configure)
- 文档:`docs/automations.md`(新:内核文档 + 关键裁决 + 验收对照 + 剩余项)、
  `docs/permissions.md`(权限点现状加 automations.configure)、`docs/audit.md`
  (词表加 automations.rule_* 三个动作;明确「执行不进审计,进 automation_runs」)
- **新依赖**:无外部新包(workspace 内接线);**无新 env**

### 验证

- `DATABASE_URL=… corepack pnpm verify` 全绿:**79 文件 / 610 测试**(本地
  postgres,带 DB 集成)
- pre-push 钩子正常跑 verify(未绕过)

## 判断层(手写)

### 本次的关键判断

1. **事件源 = 审计流,不为自动化再造事件总线**:audit_events(#29)是「一次
   业务变更一行」的既成事实,活动流(#264)是第二个读者,自动化是第三个——
   「域逻辑要触发自动化就必须写审计」本来就是 docs/audit.md 的纪律,不是新增
   负担。附带收获:老系统 38 个触发器「看不见」的病根被顺势治了——触发条件
   就是一行 SQL 可查的规则数据,执行记录就是 runs 表。
2. **触发统一为「审计 action 精确命中」**:新建(task.created)、字段变化
   (detail.from/to)、进入阶段(workflow.state_changed + detail.to)在切片 1
   是同一种触发,验收第 3 条的例子不分支就成立。定时/相对时间触发是另一种
   扫描器形态(日期字段 × 偏移),刻意不塞进本切片凑数——形状不对的统一是
   假统一。
3. **动作执行的幂等协议是本切片最重的设计**:action_results 是幂等闸(动作行
   存在 ⟺ 该动作已提交),重试只补失败的那个动作;每动作一个事务 + run 行
   FOR UPDATE 串行化并发处理器;失败不终结 run(保持 pending),give-up 终判
   交给知道重试上限的一方(扫描器清障,阈值 90min > 4 次尝试最坏 66min)。
   「什么时候算彻底失败」与「怎么重试」分属两个组件,是因为 pg-boss 的
   retryCount 在 handler 里拿不到(JobDefinition 只给 data+logger)——不改
   共享 runner.ts 的签名,把终判挪到扫描器,是顺应现有接缝而不是扩它。
4. **回路防护用 actor 前缀,不用词表黑名单**:自动化产物 actor 记
   `automation:<runId>`(审计 actor 本就是 text 约定,cli: 前缀同款),扫描器
   NOT LIKE 过滤——比维护「哪些 action 是自动化产物」的黑名单表更不会烂;
   detail.via=automation 只是给人读的补充。「规则触发规则」确有业务需要时走
   条件积木显式表达,不给隐式通路。
5. **规则删除留执行日志**(rule_id SET NULL + rule_name 快照):runs 是观测面,
   「删了规则掩盖执行痕迹」不该是配置权的副作用;这与审计不可删除(数据底线)
   同精神,但用 FK SET NULL + 快照列实现而非 append-only 触发器——runs 不是
   审计,配 pub 可清理的历史粒度(后续切片再裁决保留期)。
6. **动作配置保存时收口,运行时再 parse 一次**:与 workflow 积木「只校验名字」
   不同——自动化动作 config 是内核定义的(discriminated union 长在共享包里),
   CRUD 时 zod 就拒绝坏形状,「不改代码新增规则」的入口不能带病入库;worker
   运行时再 parse 是防手工改库/未来导入,坏了终判 failed 不带病执行。
7. **动作实现随 worker 进场,API 不执行动作**:建任务/发通知的领域行为
   (task.created 审计、task.assigned 通知)在 worker 侧镜像任务内核——承认
   这是重复面,统一通知通道(#116)进场时收拢;kernel 文档里明写「不复刻第二份」
   的到期日,避免漂移无人认领。

### 踩的坑(都花时间修了)

1. **事务边界一开始想错了**:第一版把 FOR UPDATE 行锁放在一个大事务里,但动作
   执行器拿的是 `deps.db`(池上连接)——动作根本不在事务里,行锁零作用;且
   「进度写回 + 末尾 throw」同事务,抛错时进度一起回滚,重试协议完全失效
   (测试当场抓出 action_results 为 null)。重写为「每动作一事务 + 进度带外
   落库」:动作在其事务内提交、进度紧随其后独立写、失败才抛错重试。
2. **动作语句失败会 abort 整个 PG 事务**:捕获 FK 错误后继续用同一 tx 写进度,
   会撞 25P02「current transaction is aborted」;且 drizzle 对 aborted 事务的
   COMMIT 必败,错误信息还是 COMMIT 的而不是动作的。最终形态:动作错误在回调
   内捕获进 errors 数组(细节保留)、事务拒绝在外层吞掉、进度带外写——三层
   都是因为 PG 的 aborted 事务语义。
3. **`Pick<Db, "insert">` 收窄 deps 类型炸出 107 个 unsafe**:gotcha 65 的
   变体——ActionDeps.db 收窄成 insert 面,runner 里 deps.db.select/transaction
   全变 any。正解是**按消费者拆**:执行器签名收 `Pick<Db,"insert">`(tx 可传),
   runner 自己的读写仍用完整 Db;「收窄类型」只能收窄到该函数真正用的面,
   不能顺手收窄共享接口。
4. **exactOptionalPropertyTypes 双杀**:测试桩收集 `{text, values}` 时
   `values?: unknown[]` 收到显式 undefined 报 TS2379——收集类型要写成
   `values?: unknown[] | undefined`;条件展开 `...(cond ? {x: body.spec} : {})`
   不因外层 boolean 变量收窄,必须 `cond && body.spec !== undefined`。
5. **仓库的防遗漏测试是资产不是绊子**:route-auth.test(路由册双向比对)、
   authz.test / app.test(admin 精确权限集断言)当场拦下「加了路由没声明、
   加了权限点没进清单」——三个红测试全部是更新期望而非放宽断言,这类测试
   红了先怀疑自己漏登记。
6. **pg-boss v12 的发送去重是 `singletonKey` 不是 `jobId`**(v10 之前的旧参数
   名):types.d.ts 现场确认后落码;滞留重发靠它挡在途重复,扫描器才能每分钟
   无脑重发。
7. **生成式写码的垃圾行自检**:本次有两处生成时混入成片的占位注释/残缺分支
   (测试 beforeEach 块、nudgeBells 函数),提交前全文件重读时发现并重写——
   lint/eslint 拦不住语义残缺,只有通读能拦;后续会话生成大文件后先通读再跑测试。
