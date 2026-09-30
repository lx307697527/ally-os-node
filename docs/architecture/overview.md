# 架构与迁移路线

## 目标

把 ally-nutra（Vercel + Supabase）迁移到自己掌控的 Node.js + React + PostgreSQL，解决：

- Supabase Edge Functions 不能跑常驻服务（WebSocket 协同编辑、Twilio 实时转写只能另起服务器）；
- 前端直连数据库、权限全靠 679 条 RLS 策略，难以审查和测试；
- 定时任务靠 pg_cron + pg_net 从数据库里发 HTTP 调函数，链路长、难排查；
- 平台限制（执行时长、冷启动、部署方式）带来的各种坑。

## 关键选型与理由

- **Node 而不是 Deno**：Twilio / Deepgram / Yjs 等常驻服务生态 Node 优先；前端工具链本就是 Node；
  typescript-eslint 等类型感知工具在 Node 上最成熟。Node 24 也能直接运行 `.ts`，Deno 的主要便利已不再独有。
- **严格 TypeScript + 类型感知 lint**：这是 AI 写代码时最有效的自动校验。`pnpm verify` 是唯一的“完成”标准。
- **Hono**：API 用 Web 标准 `Request`/`Response`，与 Supabase Edge Function 写法一致，迁移成本低；
  同时可以跑在任何运行时。
- **pg-boss**：队列和定时任务都在 PostgreSQL 里，少一个需要运维的组件，换云无影响。
- **单镜像多入口**：api / worker / migrate 同一个镜像，保证三者代码版本永远一致。
- **云无关**：应用代码只依赖 PostgreSQL、S3 协议和环境变量；云厂商相关的东西全部在 `infra/`。

## 分阶段迁移路线（逐步替换，每一步可单独上线、可回滚）

1. **常驻服务与后台任务先行**：把 `ws-server`（Yjs）、`voice-transcription-server`、所有 webhook
   （Twilio / Resend / PayPal / Stripe / HubSpot / iClosed / Calendly）和约 31 个定时任务搬到本项目。
   这一阶段直接连接 Supabase 的 PostgreSQL（它就是标准 PG），前端不动。
2. **按业务模块迁移 API**：建议顺序 采购/SRM → 邮件 → 报价 → CRM → 协作空间。每个模块：
   把相关 edge functions 改写为 `apps/api` 路由（带测试），同时把前端该模块的 `supabase.from()`
   直连查询改为调用 API，把对应 RLS 规则改写为 API 层的权限检查。
3. **认证迁移**：前端完全不再直连数据库后，把 Supabase Auth 换成自建认证（推荐 Better Auth）。
   `auth.users` 中的 bcrypt 密码哈希可导出，用户无需重置密码。
4. **数据与存储落地**：`pg_dump` 迁到 RDS，Supabase Storage 迁到 S3，切换 DNS，下线 Supabase / Vercel。

## 骨架当前包含 / 不包含

包含：monorepo 结构、严格校验流水线、API 与 worker 框架、数据库迁移链路、S3 适配层、
Docker 镜像、AWS 全套 Terraform、GitHub Actions CI/CD、本地 docker compose。

不包含（下一步）：认证、业务模块、WebSocket 服务、前端 UI 框架（Tailwind / shadcn）、可观测性告警。
