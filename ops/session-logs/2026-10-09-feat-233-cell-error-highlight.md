---
session_id: hand-written-233-cell-error-highlight
branch: feat/233-cell-error-highlight
date: 2026-10-09
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

# Session log — feat/233-cell-error-highlight — 2026-10-09

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#233(规则注册表,phase-1)——评论剩余清单里的
  「逐格错误的格内高亮」:上一切片 PR #309 落了 JDM 网格编辑器,编译探针的
  逐格语法错当时只进 issues 面板;本切片把它穿到格子上。PR 正文写
  **Part of #233**(gate 类别种子随 #220、治理字段编辑随 #206、#223 费率
  分档等其余剩余项未完,保持 open)。
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净。
- **选题**:①优先续做有未完成切片的 issue——#192 的剩余项全部路由到未建域
  (#238/#231/批次域触发点、#186 门户、#241 回写、#181 QuickBooks、#128 PDF),
  #193 剩余同样压在 #186/#240 上;#233 的逐格高亮是唯一自包含、可独立验收的
  未完成切片(纯 web 面,API 合同与错误措辞均已在线上)。
- **claim**:`claim_issue.py claim --issue 233` 成功。
- **数据库**:零 schema、零 API、零 migration 改动;verify 带 DATABASE_URL
  跑全量(结果见文末)。

### 本切片改动的文件

- `apps/web/src/shared/lib/rules-client.ts`:新增三个纯导出——
  `parseTableCellIssues`(镜像服务端编译探针措辞
  `rule "<_id>" input|output cell "<列id>" does not parse: `,按匹配位置切片
  拆分 `"; "` 连接的多格错误、剥掉 `rules: invalid decision table: ` 信封)、
  `cellIssueKey`(稳定句柄合成 `${rowKey}::${columnKey}`,页面与组件共用)、
  `locateTableCellIssues`(把引用解析到当前草稿的行/列句柄上;解析不到的
  引用丢弃不猜)。接口:`TableCellIssueRef` / `TableCellIssue`。
- `apps/web/src/shared/components/DecisionTableEditor.tsx`:新增可选 prop
  `cellIssues?: ReadonlyMap<string, string>`;被点名的格子
  `outline-2 outline-[var(--err-line)]` + `aria-invalid` + 原话进 `title`;
  格子有标记时表格下方出图例(`rules-edit-table-cell-errors`):红格是服务端
  上次保存点名的格子,下次保存重新裁决。文件头裁决清单同步。
- `apps/web/src/shared/pages/RulesRegistry.tsx`:把 `changeIssues`(issues
  面板渲染的同一份数组)喂 `locateTableCellIssues` 得到坐标,合成 Map 后以
  `cellIssues={tableCellIssues}` 传给编辑器;渲染期重算——标记跟着格子走,
  下次保存尝试(submitChange 入口清 changeIssues)/重开表单/切模式时揭开。
- 测试:`rules-client.test.ts` +5(措辞解析、连接拆分、句柄定位、解析不到
  丢弃、非探针措辞不点名格子);`decision-table-editor.test.ts` +1(纯函数
  契约在 client、prop 接线、err 描边、图例话术);`rules-registry.test.ts`
  +1(同一份 issues 喂定位器、prop 接线、面板保留原话)。
- `docs/rules.md`:网格编辑器条目补「逐格错误穿到格子上」的语义与边界
  (标记是注解、下次保存揭、解析不到不乱指、面板原文仍在)。

## 判断层(手写)

### 关键判断

1. **标记是「上一次保存被拒」的注解,不是实时校验**。备选:格子文本一变就
   揭掉自己的标记(看似聪明)——被否:zen 是 WASM,刻意不进 web bundle
   (#309 的裁决),客户端改完的格子依旧是「未证明」状态,提前揭标记是 UI
   在替服务端宣布无罪;整批标记在下次保存尝试时一起重裁(submitChange 入口
   清 changeIssues,派生链自然揭开),语义诚实:红 = 服务端点名,揭 = 重新
   问过服务端。

2. **定位器镜像措辞但宽容失败,宁可不高亮不误高亮**。`parseTableCellIssues`
   只认编译探针的逐格措辞;客户端 serialize 的拒绝话术(Duplicate column
   id…)与 zod 形状错不匹配、不点名格子——网格路径下形状错本就到不了服务端
   (serialize 先拒),能从服务端回来的逐格家族只有语法错,定位器收窄到它
   就没有误指面。措辞漂移的后果是「高亮不出现、面板照旧」,降级路径安全;
   这与 parseDueInDays 镜像 zod 准入是同一纪律,但方向相反:那边错会挡提交,
   这边错只是少个注解,所以解析器可以保守。

3. **解析不到的引用丢弃,不猜行不猜列**。保存被拒后用户可能改名列 id 或删行
   ,陈旧引用匹配不上就丢(面板原文仍在)。备选「整行/整列高亮兜底」被否:
   指错格子比不指更糟——编辑者会去改一个本来没错的格子。第一条 segment 若
   含行号歧义(草稿里重复行 id)取首个匹配,纯装饰性差异:serialize 在保存
   时就会把重复行 id 去重改名,服务端永远点名唯一 _id。

4. **tooltip 带切片原文,不带整包**。多格错误在服务端是一个 `"; "` 连接的
   消息,按匹配位置切片(不碰 zen JSON 的内容,无内容启发式)让每个格子的
   悬停提示只说自己;信封前缀剥掉、连接分号裁掉都是位置手术。完整原文仍在
   issues 面板——面板是 verbatim 的家,格子只借一段。

5. **键合同一处定义**:`cellIssueKey` 导出供页面与组件共用,`::` 分隔符安全
   性靠句柄铸币纪律(nextFreeId 只出 `row_*`/`col_*`,无冒号)——注释里写明
   ,防止将来有人改句柄格式时把键空间撞穿。

### 踩坑

- **Edit 的绝对路径落在了主检出**。写测试的第一轮把三个测试文件改到了
  `d:\Code\ally-os-node\apps\...`(主检出)而非 worktree
  (`.claude/worktrees/233-cell-error-highlight/apps\...`);worktree 里跑
  vitest 依旧全绿——「实现前新测试就该红,却绿了」正是暴露点。处置:确认
  主检出 status 只有这三个文件(无其他会话 WIP)→ 复制进 worktree →
  `git restore` 还原主检出。教训:bash 跟 cwd 走、Edit 跟绝对路径走,两者
  在 worktree 流程里必然分叉;开 worktree 后所有文件路径必须重新生根,
  「该红不红」是第一信号。
- **`match.index ?? 0` 被 eslint no-unnecessary-condition 拒**:本仓库 TS
  lib 配置下 `RegExpMatchArray.index` 类型是非可选 number,`??` 是多余条件
  ;而 `matches[i+1]?.index` 因 noUncheckedIndexedAccess 仍是
  `number | undefined`,`??` 必须保留。同一个正则匹配对象上,一个 `??` 删
  一个留——照编译器/ lint 的实际类型写,不照记忆里的 lib 写。

## 验证

`corepack pnpm vitest run`(改动三测试文件)57 例全绿(测试先行:红 7 →
实现后全绿);全量 `DATABASE_URL=postgres://ally:ally@localhost:5432/ally
corepack pnpm verify` 全绿 **131 文件 / 1365 测试零 skip**(基线 131/1358
,+7 用例,零新增文件)。零 migration、零 API 改动。
