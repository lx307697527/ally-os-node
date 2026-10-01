# syntax=docker/dockerfile:1
# 一个镜像、多个入口：api / worker / migrate 用同一个镜像，只是启动命令不同。
# Node 24 原生执行 .ts（类型擦除），没有构建步骤，镜像里跑的就是仓库里的源码。

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# ---------- 服务端：只装生产依赖 ----------
FROM base AS server-build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/storage/package.json packages/storage/
# postinstall needs these at install time (root package.json wires it); the
# script itself no-ops without .git, which never enters the build context.
COPY .python-version ./
COPY scripts/postinstall.mjs scripts/install_git_hooks.py scripts/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod \
      --filter "@ally/api..." --filter "@ally/worker..." --filter "@ally/db..."
COPY packages packages
COPY apps/api apps/api
COPY apps/worker apps/worker

FROM node:24-slim AS server
ENV NODE_ENV=production
WORKDIR /app
COPY --from=server-build --chown=node:node /app /app
USER node
EXPOSE 3000
# 默认启动 API；worker 用 `node apps/worker/src/index.ts`，迁移用 `node packages/db/src/migrate.ts`
CMD ["node", "apps/api/src/index.ts"]

# ---------- 前端：构建静态文件，交给 nginx ----------
FROM base AS web-build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@ally/web..."
RUN pnpm --filter @ally/web build

FROM nginxinc/nginx-unprivileged:1.29-alpine AS web
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
