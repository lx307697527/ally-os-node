# 用自己的机器跑 CI/CD（自托管 Runner）

GitHub Actions 的流水线不变，只是把「在哪台机器上执行」换成你自己的电脑或服务器。
GitHub 只负责调度，构建用的是你自己的 CPU，**不消耗 GitHub 托管机器的计费分钟数**。

> **Docker 一键版（推荐）**：`ops/ci-runner/` 提供容器化 runner——两个实例、
> 高资源限额、host 网络，`start.sh` 一条命令完成注册。详见
> `ops/ci-runner/README.md`。本文其余部分是原生（WSL2/裸机）安装的完整流程。

## 先看费用：你可能根本不需要

| 仓库类型 | GitHub 托管机器 | 自托管 Runner |
|---|---|---|
| **公开仓库** | **免费、不限分钟** | 免费，但**不安全**（见下文） |
| 私有仓库 | 每月有免费额度（Free 2000 分钟 / Pro 3000 分钟），超出按分钟计费 | 不按分钟收托管费用（以 GitHub 账单页为准） |

> ⚠️ **`ally-os-node` 目前是公开仓库。** 公开仓库用 GitHub 托管机器本来就不收费；
> 但公开仓库意味着公司的业务代码和基础设施配置所有人可见。**建议先把仓库改为私有**
> （Settings → General → Danger Zone → Change visibility），再按本文接入自托管 Runner。

**公开仓库不要接自托管 Runner**：任何人都能 fork 仓库并提交 PR，PR 里的代码会在你的机器上执行。
流水线已做防护（来自 fork 的 PR 强制使用 GitHub 托管机器），但官方仍建议自托管 Runner 只用于私有仓库。

## 机器要求

- **Linux**（Ubuntu 22.04+ 推荐），或 **Windows 上的 WSL2 Ubuntu**。
  流水线用了 Docker 服务容器（测试用的 Postgres）和 bash 脚本，**Windows 原生和 macOS 都不支持服务容器**。
- 已安装 **Docker**，并且运行 Runner 的用户能执行 `docker`（`sudo usermod -aG docker $USER` 后重新登录）。
- 部署任务还需要 **AWS CLI v2**、`jq`、`curl`、`unzip`（Ubuntu：`sudo apt install -y jq curl unzip`，AWS CLI 按官方文档安装）。
  Node、pnpm、Terraform 由流水线自动下载，不用预装。
- 建议 4 核 / 8 GB 内存 / 30 GB 可用磁盘（Docker 镜像缓存会逐渐变大，定期 `docker system prune`）。
- **机器必须开着并联网**，流水线才会执行；关机期间的任务会排队等待（最长约 24 小时后超时）。

## 安装步骤（约 10 分钟）

### 1. 在 GitHub 注册 Runner

仓库 → **Settings → Actions → Runners → New self-hosted runner** → 选择 **Linux / x64**。
页面会给出带一次性 token 的命令，在你的机器（或 WSL2 终端）里依次执行，大致如下：

```bash
mkdir ~/actions-runner && cd ~/actions-runner
curl -o actions-runner.tar.gz -L <页面上给出的下载地址>
tar xzf actions-runner.tar.gz
./config.sh --url https://github.com/lx307697527/ally-os-node --token <页面上的 token> \
  --name my-workstation --labels self-hosted,linux --unattended
```

### 2. 设为开机自启的后台服务

```bash
sudo ./svc.sh install
sudo ./svc.sh start
sudo ./svc.sh status     # 显示 active (running) 即成功
```

WSL2 用户：WSL 默认不会随 Windows 自动启动。在 Windows「任务计划程序」里加一个登录时运行
`wsl -d Ubuntu -u root service actions.runner.* start` 的任务，或者每次开机手动打开一次 WSL 终端。

### 3. 让流水线使用它

仓库 → **Settings → Secrets and variables → Actions → Variables** → 新增
`CI_RUNNER` = `self-hosted`。

之后所有 CI 和部署任务都会发到你的机器上。**想切回 GitHub 托管机器，删掉这个变量即可**，不用改代码。

## 流水线为自托管做的适配

- 测试用的 Postgres 容器映射到**随机端口**，不会和你本地开发用的 5432 冲突。
- 来自 fork 的 PR 永远在 GitHub 托管机器上跑。
- 只改文档（`*.md`、`docs/`）的提交不触发 CI。
- Docker 构建使用 GitHub Actions 缓存，重复构建很快。

## 进一步省构建次数（适合 AI 频繁提交）

- **在本地 / AI 会话里先跑 `pnpm verify`，通过了再推送。** AGENTS.md 已要求 AI 这样做，能挡掉大部分失败的构建。
- **攒一批再推**：AI 可以本地多次提交，最后一次性 push，CI 只跑一次（同一 PR 的旧构建会被自动取消）。
- 可以多开几个 Runner（同一台机器装多份，或多台机器）来并行执行任务。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 任务一直显示 “Waiting for a runner” | 机器关机、Runner 服务没启动，或 `CI_RUNNER` 的值和 Runner 标签不一致 |
| `permission denied ... docker.sock` | 运行 Runner 的用户不在 docker 组 |
| 磁盘满 | `docker system prune -af` 清理旧镜像和构建缓存 |
