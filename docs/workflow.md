# 流程与状态机（#220）

老系统的阶段流转全是「SQL 迁移里 frozen 边表 + TS 硬编码镜像 + parity 测试」
三件套，改流程要发版：线索 10 态（`crm.change_inquiry_status` 边表，转
qualified/disqualified/waitlisted 强制带理由）、生产 12 相位
（`advance_job_phase`，前置未完成不得跳步、gate 相位不可直接推进）、订单 6 态、
发票 7 态 12 边（`billing.invoice_transition_allowed`）、样品 5 态、商机 4 态
（只允许 value-chain 写入器改）……全仓库没有任何可配置流程的表或引擎。

新设计（#232 §4.4/§4.9）把流程做成**配置工作室的一种可配置对象**：XState v5
的 JSON 定义按 subject 类型存成模板，服务端只用它计算「当前状态 + 事件 →
下一状态」，结果写数据库；门槛和进入后动作按名字引用代码里的**条件积木、动作
积木**（业务事实必须在代码里实现并有测试，流程 JSON 只组合名字）；@xstate/graph
在保存时做可达性验证、在测试里枚举全部路径生成接口测试（#212 系统验证证据的
形态）。表结构参考 ERPNext 工作流（状态 + 流转 + 允许角色 + 条件）。

## 已落地：流程内核（#220 切片 1，API only）

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 数据模型 | `packages/db/src/schema.ts`（migration `0013`） | `workflow_templates`（subject 开集 text + templateKey 唯一 + productType/isDefault 选择维度 + definition jsonb + version = #226 台账版本）、`workflow_instances`（一对象一实例唯一索引 + **definition 启动时刻快照** + currentState/stateEnteredAt/stateDueAt）、`workflow_transitions`（历史，**append-only 触发器**，与 audit_events/esign_signatures 同一裁决） |
| 引擎 | `apps/api/src/workflow/engine.ts` | zod 模板 schema（流转收 XState 字符串简写与对象两种形态）→ 拓扑语义校验（initial/target/自环）→ XState 结构校验 → @xstate/graph 可达性；`applyWorkflowEvent` 用无驻留 actor 算「当前状态 + 事件 → 下一状态」；超时 `timeoutAfterHours` 在进入状态时一次算成 stateDueAt |
| 积木注册表 | `apps/api/src/workflow/blocks.ts` | `registerConditionBlock`（门槛）/`registerActionBlock`（进入后动作）——属主域切片注册；#220 切片注册表为空，第一个成员 `approval.passed` 随 #221 进场（审批作为流程门槛）；模板保存时对注册表做存在性校验，运行时门槛缺失 fail closed（422 gate_unavailable） |
| subject 注册表 | `apps/api/src/workflow/registry.ts` | `registerWorkflowSubject(type, { load })`——属主域给出「记录存在吗 + 产品类型」；线索/商机/订单履约/偏差都在 phase-2+，第一个属主域进场注册 |
| 服务 | `apps/api/src/workflow/service.ts` | `startWorkflow`（模板解析：产品类型精确命中 → 默认模板 → 409 无模板；并发双启动按唯一索引幂等）、`applyTransition`（角色 → 理由 → 门槛 → **乐观并发控制**（CAS 当前状态）→ 历史行 + 审计行同事务；进入后动作提交后执行、失败不回滚流转）、`findDueInstances`（超时扫描的内核半边） |
| 路由 | `routes/workflow-templates.ts`、`routes/workflow-instances.ts` | 模板三端点在 `workflow.configure` 权限点后（owner/admin 默认）；实例读/推/历史在可见性门后（subjects/registry.ts，与评论同扇）。**实例启动不开 HTTP 面**——它是属主域创建业务记录时的进程内调用 |
| 权限点 | `authz/permissions.ts` | `workflow.configure`：改流程 = 改全员的工作方式，配置工作室归 owner/admin；**推进**不在此点后——能推谁由可见性门 + 模板 roles 裁决，内核只守「纯 customer 角色不可推进」的地板 |
| 审计 | `docs/audit.md` 词表 | `workflow.template_created` / `workflow.instance_started` / `workflow.state_changed`（detail 带 from/to/note） |

## 模板 JSON

```jsonc
{
  "initial": "new",
  "states": {
    "new": {
      "timeoutAfterHours": 48,                    // 超时提醒基准（进入状态时算成 state_due_at）
      "on": {
        "CONTACT": "contacted",                   // XState 字符串简写
        "ESCALATE": {                             // 对象形态：约束全在流转上
          "target": "escalated",
          "roles": ["sales_lead"],                // 允许角色（app_role 闭集；缺省 = 可见者中的员工）
          "requireNote": true,                    // 人工推进必须带原因（老 feat056 理由门的内核化）
          "gates": [                              // 进入门槛 = 具名条件积木，全部通过才放行
            { "name": "contract_signed", "config": { "withinDays": 30 } }
          ]
        }
      }
    },
    "contacted": {
      "entryActions": [{ "name": "notify_owner" }] // 进入后动作 = 具名动作积木（提交后执行）
    },
    "escalated": {}
  }
}
```

引擎约束（保存时拒绝）：状态名 `lower_snake_case`、事件名 `UPPER_SNAKE_CASE`、
initial/target 必须是已定义状态、**自环流转不收**（XState 外自转移会重入本状态，
「状态值不变」与「事件未被接受」在服务端无法区分）、全部状态必须从 initial 可达、
roles 取 app_role 枚举、引用的积木必须在注册表里。

## 失败语义（fail closed 的层次）

1. 事件不在当前状态的允许流转里 → 422 `event_not_allowed`；
2. 流转限了角色而调用者不持有 → 403 `role_required`（内核地板：纯 customer
   角色永不通过）；
3. `requireNote` 而原因为空白 → 422 `note_required`；
4. 门槛积木判定不通过 → 422 `gate_failed`（带积木名）；积木未注册 → 422
   `gate_unavailable`（代码回退/注册表漂移时宁可停住）；
5. 并发推进抢输 → 409 `concurrent_conflict`（CAS 当前状态，不覆盖别人的流转，
   输家不落历史行）；
6. subject 类型未注册 400 / 记录不存在或不可见 404（反探测，同答 404 语义见
   subjects/registry.ts）。

## 刻意不在这切片里的（#220 保持 open）

- **超时提醒的投递**：`findDueInstances` 只回答「谁到期了」；「提醒负责人怎么
  送」等第一个有负责人的属主域 + #116 通知渠道层，届时以定时任务接上。
- **第一张真实模板与第一个注册的 subject**：线索（#227）/商机（#227）/
  订单履约（#231）/偏差（#243）各自进场时注册加载器、带种子模板。
- **配置版本、审计与发布（#226）**：台账已进场——模板创建即记 v1，版本史/
  差异可读（docs/config-versions.md）；定义尚无就地改写路径（替换仍是「停用旧行
  + 新键」），回滚对该族答 409，定义改写端点进场时同步补 applyRevision；
  draft → 发布流与受监管变更控制门是 #226 后续切片。
- **后台流程图 / 模板编辑 UI**：从定义自动生成流程图随配置工作室前端进场。
- **@xstate/graph 全路径接口测试作为 #212 验证文件**：形态已在
  `workflow/engine.test.ts`（全路径枚举 + 全矩阵拒绝），逐模板导出随 #212。
