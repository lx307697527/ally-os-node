---
rule_id: RULE-006
scope: global
ladder: prose           # 目标 ci-check —— 见「强制 / 升级」，机器已半成
status: proposed        # T1/CTO 待批：全局规则 + 需动根 CLAUDE.md
born_from: [BUG-020, BUG-021, BUG-025]
created: 2026-08-03
last_triggered: null
---

# RULE-006: 测试与守卫必须**构造**它需要的环境，绝不继承宿主机的那一份

## 规则

守卫及其自测不得让宿主机提供任何影响判定的环境属性（编码、`PATH` 内容、时区、locale）——
必须在 fixture 里显式构造；一条"只在某类机器上才通得过"的断言等于没有断言。

## 缘由（born from）

- **BUG-020**（harness / config-error）：守卫脚本的 `_git()` 一类辅助函数让**字符编码**由环境
  隐式决定（Windows ANSI codepage），于是解码在中文路径/输出上崩。根因原文自己写道：
  "正是 RULE-001 那条『依赖自动发现/隐式布局的东西必须补显式配置』的形状，只是这次隐式的是
  **字符编码**而非工具链布局"。
- **BUG-021**（harness / config-error，`recurrence_of: BUG-020`）：`HookFixture.path_value()`
  把 fixture 自己的 fake bin 拼在**继承的 `PATH`** 前面，于是"serena 缺席"这条前置**要求宿主机
  从未装过 serena**。凡是照文档跑过 `uv tool install serena-agent` 的机器，该 suite 必红，
  且根本走不到被测分支。**它只在 CI runner 上绿 —— 也就是只在没人会手跑它的地方绿。**
- **BUG-025**（harness，**至今 open**）：`test_write_session_log.py::test_date_is_local_not_utc`
  在 Windows 上必错，因为断言依赖**进程时区**。这是同一张处方第三次出现，且是唯一一次
  没被应用 —— backlog 里那条待办写的正是"用 `zoneinfo` 构造固定时区做转换，不改进程 TZ"。

三起、三条不同的轴（编码 / PATH / 时区）、一个机制：**把该自己钉死的值交给了宿主机**。

## 为什么现有规则盖不住

- **RULE-001**（toolchain consistency）的 scope 是"自动发现/隐式布局"的**工具链**，其机器
  （`check_workflow_lockfile`）看的是 workflow 与 lockfile 的版本钉法 —— 它**看不见测试的
  hermeticity**。硬把这条轴塞进 RULE-001，会让一条已毕业到 ci-check 的规则退回到部分靠散文，
  这个取舍本报告刻意写明，避免它默认发生。
- **RULE-002**（guards fail closed）管的是守卫**判定的方向**（缺前置须报错、判定逻辑须可自测），
  不管**判定所处的环境从哪来**。BUG-021 的 suite 完全 fail-closed，它只是在错的机器上 fail。

## 强制 / 升级

当前阶梯：`prose`。**这条能上 `ci-check`，而且机器已经半成 —— 这是它值得立规的主要理由。**

BUG-021 的修复已经建了 `scripts/hermetic_path.py` + `scripts/tests/test_hermetic_path.py`：
一个"交给被测子进程的 PATH"的显式构造器。升级路径：

1. 把 `hermetic_path` 的契约从 PATH 扩到另两条已知轴 —— 显式编码（`encoding=` 一律不省）
   与显式时区（`zoneinfo`，不改进程 TZ）。
2. 加一条断言：`scripts/tests/` 下任何 fixture 若要构造子进程环境，必须经该模块，
   不得裸读 `os.environ.get("PATH")` / 裸调 `subprocess` 而不指定 `encoding`。
   这是路径与标识符层面的事实，与 FEAT-026 划的那条线同侧（不断言散文）。
3. 那条断言天然就是 BUG-025 的红锚 —— 先红，再修，顺手关掉那个 open 项。

落地即 `ladder: ci-check`，并按纪律从根 `CLAUDE.md` 删除本条散文、替换为
"enforced by CI: `<check-name>`"。

## 归置与审批

全局规则 + 需在根 `CLAUDE.md` Global conventions 增一行 + 附带 CI 检查 → **CTO（T1）**。
提出于 2026-08-03 的 reflect 运行（无人值守 Routine），因此**只落了本提案文件，没有改根地图**
（硬约束 5：tier 压 autonomy）。批准后 root budget 由 10/15 变 11/15，无需退役任何规则。
