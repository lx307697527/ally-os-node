# @ally/landing — 营销公开站（#45）

Ally Nutra 官网：主站页、SEO 服务页、广告落地页、法律页，外加静态的
`/quote/` 询价流程与 `/schedule/` 预约页。从老仓库 `apps/landing` 忠实移植
（zero-TypeScript 的 .jsx 是老应用的有意设计，文案有逐字守卫测试）。

## 开发

```bash
corepack pnpm --filter @ally/landing dev        # http://localhost:5176
corepack pnpm --filter @ally/landing build      # 先跑 gen-quote-runtime-config 再 vite build
corepack pnpm --filter @ally/landing typecheck  # 只查 .ts 测试；.jsx 不做类型检查
corepack pnpm vitest run apps/landing           # 路由/SEO/重定向守卫测试
```

## 本地全链路冒烟（nginx + 校验脚本）

```bash
docker build --target landing -t ally-landing:smoke .   # 仓库根
docker run -d --name ally-landing-smoke -p 8090:8080 ally-landing:smoke
node apps/landing/scripts/check-url-parity.mjs http://localhost:8090
```

校验脚本断言：45 条 308 重定向（含通配形态的探针路径）、全部路由 200、
静态页标记、sitemap 全量可达、五个安全头、X-Robots-Tag 仅在 staging Host
下出现、未移植的原型前缀 404。

## 配置事实源

* `vercel.json` — 重定向/头表的**单一事实源**（老部署同款）。`nginx.conf`
  是 `scripts/gen-nginx-conf.mjs` 的产物，`nginx-conf.test.ts` 会重新生成并
  diff，手工改任何一边都会红。
* `src/lib/pages.js` — TITLES / canonical / noindex。`sitemap.xml` 与它的
  一致性由 `sitemap-sync.test.ts` 钉住（老站是纯约定，这里收口成测试）。

## 本切片未移植（各归其 issue）

* ChatWidget / chatClient（#48 公网 AI 助手）— leadCard.js 只保留纯常量与校验
* 访客追踪 / 触点归因 / 广告栈 tracking.js（#49）
* `/quote/` 仍是老静态页（惰性：无 Supabase 配置不提交），真正的重建在 #51
* 老仓库的 `/visitor`、`/super-admin`、`/employee` 演示原型（现在 404）
