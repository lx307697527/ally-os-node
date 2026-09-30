# Ally OS (Node)

Ally Nutra 的新一代技术底座：把现有 Vercel + Supabase 架构迁移到**自己掌控的 Node.js + React + PostgreSQL**，
部署在 AWS（也可迁到 Azure / 阿里云海外区等任意云）。

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 运行时 | Node.js 24 LTS | 原生执行 `.ts`（类型擦除），服务端没有构建步骤 |
| 语言 | TypeScript 6，**全量 strict** | `tsc` + typescript-eslint `strictTypeChecked` 双重校验 |
| API | Hono + @hono/node-server | Web 标准 `Request`/`Response`，ally-nutra 的 edge function 可近乎原样搬过来 |
| 数据库 | PostgreSQL 16 + Drizzle ORM | 表结构即 TS 类型；迁移文件由 drizzle-kit 生成 |
| 队列 / 定时任务 | pg-boss | 存在 PostgreSQL 里，替代 pg_cron + pg_net，不需要 Redis / SQS |
| 文件存储 | S3 协议（`@ally/storage`） | AWS S3 / MinIO / 阿里云 OSS / 腾讯云 COS 同一份代码 |
| 前端 | React 18 + Vite + TanStack Query | |
| 部署 | Docker → AWS ECS Fargate + RDS + S3 + ALB | Terraform 管理，见 `infra/terraform/aws` |
| CI/CD | GitHub Actions + OIDC | 合并即部署 staging，人工批准后上 production |

## 目录

```
apps/
  api/        HTTP API（Hono）
  worker/     后台任务与定时任务（pg-boss）
  web/        React 前端（Vite，生产用 nginx 容器提供静态文件）
packages/
  config/     环境变量定义与校验（zod）——所有服务共用
  db/         Drizzle schema、数据库连接、迁移
  storage/    S3 兼容存储适配层
infra/terraform/aws/   AWS 基础设施（VPC / RDS / S3 / ECR / ECS / ALB / GitHub OIDC）
scripts/deploy-ecs.sh  部署脚本：先迁移数据库，成功后滚动更新服务
.github/workflows/     CI 与自动部署
docs/                  架构说明与操作指南
```

## 本地开发

需要 Node ≥ 22.18（推荐 24，见 `.nvmrc`）、pnpm 10、Docker。

```bash
pnpm install
cp .env.example .env
docker compose up -d          # 启动 PostgreSQL + MinIO
pnpm db:migrate               # 建表
pnpm dev                      # 同时启动 api(:3000) / worker / web(:5173)
```

打开 http://localhost:5173 ，页面显示 “API 状态：ok” 即全链路打通。

验证完整容器化部署（与线上同一份镜像）：

```bash
docker compose --profile app up --build   # web → http://localhost:8080
```

## 常用命令

```bash
pnpm verify        # lint → typecheck → test，提交前必须通过（CI 跑同样的检查）
pnpm lint          # ESLint（类型感知的严格规则）
pnpm typecheck     # 每个包分别 tsc --noEmit
pnpm test          # Vitest；设置 DATABASE_URL 时会额外跑数据库集成测试
pnpm db:generate   # 修改 packages/db/src/schema.ts 后生成迁移文件
pnpm db:migrate    # 执行迁移
```

## 文档

- [架构与迁移路线](docs/architecture/overview.md)：为什么这样选、如何从 ally-nutra 分模块迁移
- [CI/CD 与 AWS 上线指南](docs/guides/cicd-setup.md)：从零到第一次自动部署的操作步骤
