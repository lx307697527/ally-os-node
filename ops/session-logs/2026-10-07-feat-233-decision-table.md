---
session_id: hand-written-233-decision-table
branch: feat/233-decision-table
date: 2026-10-07
reason: issue-233
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/233-decision-table — 2026-10-07

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#221 剩余项「触发条件与自动进入:#233 GoRules 决策表」
  + #233 正文 v2.2「决策表值类型」——**决策表进线切片**(值类型 + 求值内核 +
  审批路线首消费一起落,遵守 schema.ts 里「随首个消费域进场」的已裁决纪律)。
  PR 正文写 Part of #221 + Part of #233(两个 issue 都还有剩余项,严禁 Closes)。
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、main 与远端同步
  (74a27ff);#221 切片 3 的成果评论与租约释放已由上一会话完成,核对后结束。
- **选题**:①优先级里 #233 决策表同时被三处点名(#221 剩余、#233 正文 v2.2、
  schema.ts 注释的进场条件),且 #113/#110/#220 的剩余项全部标注随其他域或
  被阻塞。claim_issue 原子租约拿到(issue 显示 taking over → OK)。
- **数据库**:本地 postgres 可用,全部测试带 DATABASE_URL 跑(无 skip)。

### 本切片改动的文件

- `packages/db/src/schema.ts`:`rule_value_type` 枚举 +`decision_table`;
  「随首个消费域进场」注释改为已进场(0023/0024)
- `packages/db/migrations/0023_hard_the_renegades.sql`(db:generate):仅
  `ALTER TYPE rule_value_type ADD VALUE 'decision_table'`
- `packages/db/migrations/0024_approval-routing-seed.sql`(drizzle-kit generate
  --custom):审批路线种子规则 `approval.routing.user_role`(gate 类别,
  R-16-6,grant/revoke → role_grant,与切片 2 硬编码行为逐条等价)+
  source='created' 的 v1 台账补账(0021 先例);**自带 COMMIT/BEGIN 事务边界**
  (见判断层 3)
- `apps/api/src/rules/decision-table-schema.ts`(新):决策表值形状 zod
  (strict + 列 id 唯一 + 输出 field 唯一 + 规则行只引用已声明列 + _id 必填唯一;
  空表合法 = 路由语义的「临时全部 fail closed」)+ `assertDecisionTableCompiles`
  编译探针(zend 引擎对坏单元格静默不命中,写面逐单元格拒 parserError)
- `apps/api/src/rules/decision-table.ts`(新):`evaluateDecisionTableRule`
  ——注册表值 → 单节点 JDM 图(input→decisionTableNode→output)→ 输出 map;
  三错沿注册表内核,引擎失败包 `DecisionTableEvaluationError`(坏表 fail loud,
  绝不伪装成无命中)
- `apps/api/src/rules/service.ts`:`ruleValueSchemas.decision_table` 接线;
  `changeRuleValue` 在 zod 后过编译探针(立即与定时同一扇门)
- `apps/api/src/routes/rules.ts`:`InvalidDecisionTableError` → 400 invalid_value
- `apps/api/src/approval/routing.ts`(新):`resolveApprovalRoute`——六因折叠的
  matched/unmatched 判别结果,输出列必须叫 configKey 的字符串单值
- `apps/api/src/routes/user-roles.ts`:授予/撤销的高级角色门前先问路由表,
  unmatched 与线缺失同答 403 owner_approval_required(reason 进日志);owner
  直通不查表(R-16-5)
- `apps/api/src/authz/role-approval.ts`:`ROLE_APPROVAL_CONFIG_KEY` 语义改为
  「种子路由表输出的线键」(常量保留,测试与文档仍引用)
- 依赖:`apps/api` +`@gorules/zen-engine@^2.1.2`(#232 §4.9 选型,锁主版本)
- 测试:`apps/api/src/rules/decision-table.test.ts`(新,14 例:形状/编译门纯测
  + scratch DB 求值/路由折叠/改值/回滚/金额区间演练表);`routes/rules.test.ts`
  (+2 例:种子 58 条含路由表深断言、PATCH 决策表 400 矩阵 + 台账回滚到种子表);
  `routes/user-roles.test.ts`(+3 例:种子撤销等价、改道未配线 fail closed、
  空表关非 owner 的门而 owner 直通)
- 文档:`docs/rules.md` 决策表专节 + 剩余项勾掉;`docs/approval.md` 路由决策表
  小节 + 剩余项改为「机制半边已落地,剩金额域首次接线(#229/#231)」
- 验证:`DATABASE_URL=… corepack pnpm verify` 全绿 89 文件 / 714 测试
  (基线 88/695,+1 文件 +19 测试)

## 判断层(手写)

### 关键判断

1. **切片选题:不做「纯 #233 值类型」,做「#221 决策表进线」——消费域纪律优先。**
   schema.ts 注释早已裁决「决策表值类型随首个消费域(#221 审批路线 / #223 费率
   分档)进场」,docs/rules.md 剩余项同判。孤立地加一个枚举值 + zod schema 是
   没有消费者的内核(仓库反复拒绝的形态),所以值类型、求值内核、路由解析、
   R-16-6 改走路由表作为一个切片一起落。PR 对两个 issue 都写 Part of。
2. **zen-engine v2 的决策表 JSON 与 v1 完全不同,靠实验定形状,不靠文档记忆。**
   v2 扁平化:顶层 `inputs`/`outputs` 数组(各带必填 `id`)+ rules 是「列 id →
   单元格表达式字符串」的 map;hitPolicy 是全词 first/collect(不是 F/C);
   节点类型叫 decisionTableNode;裸 JDM 表不能直接 createDecision,必须包成带
   inputNode/outputNode 的单节点图(图校验要求恰好一个输入节点)。更大的发现:
   **单元格是 zen 表达式**——输入是 unary 测试(`== 'grant'`,字段值绑在 `$`
   上),**输出也是表达式**(`'role_grant'` 带引号;裸词解析成 null 被静默丢弃)。
   最危险的行为:解析不了的单元格**静默不命中**、validate() 不查表达式——
   一张带错字的表会「看着改好了、实际永远走不到那一行」。这直接催生判断 4。
3. **PG 55P04 + drizzle 单事务 = 种子迁移必须自带事务边界。** drizzle 的
   migrate 把全部待跑迁移包进**一个**事务,而 PG 要求 ALTER TYPE ADD VALUE 的
   新枚举值提交后才能使用(enum_in 运行时检查;::text::enum 转换也炸,实测)。
   0020/0021 的先例是「新值只加不用」(scheduled 只在运行时写),本切片的种子
   必须在同一批迁移里用新值。解法:0023 只 ALTER;0024 开头 COMMIT 结束
   drizzle 的事务(0023 的变更与其台账行随 COMMIT 原子落库),种子在自动提交
   下跑,末尾 BEGIN 把事务还给 drizzle 收尾。代价:0024 不再整体原子——种子
   按幂等写(ON CONFLICT DO NOTHING + 台账 NOT EXISTS),失败重跑安全。
   这个边界在迁移文件里写了长注释,防止后人「顺手合并文件」把坑带回来。
4. **写面编译探针是决策表内核的必要件,不是锦上添花。** 静默不命中意味着
   「配置错误」和「正常无命中」在运行时不可区分——对审批路线,前者应该大声
   死(400),后者才是 fail closed。所以 PATCH 面逐单元格跑编译探针
   (unary 用 `{$: null}` 探针、输出用空上下文),**只拒 parserError**;类型
   不匹配(`> 100` 对字符串)是运行期数据问题,写面代裁会误伤合法表。空单元格
   跳过(决策表语义 = 恒真)。读面则是 fail loud 三错 + DecisionTableEvaluationError
   ——坏表绝不能被读成「没有路线」。
5. **路由表职责收窄:只回答「进哪条线」,不重裁「谁该进审批」。** R-16-6 的
   「哪些角色是高权的」仍在属主域 payload schema(roleApprovalPayloadSchema)——
   把角色矩阵也搬进配置会造成代码与配置两份真相;本切片让表只接管原来硬编码
   的 configKey 常量,种子语义与改表前逐条等价(user-roles.test 里的
   「seed ≡ pre-table behavior」测试钉住)。金额域(#229/#231)将来把自己的
   `{amount}` 列加进自己的路由表,内核零改动——测试里的演练表验证了这个形态。
6. **resolveApprovalRoute 不抛业务错,六因折叠成 unmatched reason。** 表缺失/
   值未设/坏表/求值失败/无命中/输出不合法,调用方(路由层)一律 fail closed
   403,reason 进日志供辨「为什么没进线」。审批的安全姿态不因路由层引入新
   分叉:unmatched 与线不存在同答 owner_approval_required。
7. **种子类别用 gate。** §4.3 门槛 = 流程推进的前提条件,「高级角色变更须过
   审批」正是;#220 条件积木的「默认条件种子」是另一件事(仍保持 open)。治理
   上 changeableBy=['admin'](owner 恒可),改路由 = 改裁决,须填依据。

### 踩的坑

- **PG 55P04**(本次最大的坑,消耗三次尝试):新枚举值同事务不可用;
  drizzle 全迁移单事务 → 跨迁移文件拆分无效;`('x'::text)::enum` 也炸
  (enum_in 运行时检查)。唯一解是显式 COMMIT 边界(判断 3)。
- **zen-engine v2 无文档级信息可抄**:包内 d.ts 是 auto-generated 裸类,
  DecisionTableContent 形状靠 docs.rs(Rust 源)——顶层是 `inputs`/`outputs`
  + `rules` map,与 v1 JDM 的 columns[{type:inputs|outputs}] 完全不同。
  靠「喂最小结构 → 读报错」逐字段二分(unknown variant `F` → first;
  missing field id;invalid type map expected a string → 单元格是字符串)。
- **实验脚本要放在有依赖的包目录里跑**:pnpm 严格隔离,worktree 根部
  node resolve 不到 @gorules/zen-engine;且清脚本时 cwd 漂移导致 `rm` 落空,
  残留 zen-test*.mjs 被 eslint 的 allowDefaultProject 全数打回——verify 前先
  `git status` 看一眼未跟踪文件。
- **zod v4 的 looseObject/catchall 推导**:规则行改用
  `z.record(z.string(), z.string())` + 表级 superRefine 收 _id 约束,避免
  loose 对象的 unknown 索引类型扩散(noUncheckedIndexedAccess 处处要窄化)。
- 静态断言 `expect(parsed.rules).toHaveLength(57)` 的种子计数在新种子进场时
  会碎——rules.test.ts 的种子测试顺带升级成对路由表的深断言,计数改 58。

### 验收对照

#233(决策表值类型,§4.9/v2.2):
- [x] 「决策表」值类型(GoRules JSON)进注册表:同样有依据(改表必填 refs)、
      生效时间(立即/定时同一编译门)、历史(#226 台账记版)和回滚
      (rules.test.ts 回滚到种子表一例)
- [x] 表必须可执行:写面形状 + 编译探针双门;空表合法 = 路由全 fail closed

#221(触发条件与自动进入,机制半边):
- [x] 路由决策表裁决「进哪条线」:R-16-6 授予/撤销改走
      `approval.routing.user_role`,种子 ≡ 改表前行为(等价性测试)
- [x] 未命中/坏表 fail closed(403 owner_approval_required,六因留日志);
      owner 直通不受表影响(R-16-5)
- [ ] 金额区间 → 谁批的**真实域接线**(报价 #229 / 采购 #231,各自域切片)
- [ ] pg-boss 催办与多级通知扇出(#116)、会签/票签、配置 UI(保持 open)
