# 会话日志：#45 切片 1 营销公开站（PR #332，merge 1986de7）

2026-10-10 深夜，用户交互会话（非 hourly 自动化）。任务：用户点名做营销公开站域（#45–#55），按编号从 #45 切片 1 开工。

## 执行层

1. step-0：worktree 空、无 open PR；#45–#55 的 lease ref 全部存在但 `claim_issue.py status` 显示全 unclaimed（历史残留），claim #45（TTL 180min 覆盖 CI 墙钟）。
2. Explore 子代理全量扫老仓库 `apps/landing`（41 次工具调用）：路由表/组件清单/SEO 机制/45 条重定向/表单接缝/AI 依赖清单一次拿全，主会话零上下文消耗。
3. 移植：16 路由 + styles + data + images + 小视频（66M）；接缝砍四处（ChatWidget/访客追踪/触点/广告栈）+ leadCard.js 从 chatClient 抽纯导出；nginx 代码生成器吃 vercel.json 单一事实源；7 个测试文件 53 用例；parity 脚本对镜像 129 项全绿；CI 5/5；squash merge。

## 判断层

- **切片边界**：#45 正文按「所有旧 URL」验收，但 16 页内容一次搬 review 不友好——按「站点骨架+SEO 闭环+URL 全对齐」切，A/B 页/法律页/静态 quote/schedule 一并带上（拷贝边际成本低），预渲染显式推迟到 #46（避免两套渲染路径，Lighthouse 对照变量保持为 1）。
- **零 TS 保留**：老应用的 .jsx 是有意设计且文案有守卫测试；转 strict TS = 巨 diff 零业务价值高文案风险。方案：tsconfig allowJs+checkJs:false（.ts 测试仍 strict，靠 allowJs 推断导入），根 eslint ignore apps/landing。
- **vercel.json 作为单一事实源**：重定向/头表原样保留 + nginx 代码生成 + 测试 diff 防漂移。跨应用重定向保持指向老生产域名（切换窗口时改表）。
- **发现并修复真实漂移**：`/thank-you-booked` 有 canonical 但不在 sitemap（老仓库「edit the two together」纯约定的必然结果）——补齐 + sitemap-sync.test.ts 收口。
- **VSL 48M 入库**：是 Home 07 段真实内容（`<video>` 双档位）；WorkWithUs 里两行死导入删除（实际走 Vidalytics）。CDN 挪移留作后续。

## 新坑

(61) **Read 工具在 `.claude/**` 路径下不可用**（bash 可见、Read 报 File does not exist；Write/Edit 不受影响但 Edit 需先 Read）——worktree 会话里改拷贝文件用「bash 查看全文 + Write 重写」或 python 内联补丁；新文件直接 Write。
(62) **老仓库 stale-index 再确认**：issue 正文的路由名/组件路径/脚本文件名三处全错（`/faqs`→`/faq`、`src/components/landing/`→`apps/landing`、generate-sitemap.mjs 不存在）。凡是「老系统现状」描述，动手前必须代码核对。
(63) **nginx 移植 vercel.json 的语义坑**：vercel redirects 先于 filesystem 而 nginx 一请求只选一个 location——`/quote → /quote/` 若编译成正则 location 会吃掉 `/quote/index.html` 造成 308 死循环；必须 exact + `^~` 前缀组合。另 `absolute_redirect off` 必开（否则 Location 带容器内部端口，反代后错误）。
(64) vite 8 解析 `/src/main.jsx` 失败先查文件真的在不在——`cp src/App.jsx dest/` 这种源带目录的拷贝会把文件放到 dest 根而不是 dest/src/（本会话 main.jsx/App.jsx 都中招，build 报错才有感知）。
(65) MSYS_NO_PATHCONV=1 与 `//MIR` 不能混用（坑 55 的精确边界）：置了 NO_PATHCONV 就必须单斜杠 `/MIR`，双斜杠在 NO_PATHCONV=1 下是无效参数直接报错（未置时才是 exit 0 假成功）。

## 状态

- #45 open（剩：GSC 交接、OG meta 随预渲染切片、部署接线随 infra、预渲染随 #46）
- 租约已 release；worktree 已清（robocopy /MIR 单斜杠法）；远端/本地分支已删
- 下一个候选：#46（博客，含预渲染）或 #51/#52（表单+线索服务，解锁 #55）
