---
session_id: hand-written-222-custom-field-null-clear
branch: feat/222-custom-field-null-clear
date: 2026-10-07
reason: issue-222
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/222-custom-field-null-clear — 2026-10-07

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#224 切片 7(#294)评论里顺带发现的 #222 缺陷(「PUT
  custom-fields 对可选字段显式 null 清值会 500」),评论原话建议「在 #222 下
  开修复切片」——本切片就是那个修复切片。PR 正文写 Part of #222(#222 的
  表单构建器 UI、rjsf 接线、消费域接入等剩余项不受影响,严禁 Closes)。
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净;
  origin/main 顶端 15ae88c(#294,条件积木注册表)即基线。
- **选题**:①优先续做 issue 评论里的未完成切片。#224/#221/#233/#220 的剩余
  项多数等别的域(#229/#231/#243/#118/#206)进场,唯有这条是自带复现、边界
  清晰、零依赖的缺陷修复——按续做优先选它。claim 时发现 #222 有上一会话的
  残留租约,claim_issue.py 原子接管成功。
- **老系统参考(只读)**:本切片是内核一致性修复,老系统无可对标的迁移物;
  「清值」在老系统里从来不是合法状态(询价向导的字段值写在 intake 提交里),
  新系统把值做成可清的一等状态是 #222 自己的语义决定。
- **数据库**:本地 postgres 可用(docker 容器 5432 端口活着),verify 全程带
  DATABASE_URL(无 skip)。

### 本切片改动的文件

- `apps/api/src/custom-fields/service.ts`:`parseValueSubmission` 的 writes
  从 `{ def, value }` 改为判别联合 `ValueWrite`(`{ action: "set", def,
  value }` | `{ action: "clear", def }`)——可选字段的显式 null(进程内接缝的
  undefined 同义)解析成 clear,不再作为 `value: null` 透传给写库方;必填字段
  的 null 照旧 zod 拒绝(422 invalid),清值不是必填的后门。
- `apps/api/src/routes/custom-fields.ts`:PUT values 的事务体按 action 分支
  ——set 照旧 upsert;clear 走 `DELETE`(subjectType+subjectId+fieldDefId,
  清从未写过的字段 = 零行删除,幂等)。审计 detail 在有清值时另记
  `clearedFieldKeys`(条件展开,纯 set 提交的审计行形状不变)。
- `packages/db/src/schema.ts`:**仅注释**——`custom_field_values.value` 上的
  旧注释「null = 显式清值」与同行的 `notNull()` 自相矛盾(这正是 bug 根源),
  改写为跨模块契约的正述:行在场即有 JSON 值,行不在场 = 未填或已清。
  `corepack pnpm db:generate` 确认零 schema 变更、零迁移。
- 测试(+4):service 纯函数 2(显式 null → clear 写入且不带 value 键;必填
  字段 null → invalid);路由集成 2(可选字段 set → null 清值 → 值行物理删除
  → GET 读 null → 审计带 clearedFieldKeys → 幂等再清 → 重写回值,全程 200
  ——修复前第一段就 500(23502);必填字段 null → 422 invalid)。
- `docs/custom-fields.md`:提交语义改写(清值 = 删值行,NOT NULL 是跨模块
  契约,worker 条件块的 eq/ne/exists 语义引用);`docs/audit.md`:
  `values_updated` 词条补 clearedFieldKeys。

**验证**:`DATABASE_URL=… corepack pnpm verify` 全绿 106 文件 / 958 测试
(基线 106/954,+4,零 skip;lint/typecheck 含于 verify)。

## 判断层(本次的关键判断与踩的坑)

1. **清值 = 删行,不动列约束。** 三个候选:①列改 nullable(要新迁移,且把
   worker `custom_field` 条件块白纸黑字依赖的不变式「值列 NOT NULL,行在场即
   有 JSON 值」拆掉——「写过但清了」成为谁都没要过的第三态,每个读者都得重新
   裁决);②往 NOT NULL jsonb 里存 JSON 字面量 null(要绕开 drizzle 的
   null→SQL NULL 映射,读者面对同样的第三态);③删行(零迁移;GET 读路径本就
   把「行不在」渲染成 null;worker 的「没写过值 = eq/ne 不满足、exists 表达
   必有/必没有」对清值语义恰好全对)。③赢在它让「未填」与「已清」共用一个
   态——今天没有任何消费方能区分这两者,那就不要发明需要区分的表示。
2. **用类型把「漏掉清值分支」变成编不过,而不是靠注释提醒。** writes 若保持
   `{ def, value }` 而 value 允许 null,路由可以原样 upsert 再次埋雷;判别
   联合迫使事务体穷举 set/clear 两支。与 #224 update_field「显式键缺席即拒」
   同一纪律:形状让错误的代码不可表达。
3. **bug 的根源是规格与存储的矛盾,不是一个漏写的分支。** #222 切片 1 的
   zod 面(可选 = `.nullable().optional()`,注释明说「显式 null = 清值」)和
   存储面(NOT NULL)各自成立、从未被同一条集成测试穿过——切片内「能存进去
   的」测试全过,「注释承诺过的」没有测试。修复顺手把 schema.ts 上那句自相
   矛盾的注释改成正述:注释说到的行为必须有测试钉住,否则它只是没兑现的许诺。
   这条缺陷由 #224 切片 7 的跨切片集成测试现场撞出(23502),不是本切片的
   功劳——跨模块的契约要靠跨模块的测试才能照见。
4. **审计记「清了哪些键」,且只在非空时记。** 值行的消失从此有了可查的来路
   (「这值为什么没了」沿审计流可答);纯 set 提交的审计行形状不变(条件
   展开),既有审计消费方零感知。fieldKeys 维持「本次提交触及的全部键」不变
   ——它是操作语义,clearedFieldKeys 是其中的一部分的真子集标注。
5. **坑:vitest 的 `toContainEqual` 对多出来的已定义键是严格不相等。** 断言
   `{fieldKey, code}` 撞上有 `detail` 的 issue 连败两次,改成按 fieldKey 找
   到再断 code。同一个坑在 service 测试和路由测试各咬一口才长记性。
6. **坑:集成测试的断言面要数自己提交的次数。** 第一版清值测试断言审计恰一
   行,但测试自己先 set 后 clear 提交了两次——审计两行才是对的。断言错不
   一定是实现的错;先数一遍测试自己做了什么。
