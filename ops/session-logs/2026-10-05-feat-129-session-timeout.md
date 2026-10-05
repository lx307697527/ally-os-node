---
session_id: hand-written-129-session-timeout
branch: feat/129-session-timeout
date: 2026-10-05
reason: issue-129-slice-2
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/129-session-timeout — 2026-10-05

> 机械层本次由 agent 手写(ZCode worktree 会话,SessionEnd hook 未触发);
> 判断层为本次会话手写。

## 机械层(自动)

- **时间跨度**:2026-10-05 下午
- **引用的 issue**:#129(后台框架与通用交互)切片 2:会话超时(服务端
  会话过期 + 前端提示)
- **PR**:feat/129-session-timeout

### 改动的文件

- `apps/web/src/shared/lib/session-expiry.ts`(新增):纯逻辑层 ——
  `parseExpiryMs`(防御性解析 better-auth 的 `expiresAt`,线上是 ISO 字符串、
  类型却标 `Date`)、`phaseFor`(deadline → active/warning/expired,警告
  窗口 60s 沿老系统 DEFAULT_WARNING_GRACE_MS)、以及「会话已过期」一次性
  提示的 mark/clear/peek 三个 sessionStorage 助手(带可注入 storage 参数,
  node 环境可单测)
- `apps/web/src/shared/lib/use-session-timeout.ts`(新增):闲置登出 watcher。
  不再自跑时钟:老系统(ally-os `use-session-timeout.ts`)的 localStorage
  活动时间戳 / 活动事件监听 / 到点 signOut 全部退役,本地只对服务端发布的
  deadline 做「睡到警告窗口 → 每秒倒计时」;过期时刻先问服务端
  (refreshSession),活→新 deadline 回灌重置倒计时(多标签页场景),死→
  RequireAuth 自然跳转,4s 无判决才自行兜底跳转;登录即清提示标记
- `apps/web/src/shared/components/SessionTimeoutWarning.tsx`(新增):
  "Still there?" 覆盖层,role=alertdialog + aria-modal,不可关闭(无
  scrim 点击/Escape/×),唯一出口 "Stay signed in" 走服务端 round trip;
  手工沿用老 `@ally-os/ui` ModalFrame 的对话框配方(scrim 层 + 琥珀顶边
  + 六档 dialog 宽度的 560 档),真 ModalFrame 随首个 record 路由移植后
  应换座
- `apps/web/src/shared/lib/session.ts`:`useSession()` 增加 exposing
  `expiresAtMs`(经 parseSessionExpiry 防御解析)与 `refreshSession`
  (映射 better-auth 的 `refetch`,唯一合法的续期通道)
- `apps/web/src/shared/lib/auth-client.ts`:只加注释 —— 明确
  **session 轮询必须保持关闭**(poll = getSession = 服务端续期,开着轮询
  12h 闲置超时就名存实亡),focus 重取是唯一自动刷新
- `apps/web/src/shared/lib/return-to.ts`:`ReturnToState` 增加可选
  `sessionExpired` 标志
- `apps/web/src/shared/pages/Login.tsx` + `auth/SignIn.tsx`:登录页消费
  过期提示 —— latch 用 `useState` 初始化器做**纯读**(peek),挂载后
  effect 再清除;SignIn 增加 `notice` 属性,红色一行渲染在卡片首行
- `apps/web/src/App.tsx`:`ShellHost` 挂 watcher,警告覆盖层渲染在壳之上,
  不卸载任何页面内容(移走页面本身就是警告想防的数据丢失)
- 测试:`session-expiry.test.ts`(纯逻辑 11 个真单测:解析的字符串/数字/
  Date/垃圾输入,phase 的三态与边界含等值)、`session-timeout.test.ts`
  (源码文本纪律:无 localStorage / 无活动监听 / 续期必须走服务端 /
  auth-client 无 refetchInterval / alertdialog 不可关闭 + testid;
  负面断言先剥注释再检查,避免误伤讲道理的注释)、`login.test.ts` 增
  过期提示断言

### 验证

- `corepack pnpm verify` 全绿(lint → typecheck → test,109 passed /
  16 skipped DB-gated;本次零 API/DB 改动,skipped 不受影响)
- `vite build` 通过
- 浏览器端到端冒烟(本地 PG + API 3100 + web 5175,临时把
  SESSION_EXPIRES_IN_SECONDS 改 90s/updateAge 30s,**未提交**):
  登录 → 最后 60s 出现不可关闭警告 + 每秒倒计时 → 点 "Stay signed in"
  → 弹层消失(服务端续期,DB 里 expires_at 后移)→ 第二次警告 → 不理会
  → 倒计时归零 → 服务端判死 → 跳回 /login → 登录页显示
  "Your session expired. Sign in again to continue."(截图核验过渲染)

## 判断层(手写)

1. **轮询是这个特性的头号暗坑,裁决写进了代码注释和测试**:better-auth
   客户端有 `sessionOptions.refetchInterval`,开起来「体验更好」(能及时
   发现过期),但 poll 本身就是 getSession,服务端按 updateAge 续期 ——
   一个开着的标签页永远闲不下来,#129 验收标准「闲置超时后需要重新登录」
   直接失效。所以本地倒计时 + focus 重取 + 过期时刻一次性问服务端,是
   既能及时反应又不推翻服务端权威的唯一组合。`auth-client.ts` 的注释和
   `session-timeout.test.ts` 的 `refetchInterval` 负面断言就是防止后人
   手痒。
2. **端到端冒烟抓出一个纯推理找不到的坑**:过期提示最初用「consume 即
   删除」的 one-shot sessionStorage 读取,在 dev(StrictMode)下被
   useState 初始化器双调用吃掉,前两轮冒烟提示始终不显示。修法是把
   读(peek,纯)和清(clear,挂载后 effect)拆开 —— 初始化器必须无副
   作用这条 React 纪律,jsdom-free 的源码文本测试根本覆盖不到,只有真
   浏览器冒烟能抓到。中途还排除了两个假嫌疑:better-auth 客户端没有任何
   到期自动重取调度(session-refresh/session-atom 源码逐行读过);DB 里
   `updated_at == created_at` 证明 focus 续期从未发生。
3. **冒烟方法**:API 会话常量是硬编码的 12h,临时改成 90s/30s 本地跑全
   链路(警告→续期→再警告→过期→跳转→提示),提交前还原;9000 端口的
   PG 容器是主检出会话在用,开发栈换 3100/5175 端口,互不干扰。多标签
   页正确性(一个标签页 stay、另一个标签页倒计时归零后被服务端 verdict
   救回)是设计目标之一,靠「过期先问服务端再行动」保证。
4. **ModalFrame 移植的边界**:老系统的警告框骑在 `@ally-os/ui`
   ModalFrame(422 行,带规则与测试族)上;本切片只在 web 手工沿用其
   配方(scrim/琥珀顶边/560 宽),真组件随首个 record 路由或 #129 后续
   切片移植,届时本组件应换座 —— 已写在组件头注释里。
5. **顺手发现但不在本次范围**:better-auth 的 `getSession` 在 401 时
   (`executeSessionFetch` 的 `isUnauthorized` 分支)会清 data 但把 error
   挂在 store 上;RequireAuth 目前只看 user,不区分「本来就没登录」和
   「会话刚死」,后者的 UX(本切片)已覆盖,将来若要区分(如显示登录
   过期 vs 请先登录)需要在 session.ts 适配层暴露 error 通道。
6. **尾巴**:#129 剩余切片:切片 3 版本检查(/version.json 构建号比对 +
   刷新提示)、切片 4 删除撤销 + 通知铃 + 反馈入口、i18n 与 ops 前端
   并入;`SessionTimeoutWarning` 换座真 ModalFrame。
