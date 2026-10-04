#!/bin/bash
# docker CLI 包装：把「-p <容器端口>」这种动态端口发布改写成显式的
# 「127.0.0.1:<空闲端口>:<容器端口>」。
#
# 为什么：Docker Desktop 对「不指定宿主 IP 的动态端口」只转发到 Windows 宿主，
# 不会绑进 Docker VM 的 loopback；host 网络的 runner 用 127.0.0.1 连不到它
# （ECONNREFUSED）。显式绑定的端口则走 docker-proxy 绑在 VM 里，可达。
# GitHub Actions 的服务容器正是动态 `-p 5432`，这是唯一挡路的形式。
# runner 事后用 `docker port` 读回真实宿主端口，所以 workflow 拿到的数字不变。
set -euo pipefail

args=()
pending_publish=0
for arg in "$@"; do
  if (( pending_publish )) && [[ "$arg" =~ ^[0-9]+(/(tcp|udp|sctp))?$ ]]; then
    # 动态发布 → 选一个空闲的显式端口。runner 容器是 host 网络，
    # 在它自己的 127.0.0.1 上探测 == 探测 Docker VM 的 loopback。
    port=$(( (RANDOM % 16384) + 49152 ))
    while (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; do
      port=$(( port + 1 ))
    done
    args+=("127.0.0.1:${port}:${arg}")
  else
    args+=("$arg")
  fi

  if [[ "$arg" == "-p" || "$arg" == "--publish" ]]; then
    pending_publish=1
  else
    pending_publish=0
  fi
done

exec /usr/local/bin/docker.real "${args[@]}"
