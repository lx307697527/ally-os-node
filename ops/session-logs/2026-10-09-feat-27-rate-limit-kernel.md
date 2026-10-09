---
session_id: hand-written-27-rate-limit-kernel
branch: feat/27-rate-limit-kernel
date: 2026-10-09
reason: issue-27
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/27-rate-limit-kernel — 2026-10-09

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#27(反滥用:验证码、reCAPTCHA、机器人闸门与限流,phase-1)
  ——零评论完全未动工,本切片落**限流内核**(PG 固定窗口计数 + 认证面挂载 +
  拒绝台账 + 清理任务),PR 正文写 **Part of #27**(拦截可见面的页面与机器人
  检测随后续切片/表单域)。
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净——直接进选题。
- **选题**:优先级 ① 逐个核对评论里的未完成切片——#219 只剩「含义选择」
  (既定裁决:等真正的消费域)、#222 的 null-clear 修复切片**已于 #295 合并**
  (跨会话记忆过期,以 issue 评论为准)、#220/#221/#224/#226/#233 的剩余项全部
  压在外部门(#227/#229/#231/#206/#118/SMS 通道/通用面板)、#225 的模板管理
  切片压在 #128(未动工)。② phase-1 按编号:#22–#34 区间里 #22/#23/#25/#29/
  #30/#32 已有大切片且剩余项等切换日或业务域;#27/#28/#31/#33/#34 未动工,
  其中 **#27 是第一个自身可独立验收的**——限流内核不依赖任何消费域;#31 的
  验收绑老系统 12 处调用点替换(切换日)、#33 绑 RDS/恢复演练环境、#34 绑
  CloudWatch。故选 #27 切片 1。
- **claim**:`claim_issue.py claim --issue 27` 成功。
- **参考**:老系统 FEAT-019 phase 3(`20260804140000_*_p3_public_abuse_prevention.sql`)
  ——platform.rate_limits 固定窗口计数、request_client_ip 头信任规则、
  consume_rate_limit 原子消费;#232 §1.1「公开接口统一限流、honeypot、reCAPTCHA」。

### 本切片改动的文件

- `packages/db/src/schema.ts`:+ `rate_limit_counters`(PK = 标识四元组,窗口
  起点索引)+ `rate_limit_denials`(拒绝台账,deniedAt/identifier 索引)。
  Migration `0040`(expand-only,零既有对象改动)。
- `apps/api/src/security/rate-limit.ts`(新):`clientIpFromHeaders`
  (cf-connecting-ip → 最后一个 XFF 元素 → 不可归因;截断 100 字符、永不抛)、
  `windowStartFor`(epoch 对齐桶)、`consumeRateLimit`(INSERT..ON CONFLICT..
  UPDATE..RETURNING 原子计数判定)、`recordRateLimitDenial`(拒绝台账,
  best-effort)、规则册 `AUTH_RATE_LIMIT_RULES`(sign-in 30/5min、sign-up 10/h、
  password-reset 10/h、two-factor 10/5min)+ 背底 auth.other 300/5min、
  `authRateLimitMiddleware`(429 + Retry-After,body 只有 rate_limited)。
- `apps/api/src/app.ts`:中间件挂 `/api/auth/*` 会话门之前。
- `apps/worker/src/security/rate-limit-cleanup.ts`(新)+ `security/index.ts`:
  `rate-limit-cleanup` 每 10 分钟,计数器留 1 天、拒绝台账留 30 天。
- `apps/worker/src/index.ts`:securityJobs 登记。
- `docs/abuse-prevention.md`(新):切片地图 + 六条裁决 + 新面接入清单;
  `docs/cron-migration.md` A22 标记已落地。
- `vitest.config.ts`:hookTimeout 30s → 60s(判断层 7)。
- 测试:`apps/api/src/security/rate-limit.test.ts`(12:头信任矩阵、桶对齐、
  规则册矩阵、原子计数、**双实例共享窗口**、429 契约、拒绝台账、不可归因
  直通)、`apps/worker/src/security/rate-limit-cleanup.test.ts`(2:过期删除、
  活行保留)。

**验证**:`DATABASE_URL=… corepack pnpm verify` 全绿 135 文件 / 1415 测试
(+2 文件 +14,零 skip;本地 PG 真库集成)。本地库先 `db:migrate` 应用 0040。
session log:`ops/session-logs/2026-10-09-feat-27-rate-limit-kernel.md`。

## 判断层(手写)

1. **跨会话记忆要以 issue 评论为准**:记忆里「#222 有 null-clear 修复切片
   候选」实际已于 #295 合并(2026-10-07);若按记忆走会白占一个周期。选题的
   「剩余项核对」必须逐条读评论,不能信摘要——phase-1 八个配置工作室 issue
   的剩余项几乎全被外部门卡住,真正可做的藏在编号更小的 #22–#34 区间里。
2. **拒绝照计数,与老系统刻意相反**:老的限流器住在业务事务里,拒绝时回滚
   连增量一起吃,计数器停在阈值上;新实现计数自成一笔,超限继续累计。收益:
   窗口内真实到达量可查、denied 行的 count_at_denial 与计数器一致可对账;
   代价:无(超限请求反正都被拒)。这是「app 层限流器」与「事务内限流器」
   的结构性差异,不是偏好。
3. **不可归因 → fail open,收益比预想大**:沿用老 request_client_ip 的裁决
   (null 标识不计数,不造「unknown」共享桶)。落地后才发现这同时保住了全部
   既有测试——现有套件 POST /api/auth/* 都不带来源头,带共享桶的话它们会被
   计入同一把钥匙、互相耦合甚至互相打出 429。fail open 在生产拓扑(ALB/
   Cloudflare 必留 XFF)下不打开缺口,只在部署头配置断掉时退化——那是部署
   要修的事,不该由 429 来暴露。
4. **限流器错误不静默吞,但拒绝台账写失败只告警**:计数器是闸门,挂了让
   异常冒泡(onError 兜 500)——认证端点本来就依赖同一数据库,「装作没限制」
   才是谎报;台账是遥测,写失败改判 429→放行是把遥测错当闸门的倒置。两个
   失败路径两种姿态,写进了代码注释与 docs。
5. **2FA 单独收紧是本切片最「值钱」的一条规则**:背底 300/5min 对 TOTP 六位
   码的暴力空间形同虚设(百万级码空间 × 每窗口 300 次 = 可行的攻击节奏);
   10/5min 对反复看错时段的真人绰绰有余。规则册按面分动作而不是一刀切,
   正是为了让这类面级差异可表达。
6. **坑:块注释里写 cron 字面量**。worker 登记文件的注释里写了(`*/10`),
   `*/` 把 JSDoc 提前终止,报「Unterminated template literal」——错误位置和
   真实病因隔了一个注释块。cron 表达式进注释要么加空格 `* / 10` 要么改说法。
7. **坑:本地库要先 db:migrate**。集成测试 42P01(表不存在)不是代码错,
   是主本地库还没应用 0040;临时库套件自己跑迁移,共享库套件依赖手工迁移。
   首次落新表的切片在本地要记得这一步。
8. **hookTimeout 30s → 60s,同一裁决的第二次兑现**:全量并发下临时库
   teardown(drop database)偶发超 30s,且两轮全量失败的是**不同**套件
   (effect-digest、rules)—— Flake 特征是「漂移的失败者 + 1415/1415 全过 +
   单文件复跑 3 秒绿」。vitest.config 里的注释记录了 #221 加临时库文件后从
   10s 提到 30s 的同一先例;测试文件总数再 +2,把窗口提到 60s,不为环境抖动
   改任何业务代码。
9. **多实例验收的证法**:「两个 createApp 实例 + 同一个连接池」交替发请求,
   30 个全部 200、第 31 个无论打在哪个实例上都 429——这是部署里两台机器的
   最小替身,比 mock 两个「计数器视图」有说服力;也顺带钉死「实例间没有各自
   的 30」这句验收语言。
