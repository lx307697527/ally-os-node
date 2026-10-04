# 自托管 CI Runner —— Docker 版
#
# 在 ghcr.io/actions/actions-runner 官方镜像上加三样东西：
#   1. docker CLI + buildx 插件 —— CI 里的 Postgres 服务容器和 Docker 构建任务
#      靠它跟宿主机 Docker 通信（socket 挂载，兄弟容器方式，不跑 DinD）；
#   2. entrypoint.sh —— 官方镜像不带自动配置入口，用环境变量补上 config+run；
#   3. 版本随 actions/runner 的 release 走，升级只改 FROM 这一行。
FROM ghcr.io/actions/actions-runner:2.337.0

USER root
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg \
 && install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends docker-ce-cli docker-buildx-plugin nodejs \
 && rm -rf /var/lib/apt/lists/*
# node 是给 hashicorp/setup-terraform 的 terraform 包装脚本用的（它要往
# $GITHUB_OUTPUT 写输出）；GitHub 托管镜像预装了 node，裸容器没有会 127。
ENV DOCKER_HOST=unix:///var/run/docker.sock

# docker CLI 包装（见 docker-wrapper.sh 头注）：Docker Desktop 的动态端口
# 发布不绑 VM loopback，服务容器对 host 网络的 runner 不可达，必须改写成
# 显式绑定。包装放 /usr/bin/docker（runner 用 which 解析到这个路径），
# 真身挪到 /usr/local/bin/docker.real。
COPY docker-wrapper.sh /usr/local/bin/docker-wrapper.sh
RUN chmod +x /usr/local/bin/docker-wrapper.sh \
 && mv /usr/bin/docker /usr/local/bin/docker.real \
 && ln -s /usr/local/bin/docker-wrapper.sh /usr/bin/docker

COPY entrypoint.sh /home/runner/entrypoint.sh
RUN chmod +x /home/runner/entrypoint.sh \
 # compose 把 work 卷挂在这里；镜像里预建好属主，否则卷根目录归 root，job 起不来
 && install -d -o runner -g docker /home/runner/_work
USER runner
WORKDIR /home/runner
ENTRYPOINT ["./entrypoint.sh"]
