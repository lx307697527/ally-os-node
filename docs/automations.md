# 自动化规则引擎（#224）

老系统把业务连锁反应写在**数据库触发器**里（#134 清单的 38 个）和约 30 个
pg_cron + pg_net 定时任务里（#32）：逻辑分散在 887 个迁移文件与线上
`cron.job`，看不见、难测试、改一条要发迁移。新设计（#232 §4.4「自动化规则」行、
§4.9 v2.2 实现选型）统一成 **「触发 → 条件 → 动作」的可配置规则**：规则是数据
不是代码，动作由后台作业（pg-boss）执行，每次执行留日志——参考 Odoo 的自动化
规则模型（触发 → 过滤条件 → 动作），刻意不引入 n8n（把核心业务连锁反应放进
可视化编排，会重演老触发器「看不见、难测试」的问题）。

## 已落地：自动化内核（#224 切片 1，事件触发 + 两个内核动作）

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 形状与纯引擎 | `packages/automations/src/index.ts` | 规则 spec 的 zod（trigger / conditions / actions，**API 保存时校验与 worker 运行时解析共用同一份**，两端不长两套形状）+ 纯求值：`eventMatchesTrigger`、`resolvePath`（点路径只穿普通对象，原型链键到不了）、`evaluateConditions`（AND，全过才放行）。包零依赖（只有 zod），api 与 worker 各自引入 |
| 数据模型 | `packages/db/src/schema.ts`（migration `0017`） | `automation_rules`（trigger/conditions/actions 三段 jsonb + enabled + version = #226 台账版本 + createdById）、`automation_runs`（一次执行一行：status `pending`/`skipped`/`succeeded`/`failed`、逐条件结果、逐动作结果、error；(rule_id, source_event_id) 唯一约束是扫描窗口重叠的防重发闸；**规则删除后 run 仍在**——rule_id SET NULL + rule_name 快照，执行日志是观测面不随配置消失） |
| 路由 | `apps/api/src/routes/automations.ts` | 规则 CRUD + 执行日志读面（`GET /api/automations/runs`，最新在前，可按 ruleId/status 过滤），全部在 `automations.configure` 权限点后。spec 整体替换不局部合并；每次真实变更（改名/启停/换 spec）经配置版本台账（#226）
记一版并留审计，无实效变更幂等返回现状（不记账不留审计） |
| 权限点 | `authz/permissions.ts` | `automations.configure`（owner/admin 默认）：新增一条规则 = 改全公司的连锁反应，属配置工作室；runs 的查看也在此点后（运行记录含收件人名单与业务事件细节，不另开读口） |
| 扫描器 | `apps/worker/src/automations/scanner.ts` | `automation-scan` 任务（每分钟）：90 秒审计事件尾窗 × 启用规则 → 触发命中（审计 action 精确匹配）→ 条件求值 → 插 run 行（条件不过 = `skipped`，不发执行任务）；重叠窗口的重复命中靠唯一约束吸收。兼任滞留清障：pending 超 2 分钟重发执行任务（singletonKey 去重挡在途重复）、超 90 分钟终判 `failed`（执行任务 4 次尝试的最坏总时长 ≈ 66 分钟之外留余量） |
| 执行器 | `apps/worker/src/automations/runner.ts` + `actions.ts` | `automation-run` 任务：顺序执行动作，**每动作一个事务 + run 行 SELECT … FOR UPDATE**（并发处理器在行锁上排队，动作不双跑）；动作失败不终结 run——进度带外写回后向上抛，pg-boss 重试 3 次（60s 指数退避）每次告警，重试只补失败的那个动作（action_results 是幂等闸：动作行存在 ⟺ 该动作已提交） |
| 审计 | `docs/audit.md` 词表 | `automations.rule_created` / `rule_updated` / `rule_deleted`（配置面生命周期）。规则的**执行**不进审计——进 automation_runs；动作产物进各自域的词表（如 `task.created`，actor 带 `automation:<runId>` 前缀、detail.via = automation） |

## 已落地：due 触发（#224 切片 2，「日期字段 × 偏移」+ 独立到期扫描器）

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 触发形状 | `packages/automations/src/index.ts` | trigger 起为判别联合（`kind` 区分）：`event`（切片 1，审计 action 命中）与 `due`（`subjectType` + `anchorField` + `direction` before/after + `offsetMinutes` 5..129600，即「锚点日期前/后 N 分钟」，Odoo 的 based-on-date-field 触发）。两种触发同表同动作同执行日志，差别只在「谁发现它该跑了」。切片 1 的无 kind 旧形状不再收（规则是上线前数据，不留双形状） |
| due subject 注册表 | `apps/worker/src/automations/due-registry.ts` | 「哪张表、哪个日期列找到期时刻」只有属主域知道——与可签名 subject、评论可见性门同一裁法：内核接缝 + 属主域注册。`anchorFields` 是声明式白名单。第一个成员 **task（锚点 dueAt）**：只扫 open 任务、排除自动化自建任务（防环）。预约/会议（#207）进场时注册自己的成员 |
| 到期扫描器 | `apps/worker/src/automations/due-scanner.ts` | `automation-due-scan` 任务（每分钟）：due 触发的启用规则 × 「锚点 ± 偏移落在 [now-90s, now] 带」的 subject 行 → 条件求值（语境 = 注册方投影的行字段，包一层 `dueEventContext`，与审计事件同形状）→ 插 run 行（同唯一约束去重、同 `automation-run` 执行器）。fail closed：spec 坏 / subject 未注册 / 字段未声明 = 跳过并告警，不拖垮扫描 |
| 防环 | `apps/worker/src/automations/actions.ts` + due-registry | 自动化 `create_task` 产出的任务附着在规则行上（`subject_type='automation_rule'`，观测面「这条规则 spawn 过哪些任务」同源），task 成员不扫这类任务——「due 触发 → create_task(dueInHours)」若不设防会每 ≥5 分钟自增一条任务；同规则与跨规则链式自触发一并挡住，人工建的任务入口不受影响 |

### due 触发的关键裁决

- **(规则, 行) 一次性**：去重键 = `(rule_id, source_event_id)`（source_event_id = subject 行 id）。到期提醒对一条任务只响一次；**锚点改期不重报**（要支持需把锚点值纳入去重键，等真实域需求进场再议）。
- **不追停摆缺口**：到期时刻落在扫描带（90 秒）之外的不补——停摆期间错过的到期，恢复后不补发（与事件扫描器同一裁决；现在没有生产规则，追平机制是空转的复杂度）。
- **语境不写审计**：`task.due` 这类合成语境只活在 run 行与条件求值里——「到期时刻到了」不是一次业务变更（docs/audit.md 的纪律），执行日志在 automation_runs。
- **纯 wall-clock 触发刻意不做**：「每周一 9 点建盘点任务」这类无记录锚点的定时需求，归属是域定时任务（#32 对照表逐域登记 pg-boss cron）与 #225 Superset 的定时报表——自动化规则没有记录语境时条件无事可做，做了只是第二套 cron。等出现真实的无记录周期需求再议。

## 已落地：规则配置 UI（#224 切片 3，配置工作室 /system/automations）

- **一页三面**：规则列表（名称/触发摘要/条件数/动作摘要/启停/版本，可按文本、
  触发类型 event|due、启停状态过滤）+ 新建/编辑表单（trigger/conditions/actions
  结构化编辑器）+ runs 执行日志（状态过滤、「仅选中规则」开关、逐条件裁决与逐
  动作结果原样展示）；#226 版本史与一键回滚嵌在规则详情里。全部在
  `automations.configure` 后——没有公司级只读半边，无权限是整页答案。
- **保存即生效的文案纪律**：页面第一屏就说「保存即生效，没有发布开关」；编辑
  面区分「无实效变化（版本原地不动）」与「真变更（进台账）」（PATCH 幂等语义的
  UI 呈现）；删除走两段确认，文案明说「日志比配置活得久——删掉的规则执行记录
  仍在」。
- **开集 spec 不被 UI 悄悄毁掉**：trigger/action 是 jsonb 开集（新动作类型随属
  主域进场），UI 只结构化编辑本构建认识的形状（event/due 触发、eq/ne/in/exists
  条件、create_task/notify 动作）；**不认识的形状以原样 JSON 保存与编辑**
  （specToDraft 的 `kind:"json"` 旁路），列表摘要诚实说「not drawn by this
  build」——显示不装校验器，编辑永不静默销毁操作员看不见表单的部分。服务端
  zod 仍是唯一权威，客户端 buildSpec 只是把明显坏掉的提交挡在线下。
- **due 的 fail-closed 说在前头**：due 编辑器明说「未注册的锚点对能保存但永不
  触发，worker 会告警」，事件触发明说「条件只看得到事件的 action/target/actor/
  detail」——内核的裁决在配置面就有答案，不留到规则不跑时才被发现。

## 已落地：send_email 动作（#224 切片 4，#116 渠道层解锁）

- **形状**：`{ type: "send_email", config: { userIds(1..50), subject(1..200),
  body(1..5000) } }`，进 `packages/automations` 的动作 discriminated union——
  API 保存面与 worker 运行时同一份 schema，零 migration（动作是 jsonb 开集，
  扩展不改表）。runner 的分发随之改为穷举 switch：动作联合新进类型而执行器
  没接上时，编译期「使用前未赋值」直接挡住，不留运行期静默漏派的口子。
- **收件人是站内用户**（保存时点死的 uuid 列表，发送时按 id 解析账号邮箱）：
  自动化无人值守地发信，不给规则作者任意外部地址的入口——对外邮件是属主域
  写路径与 #237 营销邮件审批面的事。收件人被删 = 动作失败进重试/告警，不静默
  跳过（与 notify 收件人的 FK 约束同一裁法）。
- **传输走 `@ally/mailer`**（#116 渠道层，worker 引导时注入，与通知摘要同一
  实例）：未配 Resend key 时是日志模式，动作照样「成功」，本地开发从日志取信。
  老系统对应物是 comms 层的「传输只是接缝、内容是调用方策略」（Resend client
  从 integration-worker 平移时立的规矩）——新系统 mailer 就是那个接缝，自动化
  不再造第二套传输。正文是规则作者写的纯文本，转义成 HTML（BUG-285 的教训：
  作者写的东西进 HTML 前必须转义，规则名同判）、换行成 `<br>`，text 从 html
  推导，尾注署名规则名。
- **投递语义 at-least-once**（与铃铛「催」的 at-most-once 刻意相反）：信是
  真金白银的外部副作用，丢了比重复更糟。逐人一封（收件人之间不见地址）、顺序
  发送；部分收件人失败 = 动作失败进重试，已收到的重试后会再收到一封（窗口 =
  第一个失败点之前的收件人，含动作事务回滚的极端情形）。集成测试把这个裁决
  钉死（第一封成功、第二封失败、重试后第一人两封）。
- **邮件不写审计、不进通知表**：发送事实在 automation_runs 的 action_results
  （与 notify 的「通知行即台账」同裁）；收件人不吃通知偏好——通知偏好轴
  （#116）管的是通知域的分渠，send_email 是规则作者的直接点名，不走摘要。

## 已落地：send_webhook 动作（#224 切片 5，出站 webhook 与 SSRF 闸）

- **形状**：`{ type: "send_webhook", config: { url, method(POST/PUT/PATCH，默认
  POST), headers?(≤10 个，RFC 7230 token 名、值禁 CR/LF/NUL、每个 ≤1024 字符),
  body?(任意 JSON) } }`，进共享 discriminated union——零 migration、零新路由、
  零新 env。payload 是保存时点死的静态 JSON，**不做模板插值**：语境数据进负载
  是条件积木/模板切片的事，本动作只忠实投递作者写的内容；接收方区分不了来源
  是作者的设计（要带就自己在 headers/body 里带）。
- **SSRF 三道闸，全部 fail closed**：自动化无人值守地发请求，端点绝不能是内网
  ——worker 所在网络里 169.254.169.254（云元数据）、数据库、内部服务都在私网
  段上，「触发 → webhook」规则不设防就是一条把内网当靶子的通路。
  1. **保存时**（`packages/automations` 的 url refine）：https-only（负载可能带
     密钥，出站一律加密）+ 公网形状——IP 字面量过私网段检查（0/8、10/8、
     100.64/10 CGNAT、127/8、169.254/16、172.16/12、192.168/16、198.18/15、
     `::1`、`::`、fc00::/7、fe80::/10、`::ffff:` 映射地址查内嵌 v4；WHATWG URL
     的 IPv4 规范化让十六进制/十进制变体到不了这里），域名挡 localhost 家族与
     `*.local`/`*.internal`；
  2. **执行时复查**（executor）：spec 可能早于闸的收紧或被手工改库——url 原样
     再判一遍（其下还有 loadRuleSpec 的防呆 parse，坏 spec 直接终判 failed）；
  3. **DNS 复查**（executor）：公网域名解析出的全部地址逐个过同一张私网表——
     「公口域名」不等于「公网目标」，解析出一条私网答案就是一条私网通路，一个
     包都不出网。已知残余：DNS rebinding（两次解析答案不同）不在检查范围，
     接出口代理时收口。
- **传输裁决**：`redirect: "error"`（重定向能把过闸的 url 带去没过闸的目标）、
  `AbortSignal.timeout(10s)`（挂死的端点不能拴住 worker——动作在 runner 的
  事务里跑，行锁在等它）、非 2xx = 失败进重试、失败说明只取响应头部的有界字节
  （2 KB 读上界即取消流 + 200 字符截断，任意第三方端点不能靠超大响应耗内存）。
  headers 里的密钥存在规则配置里（配置行本就是 trust boundary），但**绝不进
  action_results 的 error**——错误消息可被规则读者看到。
- **投递语义与 send_email 同裁 at-least-once**：对端已处理但响应 5xx/超时 =
  重试会再投一次（重复窗口 = 第一个成功响应之前的每次投递，含动作事务回滚的
  极端情形），集成测试钉死（500 后 200，接收方共见两次投递）。
- **不写审计、不进通知表**：与 send_email 同裁，执行事实在 automation_runs 的
  action_results。
- **UI**：配置页动作选择器/编辑器/ActionCard 各进 send_webhook 结构化分支；
  编辑器第一段把目标裁决（https 公网、保存与执行两道闸）与投递语义
  （at-least-once、payload 无模板）说在前头；headers 编辑是「Name: Value」
  每行一条，密钥提示明说「存在规则配置里、不进运行错误」。

## 关键裁决

- **触发统一为「审计事件 action 精确命中」（event）/「日期字段 × 偏移」（due，
  切片 2）**：新建（`task.created`）、字段变化（域事件 detail 带 from/to，条件对
  `detail.to` 断言）、进入阶段（`workflow.state_changed` + 条件 `detail.to`）在
  event 触发下是同一种触发；due 触发见上节。
- **事件源 = 审计流（#29 audit_events）**：审计流是「一次业务变更一行」的既成
  事实（活动流 #264 是它的第二个读者，自动化是第三个），不为自动化再造事件
  总线。含义：**域逻辑要触发自动化，就必须写审计**——这本来就是 docs/audit.md
  的纪律，不是新增负担。
- **回路防护**：自动化动作产物（actor `automation:<runId>` 前缀）不进匹配——
  「规则触发规则」会在一个窗口内连环爆炸。规则触发规则如确有业务需要，等条件
  积木显式表达，不给隐式通路。
- **执行在 worker、不在 API**：动作由 pg-boss 执行（重试、告警、观测与现有
  runner.ts 同一套），API 只开配置与读面。动作实现随 worker 进场（建任务、发
  通知是内核动作；邮件、webhook 已落，短信/AI 步骤随所属域切片注册新的动作
  类型——spec 是 discriminated union，扩展不改表）。
- **扫描尾窗 90 秒，不追停摆缺口**：服务停摆超过窗长的事件本切片不补（游标
  硬化留待切换期随首批真实域任务一起评估——现在没有生产规则，追平机制是空转
  的复杂度）。
- **动作配置保存时收口**：与 workflow 积木「只校验名字」不同，自动化动作的
  config 是内核定义的（不是属主域注入的），zod 在 CRUD 时就拒绝坏形状——
  「不改代码新增规则」的入口不能带病入库；worker 运行时再 parse 一次是防呆
  （手工改库、未来导入），坏了终判 `failed`（error = rule spec is invalid）。

## 验收对照（#224）

- [ ] #134 中需要移到应用层的逻辑都用规则实现，并有测试 —— **后续切片**（逐域
      迁移；event/due 两种触发、条件、动作的形状已备好，预约 #207 进场时注册
      due subject 即得「会前 N 小时提醒」）
- [x] 每条规则的执行记录可在后台查看（runs 读面 + automation_runs 全量留痕），
      失败会重试（pg-boss 3 次指数退避）并告警（每次失败尝试都进 runner.ts 的
      告警通道；重试耗尽由扫描器终判 failed）
- [x] 不改代码即可新增一条「进入阶段 → 建任务 + 发通知」的规则并生效（API 建
      规则 → `workflow.state_changed` + 条件 `detail.to` → 扫描命中 → 建任务 +
      双通知，worker 测试端到端覆盖）；due 触发同理（「任务到期前 1 小时 →
      通知」，due-scanner.test.ts 端到端覆盖）

## 剩余项（#224 保持 open）

1. 动作类型扩展：事务短信（等 SMS 通道进场；邮件、出站 webhook 已落，见上节）、
   改字段、报名序列、AI 步骤
2. 条件积木复用 workflow 的注册表形态（跨对象条件、自定义字段条件——
   custom_field_values 按字段键查询已备好）
3. 规则效果度量（触发/例外/越过计数，§4.8 周报）与 #233 规则注册表的接驳
4. #226 配置版本化：台账与草稿发布已进场（每次真实变更记一版、可回滚、可存
   草稿一键发布，见 docs/config-versions.md）；规则配置 UI 已落地
   （/system/automations：列表/新建/编辑/启停/删除、runs 执行日志、版本史与
   一键回滚）；草稿发布面暂未接 UI（直改即生效已覆盖当前需求，草稿面随第一
   个真实「先审后上」需求进场）
5. due 触发的后续深化（等真实域需求）：锚点改期重报、通知收件人按行字段
   解析（如「提醒经办人」）、更多域注册 due subject
