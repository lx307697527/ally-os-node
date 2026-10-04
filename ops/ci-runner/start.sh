#!/usr/bin/env bash
# 拉起（或重建）本地 Docker CI Runner，并在 GitHub 上注册。
#
# 用法：./start.sh        （依赖 gh 已登录仓库所有者账号）
# 停止：docker compose down
#
# 说明：
# - 注册 token 1 小时过期，所以每次启动现铸一个，不落盘。
# - 重建时先在 GitHub 侧删掉同名旧 runner 再注册，避免 Settings 里堆
#   Offline 的僵尸条目。
# - 日常重启机器后 compose 的 restart: unless-stopped 会自己拉起，
#   已注册的 runner 不需要重新铸 token —— 只有重建容器才要跑本脚本。
set -euo pipefail
cd "$(dirname "$0")"

REPO_NAME="${REPO_NAME:-lx307697527/ally-os-node}"

echo "==> 清掉同名旧 runner（GitHub 侧）"
existing=$(gh api "repos/${REPO_NAME}/actions/runners" --jq '.runners[] | select(.name == "local-docker-1" or .name == "local-docker-2") | .id')
for id in $existing; do
  echo "    delete runner #$id"
  gh api -X DELETE "repos/${REPO_NAME}/actions/runners/$id" > /dev/null
done

echo "==> 停掉本地旧容器"
docker compose down --remove-orphans 2>/dev/null || true

echo "==> 铸注册 token 并构建启动"
TOKEN=$(gh api -X POST "repos/${REPO_NAME}/actions/runners/registration-token" --jq .token)
ACCESS_TOKEN="$TOKEN" docker compose up -d --build

echo "==> 等待注册（最多 60s）"
for _ in $(seq 1 12); do
  sleep 5
  online=$(gh api "repos/${REPO_NAME}/actions/runners" \
    --jq '[.runners[] | select(.status == "online")] | length')
  echo "    online runners: $online"
  [ "$online" -ge 2 ] && break
done

gh api "repos/${REPO_NAME}/actions/runners" \
  --jq '.runners[] | "\(.name): \(.status) \([.labels[].name] | join(","))"'
echo "==> 完成。CI 走本地由仓库变量 CI_RUNNER=self-hosted 控制。"
