---
rule_id: RULE-002
scope: global
ladder: ci-check
status: active
born_from: [BUG-002, BUG-003, BUG-006, BUG-010, BUG-017, BUG-030]
created: 2026-07-23
last_triggered: 2026-08-03
---

# RULE-002: 守卫必须 fail-closed、必须能证明自己活着，且判定逻辑必须可被测试

> **BUG-006 加入本规则时带来一个新变体，值得写在最前面**：`backlog-close` Action
> 并不是 fail-open —— 它**响亮地失败了 31 次，连续 6 天**。它之所以等于不存在，是因为
> 它**不在 required status checks 里**（`main-protect` 只要求 `same-pr-rule` 一条），
> 于是它每次都红、每次都不拦人。会话看见了（YAML 注释里逐次记着「FAILED again」），
> **流程**没看见。
>
> 所以「证明自己活着」不止是「别静默退出 0」，还包括:**一个不阻塞任何人的守卫，
> 等于一个没人读的守卫。** 新增阻断式守卫时，把它纳入 required checks 是本规则的一部分，
> 不是可选的收尾。

## 规则

任何守卫（CI gate、hook、审计脚本）：**前提缺失或启动失败时必须报错，
不得静默放行**（fail-closed）；且必须产生可断言的存活证据（运行日志/
artifact/git mode）。静默失效的守卫比没有守卫更危险——它制造虚假信心。

并且（reflect-2026-07-26 增补）：**守卫的判定逻辑必须落在带反向 fixture 自测的
脚本里，不得内联在 workflow 的 bash 中。** 具体两条:① workflow 调用的任何
`scripts/*.py` 必须有 `scripts/tests/test_<stem>.py`（[FEAT-044] phase 5 起，
harness 扩展点 `guards/` 下的脚本同理：`guards/test_<name>.py`，无自测的扩展
脚本由包直接判红）;② 任何 `run:` 步骤不得
一边自己检视仓库内容（grep/sed/awk/head/ls）一边自己发出 `::error` 判定 ——
判定必须交给脚本。**区分标准是「是否委派给脚本」,不是用了哪些 shell 命令**:
test-integrity.yml 的 core-table 步骤同样 grep、同样 `::error`,但判定来自
`check_core_table_touch.py`,因此合规。存量债钉在
`ops/rules/guard-testability-allowlist.txt`,双向 ratchet。

> **BUG-030 加入本规则时带来第二个变体:「前提缺失」也包括「前提从没被问过」。**
> `backlog-close` 的 closer 从不校验这次合并落在哪个分支,于是堆叠 PR 合进父分支时
> 它照样写 `done` —— 五次,全部 success。这不是 fail-open(没有任何分支被吞),而是
> **一条前提根本不在判定里**。它同时印证了本规则第 ② 条:判定必须落在带自测的脚本里
> 才可能被反向 fixture 钉住 —— 修复把 base 判定放进 `scripts/backlog_close.py` 并补了
> 9 条反向用例,另加 2 条直接对 workflow 文件断言接线还在(BUG-003/BUG-006 都是
> 「机制建好了但没接上」)。

## 缘由（born from）

跨模块同机制 ×2（+ 本次审计核实的多处活体违例）：

- **BUG-002**（ci）：mutation gate 自 pnpm 迁移起从未启动（4 秒即崩），
  `continue-on-error: true` 让夜跑红灯无人认领——"启动失败"被当成
  "分数不达标"吞掉。
- **BUG-003**（harness）：三个 hook 以 100644 入库，所有新克隆上静默
  从未触发，两个月无人发现——失效无任何信号。

活体违例（2026-07-23 审计核实，经 chore 逐个 ratchet 翻转）：

- ~~四个 `validate_*.py` 在「要查的东西根本不存在」时 `exit 0`~~ →
  **已翻转（FEAT-026 phase 4）**：`validate_backlog` / `validate_incidents` /
  `validate_maps` / `validate_specs --audit` 四个前置分支全部改为报错。
  这是本规则最迟才还上的一笔债，也是最贵的一笔 —— 四个都是**每个 PR 必过**的门。
  FEAT-028 phase 1 先把当时的行为钉成反向 fixture，翻转才有红锚可依；两相分开，
  正是因为「织网」和「改行为」不该在同一个 PR 里评审。
  三点值得记住，因为天真的翻法会翻错：
  1. **「残缺」不等于「合法地为空」**。`items: []` 是一份完整而没有活的待办，
     必须放行；`items:` 键缺失是文件被截断，必须判红。最危险的恰恰是后者——
     截断的文件此前打印的是「校验通过，0 条」，和健康状态一字不差。
  2. **`validate_maps` 没有按「一份地图都没有就红」翻**。那会让每个刚采用这套
     harness 的仓库第一天就红。真正的判据是**欠着一份地图**（`src/modules/*` 或
     `apps/*` 目录旁没有 `CLAUDE.md`），它比原判据更严，还能抓出「模块建了但地图
     从没写」这种此前完全看不见的缺陷。`supabase/CLAUDE.md` 例外，因为它的事实层
     是表索引而非 Key files —— 这条例外是**先拿真仓库量出来的**，不是假设。
  3. **`validate_specs` 把「规格目录被删」和「那个路径是个文件」拆开了**。前者
     合法，后者是畸形；此前同一个 `continue` 把两者一起吞了。

- ~~`test-integrity.yml`：找不到 red anchor 时 `exit 0` 直接放行~~ →
  **已翻转（BUG-012）**：无 red anchor 且 PR 改了测试文件时报错（需 red-anchor
  提交或 `test-amended` 标签）；未改测试则仍放行。
- ~~`check_rls_enabled.py --audit || true`：存量 RLS 缺口永不阻断~~ →
  **已翻转（BUG-012）**：`audit()` 有缺口即 `exit 1`，doc-sync-check 去掉
  `|| true`（前提 BUG-009 已补齐 57/57，无存量缺口）。
- **finding 8（BUG-012）**：`test.yml` unit job 的 `if src==true` 路径门让
  docs/migration-only PR 跳过 vitest+verify_ac_coverage（#44 类漏红）→ 改为 unit
  **恒跑**（横跨 vitest workspace）。
- ~~测试文件 glob 漏掉 46 个 pgTAP、7 个 Deno、8 个 Playwright 测试~~ →
  **已关闭（BUG-013 / chore 3 PR-B）**：单一清单 `ops/rules/test-manifest.json`
  被 test-integrity amendment-guard 与 vitest include 共用（第三个消费者
  `verify_ac_coverage` 已随 FEAT-026 退役）;
  amendment-guard 现按清单**全部层**（pgTAP/Deno/Playwright + unit）的 `:(glob)`
  pathspec 监视,改任一层测试都需 red-anchor 或 `test-amended` 标签。
- ~~`check_guard_liveness.check_interpreter_prefix`：配置文件不在盘上时
  `continue` 跳过，该检查可以「一个都没查」却让 `main()` 打印 OK~~ →
  **已翻转（FEAT-026 相 2）**：缺失即 `::error` + `bad = 1`，与同文件
  `check_exec_bits` 的 `seen == 0` 先例一致。该 `continue` 原本只在
  `HOOK_CONFIGS` 含幻影条目（`.agents/hooks.json` 从未存在）时才说得过去；
  镜像层退役后只剩一套真配置，容忍缺失就等于自我中立化。**这正是
  RULE-004 退役记录里引用的那个病灶**，若留着不修，就成了「一边把某个
  病灶写成退役理由、一边在自己身上留着同一个病灶」。由相 2 的独立评审抓出；
  同期补上 `scripts/tests/test_check_guard_liveness.py`（此前**零自测**，
  而这正是 AC-8 只查「suite → guard」不查反向所致 —— 反向断言同期补齐）。
- **未翻转、已记账（FEAT-026 相 2 发现，两处均在 `check_workflow_lockfile`）**：
  ① `check_changed` 在**仓里没有任何 lockfile** 时打印「nothing to enforce」并
  返回 **0** —— 按本规则属 fail-open。可达性低（本仓恒提交 `pnpm-lock.yaml`，
  只有坏 checkout 会走到），故本相只断言该分支必须**发声**，**刻意不钉退出码**，
  以免将来的 fail-closed 修复看起来像回归。② PR **删除**一个 workflow 时，
  `check_version_pins` 无 `is_file()` 保护即 `read_text()` → 抛
  `FileNotFoundError`（两个兄弟函数都有该保护）。这是 fail-**hard** 不是
  fail-open，不违反本规则，但对「删掉一个 workflow」这种正当操作是个费解的红；
  一行可修，但「删除的 workflow 算 no-op 还是算错」是 spec 决定，留待谁先需要谁定。
  两处均由新增的 `scripts/tests/test_check_workflow_lockfile.py` 实测确认。
- **finding 9（BUG-017）**：同一个 amendment-guard 的**比较范围**错了两处 ——
  红锚点用 `git log | tail -1` 取到**最旧**匹配（`git log` 从新到旧），且 diff 用
  两点 `RED..HEAD` 把红锚点之后 `git merge main` 带进来的测试改动也算成改测试。
  在 stacked 相位分支上（#75：26 提交 / 5 相 / 4 个红锚点）报出 ~50 个文件而真实
  命中仅 1 个 → **这是伪装成噪音的 fail-open**：98% 是噪音的清单会训练所有人不读
  就打 `test-amended`，等于把 BUG-012 刚翻转的门变成橡皮章。已修：判定逻辑从
  内联 bash 提取到 `scripts/check_test_amendments.py`（最新红锚点 + `--topo-order`
  + 与 PR 相对 base 的净改动取交集），并加反向 fixture 自测接入 workflow
  （守卫先证明自己活着）。

## 缘由（born from）—— 增补的第三条：判定逻辑不可测（同机制 ×2）

`ci` 模块内同机制两发，但**机器聚类抓不到**：BUG-010 归 `validation-missing`、
BUG-017 归 `config-error`，`(module, root_cause_category)` 分到两个桶。两者的
真实共同点是**判定逻辑写在没有测试的 workflow bash 里**，而且两次的修复动作
一模一样 —— 抽成 `scripts/*.py` + 反向 fixture：

- **BUG-010**（ci / validation-missing）：core-table-guard 是 test-integrity.yml
  里的内联 `grep`，逐行且只认 4 个前缀动词，静默漏掉 `DELETE FROM` /
  `TRUNCATE` / `CREATE INDEX|POLICY ON` / `GRANT … ON` / 跨行 `ALTER TABLE` ——
  每一种都能让一次 T1 core 表改动绕过 `cto-approved` 门。事故记录原话：
  「守卫**没有任何测试**，这个洞一直不可见」。
- **BUG-017**（ci / config-error）：test-amendment-guard 的内联 bash 用
  `git log … | tail -1` 取到**最旧**红锚点（`git log` 从新到旧），又用两点
  `RED..HEAD` 把 `git merge main` 带进来的测试改动算成改测试。在 stacked 相位
  分支上（#75：26 提交 / 5 相 / 4 个红锚点）报 ~50 个文件而真实命中 **1** 个。
  危害不是吵：**98% 是噪音的清单会训练所有人不读就打 `test-amended` 标签**，
  等于把 BUG-012 刚翻转的 fail-closed 门变成橡皮章 —— fail-open 换了个形态。
  事故自己写下的规则候选就是本条：「任何 CI 守卫的判定逻辑不得内联在 workflow
  的 bash 里，必须落在带自测的脚本中（BUG-010 + BUG-017 已构成同根因 ×2）」。

**本规则早已为这次升级留好了口子**：下方「不可机器化残余」原文写着「若同族再犯，
升级为 workflow lint」。BUG-010 + BUG-017 就是同族再犯，故本次兑现该承诺。

实测证据（reflect-2026-07-26 实地清点，非推测）：**4 个** workflow 调用的脚本零自测
—— `validate_backlog.py`、`validate_incidents.py`、`validate_maps.py`、
`validate_specs.py`。**其中两个正是校验 reflect 自己输入的脚本** —— 本报告聚类
所依据的事故台账、以及 spec 三件套完整性门 —— 都由无人测试的代码把关。另有
**3 个** workflow 步骤自行检视并自行判定（doc-sync-check 的 same-PR 规则与重复
spec ID 扫描、test.yml 的迁移头扫描）。

> **[2026-07-30 更新，FEAT-028 相 1]** 上面那 4 个已归零：四个 `validate_*.py`
> 各得一份反向夹具套件（`scripts/tests/test_validate_*.py`，84 例，覆盖每一条
> `::error` 分支 + 真实仓库零误报），`guard-testability-allowlist.txt` 的
> `untested-guard:` 段随之清空，`test_test_manifest.py` 的守卫→套件棘轮同步从
> `check_*.py` 拓宽到 `check_*.py + validate_*.py`，所以这一段不会再长回来。
> 上方 2026-07-26 的清点数字保留原样 —— 那是当时的实测，不是现状。
> **本条规则的 fail-closed 语义仍有存量缺口**：这四个校验器在"要检查的产物
> 根本不存在"时仍然 exit 0（missing backlog / index.yaml / 全部地图 /
> `ops/specs`），与本规则正面冲突。FEAT-028 刻意只钉住不翻转（先建网，再动
> 每个 PR 都要跑的守卫），翻转归 FEAT-026 相 3；夹具已备好，改期望值即为红锚。
> 另外 `validate_backlog.py` 的两条分支是**崩溃而非判定**（相位写成标量、
> `depends_on` 写成标量，均在 `:97` 抛异常，收集到的 `::error` 随栈丢失）——
> 由这批夹具首跑发现，登记为 FEAT-028 相 2。

**开工时是 5 个，其中最尖锐的一个在本 PR 在飞期间被还掉了 —— 而这恰好是本条规则
第一天就触发的实证。** `backlog_close.py`（写 backlog `done` 的那个机器）当时零
自测且已误动作约 10 次；BUG-006 的修复（#89，2026-07-26 合入）补上了
`scripts/tests/test_backlog_close.py`。于是本 PR 白名单里那行 `untested-guard:`
**当场变成"已修好却还留着的豁免"**，被新增的反向 ratchet 判红，逼着本 PR 摘掉它 ——
这正是该 ratchet 存在的理由（防白名单腐烂成永久豁免），只是没料到它在合入前就先
考了自己一次。同期 #89 新增的 `check_backlog_done_authorship.py` 自带自测、其
workflow 步骤也委派给脚本，**两条新检查均放行**，是零误报的又一个真实样本。

## 强制 / 升级

当前阶梯：`ci-check`（hook 活性 + 判定可测性均为机器；fail-closed 语义部分仍留
prose，靠 chore 逐个翻转存量 fail-open 点）。

- 本 PR 机器件：`scripts/check_guard_liveness.py`（接入 doc-sync-check
  mechanical-checks，阻断式）——
  1. 所有 tracked hook `*.sh` 的 **git mode 必须 100755**（BUG-003 防回归；
     Windows checkout 不可信，断言的是 git 内的 mode）；
  2. harness 配置里的 hook 命令必须以显式解释器（`bash <path>`）调用
     （BUG-003 遗留的 belt-and-braces 建议，本 PR 同时落地
     `.claude/settings.json` 的改造）。**当时是三套配置**
     （`.claude/settings.json` + `.codex/hooks.json` + `.agents/hooks.json`）；
     后两者随 FEAT-026 相 2 的镜像层退役一并删除，现在只有一套
     —— 其中 `.agents/hooks.json` **从来不存在**，这个守卫长期在扫一条空路径
     （见 `ops/rules/RULE-004-mirror-parity.md` 的「退役」一节）。
- 已本地验证：裸路径命令被正确拦截（修复前 3 错），修复后全绿。
- **本 PR 机器件（reflect-2026-07-26，BUG-010 + BUG-017）**：同一脚本新增
  `check_guard_self_tests`（workflow 调用的 `scripts/*.py` 必须有
  `scripts/tests/test_<stem>.py`）与 `check_inline_verdicts`（`run:` 块不得
  自检视 + 自判定，除非委派给脚本）。**不新增 workflow 步骤、不新增 job** ——
  doc-sync-check 的 `mechanical-checks` 早已每 PR 跑本脚本，其自测循环也早已
  跑本脚本的 suite。存量债钉在 `ops/rules/guard-testability-allowlist.txt`，
  两种行式（`untested-guard:` / `inline-verdict:`），**双向 ratchet**：已记录的
  违例放行，**已被修好却还留着的豁免行报错**（RULE-003 先例，防白名单腐烂成
  永久豁免）；清单读不到 → fail-closed。
  自测 13 例接入既有 suite（23/23 绿），且在**真实仓库**上自证：摘掉
  `backlog_close` 与 test.yml 两行 → 两处如实报出 exit 1；给 `validate_maps`
  伪造一个 suite → 报出 stale exemption；完整清单 → exit 0，7 个 workflow /
  13 个脚本零误报。
- **刻意的假阴性偏向（如实记录）**：步骤词法分析是缩进式的、不是 YAML 解析器
  （`run:` 写成 flow scalar 就看不见）；只靠裸 `exit 1` 而不打 `::error` 的判定
  不报。两处都偏向**漏报**而非误报 —— 因为 BUG-017 记录的失效模式恰恰是噪音：
  一个吵的守卫会让人学会忽略它。宁可漏报，也不要制造一份没人读的清单。
- 不可机器化残余（prose）：新增守卫时 reviewer 检查"前提缺失分支是 error
  还是 exit 0"；`continue-on-error`/`|| true` 的白名单外用法仍靠 reviewer
  （FEAT-026 已定「删除而非降级」为原则，故此项压力下降）。

## 归置与审批

- 全局规则 + 新增 CI 检查 + 触及 `.claude/settings.json` → **CTO（T1）**。
  根 CLAUDE.md 一行由 reflect 报告 PR 统一落。
