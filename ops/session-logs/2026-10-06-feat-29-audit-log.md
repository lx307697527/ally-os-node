---
session_id: hand-written-29-audit-log
branch: feat/29-audit-log
date: 2026-10-06
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

# Session log — feat/29-audit-log — 2026-10-06

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#29(审计日志、删除记录与状态变更日志;#232 平台服务
  「审计日志」+ §13 合规「审计追踪 / 审计日志不可删除」)——**切片 1:审计
  内核 + 查询面**,PR 正文写 Part of #29(切片未完,严禁 Closes 关键字)
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净。
  选题:#129 已关闭(切片 4 合并后整体关闭),其评论里的剩余项(i18n +
  ops 前端并入)依赖尚未存在的业务页面(BOM/仓库收货/采购),不可做;
  #22 代码侧全部完成(评论明示剩余为运维切换步骤);#23/#25 剩余被
  #227/#235 阻塞;落到 phase-1 的 #29(无评论、无阻塞)。

### 本切片改动的文件

- `packages/db/src/schema.ts`:audit_events 加 `(created_at desc)` 索引 +
  append-only 注释块
- `packages/db/migrations/0007_overrated_mercury.sql`(新,expand-only):
  索引(drizzle 生成)+ **append-only 触发器(手写)**——
  `audit_events_is_immutable()` + BEFORE UPDATE/DELETE 两个触发器,直译老系统
  `audit_log_is_immutable()`(fix747+fix906 的无条件拒绝)
- `apps/api/src/audit/audit-log.ts`(新):共享审计写入器 `recordAudit`,
  失败语义 = 原样抛出(审计丢失比业务失败严重,不做静默降级)
- `apps/api/src/routes/audit-events.ts`(新):`GET /api/audit-events`,
  `audit.read` 权限点门;zod 收 query;offset 分页(默认 50 封顶 200)+
  精确 total;actor/action/target 精确匹配;**纯读端点(查询不写审计)**
- `apps/api/src/authz/permissions.ts`:`PERMISSIONS` 加 `audit.read`
  (owner/admin 默认;矩阵测试自动覆盖)
- `apps/api/src/routes/registry.ts`:新路由声明(permission 类,403 测试
  由 route-auth 契约强制)
- `apps/api/src/routes/user-roles.ts`、`scripts/grant-role.ts`:私有 audit()
  helper 收敛到共享 `recordAudit`(API 与 CLI 两个现存生产者)
- `apps/web`:`shared/lib/audit-client.ts`(zod + 三态读取:ok/forbidden/
  unavailable——页面是主界面,空表必须说明原因,不做铃铛式的静默降级);
  `shared/pages/AuditLog.tsx`(System 区第一个页面,四态不撒谎 + 固定步长
  翻页 + 精确 total 页脚);App.tsx 挂 `/system/audit`;rail-groups 的
  system 组从空组变真页面(note 同步改真话);RailIcon 加 `ledger` 字形
  (自绘,遵守既有 stroke spec);`audit-log.test.ts`(源码断言 9 条)
- 测试:`packages/db/src/audit-immutable.test.ts`(触发器 3 条:插入可、
  UPDATE 拒、DELETE 拒且行还在)、`apps/api/src/routes/audit-events.test.ts`
  (6 条集成:401/403/200 形状/过滤/分页越界 400/读不写审计)
- 文档:`docs/audit.md`(新:层次裁决、词表、TRUNCATE 纪律、剩余项);
  `docs/permissions.md`(owner/admin 矩阵行 + 权限点现状加 audit.read)
- **无新依赖、无新 env**

### 验证

- `corepack pnpm verify` 全绿:**48 文件 / 361 测试**(含 DB 集成;本地
  postgres = docker ally-os-node-postgres-1);apps/api+packages/db 连续 6 轮
  并行无 flakes;`vite build` 通过
- pre-push 钩子正常跑 verify(未绕过)

## 判断层(手写)

### 本次的关键判断

1. **层次裁决(本 issue 的正题)**:「触发器 vs 应用层」裁成**应用层写
   (`recordAudit` 同事务显式调用)+ 数据库只兜一条 append-only 底线**。
   理由:新系统所有写路径收敛在 API,应用层审计记得出「谁、通过哪个路由」;
   触发器方案今天没有附着对象(业务表没进场),先建机制不留产线 = 生产死代码。
   而且老-老系统的 176 个触发器恰是 #232 设计明确抛弃的形态,上一代内核
   `core.emit_event()` 就是应用层同事务显式调用——有直接先例。append-only
   触发器则补上应用层挡不住的那一半:绕过应用的人工写路径改写/抹不掉历史
   (fix906 的论证:不存在合法的行级 UPDATE/DELETE 流量,所以无条件拒绝)。
   将来 Part 11 监管表进场时逐表评估触发器兜底,评估记录回 docs/audit.md。
2. **验收标准的诚实处理**:验收两条(「线索状态变更/删除后日志页可见操作人
   时间前后值」「已删除记录可查看恢复」)都依赖尚不存在的业务域(#227 等),
   本切片不硬凑——PR 写 **Part of #29** 并逐条列剩余项;「前后值」的载体定为
   detail 里的 from/to 约定(docs/audit.md 词表节),不为它提前加列(无消费者的
   列是投机设计)。
3. **audit.read 给 owner+admin**:#232 §12 老板「全部查看」+ 管理员是系统
   操作者;审计含全公司人员操作记录,其余角色不给默认开。
4. **页面 403 态显式化、导航显隐不做**:铃铛的「失败静默降级」纪律不适合
   主界面——操作员面对空表必须知道是没有记录还是没有权限,adapter 三态
   (ok/forbidden/unavailable)。rail 项全员可见 + 页内诚实答复,与壳现状
   一致(壳注释明说 per-role 显隐归 #23 后续切片)。
5. **detail 列 vs 新加 before/after 列**:裁 detail jsonb——老系统
   core.audit_log 就是 detail 单列装 payload;状态变更的 from/to 是约定不是
   结构,第一个真实消费域(#227)落地时若确需结构化再 expand-only 加列。

### 踩的坑(都花时间修了)

1. **append-only 触发器 vs 并行测试的清库路径**——本切片最大的坑,两层:
   - 已有测试用 `db.delete(auditEvents)` 清库(无 FK,历史残行),
     触发器一上直接红。TRUNCATE(DDL,不触发行触发器)是唯一通道——
     但**共享库上的 TRUNCATE 会抹掉并行测试文件正在断言的行**:
     user-roles.test.ts 的 afterEach 清库 → audit-events.test.ts 的精确
     total 随机红;反过来 index.test.ts 清库 → user-roles 的按 target 断言
     随机红。最终纪律:**需要空表的文件自开临时库**(audit-events.test.ts
     每次运行 create database/drop with (force),hermetic);共享库上的文件
     不清库、断言只认带唯一前缀的行。坑的根因是 vitest 默认文件级并行 +
     全套件共用一个 DATABASE_URL——单跑全绿、并行随机红,用 6 连跑才压稳。
   - 顺带:drizzle 把 pg 错误包进 DrizzleQueryError,触发器的 RAISE 在
     `.cause` 链上,`rejects.toThrow(/append-only/)` 永远不中——断言要沿
     cause 链找真实原因,不能「任何拒绝都算数」。
2. **eslint no-unnecessary-condition 对测试夹具的假类型不买账**:
   `let pool = undefined as unknown as Pool` 后,`pool !== undefined` 和
   truthy 检查都被判多余条件。正解不是压 lint,是结构重排——pg.Pool 构造
   是惰性的(不发 I/O),所有句柄在 describe 作用域非空创建,beforeAll 只做
   建库 + 迁移,条件判断整个消失。
3. **total=0 幻象**:第一次红时 200 响应 total 为 0 而行明明插进去了——
   先怀疑 drizzle 的 count 写法,单跑又绿。真相是并行文件的 TRUNCATE 恰好
   插在播种和断言之间(见坑 1)。教训:并行 flake 先查共享状态,别急着怀疑
   查询本身。

### 遗留 / 备注

- #29 剩余(随业务域):业务域接线(第一个是 #227 线索状态变更,detail 带
  from/to)→ 删除记录 + 快照 + 恢复 → 状态变更日志投影(crm.status_change_log
  的对应物)→ Part 11 监管表的逐表触发器评估。
- audit-events.test.ts 的临时库做法(每文件独立库)是共享表集成测试的样板,
  后续业务域的审计断言建议直接复用。
- 本地库 `ally` 里留有本切片开发期的 audit_events 残行(index.test.ts 按
  新纪律不清库)——共享库残行无害,已被唯一前缀纪律覆盖。
