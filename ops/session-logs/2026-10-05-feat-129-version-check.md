---
session_id: hand-written-129-version-check
branch: feat/129-version-check
date: 2026-10-05
reason: issue-129-slice-3
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/129-version-check — 2026-10-05

> 机械层本次由 agent 手写(ZCode worktree 会话,SessionEnd hook 未触发);
> 判断层为本次会话手写。

## 机械层(自动)

- **时间跨度**:2026-10-05 下午
- **引用的 issue**:#129(后台框架与通用交互)切片 3:版本检查
  (/version.json 构建号比对 + 刷新提示)
- **PR**:feat/129-version-check

### 改动的文件

- `apps/web/src/build/version-plugin.ts`(新增):构建侧 ——
  `resolveBuildId`(git short SHA 优先,无仓库/docker 上下文回退构建时间戳,
  git 命令可注入)、`versionDefine`(把构建号以字符串字面量 define 进
  bundle,标识符 `__ALLY_BUILD_ID__`)、`versionAsset`(产出
  `dist/version.json`)、`versionPlugin`(vite 插件:config 钩子挂 define,
  generateBundle 落 version.json,与 index.html 同目录)
- `apps/web/vite.config.ts`:接入 versionPlugin —— 一次构建,两端同源:
  bundle 里的 `__ALLY_BUILD_ID__` 与 dist/version.json 携带同一个 id
- `apps/web/src/vite-env.d.ts`(新增):`__ALLY_BUILD_ID__` 声明为
  `string | undefined`(测试/node 运行无 define)
- `apps/web/src/shared/lib/version-watch.ts`(新增):运行时 watch ——
  zod 校验 /version.json 响应体(缺 buildId/垃圾体 = 无消息,保留已知)、
  60s 节流底 + in-flight 去重、fetch 失败永不抛、`onNews` 在每次完成的
  检查后回报判定(轮询在 React 之外发生,状态必须由它推)、
  `scheduleVersionWatch`(可见才问:5min 间隔 tick + visibilitychange,
  `VersionWatchHost` 是最小结构接口,测试可纯结构伪造,`window` 天然满足)
- `apps/web/src/shared/lib/use-version-check.ts`(新增):React 接缝 ——
  一 mount 一 watch(useState 惰性初始化),`onNews: setNewBuildId` 直连,
  effect 只负责 schedule/stop;消息只进不退(watch 的 live 单向前进)
- `apps/web/src/shared/components/NewVersionBanner.tsx`(新增):右下角
  role=status 提示条,唯一动作 "Refresh now"(window.location.reload),
  刻意无关闭按钮(过期不会自动消失,下次轮询只会再弹)
- `apps/web/src/App.tsx`:ShellHost 挂 `useVersionCheck`,banner 渲染在
  壳之上、会话警告层之下;登录页不挂(验收标准是「在线用户」)
- `apps/web/package.json`:加 `zod ^4.6.5`(与 @ally/config 同版本线)
- 测试:`version-plugin.test.ts`(id 解析三种路径、两个产物 JSON 往返、
  插件接线源码断言:同一 buildId 闭包喂 define 与 emitFile)、
  `version-watch.test.ts`(纯单元 15 个:同/异 id、无 id 停摆、失败不抛、
  HTML/空/非串 body 不算消息、坏体保留已知、60s 节流、并发去重、onNews
  判定序列、假 host 上的间隔/可见性/清理)、`version-check.test.ts`
  (源码文本纪律:watch/hook 无 reload、App 恰好一处 location.reload、
  no-store + same-origin、safeParse、define 守卫、常量节拍、banner 无
  onClose)

### 验证

- `corepack pnpm verify` 全绿(lint → typecheck → test,138 passed /
  16 skipped DB-gated;本次零 API/DB 改动)
- `vite build` 产物核验:dist/version.json 出现且 buildId = git SHA
  (386f8d3);bundle 内 define 已替换(产物里是 `current:"386f8d3"`,
  标识符零残留),fetch 接线原样保留
- 浏览器端到端冒烟(本地 PG + API 3100 + **vite preview 5175 伺服真实
  dist**,临时把 VERSION_CHECK_INTERVAL_MS 改 5s、vite.config 加 preview
  代理、BETTER_AUTH_URL=http://localhost:5175,**均未提交**):
  登录进壳 → 同构建号无 banner(无误报)→ 改 dist/version.json 为新 id →
  visibilitychange 触发检查 → banner 出现(文案 + Refresh now,截图核验
  配方:白卡、hairline 边、navy 主按钮)→ 点 Refresh now → 页面真实重载
  (performance.now 归零)→ 因 bundle 仍是旧 id,banner 按预期重现 →
  登出 → 登录页无 banner

## 判断层(手写)

1. **define 替换的是标识符,不是模块常量 —— 第一稿踩了这个坑**:最初
   version-watch.ts 从插件模块 import `BUILD_ID_DEFINE` 常量再 typeof,
   这样编译产物里 current 永远是字面串 "__ALLY_BUILD_ID__",与
   version.json 里的 git SHA 永不相等 → 每个标签页开屏即报「有新版本」。
   define 的本义是把源码里的标识符 `__ALLY_BUILD_ID__` 文本替换成字面量,
   所以运行时代码必须直接书写该标识符,.d.ts 里声明成
   `string | undefined`、用 typeof 守卫(对未声明标识符做 typeof 不抛
   ReferenceError,这是 JS 语义给的免费安全网)。版本检查的两端如果各走
   各的 id 来源,错法是静默的 —— 要么永远闭嘴要么永远喊狼来了,单测里
   用「同一 buildId 闭包喂两端」的源码断言钉死。
2. **Vite 8 的 dev 不应用 define,运行时 watch 在 dev 停摆 —— 接受了,
   而且认为这是对的语义**:dev 服务器上不存在「部署了新构建」这回事,
   banner 在 dev 常驻反而是噪音。代码注释写明 typeof 守卫让 dev/test 归入
   "no news"。代价是冒烟必须走真实构建产物(`vite preview` + 临时给
   vite.config 加 preview 代理),但这反而更诚实 —— 验的是要上船的那个
   artifact,define 替换、version.json 落盘、nginx 式静态伺服全在链路里。
   顺带发现 dev 模式下 buildId 是 git SHA,curl dev 转换后的模块能直接
   看到 define 是否生效,这个观察手段值得留用。
3. **冒烟环境的三只拦路虎,都不是代码的错但要记录**:① localhost 的
   cookie 不分端口 —— dev 登录过的会话直接漏进 preview,冒烟时"明明没登录
   却已是登录态"不是 bug;② 本机 3000 端口上有别的会话的 API 在跑,preview
   代理默认指向 3000,better-auth 报 Invalid origin 的真凶是代理打错了门,
   `VITE_API_PROXY` 指对即愈;③ IAB 无头面板会节流 setInterval(第一个
   tick 之后就不再触发),但 visibilitychange 监听器路径畅通 —— 这恰好是
   产品代码自己的另一条触发路径,用它驱动检查反而验证了「标签页切回可见
   立即询问」这条真实用户路径。Playwright 的 click 可点性判定在该面板里
   也不稳(登录按钮、刷新按钮双双超时),evaluate 内 elementFromPoint
   证明按钮可命中后改用页内 click,一次成功。
4. **节流底和轮询节奏是两个独立的旋钮,冒烟时只拧了一个**:临时把
   INTERVAL 改 5s 后,第二次检查仍被 60s 的 MIN_GAP 压住 —— 单测里
   「asks at most once per gap」钉住的正是这个行为,冒烟时却忘了它,
   白等了两轮。这个教训写进来提醒后人:压节奏测试时两个常量要一起看。
   真实部署里这组值(5min/60s)沿老系统 DEPLOYMENT_CHECK_* 的值,一个
   version.json 请求的成本是噪音,不必更激进。
5. **构建号选 git SHA + 时间戳回退,而不是纯时间戳**:同一 commit 重发
   镜像不该打扰在线用户(SHA 相同 → 安静);docker 构建没有 .git 也没有
   git 二进制(node:24-slim),回退时间戳保证每次镜像构建都是一个独立
   的「部署事件」,这正是 watch 该通报的对象。老系统靠比对 index.html 里
   的 hashed entry 名(无版本文件)也能答同一问题,但 issue 的设计明确
   指定 /version.json + 构建号,nginx 从 dist 原样伺服、SPA fallback
   不碰真实存在的文件,cache 策略与 index.html 同为 no-cache,链路上
   没有新增的缓存失效面。
6. **「永不自动重载」是老系统裁决,原样渡河**:banner 无关闭按钮是刻意
   的 —— 过期不会自己消失,给个 × 只是 UI 在撒谎,下一次轮询(节流窗口
   后)只会再弹。重载的唯一入口是操作者自己的点击,这一条由源码文本测试
   钉死(watch/hook 无 reload、全 App 恰好一处 location.reload)。
7. **顺手发现但不在本次范围**:登录成功后偶发被弹回 /login(表单清空、
   会话 cookie 已就位,direct 访问 /overview 即入壳)—— 疑似 RequireAuth
   在 better-auth session store 回灌前抢跑的导航竞态,dev 与 preview 都
   偶现,属 #129 切片 1/2 的既有路径,与本次改动无关;将来若要修,方向
   是 Login 提交成功后等 useSession 就绪再 navigate,或在 RequireAuth
   的 loading 分支里多等一拍。另:#129 剩余 —— 切片 4 删除撤销 + 通知铃
   + 反馈入口、i18n 与 ops 前端并入;`SessionTimeoutWarning` 换座真
   ModalFrame。
