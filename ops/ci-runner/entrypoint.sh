#!/bin/bash
# Runner 容器入口：用环境变量做一次 config.sh，然后前台跑 run.sh。
# 官方 ghcr 镜像不带自动配置的 entrypoint（那是别的衍生镜像的玩法），这里自己补上。
# 重建容器 = 重新注册：--replace 会顶掉 GitHub 上同名旧条目。
set -euo pipefail
cd /home/runner

# compose 层不能把 ACCESS_TOKEN 设成必填（否则连 `compose down` 都要 token），
# 真正的校验在这里做。
: "${ACCESS_TOKEN:?"ACCESS_TOKEN 未设置：注册 token 1 小时过期，请用 start.sh 启动，或 gh api -X POST repos/<owner>/<repo>/actions/runners/registration-token --jq .token"}"

./config.sh \
  --url "https://github.com/${REPO_NAME:?REPO_NAME 未设置}" \
  --token "${ACCESS_TOKEN:?ACCESS_TOKEN 未设置（注册 token 1 小时过期，用 start.sh 现铸）}" \
  --name "${RUNNER_NAME:?RUNNER_NAME 未设置}" \
  --labels "${RUNNER_LABELS:-self-hosted}" \
  --work "${RUNNER_WORKDIR:-_work}" \
  --replace \
  --unattended

exec ./run.sh
