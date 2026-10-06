---
session_id: hand-written-116-notify-channels
branch: feat/116-notify-channels
date: 2026-10-07
reason: issue-116
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/116-notify-channels — 2026-10-07

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#116 正文「统一的通知服务:写库、实时推送、按用户偏好发邮件或
  Slack,一处调用多渠道送达」+ #232 §11「应用内实时、邮件摘要、Slack,每人可选
  渠道」。#116 的两条验收(实时出现 / 已读跨设备同步)已由 #259 / #263 满足,
  剩余的正是**渠道层**——本切片落「偏好 + 首渠道(邮件摘要)」。PR 正文写
  Part of #116(Slack 渠道随 #115、摘要深链随共享 face 包,都还没进场)。
- **前置收尾(第 0 步)**:open PR #280(#233 决策表)CI 首跑红(terraform
  下载 EOF 抖动 + worker rules.test 一条断言顺序翻车);分支上已有拥有会话推的
  排序修复提交,第二次 run 四项全绿。**拥有会话(租约活到 18:35Z)自己完成了
  合并+双 issue 成果评论+租约释放+worktree 清理**——我的 shell 正坐在那个
  worktree 里,被连坐杀死(spawn ENOENT,cwd 已删);按 gotcha #89 用子 agent
  重建被删目录恢复 shell,核对合并态后结束第 0 步,未重复合并、未重复评论。
- **选题**:规则①(评论里有未完成切片的 issue 优先)。#116 是记忆里点名的
  最大解锁器——#110 邮件摘要、#113 邮件通知、#220 超时送达、#221 多级扇出
  全部等这个渠道层。claim 原子租约一次拿到。
- **数据库**:本地 postgres 可用,全部测试带 DATABASE_URL 跑(无 skip)。

### 本切片改动的文件

- `packages/mailer/`(新包):`apps/api/src/mailer/mailer.ts` + 测试原样上浮,
  barrel 导出;worker 成第二个消费方后基建下沉(worker 不跨 app 依赖,与
  automations 内核下沉同一裁法);api/worker 的 package.json 加
  `@ally/mailer: workspace:*`
- `apps/api/src/{index.ts,auth/auth.ts}` + 10 个测试文件:import 改
  `@ally/mailer`(老路径已删;测试文件的断裂是 lint 用
  "type that cannot be resolved" 抓出来的,typecheck 反而先被 vitest 隔离)
- `packages/db/src/schema.ts`:`notifications.digestSentAt`(投递台账)+
  新表 `notificationPreferences`(userId PK、emailDigest 默认 false、updatedAt)
- `packages/db/migrations/0025_rapid_agent_brand.sql`(db:generate):
  CREATE TABLE + ADD COLUMN,expand-only
- `apps/api/src/routes/notifications.ts`:GET/PUT `/api/notifications/preferences`
  (GET 缺席读默认、PUT strict 整份替换 upsert);registry.ts 两行 session 声明
- `apps/worker/src/notifications/digest.ts`(新):扫描(join prefs+auth_user,
  未读+未盖章)→ 按人攒信 → 发信 → 只给列出的行盖章;按人隔离失败,末尾汇总
  上抛给 pg-boss 重试;`renderDigest` 纯函数(英文文案、HTML 转义、封顶
  「还有 N 条」、webAppUrl 缺席不放死链)
- `apps/worker/src/notifications/index.ts`(新):`notifications-digest` 任务,
  cron 13:30 UTC(与 rules 13:00 同锚错峰),retry 1;worker index.ts 接线
  createMailer
- `apps/web`:notification-preferences-client.ts(zod、永不 throw、失败 null)、
  NotificationSettings.tsx(/settings/notifications,加载失败/保存失败/已存
  三种话各说各的)、NotificationBell 下拉尾部设置入口、App.tsx 路由
- `docs/notifications.md`:渠道层一节(台账语义、封顶语义、事实渲染、沉包、
  opt-in 默认)
- `ops/session-logs/2026-10-07-feat-116-notify-channels.md`(本文件)

### 验证

- `DATABASE_URL=… corepack pnpm verify` 全绿:lint ✓、typecheck ✓、
  **92 个测试文件 / 737 测试全过**(此前 83/651;新增 digest 10、preferences
  路由 5、preferences client 3、settings/bell 源码合同 6、既有 mailer 12 随包迁移)
- 迁移纪律:0025 为 db:generate 产物,未手改;无新 env(RESEND_API_KEY/
  EMAIL_FROM/WEB_APP_URL 均已在 @ally/config 与 .env.example)

## 判断层(手写)

1. **切片 = 渠道层,不是「重做通知」**。#116 两条验收早被 #259(已读同步)/
   #263(实时推)满足但 issue 零评论、无人认账;正文迁移要点的「按用户偏好发
   邮件或 Slack」才是真空。选邮件摘要而非 Slack:mailer 基建已在(#22),
   Slack 连 webhook 形态都未定;先落「每人可选渠道」的骨架和第一个渠道,
   Slack 是加列+加渲染器的 expand。
2. **渠道是读侧投影,生产方 seam 一根手指都不动**。通知行(事实行)本来就是
   普遍收件箱;realtime 铃铛和邮件摘要都是对同一行的读投影。所以「一处调用
   多渠道送达」不需要新的写时钩子——偏好表决定哪些读投影生效。这跟老系统
   「插通知散在 11 个生产者里」(#1474 点名不要照搬)是同一个方向的防守。
3. **行级台账 digest_sent_at,不用偏好行上的游标**。exactly-once 语义:
   一行最多进一次邮件;偏好开→关→开不会把旧货重念一遍。封顶(50 条)只盖章
   列出的行,总数照报——没列出的行留 null,明天的摘要继续带,不静默吞。
   盖章 WHERE 再挡一次 IS NULL,重试/并发下不改写已盖的行。
4. **邮件文案渲染事实,不复制铃铛的 face map**。describeNotification 是前端
   展示层资产;服务端复制一份=两处漂移。摘要邮件只渲染行事实(事件类型+
   payload 事实字段+时间)+ 一条去应用的链接;per-item 深链等共享 face 包,
   与 #115 Slack(需要同一份文案)一起进场。这个「先不抄」是有意的克制。
5. **默认 opt-in(false)**:未配置的部署不该替人决定往外发真信;摘要的卖点
   是「少看铃铛」,默认多收邮件方向就反了。GET 缺席读返回默认且**不落行**。
6. **cron 13:30 UTC**:与 rules 待办提醒(13:00,美东早 9)同锚错峰半点;
   摘要也落「早上一上班的邮箱」。retry 1 + 明天的扫描兜底,与 rules 作业
   同一裁法。
7. **坑(本次新踩)**:
   - 移动共享模块时,**typecheck 不抓测试文件的旧 import**(vitest 各文件独立
     transform,类型断了运行才发现?不——eslint 的
     no-unsafe-member-access "type that cannot be resolved" 先炸)。10 个测试
     文件的 `../mailer/mailer.ts` 断裂全是 lint 抓的;以后沉包先 `grep -rl` 全
     仓引用(我第一次只 grep 了非 test 文件)。
   - JSX 源码文本测试(jsdom-free)里,`&apos;` 要按转义形态断言,源文件里
     没有裸 `'`。
   - 源码合同测试的正则 `[\s\S]*` 会跨代码块误配(load 失败块之外很远的
     setDraft 也算命中)——钉结构性事实本身(early return 三行),别钉「A 和
     B 的相对位置」。
   - 假 fetch 用 `() => Promise.resolve(new Response(...))` 而非
     `async () =>`(require-await);返回 Promise 的同步函数天然满足
     typeof fetch,断言反而是 no-unnecessary-type-assertion。
   - `expect.any(String)` 在 toEqual 里触发 no-unsafe-assignment——老测试都
     手写类型化 parse 后 `typeof` 断言,新人(我)差点开倒车。
   - 并发收尾的物理伤害:拥有会话清 worktree 能杀死坐在里面的**别的**会话的
     shell(gotcha #74 的变体:受害者甚至不是同一条 PR 的工人)。恢复 =
     让子 agent `mkdir -p` 被删目录;预防 = merge 后第一时间 cd 回主检出。
