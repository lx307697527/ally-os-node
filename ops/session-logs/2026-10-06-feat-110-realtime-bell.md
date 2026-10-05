---
session_id: hand-written-110-realtime-bell
branch: feat/110-realtime-bell
date: 2026-10-06
reason: issue-110
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/110-realtime-bell — 2026-10-06

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#110(评论、@提及、通知与活动流)——**切片 2:通知实时
  推送(铃铛订阅)**,PR 正文写 Part of #110(活动流、关注、附件、评论编辑、
  阶段笔记、邮件汇总未做,严禁 Closes 关键字);同时是 #30 推送服务的第一个
  前端接入方。
- **前置收尾(第 0 步)**:无 open PR;残留 worktree `110-comments-kernel`
  (PR #262 已 squash 合并)清理时踩 Windows「Filename too long」,worktree
  remove 半成功(注册项已删、目录残留),`git worktree prune` + 手动 rm 解决
  (首次 rm 报 Device or resource busy,重试即净);本地/远端分支均清。
- **选题**:①优先续做未完切片——#113/#23/#25/#29 的剩余项全部被 #227/#235/
  #116/ops 域阻塞;#110 切片 1(PR #262)评论里明排「铃铛订阅作为独立切片
  排下一张」,兑现它。
- **关键勘察**:docs/realtime.md 显示 #30 的推送基础设施**已建成**(WS hub、
  PG LISTEN/NOTIFY 总线、重连恢复、会话鉴权全 ✅,#30 open 只剩「各域替换
  轮询」收尾项)——本切片不是造轮子,是接线。issue 正文的 workspace_comments/
  workspace_activity 在这一代从未存在(切片 1 会话已 pickaxe 证实),老代码
  依旧无可搬。
- **本切片改动**:protocol.ts 加 `user:` 私人频道约定 + `notifications.changed`
  知名事件;hub 加可注入 `authorize` 频道授权钩子;生产接线 `channels.ts`
  (user:<id> 仅本人可订阅);`GET /api/realtime/token` 发还调用者自己会话的
  令牌(cookie HttpOnly,浏览器拿不到 auth 帧令牌——设计缺口的补齐);两个
  通知生产者(tasks/comments)事务提交后经 `AppDeps.notifyUsers` 发催(实现
  方合同:永不 reject,失败只降级);web 侧 `notification-live.ts`(每标签页
  一条 WS 订 user:<id>,催/真重连 resync 即重读 summary),铃铛加 live prop,
  60s 轮询降为兜底;vite dev 代理开 ws: true。
- **测试**:protocol 3 条、hub authorize 4 条、channels 规则 4 条、token 端点
  集成 2 条(独立临时库)、tasks/comments 催断言并入既有用例、notification-live
  6 条(假 socket 走真重连路径)、bell 源码断言 +2;其余 10 个测试文件的
  createApp 补 notifyUsers noop。**无 schema 改动、无新 migration**(db:generate
  复核无漂移)。
- **验证**:`DATABASE_URL=… corepack pnpm verify` 全绿 **59 文件 / 437 测试**
  (此前 55/416);vite build 通过;CI 四项全绿。

## 判断层(手写)

### 本次的关键判断

1. **切片是接线不是造轮子——先读 docs 再定题**:勘察发现 #30 的验收状态里
   推送服务四项全 ✅,issue 还开着只是因为「各域替换轮询」的收尾条。上一会话
   (切片 1)排的「铃铛订阅排下一张」在本切片兑现,#110 验收「被 @ 的人
   **实时**收到通知」就此闭环(切片 1 已给通知+深链)。选题时一度考虑活动流,
   但 #232 §11 对「活动」的落点是「每个业务对象都有」而非全局页,而切片 1
   评论明排了铃铛订阅——按既定排队走,不换题。
2. **令牌端点是 HttpOnly 与「auth 帧带会话令牌」设计之间的桥,不是新发明**:
   docs/realtime.md 说 auth 帧用 Better Auth 会话令牌,docs/auth.md 说 cookie
   HttpOnly——两份既有文档互相矛盾处就是本切片的缺口。裁定:发还调用者**自己
   会话**的令牌不算提权(持有者本就拥有 cookie 里那份),不发明短时票据表
   (那要新 migration,超出接线切片);XSS 面没变大(同源 XSS 本就能带着
   cookie 冒充本人调任何 /api)。生产永不放行 dev: 令牌的既有裁定不变。
3. **催信号走「事务提交后」而非 NOTIFY 的事务性**:pg_notify 在事务内发布
   会随提交才投递,看似该在事务里发;但发布走的是总线独立连接,与业务事务
   不同生命周期,放进事务只会制造「回滚了却已投递」的窗口。提交后发 +
   `notifyUsers` 永不 reject 的合同(at-most-once,60s 轮询兜底)——推送的
   定位是「催」,丢了不可怕,把业务请求搞失败才可怕。
4. **`user:` 频道授权落在本切片,因为第一个用例的元信息就是敏感的**:催帧
   `data` 为空,但「谁在何时收到通知」本身是元信息,不能让登录者互听。
   授权做成 hub 的可注入 `authorize` 而非写死在 hub:hub 保持 #30 的通用性
   (未注入 = 原行为,既有 30 条 hub 测试零改动),规则本体(channels.ts)
   独立单测。拒绝码沿用 `unauthorized`,不新增协议错误码。
5. **轮询不删,降级为兜底——对 #129 裁定的修订而非推翻**:「POLLING, NOT A
   SUBSCRIPTION」的前提(推送无通知发布方)已失效,但轮询的两条腿还在:
   at-most-once 丢的催要补,死连接/被拒 upgrade 要兜。visible-poll 原样保留
   (隐藏标签页停轮询但仍收推送);resync 只认 attempts>0 的真重连,初次连接
   的 auth.ok 不催(挂载读刚发生过,多催一次是白读)。
6. **PATCH 的「催谁」用数组持有,不用闭包外的 let**:事务回调里的赋值不参与
   外层控制流分析,`let notifiedUserId: string | null` 出来还是 null 窄化,
   `!== null` 判空被 no-unnecessary-condition 判死——lint 逼出的其实是更稳的
   写法(数组 push + length 判空);POST 侧从事务返回值带出,无此问题。
7. **web 测试无 jsdom,组件行为靠源码断言——live 通道的逻辑全部下沉到
   notification-live.ts 纯库**:假 socket 工装搬 realtime-client 测试的
   (FakeWebSocket + serverSend),重连路径真走(drop → 毫秒级退避 → 新
   socket → auth.ok)。测试自身的坑:subscribe 帧只在 auth.ok 之后由客户端
   重放,不发 auth.ok 就断言订阅,永远等不到。
8. **10 个既有测试文件机械补 noop,2 个目标文件上收集器**:AppDeps 加必填
   notifyUsers 后,typecheck 精确指出全部 13 处调用点;只有 tasks/comments
   的测试需要「催」断言(收集型 fake,beforeEach 清空),其余一行 noop——
   让类型系统找调用点,不做盲改。

### 踩的坑

1. **Windows worktree 清理的「Filename too long」**:node_modules 深路径使
   `git worktree remove --force` 半成功(注册项删了、目录删不动);`prune`
   后手动 `rm -rf`,首次还撞「Device or resource busy」(有进程占着),重试即
   净。远端分支已删时 `git branch --merged` 看不出 squash 合并的分支该删——
   按 PR 号对 main 的提交历史核对。
2. **exactOptionalPropertyTypes 的两头堵**:bell 的新 prop `live?:` 传
   `notificationLive ?? undefined` 报 TS2375,要写成
   `live?: NotificationLiveChannel | undefined`;而测试桩的 fetch 桩函数
   `(input) => { void input; ... }` 又被 no-meaningless-void-operator 判死
   ——最后零参数函数直接可赋给 `typeof fetch`,unused 参数问题消失。
3. **初次 auth.ok 也带 resync(attempts=0)**:客户端 SDK 的设计如此。第一版
   通道对所有 resync 都催,测试揭出「挂载后立刻多一次白读」;修为只认
   attempts>0。若铃铛哪天把挂载读去掉,这里要跟着重新裁决。
4. **测试里忘发 auth.ok**:hub 服务端帧驱动的假 socket 测试,auth 帧 →
   auth.ok → 重放订阅是三步,漏第二步则 subscribe 帧永不出现,断言等空。
   与切片 1 踩的「href-parity 测试相对路径」同类:工装的隐含时序要写进测试
   注释。
5. **假 socket 测试的时序都要 waitFor**:token 读走 fetch(微任务链),subscribe
   帧只在 auth.ok 后重放——两处都是「发完立即断言必落空」。vi.waitFor 等
   正向条件;负向断言(无 auth 帧、无催)放在 waitFor 收敛之后才可靠。
   hub.test.ts 全文件 beforeEach 用 fake timers,既有 authAndSubscribe 工装
   已兼容(vi.waitFor 会推 fake timers),新用例沿用同款不另起炉灶。
