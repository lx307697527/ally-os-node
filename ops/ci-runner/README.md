# 本地 Docker CI Runner

把 GitHub Actions 的执行端放进本机 Docker，占满机器的多核。仓库正本在本目录；
**运行实例放在仓库之外**（worktree 可能被清理），见下方部署位置。

一键启动 / 重建（依赖 `gh` 已登录）：

```bash
d:/Code/ally-ci-runner/start.sh
```

之后在仓库 **Settings → Secrets and variables → Actions → Variables** 设
`CI_RUNNER` = `self-hosted`，所有非 fork 的 CI 和部署
任务就都发到本机；删掉这个变量即回退 GitHub 托管机器。

## 文件

| 文件 | 作用 |
| --- | --- |
| `Dockerfile` | 官方 `ghcr.io/actions/actions-runner` 镜像 + docker CLI/buildx + 我们的 entrypoint |
| `entrypoint.sh` | 用环境变量跑 `config.sh`（`--replace` 顶掉同名旧 runner）+ 前台 `run.sh` |
| `compose.yaml` | 两个 runner 实例（`local-docker-1/2`），单实例限额 10 CPU / 10GB |
| `start.sh` | 铸注册 token（1 小时有效，现铸现用）→ 清同名旧 runner → `compose up` → 等注册上线 |

## 部署到本机（一次性）

```bash
mkdir -p /d/Code/ally-ci-runner
cp -r <仓库>/ops/ci-runner/* /d/Code/ally-ci-runner/
d:/Code/ally-ci-runner/start.sh
```

日常开关机不用管：`restart: unless-stopped` 会在 Docker 起来后自动拉回已注册的
runner，不需要重新铸 token；只有**重建容器**才需要再跑 `start.sh`。

## 资源怎么给高

- 单个 job 的上限 = compose 里 `deploy.resources.limits`（当前 10 CPU / 10GB）。
- 两个实例并行 → CI 的 4 个 job（verify + docker×2 + terraform）两两并行。
- 真正的天花板是 **Docker Desktop 虚拟机**：Settings → Resources（本机当前
  24 CPU / 16GB，够两个 runner；要再加就调大 VM 并放宽 compose 限额）。
- 长期用注意磁盘：job 的工作目录在 `work` 卷里，Docker 构建缓存也会积累，
  定期 `docker system prune` / `docker volume rm ally-ci-runners_work`。

## 前提与安全

- Linux 容器（Docker Desktop WSL2 后端）；Windows 原生容器不行——CI 用
  Postgres 服务容器和 bash。
- 本仓库目前是**公开仓库**：流水线已强制 fork 的 PR 走 GitHub 托管机器，
  外部代码不会到本机执行；但公开仓库接自托管 runner 官方仍不建议，
  长期请按 `docs/guides/self-hosted-runner.md` 开头说的把仓库转私有。
- 部署（Deploy）任务同样会被 `CI_RUNNER` 切到本机执行，需要本机能访问 AWS。

更多原生安装 / 原理说明见 `docs/guides/self-hosted-runner.md`。
